import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Akumas, Keis, Keiyaku, Repo, World, type InvocationWaitResult } from "../src/index.js";
import { appendActivity, beginTurn, endTurn, finishBodyIfIdle } from "../src/akuma/heart/index.js";
import { modelOutputSchemas, projectModelOutput } from "../src/library/model-tools.js";
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
    assert.ok(changed.members[0]?.kind === "contract");
    assert.equal(changed.members[0].observation.changed, true);
    assert.equal(changed.members[0].observation.summary?.title, "Library verbs");
    assert.equal(changed.members[0].observation.summary?.phase, "bound");

    barrier.reset();
    const all = facet.run("wait", { selectors, completion: "all", timeout: "1200ms" });
    await barrier.reads();
    accepted(await f.bound.kei.arc({ markdown: "# Still waiting\n\nThis is a new journal fact.\n" }));
    const deadline = await all;
    assert.equal(deadline.reason, "deadline");
    assert.ok(deadline.members[0]?.kind === "contract");
    assert.equal(deadline.members[0].observation.changed, true);
    assert.equal(deadline.members[0].observation.summary?.id, f.bound.contractId);
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
    assert.ok(result.members[1]?.kind === "contract");
    assert.equal(result.members[1].observation.changed, true);
    assert.equal(result.members[1].observation.summary?.id, f.bound.contractId);
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

test("deadline wait returns three actual events and settled wait keeps the complete exact-turn answer", async t => {
  const f = await fixture(t);
  const paths = f.worker.allocated.paths;
  const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  await appendActivity(paths, { turnSequence: turn.sequence, at: AT, event: {
    type: "tool", id: "edit", name: "edit", phase: "completed", result: { status: "ok" },
    call: { kind: "fileChange", changes: [{ op: "update", path: "source.ts", diffstat: { added: 2, removed: 1 } }] },
  } });
  const adapter = createKeiyakuMcpServer({ cwd: f.world, environment: f.environment, version: "test" });
  const client = new Client({ name: "full-wait-and-changes", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  await client.listTools();
  const status = await client.callTool({ name: "status", arguments: { selector: f.worker.allocated.id } });
  assert.equal(status.isError, false);
  const projectedStatus = modelOutputSchemas.status.parse(status.structuredContent);
  assert.ok("changes" in projectedStatus);
  assert.deepEqual(projectedStatus.changes, [{ path: "source.ts", diffstat: { added: 2, removed: 1 } }]);
  const sequences = [];
  for (const text of ["first", "second", "same", "same", "last"]) {
    sequences.push(await appendActivity(paths, { turnSequence: turn.sequence, event: { type: "assistant", text }, at: AT }));
  }
  const input = { selectors: [f.worker.allocated.id, f.bound.contractId], completion: "all" as const, timeout: "0ms" };
  const running = await f.facet().wait(input);
  const argv = ["wait", ...input.selectors, "--all", "--timeout", "0ms"];
  const cli = await cliJson<InvocationWaitResult>(argv, { cwd: f.world, environment: f.environment });
  assert.deepEqual(cli.value, running);
  const member = running.members[0];
  assert.ok(member?.kind === "akuma" && member.observation.kind === "observed");
  assert.equal(member.observation.life, "running");
  assert.equal(member.observation.lastActivityAt, AT);
  assert.deepEqual(member.observation.events?.map(event => event.sequence), sequences.slice(-3));
  assert.deepEqual(member.observation.events?.map(event => event.kind === "said" ? event.text : event.kind), ["same", "same", "last"]);
  assert.equal(Object.hasOwn(member.observation, "provider"), false);
  assert.equal(Object.hasOwn(member.observation, "changes"), false);
  const text = await runCli(argv, { cwd: f.world, environment: f.environment });
  assert.equal(text.exit, 0);
  assert.equal((text.stdout.match(/same/gu) ?? []).length, 2);
  assert.ok(text.stdout.indexOf(f.worker.allocated.id) < text.stdout.indexOf(f.bound.contractId));
  const deadlineResponse = await client.callTool({ name: "wait", arguments: input });
  assert.equal(deadlineResponse.isError, false);
  assert.deepEqual(deadlineResponse.structuredContent, JSON.parse(JSON.stringify(projectModelOutput("wait", running))));
  assert.equal((deadlineResponse.content as { text: string }[])[0]?.text, text.stdout.trimEnd());

  const answer = `answer begins\n${"full answer ".repeat(1000)}\n  exact answer tail`;
  await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "answered", answer, session: { sessionId: "answer" } } });
  await f.finish();
  accepted(await f.bound.kei.abandon());
  const settled = await f.facet().wait(input);
  const response = await client.callTool({ name: "wait", arguments: input });
  assert.equal(response.isError, false);
  assert.deepEqual(response.structuredContent, JSON.parse(JSON.stringify(projectModelOutput("wait", settled))));
  const projected = modelOutputSchemas.wait.parse(response.structuredContent);
  const row = projected.members[0];
  assert.ok(row && "verdict" in row);
  assert.equal(row.verdict, "answered");
  assert.equal(row.turn, `turn/${turn.sequence}`);
  assert.equal(row.answer, answer);
  assert.equal(Object.hasOwn(row, "events"), false);
  const completedText = await runCli(["wait", f.worker.allocated.id, "--timeout", "0ms"], { cwd: f.world, environment: f.environment });
  assert.match(completedText.stdout, new RegExp(`turn/${turn.sequence}`, "u"));
  assert.ok(completedText.stdout.includes("exact answer tail"));
  assert.equal((completedText.stdout.match(/full answer/gu) ?? []).length, 1000);
});

test("deadline activity decoding failure preserves its member outcome and readable peers", async t => {
  const f = await fixture(t);
  const paths = f.worker.allocated.paths;
  const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  await appendActivity(paths, { turnSequence: turn.sequence, event: { type: "assistant", text: "activity" }, at: AT });
  await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "failed", diagnostic: "exact failure" } });
  const database = new DatabaseSync(paths.heart);
  try { database.prepare("UPDATE activity SET event_json = ?").run("{}"); }
  finally { database.close(); }
  const result = await f.facet().wait({ selectors: [f.worker.allocated.id, f.bound.contractId], completion: "all", timeout: "0ms" });
  assert.equal(result.reason, "deadline");
  const member = result.members[0];
  assert.ok(member?.kind === "akuma" && member.observation.kind === "observed");
  assert.equal(member.observation.outcome?.kind, "failed");
  assert.match(member.observation.eventsUnavailable ?? "", /Invalid/u);
  assert.ok(result.members[1]?.kind === "contract");
  assert.equal(result.members[1].observation.summary?.id, f.bound.contractId);
  assertWireConformance(Keiyaku.verbs.wait.normal, result);
});
