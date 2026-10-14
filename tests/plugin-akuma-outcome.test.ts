import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Square } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import test from "node:test";
import { Akuma, Akumas, Schema, World, type WorldRoot } from "../src/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { readAkumaTimeline } from "../src/akuma/akuma.js";
import { beginTurn, endTurn, finishBodyIfIdle, readTell } from "../src/akuma/heart/index.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { bodyRequestExecution } from "../src/akuma/requests.js";
import { selectionRequestCommands } from "../src/akuma/selection-request.js";
import { selectionRequestPort } from "../src/akuma/selection-owner-port.js";
import { akumasWithExecution } from "../src/library/akumas.js";
import { bornBody, bornDirectAkuma } from "./support/akuma-fixtures.js";
import { answering, bornWorld, fixtureRuntime, installTellRuntime, settleFixtureBodies } from "./support/akuma-tell.js";
import { restoreEnvironmentValues, temporaryDirectory } from "./support/process.js";

const AT = "2026-10-14T00:00:00.000Z";
type Signal = Readonly<{ kind: "akuma.outcome-observed"; akumaId: string; historyId: string; observer?: string }>;

function recordingPlugin(world: WorldRoot, fail = false) {
  const output = join(world, "observations.jsonl");
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(join(world, "plugins", "record.mjs"), `
    import { appendFileSync } from "node:fs";
    export default {
      manifest: { id: "record", apiVersion: 1 },
      activate(context) { return { signals: {
        "akuma.outcome-observed": (signal) => {
          appendFileSync(context.config.output, JSON.stringify(signal) + "\\n");
          ${fail ? 'throw new Error("observer deliberately failed");' : ""}
        }
      } }; }
    };
  `);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({
    plugins: { record: { package: "./plugins/record.mjs", config: { output } } },
  }));
  return {
    signals: (): Signal[] => existsSync(output)
      ? readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Signal)
      : [],
    reset: () => writeFileSync(output, ""),
  };
}

function signal(akumaId: string, sequence: number): Signal {
  return { kind: "akuma.outcome-observed", akumaId, historyId: `turn/${sequence}` };
}

async function outcome(value: Awaited<ReturnType<typeof bornBody>>, answer?: string) {
  const turn = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
  await endTurn(value.allocated.paths, {
    turnSequence: turn.sequence,
    completedAt: AT,
    outcome: answer === undefined ? { kind: "failed", diagnostic: "provider failed" }
      : { kind: "answered", answer, session: { sessionId: "fixture-session" } },
  });
  return turn;
}

async function finish(value: Awaited<ReturnType<typeof bornBody>>) {
  await finishBodyIfIdle(value.allocated.paths, { sequence: value.body.sequence, at: AT });
  value.holder.release();
}

test("public status observes committed identity, not idle or incidental internal reads", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-status-"));
  const recorded = recordingPlugin(world);
  const value = await bornBody(world, "0b500001", AT);
  t.after(() => value.holder.release());
  const empty = await bornBody(world, "0b500002", AT);
  await finish(empty);
  const answered = await outcome(value, "");
  const api = Akumas.of(world);
  await api.list();
  await readAkumaTimeline(world, value.allocated.id);
  await new AkumaOwner(value.allocated.id, world).history();
  await new AkumaOwner(value.allocated.id, world).lastAnswer();
  assert.deepEqual(recorded.signals(), [], "lifecycle production, roster and internal reads are not observers");
  assert.equal((await Akuma.select(world, empty.allocated.id).idle({ timeoutMs: 0 })).reason, "completed");
  await api.status({ akuma: empty.allocated.id });
  await api.history({ akuma: value.allocated.id, id: "turn/9999" });
  assert.deepEqual(recorded.signals(), [], "idle and missing history have no invented result");
  const observed = await api.status({ akuma: value.allocated.id });
  assert.equal(observed.status.life, "running");
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, answered.sequence)]);
  recorded.reset();
  const failed = await outcome(value);
  await Akuma.select(world, value.allocated.id).status();
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, failed.sequence)]);
  recorded.reset();
  await api.status({ akuma: value.allocated.id });
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, failed.sequence)],
    "a distinct operation may observe the same result again");
  recorded.reset();
  await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
  const open = await api.status({ akuma: value.allocated.id });
  assert.equal(open.status.timeline.kind, "open");
  assert.deepEqual(recorded.signals(), [], "a past outcome read to build an open view is not caller observation");
});

test("history page, exact and last use the identity of the actual retained result", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-history-"));
  const recorded = recordingPlugin(world);
  const value = await bornBody(world, "0b500003", AT);
  t.after(() => value.holder.release());
  const answered = await outcome(value, "answer before failure");
  const failed = await outcome(value);
  const api = Akumas.of(world);
  const last = await api.history({ akuma: value.allocated.id, last: true });
  assert.equal(last.kind, "last");
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, answered.sequence)], "last must not guess the newer failed Turn");
  recorded.reset();
  const exact = await api.history({ akuma: value.allocated.id, id: `turn/${failed.sequence}` });
  assert.equal(exact.kind, "exact");
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, failed.sequence)]);
  recorded.reset();
  await api.history({ akuma: value.allocated.id });
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, answered.sequence), signal(value.allocated.id, failed.sequence)]);
  recorded.reset();
  await Akuma.select(world, value.allocated.id).history();
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, answered.sequence), signal(value.allocated.id, failed.sequence)]);
});

test("live all-wait observes an outcome before completion and deduplicates repeated rounds", { timeout: 10_000 }, async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-wait-"));
  const recorded = recordingPlugin(world);
  const first = await bornBody(world, "0b500004", AT);
  const peer = await bornBody(world, "0b500005", AT);
  t.after(() => { first.holder.release(); peer.holder.release(); });
  const turn = await outcome(first, "already committed");
  await finish(first);
  let rounds = 0;
  let finishing: Promise<void> | undefined;
  const result = await Akumas.of(world).wait({
    akuma: [first.allocated.id, peer.allocated.id], completion: "all", signal: t.signal,
    observe: { observe: () => {
      rounds += 1;
      assert.deepEqual(recorded.signals(), [signal(first.allocated.id, turn.sequence)]);
      if (rounds === 3) finishing = finish(peer);
    } },
  });
  await finishing;
  assert.equal(result.reason, "completed");
  assert.ok(rounds >= 3, "the observed result did not terminate the all-wait");
  assert.deepEqual(recorded.signals(), [signal(first.allocated.id, turn.sequence)]);
  recorded.reset();
  await Akuma.select(world, first.allocated.id).idle({ timeoutMs: 0 });
  assert.deepEqual(recorded.signals(), [signal(first.allocated.id, turn.sequence)]);
});

test("forwarded wait and ask have exactly one serving observer", { timeout: 15_000 }, async (t) => {
  const root = temporaryDirectory(t, "keiyaku-outcome-forwarded-");
  const source = await bornWorld(root, "0b500006");
  const world = source.world;
  const recorded = recordingPlugin(world, true);
  const priorParticipant = process.env.SQUARE_PARTICIPANT_NAME;
  process.env.SQUARE_PARTICIPANT_NAME = "UnrelatedServingSession";
  t.after(() => {
    if (priorParticipant === undefined) delete process.env.SQUARE_PARTICIPANT_NAME;
    else process.env.SQUARE_PARTICIPANT_NAME = priorParticipant;
  });
  const diagnostics: string[] = [];
  const parent = await bornDirectAkuma({ root: world, archetype: "parent", draw: "0b500007", createdAt: AT });
  t.after(() => parent.leash.release());
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  const bodies: Promise<unknown>[] = [];
  const restore = installTellRuntime(fixtureRuntime(bodies, new Map([
    [source.allocated.paths.directory, { adapter: answering("forwarded answer"), now: AT }],
  ])));
  const pump = await BodyRequestPump.open({
    paths: parent.paths, allowed: parent.soul.allowed, bodySequence: body.sequence, now: () => AT,
    commands: selectionRequestCommands(selectionRequestPort(world, (message) => { diagnostics.push(message); })), signal: t.signal,
  });
  try {
    const api = akumasWithExecution(world, bodyRequestExecution({ directory: pump.directory }));
    const asked = await api.ask({ akuma: source.allocated.id, body: "work", signal: t.signal });
    assert.deepEqual(asked.observation, { reason: "answered", answer: "forwarded answer" });
    const tell = await readTell(source.allocated.paths, asked.tell.admission.tellId);
    assert.ok(tell?.binding);
    assert.deepEqual(recorded.signals(), [{ ...signal(source.allocated.id, tell.binding.turnSequence), observer: parent.soul.id }]);
    recorded.reset();
    const waited = await api.wait({ akuma: [source.allocated.id], timeoutMs: 5_000 });
    assert.equal(waited.reason, "completed");
    assert.deepEqual(recorded.signals(), [{ ...signal(source.allocated.id, tell.binding.turnSequence), observer: parent.soul.id }]);
    assert.equal(diagnostics.filter((message) => message.includes("observer deliberately failed")).length, 2,
      "the serving operation owns diagnostics for ask and wait, without submitting-side delivery");
  } finally {
    restore();
    await settleFixtureBodies(bodies);
    await pump.close();
  }
});

test("forwarded wait acknowledges real Square notice for the requesting Soul, not the serving session", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-square-forwarded-"));
  const prior = { SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT };
  process.env.SQUARE_PARTICIPANT_NAME = "ServingSession";
  process.env.SQUARE_HOST_LEDGER_ROOT = join(world, "ledger");
  t.after(() => restoreEnvironmentValues(prior));
  const target = await bornBody(world, "0b500009", AT);
  t.after(() => target.holder.release());
  const turn = await outcome(target, "known answer");
  await finish(target);
  const parent = await bornDirectAkuma({ root: world, archetype: "parent", draw: "0b500010", createdAt: AT });
  t.after(() => parent.leash.release());
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  const path = join(world, ".square", "KEIYAKU.square");
  mkdirSync(join(world, ".square"), { recursive: true });
  const square = await Square.build({ path, markdown: "", env: {} });
  t.after(() => square.close());
  await square.join(parent.soul.id);
  await square.join("ServingSession");
  const observer = await squarePlugin.activate({ world, config: undefined, writablePath: () => join(world, ".square") });
  await observer.signals?.["akuma.turn-outcome"]?.({
    kind: "akuma.turn-outcome", akumaId: target.allocated.id, bodySequence: target.body.sequence,
    turnSequence: turn.sequence, participants: [parent.soul.id, "ServingSession"], outcome: { kind: "answered", text: "known answer" },
  });
  const notice = (await square.history({ from: [target.allocated.id] })).find((item) => item.kind === "say")!;
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(join(world, "plugins", "square.mjs"),
    `export { default } from ${JSON.stringify(new URL("../plugins/square/index.js", import.meta.url).href)};`);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { package: "./plugins/square.mjs" } } }));
  const diagnostics: string[] = [];
  const pump = await BodyRequestPump.open({
    paths: parent.paths, allowed: parent.soul.allowed, bodySequence: body.sequence, now: () => AT, signal: t.signal,
    commands: selectionRequestCommands(selectionRequestPort(world, (message) => diagnostics.push(message))),
  });
  try {
    const waited = await akumasWithExecution(world, bodyRequestExecution({ directory: pump.directory }))
      .wait({ akuma: [target.allocated.id], timeoutMs: 5_000, signal: t.signal });
    assert.equal(waited.reason, "completed");
    const snapshot = await square.snapshot();
    assert.equal(snapshot.delivered(parent.soul.id, notice.id), true);
    assert.equal(snapshot.delivered("ServingSession", notice.id), false);
    assert.deepEqual(diagnostics, []);
  } finally { await pump.close(); }
});

test("ask retains the observed outcome through schema and plugin failure", { timeout: 15_000 }, async (t) => {
  const source = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-ask-"), "0b500008");
  const recorded = recordingPlugin(source.world, true);
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (message: string) => { diagnostics.push(message); });
  const bodies: Promise<unknown>[] = [];
  const restore = installTellRuntime(fixtureRuntime(bodies, new Map([
    [source.allocated.paths.directory, { adapter: answering('{"ok":true}'), now: AT }],
  ])));
  try {
    const schema = Schema.json({ type: "object" }, () => { throw new Error("decode refused"); });
    const result = await Akuma.select(source.world, source.allocated.id).ask("work", { schema, signal: t.signal });
    assert.equal(result.observation.reason, "invalid-output");
    const tell = await readTell(source.allocated.paths, result.tell.admission.tellId);
    assert.ok(tell?.binding);
    assert.deepEqual(recorded.signals(), [signal(source.allocated.id, tell.binding.turnSequence)]);
    assert.ok(diagnostics.some((message) => message.includes("observer deliberately failed")));
  } finally {
    restore();
    await settleFixtureBodies(bodies);
  }
});
