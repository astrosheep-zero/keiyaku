import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { main } from "../src/cli/main.js";
import { captureOutput, cliJson, runCli } from "./support/cli-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";

test("show reads native bytes once for explicit and contextual Contract selection", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const library = Keiyaku.with();
  const bound = accepted(
    await library.bind({
      repo,
      target: "main",
      gates: ["reviewed"],
      markdown: contractMarkdown("Guidance read", {
        Context: "Native guidance",
        Objective: "Read guidance",
        Design: "One owner",
        Region: "src/**",
        Criteria: "### Read\nReturn admitted terms.",
      }),
    }),
  );
  const row = (await library.list({ repo })).rows.find((entry) => entry.id === bound.contract)!;
  assert.ok(row.worktreePath);
  const expected = await library.select({ repo, id: row.id }).guidance();
  assert.equal(typeof expected, "string");
  const read = t.mock.method(Keiyaku.prototype, "guidance");
  for (const [cwd, selector] of [
    [repository.path, row.id],
    [repository.path, `@${row.id.slice("kei/".length)}`],
    [row.worktreePath, undefined],
  ] as const) {
    const argv = ["-C", cwd, "show", ...(selector === undefined ? [] : [selector])];
    let before = read.mock.callCount();
    const text = await runCli(argv, { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.equal(text.stdout, expected!.endsWith("\n") ? expected : `${expected}\n`);
    assert.equal(read.mock.callCount(), before + 1);
    before = read.mock.callCount();
    const json = await cliJson(argv, { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    assert.equal(json.value, expected);
    assert.equal(read.mock.callCount(), before + 1);
  }
  const before = read.mock.callCount();
  const status = await runCli(["-C", repository.path, "status", row.id], { environment: {} });
  assert.equal(status.exit, 0, status.stderr);
  assert.equal(read.mock.callCount(), before);
  for (const selectors of [[], ["kei"], ["aku"], [row.id, `@${row.id.slice("kei/".length)}`]]) {
    const ordinary = await runCli(["-C", repository.path, "status", ...selectors], { environment: {} });
    assert.equal(ordinary.exit, 0, ordinary.stderr);
    assert.equal(read.mock.callCount(), before);
    assert.doesNotMatch(ordinary.stdout, /# Guidance read/u);
  }
  const child = join(row.worktreePath, "nested");
  mkdirSync(child);
  const nested = await captureOutput(() => main(["-C", child, "show"]));
  assert.equal(nested.exit, 64);
  assert.match(nested.stderr, /required outside a managed worktree/u);
  assert.equal(read.mock.callCount(), before);
  assert.doesNotMatch(status.stdout, /# Guidance read/u);
});

test("show preserves native absence and selection refusals with command-specific diagnostics", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const read = t.mock.method(Keiyaku.prototype, "guidance");
  const text = await runCli(["-C", repository.path, "show", "kei/missing"], { environment: {} });
  assert.equal(text.exit, 1);
  assert.equal(text.stdout, "× show refused\n  contract  kei/missing\n  reason  contract missing\n");
  const json = await cliJson(["-C", repository.path, "show", "kei/missing"], { environment: {} });
  assert.equal(json.exit, 1);
  assert.equal(json.value, null);
  assert.equal(read.mock.callCount(), 2);
  for (const [args, reason] of [
    [[], /required outside a managed worktree/u],
    [["@missing"], /unknown contract selector/u],
    [["@kei/missing"], /redundant short contract selector/u],
    [["aku/worker/1234abcd"], /cannot select an Akuma/u],
    [["kei/*"], /cannot select a category/u],
    [["kei/a", "kei/b"], /at most one contract/u],
    [["--unknown"], /not valid for show/u],
  ] as const) {
    const result = await captureOutput(() => main(["-C", repository.path, "show", ...args]));
    assert.equal(result.exit, 64, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, reason);
    assert.match(result.stderr, /keiyaku show/u);
    assert.doesNotMatch(result.stderr, /keiyaku status/u);
  }
  assert.equal(read.mock.callCount(), 2);
});

test("retired status guidance is a usage refusal before World or guidance acquisition", async (t) => {
  const read = t.mock.method(Keiyaku.prototype, "guidance", async () => {
    assert.fail("status must not acquire guidance");
  });
  for (const selectors of [[], ["kei/missing"], ["aku"], ["kei/a", "kei/b"]]) {
    const result = await captureOutput(() =>
      main(["-C", "/definitely/absent/keiyaku-world", "status", ...selectors, "--guidance", "--json"]),
    );
    assert.equal(result.exit, 64);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /× usage  keiyaku status/u);
    assert.match(result.stderr, /option --guidance is not valid for status/u);
  }
  assert.equal(read.mock.callCount(), 0);
});

test("guidance acquisition failure stays a failure, not missing guidance", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  t.mock.method(Keiyaku.prototype, "guidance", async () => {
    throw new Error("guidance unavailable");
  });
  const result = await captureOutput(() => main(["-C", repository.path, "show", "kei/missing"]));
  assert.equal(result.exit, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /guidance unavailable/u);
});
