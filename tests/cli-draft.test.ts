import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BindDraftError, preserveBindDraft } from "../src/cli/draft.js";
import { runContractMutation } from "../src/cli/commands/contract.js";
import { resolveInvocationCoordinates } from "../src/cli/coordinates.js";
import { parseArgv } from "../src/cli/parse.js";
import { writeExecutionProgress, type CliRuntime } from "../src/cli/runtime.js";
import { cliExitCode } from "../src/cli/streams.js";
import { captureOutput, runCli } from "./support/cli-fixtures.js";
import { renderBindDraftReceipt, renderRefusal } from "../src/cli/render/refusal.js";
import { World, type WorldRoot } from "../src/world.js";
import { Keiyaku } from "../src/index.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

async function draftWorld(): Promise<WorldRoot> {
  return World.at(mkdtempSync(join(tmpdir(), "keiyaku-bind-draft-")));
}

test("bind draft preservation repairs corrupted content and renews equal receipt custody", async () => {
  const world = await draftWorld();
  const bytes = "same refused input\n";
  const first = await preserveBindDraft(world, bytes);
  if (first.path === undefined) throw new Error(first.warning);
  const path = resolve(world, first.path);
  writeFileSync(path, "corrupt");

  const repaired = await preserveBindDraft(world, bytes);
  assert.equal(repaired.path, first.path);
  assert.equal(readFileSync(path, "utf8"), bytes);

  const now = Date.now();
  const expired = new Date(now - 8 * 24 * 60 * 60 * 1_000);
  utimesSync(path, expired, expired);
  const renewed = await preserveBindDraft(world, bytes, now);
  assert.equal(renewed.path, first.path);
  await preserveBindDraft(world, "another failure\n", now + 1);
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("a successful draft write sweeps only expired content-addressed bind drafts", async () => {
  const world = await draftWorld();
  const directory = resolve(world, ".keiyaku/draft");
  mkdirSync(directory, { recursive: true });
  const expired = resolve(directory, `bind-${"0".repeat(64)}.md`);
  const unrelated = resolve(directory, "notes.md");
  writeFileSync(expired, "expired");
  writeFileSync(unrelated, "keep");
  const now = Date.now();
  utimesSync(expired, new Date(now - 8 * 24 * 60 * 60 * 1_000), new Date(now - 8 * 24 * 60 * 60 * 1_000));

  const receipt = await preserveBindDraft(world, "fresh\n", now);

  assert.notEqual(receipt.path, undefined);
  assert.equal(existsSync(expired), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep");
});

test("BindDraftError keeps the original failure when draft custody is a warning", async (context) => {
  const world = await draftWorld();
  writeFileSync(resolve(world, ".keiyaku/draft"), "not a directory");
  const original = new TypeError("first diagnostic\nsecond diagnostic");
  const draft = await preserveBindDraft(world, "cannot persist\n");
  const error = new BindDraftError(original, draft);

  assert.equal(error.message, original.message);
  assert.equal(error.original, original);
  assert.equal(error.draft.path, undefined);
  assert.match(error.draft.warning ?? "", /could not be preserved/u);
  assert.match(renderBindDraftReceipt(error.draft), /^! draft warning  /u);

  const root = mkdtempSync(join(tmpdir(), "keiyaku-draft-coordinate-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = join(root, "nonexistent-cwd");
  const early = await runCli(["-C", absent, "bind", "-"], {
    environment: {},
    readStdin: async () => "invalid markdown",
  });
  assert.equal(early.exit, 1);
  assert.match(early.stdout, /invalid document/iu);
  assert.match(early.stdout, /draft warning/u);
  assert.equal((early.stdout.match(/invocation cwd is not an existing directory/gu) ?? []).length, 1);
  assert.doesNotMatch(early.stdout, /× usage/u);
  assert.doesNotMatch(early.stdout, /draft  \.keiyaku\/draft\//u);
  assert.equal(existsSync(absent), false);

  const repository = repositoryWithMain();
  const facet = Keiyaku.at({ cwd: repository.path, environment: {}, home: root });
  const markdown = document();
  const refusal = await facet.run("bind", { markdown, target: "missing-target" });
  assert.equal(refusal.kind, "refused");
  if (refusal.kind !== "refused") throw new Error("expected native bind refusal");
  assert.equal(refusal.reason.kind, "target-missing");
  for (const output of ["text", "json"] as const) {
    const parsed = parseArgv(["bind", "-", "--target", "missing-target", ...(output === "json" ? ["--json"] : [])]);
    if (!("command" in parsed) || parsed.command.command !== "bind") throw new Error("expected bind");
    const command = parsed.command;
    const runtime: CliRuntime = {
      environment: {},
      facet,
      readStdin: async () => markdown,
      draftWorld: async () =>
        (await resolveInvocationCoordinates({ processCwd: root, command }, { KEIYAKU_GIT_PATH: " " })).establishWorld(),
      signal: new AbortController().signal,
      progress: writeExecutionProgress,
    };
    const result = await captureOutput(async () => cliExitCode(await runContractMutation(command, runtime)));
    assert.equal(result.exit, 1);
    if (output === "json") {
      assert.deepEqual(JSON.parse(result.stdout), refusal);
    } else {
      const original = renderRefusal({ operation: "bind", refusal: refusal.reason });
      assert.ok(result.stdout.startsWith(`${original}\n`));
      assert.equal(result.stdout.split(original).length - 1, 1);
      assert.match(result.stdout, /draft warning/u);
      assert.equal((result.stdout.match(/KEIYAKU_GIT_PATH requires a nonblank value/gu) ?? []).length, 1);
      assert.doesNotMatch(result.stdout, /draft  \.keiyaku\/draft\//u);
    }
  }
});
