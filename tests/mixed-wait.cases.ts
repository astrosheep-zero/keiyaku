import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Akumas, Keis, Keiyaku, Repo, World, type InvocationWaitResult } from "../src/index.js";
import { finishBodyIfIdle } from "../src/akuma/heart/index.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { bornBody, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { withContractWaitBarrier } from "./support/contract-wait.js";
import { withGitShim } from "./support/git.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";
import { assertWireConformance } from "./support/schema-parity.js";

const AT = "2026-11-16T00:00:00.000Z";
async function fixture(t: TestContext) {
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const home = temporaryDirectory(t, "mixed-wait-home-");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const environment = { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home };
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  const worker = await bornBody(world, "abcd0001", AT);
  t.after(() => worker.holder.release());
  const facet = (gitPath?: string) => Keiyaku.for({ cwd: world, home, environment: {
    ...environment, ...(gitPath === undefined ? {} : { KEIYAKU_GIT_PATH: gitPath }),
  } });
  const finish = async () => {
    assert.equal((await finishBodyIfIdle(worker.allocated.paths, { sequence: worker.body.sequence, at: AT })).kind, "finished");
    worker.holder.release();
  };
  const amend = async () => accepted(await bound.kei.amend({ markdown: "## Replace: Objective\n\nWitness this journal change.\n" }));
  return { world, repository, environment, bound, worker, facet, finish, amend };
}

function observations(value: InvocationWaitResult) { return value.members.map(member => member.observation); }

test("mixed any wakes from either native owner; all retains its original Contract baseline", async t => {
  const f = await fixture(t);
  const selectors = [f.bound.contractId, f.worker.allocated.id];
  await withContractWaitBarrier(f.world, async barrier => {
    const facet = f.facet(barrier.gitPath);
    const first = facet.wait({ selectors, timeout: "10s" });
    await barrier.reads();
    await f.amend();
    const changed = await first;
    assert.equal(changed.reason, "completed");
    assert.deepEqual(changed.members[0], { kind: "contract", observation: { id: f.bound.contractId, changed: true } });

    barrier.reset();
    const all = facet.run("wait", { selectors, completion: "all", timeout: "1200ms" });
    await barrier.reads();
    accepted(await f.bound.kei.arc({ markdown: "# Still waiting\n\nThis is a new journal fact.\n" }));
    const deadline = await all;
    assert.equal(deadline.reason, "deadline");
    assert.deepEqual(deadline.members[0], { kind: "contract", observation: { id: f.bound.contractId, changed: true } });
    assert.ok(deadline.members[1]?.kind === "akuma" && deadline.members[1].observation.kind === "observed");
    assert.equal(deadline.members[1].observation.life, "running");
    assertWireConformance(Keiyaku.verbs.wait.normal, deadline);

    barrier.reset();
    const second = facet.wait({ selectors, timeout: "10s" });
    await barrier.reads();
    await f.finish();
    const completed = await second;
    assert.equal(completed.reason, "completed");
    assert.ok(completed.members[1]?.kind === "akuma" && completed.members[1].observation.kind === "observed");
    assert.equal(completed.members[1].observation.life, "asleep");
    assert.notEqual((completed.members[0]?.observation as { changed?: true }).changed, true);
  });
});

test("mixed all waits for both members, freezing aliases/globs and first-seen order", async t => {
  const f = await fixture(t);
  await moveAlias({ world: f.world, alias: parseAkumaAlias("@worker"), akumaId: f.worker.allocated.id });
  await withContractWaitBarrier(f.world, async barrier => {
    const pending = f.facet(barrier.gitPath).wait({
      selectors: ["@worker", f.bound.contractId, "aku/claude/*", f.bound.contractId], completion: "all", timeout: "10s",
    });
    await barrier.reads();
    const peer = await bornLineageAkuma({ root: f.world, akumaName: "claude", draw: "abcd0002", createdAt: AT });
    await moveAlias({ world: f.world, alias: parseAkumaAlias("@worker"), akumaId: peer.id });
    await f.amend();
    barrier.reset();
    await barrier.reads(2);
    await f.finish();
    const result = await pending;
    assert.equal(result.reason, "completed");
    assert.deepEqual(observations(result).map(member => member.id), [f.worker.allocated.id, f.bound.contractId]);
    assert.deepEqual(result.members[1], { kind: "contract", observation: { id: f.bound.contractId, changed: true } });
    assertWireConformance(Keiyaku.verbs.wait.normal, result);
  });
});

test("already satisfied members count immediately and slow peers stay honestly unknown", async t => {
  const f = await fixture(t);
  await f.finish();
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
    const started = performance.now();
    const result = await f.facet(gitPath).wait({ selectors: [f.bound.contractId, f.worker.allocated.id], timeout: "10s" });
    assert.ok(performance.now() - started < 5000, "any does not spend a peer's full timeout");
    assert.equal(result.reason, "completed");
    assert.deepEqual(result.members[0], { kind: "contract", observation: { id: f.bound.contractId, presence: "unknown" } });
    assertWireConformance(Keiyaku.verbs.wait.normal, result);
  });
  accepted(await f.bound.kei.abandon());
  const result = await f.facet().wait({ selectors: [f.bound.contractId, f.worker.allocated.id], completion: "all", timeout: "0ms" });
  assert.equal(result.reason, "completed", "completion wins at the deadline edge");
  assertWireConformance(Keiyaku.verbs.wait.normal, result);
});

test("one deadline and caller abort release readers without stopping Akuma work", async t => {
  const f = await fixture(t);
  const selectors = [f.bound.contractId, f.worker.allocated.id];
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
    const started = performance.now();
    const result = await f.facet(gitPath).wait({ selectors, completion: "all", timeout: "200ms" });
    assert.ok(performance.now() - started < 5000);
    assert.equal(result.reason, "deadline");
    assert.deepEqual(result.members[0], { kind: "contract", observation: { id: f.bound.contractId, presence: "unknown" } });
  });
  await withContractWaitBarrier(f.world, async barrier => {
    const controller = new AbortController();
    const reason = new Error("caller stops watching");
    const pending = f.facet(barrier.gitPath).wait({ selectors, completion: "all" }, { signal: controller.signal });
    await barrier.reads(2);
    const original = DatabaseSync.prototype.close;
    let closes = 0;
    t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) { closes++; return original.call(this); });
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.ok(closes > 0, "cancellation retires the retained Heart reader before rejecting");
    t.mock.restoreAll();
  });
  const worker = await Akumas.of(f.world).status({ akuma: f.worker.allocated.id });
  assert.equal(worker.life, "running");
});

test("mixed missing authority retains native refusal, never satisfying any", async t => {
  const f = await fixture(t);
  const input = { selectors: ["kei/not-present", f.worker.allocated.id], timeout: "0ms" };
  const result = await f.facet().wait(input);
  assert.equal(result.reason, "missing");
  assert.deepEqual(result.members[0], { kind: "contract", observation: { id: "kei/not-present", presence: "missing" } });
  assert.equal(classifyVerb("wait", input, { kind: "returned", value: result }), "refused");
  assertWireConformance(Keiyaku.verbs.wait.output, result);
  assertWireConformance(Keiyaku.verbs.wait.normal, result, false);
});

test("unsettled Akumas use cheap paced probes between initial and deadline snapshots", async t => {
  const f = await fixture(t);
  for (const selectors of [[f.worker.allocated.id], [f.bound.contractId, f.worker.allocated.id]]) {
    let snapshots = 0;
    let lifeReads = 0;
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (sql.includes("SELECT sequence FROM turns ORDER BY sequence DESC LIMIT 1")) snapshots++;
      if (sql.includes("FROM bodies ORDER BY sequence DESC LIMIT 1")) lifeReads++;
      return prepare.call(this, sql);
    });
    try {
      const result = await f.facet().wait({ selectors, completion: "all", timeout: "1200ms" });
      assert.equal(result.reason, "deadline");
      assert.equal(snapshots, 2, "only initial and final full monitoring snapshots, not one per poll");
      assert.ok(lifeReads > snapshots + 2, "intervening rounds still probe native completion");
      assert.ok(lifeReads <= 8, "cheap probes retain native pacing instead of running every Contract poll");
      const worker = result.members.find(member => member.kind === "akuma");
      assert.ok(worker?.kind === "akuma" && worker.observation.kind === "observed");
      assert.equal(worker.observation.life, "running");
    } finally { t.mock.restoreAll(); }
  }
});

test("a failed peer observation remains identified failure, not group completion", async t => {
  const f = await fixture(t);
  await withContractWaitBarrier(f.world, async barrier => {
    const input = { selectors: [f.bound.contractId, f.worker.allocated.id], completion: "all" as const, timeout: "1400ms" };
    const pending = f.facet(barrier.gitPath).wait(input);
    await barrier.reads(2);
    renameSync(f.worker.allocated.paths.heart, `${f.worker.allocated.paths.heart}.retained`);
    writeFileSync(f.worker.allocated.paths.heart, "not a Heart database\n");
    const result = await pending;
    assert.equal(result.reason, "deadline");
    const peer = result.members[1];
    assert.ok(peer?.kind === "akuma" && peer.observation.kind === "unobserved");
    assert.equal(peer.observation.id, f.worker.allocated.id);
    assert.match(peer.observation.diagnostic, /not a database/u);
    assert.equal(classifyVerb("wait", input, { kind: "returned", value: result }), "failed");
    assertWireConformance(Keiyaku.verbs.wait.output, result);
    assertWireConformance(Keiyaku.verbs.wait.normal, result, false);
  });
});

test("mixed SDK, CLI and MCP share one object input and ordered native evidence", async t => {
  const f = await fixture(t);
  const input = { selectors: [f.worker.allocated.id, f.bound.contractId], completion: "all" as const, timeout: "0ms" };
  const expected = await f.facet().run("wait", input);
  assert.equal(expected.reason, "deadline");
  const argv = ["wait", ...input.selectors, "--all", "--timeout", "0ms"];
  const cli = await cliJson<InvocationWaitResult>(argv, { cwd: f.world, environment: f.environment });
  assert.deepEqual(cli.value, expected);
  const text = await runCli(argv, { cwd: f.world, environment: f.environment });
  assert.ok(text.stdout.indexOf(f.worker.allocated.id) < text.stdout.indexOf(f.bound.contractId));
  const adapter = createKeiyakuMcpServer({ cwd: f.world, environment: f.environment, version: "test" });
  const client = new Client({ name: "mixed-wait", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  const { tools } = await client.listTools();
  const tool = tools.find(tool => tool.name === "wait")!;
  assert.equal(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties?.selectors);
  const result = await client.callTool({ name: "wait", arguments: input });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, expected);
  assert.equal((result.content as { text: string }[])[0]?.text, text.stdout.trimEnd());
});
