import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Akuma } from "../src/akuma/index.js";
import { readHeart, probeLeash } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import test from "node:test";
import { Kei, Keis, Repo, World } from "../src/index.js";
import { main } from "../src/cli/main.js";
import { captureOutput, cliJson, runCli } from "./support/cli-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
  waitForCondition,
  waitForPidReceiptExit,
} from "./support/process.js";
import { contractMarkdown } from "./support/markdown.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("show reads native bytes once for explicit Contract selection and refuses omission", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const library = Keis.of(repo);
  const bound = accepted(
    await library.bind({
      target: "main",
      gates: ["reviewed"],
      terms: contractMarkdown("Guidance read", {
        Context: "Native guidance",
        Objective: "Read guidance",
        Design: "One owner",
        Region: "src/**",
        Criteria: "### Read\nReturn admitted terms.",
      }),
    }),
  );
  const expected = await bound.kei.guidance();
  assert.equal(expected.kind, "present");
  if (expected.kind !== "present") assert.fail("missing native guidance");
  const read = t.mock.method(Kei.prototype, "guidance");
  const text = await runCli(["-C", repository.path, "show", bound.contractId], { environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(text.stdout, expected.guidance.endsWith("\n") ? expected.guidance : `${expected.guidance}\n`);
  assert.equal(read.mock.callCount(), 1);
  const omitted = await captureOutput(() => main(["-C", bound.worktreePath!, "show"]));
  assert.equal(omitted.exit, 64);
  assert.match(omitted.stderr, /show requires one explicit selector/u);
  assert.equal(read.mock.callCount(), 1);
});

test("show preserves native absence", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const json = await cliJson(["-C", repository.path, "show", "kei/missing"], { environment: {} });
  assert.equal(json.exit, 1);
  assert.deepEqual(json.value, { kind: "missing" });
});

test("CLI ask returns the exact parsed JSON on stdout", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-tell-"));
  const home = temporaryDirectory(t, "keiyaku-cli-tell-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const agent = join(world, "host-acp.mjs");
  const answer = '{"ok":true}';
  writeFileSync(agent, readFileSync(agent, "utf8").replace('text: "acp-answer"', `text: ${JSON.stringify(answer)}`));
  const schema = join(world, "answer.json");
  writeFileSync(schema, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }));
  const receipt = join(root, "body-pids");
  const restore = installAkumaBodyPidReceipt(receipt);
  let operationFailed = true;
  try {
    const born = await Akuma.birth("acp-worker", { root: world, cwd: world, home, bare: true });
    const paths = pathsForAkumaId(world, born.id);
    await waitForCondition("ordinary birth Body settlement", async () =>
      (await readHeart(paths)).latestBody?.end === "exited" && (await probeLeash(paths)) === "free",
    );
    await waitForPidReceiptExit(receipt, 60_000, { requireBirth: true });
    const runtime = { environment: { KEIYAKU_HOME: home }, signal: t.signal };
    const printed = await runCli(["-C", root, "ask", born.id, "--schema", schema, "prompt"], runtime);
    assert.equal(printed.exit, 0, printed.stderr);
    assert.equal(printed.stdout, answer, "one exact JSON serialization, without a newline");
    assert.match(printed.stderr, new RegExp(`^✓ answered ${born.id}\\n  input `, "u"));
    assert.equal(printed.stderr.trimEnd().split("\n").length, 2, "non-TTY Ask emits only final facts");
    operationFailed = false;
  } finally {
    try {
      await cleanupSpawnCapableFixtureForTest(t, { fixturePath: root, pidReceiptPath: receipt, timeoutMs: 60_000, operationFailed });
    } finally { restore(); }
  }
});

