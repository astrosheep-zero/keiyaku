import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Akuma } from "../src/akuma/index.js";
import { HeldAkumaLeash, readHeart, probeLeash } from "../src/akuma/heart/index.js";
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

test("show reads native bytes once for explicit and contextual Contract selection", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const library = Keis.of(repo);
  const bound = accepted(
    await library.bind({
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
  const row = (await library.list({})).rows?.find((entry) => entry.id === bound.contractId);
  assert.ok(row !== undefined);
  const observed = await library.observe({ id: row.id });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present" || observed.row.workspace.kind === "unappointed") assert.fail("missing workspace");
  const worktreePath = observed.row.workspace.path;
  const expected = await library.kei({ id: row.id }).guidance();
  assert.equal(expected.kind, "present");
  if (expected.kind !== "present") assert.fail("missing native guidance");
  const read = t.mock.method(Kei.prototype, "guidance");
  for (const [cwd, selector] of [
    [repository.path, row.id],
    [repository.path, `@${row.id.slice("kei/".length)}`],
    [worktreePath, undefined],
  ] as const) {
    const argv = ["-C", cwd, "show", ...(selector === undefined ? [] : [selector])];
    let before = read.mock.callCount();
    const text = await runCli(argv, { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.equal(text.stdout, expected.guidance.endsWith("\n") ? expected.guidance : `${expected.guidance}\n`);
    assert.equal(read.mock.callCount(), before + 1);
    before = read.mock.callCount();
    const json = await cliJson(argv, { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    assert.deepEqual(json.value, expected);
    assert.equal(read.mock.callCount(), before + 1);
  }
  const before = read.mock.callCount();
  const status = await runCli(["-C", repository.path, "status", row.id], { environment: {} });
  assert.equal(status.exit, 0, status.stderr);
  assert.equal(read.mock.callCount(), before);
  for (const selectors of [[], [row.id], [`@${row.id.slice("kei/".length)}`]]) {
    const ordinary = await runCli(["-C", repository.path, "status", ...selectors], { environment: {} });
    assert.equal(ordinary.exit, 0, ordinary.stderr);
    assert.equal(read.mock.callCount(), before);
    assert.doesNotMatch(ordinary.stdout, /# Guidance read/u);
  }
  const child = join(worktreePath, "nested");
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
  const read = t.mock.method(Kei.prototype, "guidance");
  const text = await runCli(["-C", repository.path, "show", "kei/missing"], { environment: {} });
  assert.equal(text.exit, 1);
  assert.equal(text.stdout, "× show refused\n  contract  kei/missing\n  reason  contract missing\n");
  const json = await cliJson(["-C", repository.path, "show", "kei/missing"], { environment: {} });
  assert.equal(json.exit, 1);
  assert.deepEqual(json.value, { kind: "missing" });
  assert.equal(read.mock.callCount(), 2);
  for (const [args, reason] of [
    [[], /required outside a managed worktree/u],
    [["@missing"], /unknown contract selector/u],
    [["@kei/missing"], /redundant short contract selector/u],
    [["aku/worker/1234abcd"], /cannot select an Akuma/u],
    [["kei/*"], /cannot select a category/u],
    [["kei/a", "kei/b"], /at most one Contract/u],
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
  const read = t.mock.method(Kei.prototype, "guidance", async () => {
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

test("CLI ask returns JSON and invalid-output while tell observes text", { timeout: 60_000 }, async (t) => {
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
    const runtime = { environment: { KEIYAKU_HOME: home }, signal: t.signal, readStdin: async () => "answer this" };
    const text = await runCli(["-C", root, "tell", born.id, "--wait", "60s", "-"], runtime);
    assert.equal(text.exit, 0, text.stderr);
    assert.equal(text.stdout, answer);
    const decoded = await cliJson<{ kind: string; answer: unknown }>(
      ["-C", root, "ask", born.id, "--schema", schema, "-"], runtime,
    );
    assert.equal(decoded.exit, 0, decoded.stderr);
    assert.equal(decoded.value.kind, "answered");
    assert.deepEqual(decoded.value.answer, { ok: true });
    const printed = await runCli(["-C", root, "ask", born.id, "--schema", schema, "prompt"], runtime);
    assert.equal(printed.exit, 0, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), { ok: true });
    writeFileSync(agent, readFileSync(agent, "utf8").replace(`text: ${JSON.stringify(answer)}`, 'text: "not-json"'));
    const invalid = await cliJson<{ kind: string; answer: unknown }>(
      ["-C", root, "ask", born.id, "--schema", schema, "prompt"], runtime,
    );
    assert.equal(invalid.exit, 3, invalid.stderr);
    assert.equal(invalid.value.kind, "invalid-output");
    assert.equal(invalid.value.answer, "not-json");
    operationFailed = false;
  } finally {
    try {
      await cleanupSpawnCapableFixtureForTest(t, { fixturePath: root, pidReceiptPath: receipt, timeoutMs: 60_000, operationFailed });
    } finally { restore(); }
  }
});

test("an observer-held leash cannot strand the original Tell", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-tell-observer-leash-"));
  const home = temporaryDirectory(t, "keiyaku-tell-observer-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const receipt = join(root, "body-pids");
  const restore = installAkumaBodyPidReceipt(receipt);
  let operationFailed = true;
  let observation: Promise<unknown> | undefined;
  try {
    const born = await Akuma.birth("acp-worker", { root: world, cwd: world, home, bare: true });
    const paths = pathsForAkumaId(world, born.id);
    await waitForCondition("ordinary birth Body settlement before contention", async () =>
      (await readHeart(paths)).latestBody?.end === "exited" && (await probeLeash(paths)) === "free",
    );
    await waitForPidReceiptExit(receipt, 60_000, { requireBirth: true });
    const settledLog = readFileSync(paths.log, "utf8");
    const take = HeldAkumaLeash.try;
    let contended = false;
    t.mock.method(HeldAkumaLeash, "try", async (observed: Parameters<typeof take>[0]) => {
      const observer = new Error().stack?.includes("bornObservation") === true;
      const claim = await take.call(HeldAkumaLeash, observed);
      if (observed.leash === paths.leash && observer && claim !== null && !contended) {
        contended = true;
        try {
          await waitForCondition("real launch refused by the observer's exclusive leash", () =>
            existsSync(paths.log) && readFileSync(paths.log, "utf8").slice(settledLog.length).includes("[child exit 75]"),
          );
        } catch (error) {
          claim.release();
          throw error;
        }
      }
      return claim;
    });
    // Establish actual observation custody before admitting the Tell, so child
    // startup speed cannot choose whether the launch encounters the held seat.
    observation = born.status();
    void observation.catch(() => undefined);
    await waitForCondition("observer acquired the exclusive leash before Tell admission", () => contended);
    const result = await runCli(["-C", root, "tell", born.id, "--wait", "60s", "answer this"], {
      environment: { KEIYAKU_HOME: home },
      signal: t.signal,
    });
    await observation;
    assert.equal(contended, true, "the observer held the actual admission leash across launch");
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.stdout, "acp-answer", result.stderr);
    assert.deepEqual((await readHeart(paths)).pending, []);
    operationFailed = false;
  } finally {
    try {
      await observation?.catch(() => undefined);
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath: root,
        pidReceiptPath: receipt,
        timeoutMs: 60_000,
        operationFailed,
        expectRetainedEvidence: operationFailed,
      });
    } finally {
      restore();
    }
  }
});

test("guidance acquisition failure stays a failure, not missing guidance", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  t.mock.method(Kei.prototype, "guidance", async () => {
    throw new Error("guidance unavailable");
  });
  const result = await captureOutput(() => main(["-C", repository.path, "show", "kei/missing"]));
  assert.equal(result.exit, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /guidance unavailable/u);
});
