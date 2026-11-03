import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DeliveryLedger, Square, harnessOwner, type Participant } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import type { WorldRoot } from "../src/world.js";
import { deferred, restoreEnvironmentValues } from "./support/process.js";

const identityNames = ["PI_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "OPENCODE_SESSION_ID", "PASEO_AGENT_ID", "SQUARE_PARTICIPANT_NAME", "SQUARE_DELIVERY", "SQUARE_INDEX"] as const;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-k2-"));
  const prior = Object.fromEntries(identityNames.map((name) => [name, process.env[name]]));
  for (const name of identityNames) delete process.env[name];
  process.env.PI_SESSION_ID = "requester";
  process.env.SQUARE_PARTICIPANT_NAME = "Alice";
  process.env.SQUARE_DELIVERY = join(root, "delivery.sqlite");
  process.env.SQUARE_INDEX = join(root, "index.ndjsonl");
  mkdirSync(join(root, ".square"), { recursive: true });
  const path = join(root, ".square", "KEIYAKU.square");
  const aliceOwner = harnessOwner({ channel: "pi", session: "requester" });
  const bobOwner = harnessOwner({ channel: "pi", session: "peer" });
  const square = await Square.build({ path, markdown: "", env: { ...process.env } });
  await square.join("Alice", { owner: aliceOwner });
  await square.join("Bob", { owner: bobOwner });
  const plugin = await squarePlugin.activate({ world: root as WorldRoot, config: undefined, writablePath: () => join(root, ".square") });
  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
  t.after(async () => {
    await ledger.close();
    await square.close();
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  });
  async function cards(owner: typeof aliceOwner) {
    const session = await ledger.session(owner);
    assert.ok(session);
    return await ledger.pending(owner, { generation: session.generation });
  }
  async function turn(id: string, sequence: number, recipients = ["Alice"], tellIds?: readonly string[]) {
    await plugin.signals!["akuma.turn-outcome"]!({ kind: "akuma.turn-outcome", akumaId: id,
      bodySequence: 1, turnSequence: sequence, participants: recipients,
      ...(tellIds === undefined ? {} : { tellIds }), outcome: { kind: "answered", text: `answer ${id} ${sequence}` } });
  }
  async function observe(id: string, sequence: number) {
    await plugin.signals!["akuma.outcome-observed"]!({ kind: "akuma.outcome-observed", akumaId: id, historyId: `turn/${sequence}` });
  }
  function notices() {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare(`SELECT n.notice_index, n.body_json, n.metadata_json, a.recipient_json, a.consumed_at
        FROM square_notices n JOIN notice_audience a ON a.notice_index = n.notice_index
        ORDER BY n.notice_index, a.recipient_json`).all() as { notice_index: number; body_json: string; metadata_json: string | null; recipient_json: string; consumed_at: number | null }[];
    } finally { db.close(); }
  }
  return { root, path, square, plugin, ledger, aliceOwner, bobOwner, cards, turn, observe, notices };
}

const hasText = (cards: readonly { text: string }[], text: string) => cards.some((card) => card.text.includes(text));

test("partial acquisition releases late custody when another lease fails", async (t) => {
  const f = await fixture(t);
  const seat = await f.square.participant("Alice", { owner: f.aliceOwner });
  const prototype = Object.getPrototypeOf(seat) as Participant;
  const defer = prototype.deferDelivery;
  const release = prototype.releaseDeliveryDeferral;
  const late = deferred<void>();
  const failed = deferred<void>();
  const released: string[] = [];
  let allocated: string | undefined;
  let count = 0;
  t.mock.method(prototype, "deferDelivery", async function (this: Participant, ...args: Parameters<Participant["deferDelivery"]>) {
    if (++count === 2) { failed.resolve(); throw new Error("acquisition failed"); }
    await late.promise;
    const lease = await defer.apply(this, args);
    allocated = lease.id;
    return lease;
  });
  t.mock.method(prototype, "releaseDeliveryDeferral", async function (this: Participant, ...args: Parameters<Participant["releaseDeliveryDeferral"]>) {
    assert.equal(await release.apply(this, args), true);
    released.push(args[0]);
    return true;
  });
  const result = assert.rejects(Promise.resolve(f.plugin.waitDeferral!({ akumaIds: ["aku/one", "aku/two"] })), /acquisition failed/u);
  await failed.promise;
  late.resolve();
  await result;
  assert.ok(allocated);
  assert.deepEqual(released, [allocated]);
  assert.equal(await release.call(seat, allocated), false, "the actual late lease was removed");
});

test("lost renewal remains visible and close releases only its own leases", async (t) => {
  const f = await fixture(t);
  const seat = await f.square.participant("Alice", { owner: f.aliceOwner });
  const prototype = Object.getPrototypeOf(seat) as Participant;
  const defer = prototype.deferDelivery;
  const renew = prototype.renewDeliveryDeferral;
  const release = prototype.releaseDeliveryDeferral;
  const allocated: string[] = [];
  const renewed: string[] = [];
  const released: string[] = [];
  const firstBatch = deferred<void>();
  const secondBatch = deferred<void>();
  t.mock.method(prototype, "deferDelivery", async function (this: Participant, ...args: Parameters<Participant["deferDelivery"]>) {
    const lease = await defer.apply(this, args);
    allocated.push(lease.id);
    return lease;
  });
  t.mock.method(prototype, "renewDeliveryDeferral", async function (this: Participant, ...args: Parameters<Participant["renewDeliveryDeferral"]>) {
    renewed.push(args[0]);
    if (args[0] === allocated[0]) {
      assert.equal(await release.call(this, args[0]), true);
      return null;
    }
    const result = await renew.apply(this, args);
    if (renewed.length === 2) firstBatch.resolve();
    if (renewed.length === 3) secondBatch.resolve();
    return result;
  });
  t.mock.method(prototype, "releaseDeliveryDeferral", async function (this: Participant, ...args: Parameters<Participant["releaseDeliveryDeferral"]>) {
    const result = await release.apply(this, args);
    released.push(args[0]);
    return result;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/one", "aku/two"] });
  assert.ok(scope);
  t.mock.timers.tick(120_000);
  await firstBatch.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(120_000);
  await secondBatch.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(renewed, [allocated[0], allocated[1], allocated[1]]);
  await assert.rejects(Promise.resolve(scope.close()), /expired before renewal/u);
  assert.deepEqual(released.sort(), [...allocated].sort());
  assert.equal(await release.call(seat, allocated[1]!), false, "cleanup removed the still-live lease");
});

test("initiating joins and reconnects its own voice silently without reviving or taking over", async (t) => {
  const f = await fixture(t);
  const initiating = f.plugin.signals!["akuma.initiating"]!;
  await initiating({ kind: "akuma.initiating", initiator: "Carol" });
  const initial = (await f.square.seatsOf(f.aliceOwner)).find(seat => seat.name === "Carol");
  assert.ok(initial);
  await initiating({ kind: "akuma.initiating", initiator: "Carol" });
  const session = await f.ledger.session(f.aliceOwner);
  assert.ok(session);
  await f.ledger.detach({ owner: f.aliceOwner, generation: session.generation });
  await f.square.join("Bob", { owner: f.bobOwner });
  assert.deepEqual(await f.square.seatsOf(f.aliceOwner), []);
  assert.ok(await f.ledger.attach({ owner: f.aliceOwner, expectedGeneration: session.generation, routes: [] }));
  await initiating({ kind: "akuma.initiating", initiator: "Carol" });
  assert.equal((await f.square.seatsOf(f.aliceOwner)).find(seat => seat.name === "Carol")?.name, initial.name);
  await (await f.square.participant("Carol", { owner: f.aliceOwner })).done();
  await initiating({ kind: "akuma.initiating", initiator: "Carol" });
  assert.equal((await f.square.seatsOf(f.aliceOwner)).some(seat => seat.name === "Carol"), false);
  await assert.rejects(Promise.resolve(initiating({ kind: "akuma.initiating", initiator: "Bob" })), { code: "already_joined" });
  assert.equal((await f.square.seatsOf(f.bobOwner)).some(seat => seat.name === "Bob"), true);
  assert.deepEqual(f.notices(), []);
});

test("canceled send before source insertion cannot land or suppress its Body ending", async (t) => {
  const f = await fixture(t);
  const prototype = Object.getPrototypeOf(f.square) as Square;
  const send = prototype.send;
  const entered = deferred<void>();
  const released = deferred<void>();
  const controller = new AbortController();
  t.mock.method(prototype, "send", async function(this: Square, ...args: Parameters<Square["send"]>) {
    if (args[0].metadata !== undefined) { entered.resolve(); await released.promise; }
    return await send.apply(this, args);
  });
  const canceled = Promise.resolve(f.plugin.signals!["akuma.turn-outcome"]!({
    kind: "akuma.turn-outcome", akumaId: "aku/canceled-send", bodySequence: 1, turnSequence: 1,
    participants: ["Alice"], outcome: { kind: "failed", reason: "not inserted" },
  }, controller.signal));
  const reason = new Error("send canceled");
  const rejection = assert.rejects(canceled, error => error === reason);
  try {
    await entered.promise;
    controller.abort(reason);
    released.resolve();
    await rejection;
    await f.plugin.signals!["akuma.body-ended"]!({
      kind: "akuma.body-ended", akumaId: "aku/canceled-send", bodySequence: 1,
      end: "hung", participants: ["Alice"],
    });
    assert.equal(f.notices().length, 1);
    assert.match(JSON.parse(f.notices()[0]!.body_json), /interrupted/u);
  } finally { released.resolve(); }
});

test("notifier has no seat; absent audience stays silent and outcome bodies preserve full results", async (t) => {
  const f = await fixture(t);
  await f.plugin.signals!["akuma.born"]?.({ kind: "akuma.born", akumaId: "aku/forms", bodySequence: 1,
    origin: { kind: "direct" }, caller: { kind: "unknown" }, initiator: "Alice" });
  await f.plugin.signals!["akuma.turn-outcome"]!({ kind: "akuma.turn-outcome", akumaId: "aku/forms", bodySequence: 1,
    turnSequence: 9, outcome: { kind: "answered", text: "silent" } });
  assert.equal(f.notices().length, 0);
  const answer = "full answer\n".repeat(100);
  for (const [turnSequence, outcome] of [
    [1, { kind: "answered", text: answer }], [2, { kind: "failed", reason: "failure detail" }], [3, { kind: "canceled" }],
  ] as const) {
    await f.plugin.signals!["akuma.turn-outcome"]!({ kind: "akuma.turn-outcome", akumaId: "aku/forms", bodySequence: 1,
      turnSequence, participants: ["Alice"], outcome });
  }
  const rows = f.notices();
  assert.equal(rows.length, 3);
  assert.ok(JSON.parse(rows[0]!.body_json).includes(answer));
  assert.ok(JSON.parse(rows[1]!.body_json).includes("failure detail"));
  assert.ok(JSON.parse(rows[2]!.body_json).includes("canceled"));
  assert.deepEqual(rows.map(row => JSON.parse(row.metadata_json!).keiyaku.historyId), ["turn/1", "turn/2", "turn/3"]);
  assert.equal((await f.square.participants()).participants.some(person => person.name === "keiyaku-notice"), false);
});

test("abnormal Body notices suppress only notified Turn recipients for the same Body", async (t) => {
  const f = await fixture(t);
  await f.plugin.signals!["akuma.turn-outcome"]!({ kind: "akuma.turn-outcome", akumaId: "aku/body", bodySequence: 1,
    turnSequence: 1, participants: ["Alice"], outcome: { kind: "failed", reason: "failed" } });
  for (const bodySequence of [1, 2]) {
    await f.plugin.signals!["akuma.body-ended"]!({ kind: "akuma.body-ended", akumaId: "aku/body", bodySequence,
      end: "hung", participants: ["Alice", "Bob"] });
  }
  const bodyRows = f.notices().filter(row => JSON.parse(row.body_json).includes("interrupted"));
  assert.deepEqual(bodyRows.map(row => JSON.parse(row.recipient_json)), ["Bob", "Alice", "Bob"]);
  assert.ok(JSON.parse(bodyRows[0]!.body_json).includes("body/1"));
  assert.ok(JSON.parse(bodyRows[1]!.body_json).includes("body/2"));
});

test("early exact observation survives restart; recipient, other Turn, and report remain independent", async (t) => {
  const f = await fixture(t);
  await f.observe("aku/early", 1);
  // Close and reopen producer custody before the delayed notice is inserted.
  const later = Date.now() + 365 * 24 * 60 * 60_000;
  t.mock.method(Date, "now", () => later);
  const reopened = await Square.at({ path: f.path, env: { ...process.env } });
  await reopened.close();
  await f.turn("aku/early", 1, ["Alice", "Bob"]);
  await f.turn("aku/early", 2);
  await f.plugin.signals!["akuma.reported"]!({ kind: "akuma.reported", akumaId: "aku/early", bodySequence: 1,
    turnSequence: 1, reportSequence: 1, text: "progress", at: "2026-10-30T00:00:00.000Z", initiator: "Alice" });
  const rows = f.notices();
  const first = rows.filter((row) => JSON.parse(row.metadata_json!).keiyaku.historyId === "turn/1");
  assert.equal(first.length, 2);
  assert.ok(first.find((row) => JSON.parse(row.recipient_json) === "Alice")?.consumed_at);
  assert.equal(first.find((row) => JSON.parse(row.recipient_json) === "Bob")?.consumed_at, null);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/early 1"), false);
  assert.equal(hasText(await f.cards(f.bobOwner), "answer aku/early 1"), true);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/early 2"), true);
  assert.equal(hasText(await f.cards(f.aliceOwner), "progress"), true);
  assert.equal((await f.square.history({ limit: null })).activities.some((item) => item.actor === "keiyaku-notice"), false);
});

test("overlapping Akuma and initial-Tell leases hold independently without becoming result identity", async (t) => {
  const f = await fixture(t);
  const first = await f.plugin.waitDeferral!({ akumaIds: ["aku/scoped"] });
  const identical = await f.plugin.waitDeferral!({ akumaIds: ["aku/scoped"] });
  const second = await f.plugin.waitDeferral!({ akumaIds: [], initialTellId: "tell-uuid" });
  assert.ok(first && identical && second);
  try {
    await f.turn("aku/scoped", 1, ["Alice", "Bob"], ["tell-uuid", "other-steer"]);
    await f.turn("aku/other", 1, ["Alice"], ["other-uuid"]);
    let rows = f.notices();
    assert.deepEqual(JSON.parse(rows[0]!.metadata_json!).keiyaku.tellIds, { "tell-uuid": true, "other-steer": true });
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/scoped 1"), false);
    assert.equal(hasText(await f.cards(f.bobOwner), "answer aku/scoped 1"), true);
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/other 1"), true);
    await first.close();
    // A new privileged producer operation scans unconsumed notices.
    await f.turn("aku/unrelated", 1);
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/scoped 1"), false);
    await second.close();
    await f.turn("aku/still-held", 1);
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/scoped 1"), false, "the identical scope still holds it");
    await identical.close();
    await f.turn("aku/trigger", 1);
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/scoped 1"), true);
    rows = f.notices();
    assert.equal(new Set(rows.filter((row) => JSON.parse(row.metadata_json!).keiyaku.akumaId === "aku/scoped")
      .map((row) => row.notice_index)).size, 1);
  } finally { await first.close(); await identical.close(); await second.close(); }
});

test("an expired unobserved scope permits later posting", async (t) => {
  const f = await fixture(t);
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/expires"] });
  assert.ok(scope);
  try {
    await f.turn("aku/expires", 1);
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/expires 1"), false);
    const later = Date.now() + 6 * 60_000;
    t.mock.method(Date, "now", () => later);
    await f.turn("aku/trigger-expiry", 1);
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/expires 1"), true);
  } finally { await scope.close(); }
});

test("foreign and stale seats cannot consume another owner's exact outcome", async (t) => {
  const f = await fixture(t);
  const stale = await f.square.participant("Alice", { owner: f.aliceOwner });
  const prior = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "foreign";
  const foreign = await squarePlugin.activate({ world: f.root as WorldRoot, config: undefined, writablePath: () => join(f.root, ".square") });
  restoreEnvironmentValues({ PI_SESSION_ID: prior });
  assert.equal(await foreign.waitDeferral!({ akumaIds: ["aku/foreign"] }), undefined);
  await foreign.signals!["akuma.outcome-observed"]!({ kind: "akuma.outcome-observed", akumaId: "aku/foreign", historyId: "turn/1" });
  await f.turn("aku/foreign", 1);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/foreign 1"), true);
  await f.square.join("Alice", { owner: f.bobOwner, takeover: true });
  await assert.rejects(stale.ack({ from: "keiyaku-notice", future: "exact", match: { fields: [
    { path: ["keiyaku", "kind"], equals: "akuma.turn-outcome" },
    { path: ["keiyaku", "akumaId"], equals: "aku/stale" },
    { path: ["keiyaku", "historyId"], equals: "turn/1" },
  ] } }));
  await f.turn("aku/stale", 1);
  assert.equal(hasText(await f.cards(f.bobOwner), "answer aku/stale 1"), true);
});

test("requester uses World custody even when its ledger path is inaccessible", async (t) => {
  const f = await fixture(t);
  const original = process.env.SQUARE_DELIVERY;
  process.env.SQUARE_DELIVERY = join(f.root, "missing-ledger-parent", "delivery.sqlite");
  // A file in the parent position makes ledger creation impossible, including as root.
  writeFileSync(join(f.root, "missing-ledger-parent"), "not a directory");
  const sandbox = await squarePlugin.activate({ world: f.root as WorldRoot, config: undefined, writablePath: () => join(f.root, ".square") });
  restoreEnvironmentValues({ SQUARE_DELIVERY: original });
  const scope = await sandbox.waitDeferral!({ akumaIds: ["aku/world-only"] });
  assert.ok(scope);
  try {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { Square } from "@astrosheep/square";
      const square = await Square.at({ path: process.env.TEST_SQUARE });
      try { await square.send({ from: "keiyaku-notice", to: "Alice", body: "answer aku/world-only 1",
        metadata: { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/world-only", historyId: "turn/1" } } }); }
      finally { await square.close(); }
    `], { env: { ...process.env, TEST_SQUARE: f.path } });
    assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/world-only 1"), false);
    await sandbox.signals!["akuma.outcome-observed"]!({ kind: "akuma.outcome-observed", akumaId: "aku/world-only", historyId: "turn/1" });
  } finally { await scope.close(); }
  await f.turn("aku/trigger", 1);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/world-only 1"), false);
  assert.ok(f.notices().find(row => JSON.parse(row.metadata_json!).keiyaku.akumaId === "aku/world-only")?.consumed_at);
});

test("locally detached or departed seats cannot acquire or acknowledge", async (t) => {
  const f = await fixture(t);
  const session = await f.ledger.session(f.aliceOwner);
  assert.ok(session);
  await f.square.send({ from: "System", to: "Bob", body: "initial notice" });
  const original = process.env.SQUARE_DELIVERY;
  writeFileSync(join(f.root, "blocked-ledger"), "not a directory");
  process.env.SQUARE_DELIVERY = join(f.root, "blocked-ledger", "delivery.sqlite");
  const sandbox = await squarePlugin.activate({ world: f.root as WorldRoot, config: undefined, writablePath: () => join(f.root, ".square") });
  restoreEnvironmentValues({ SQUARE_DELIVERY: original });
  await f.ledger.detach({ owner: f.aliceOwner, generation: session.generation });
  const captured = await sandbox.waitDeferral!({ akumaIds: ["aku/before-reconcile"] });
  assert.ok(captured, "ledger-only detach is not yet known to World custody");
  await sandbox.signals!["akuma.outcome-observed"]!({ kind: "akuma.outcome-observed", akumaId: "aku/before-reconcile", historyId: "turn/1" });
  const detached = await f.square.send({ from: "System", to: "Bob", body: "reconcile detached seat" });
  assert.match(detached.id, /^notice\/[1-9]\d*$/u);
  assert.equal(await sandbox.waitDeferral!({ akumaIds: ["aku/detached"] }), undefined);
  await sandbox.signals!["akuma.outcome-observed"]!({ kind: "akuma.outcome-observed", akumaId: "aku/detached", historyId: "turn/1" });
  await assert.rejects(Promise.resolve(captured.close()));
  assert.ok(await f.ledger.attach({ owner: f.aliceOwner, expectedGeneration: session.generation, routes: [] }));
  const reattached = await f.square.send({ from: "System", to: "Bob", body: "reconcile reattached seat" });
  assert.match(reattached.id, /^notice\/[1-9]\d*$/u);
  assert.notEqual(detached.id, reattached.id);
  await f.turn("aku/before-reconcile", 1);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/before-reconcile 1"), false);
  const restored = await f.square.participant("Alice", { owner: f.aliceOwner });
  await f.turn("aku/detached", 1);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/detached 1"), true);
  await restored.done();
  assert.equal(await f.plugin.waitDeferral!({ akumaIds: ["aku/departed"] }), undefined);
  await f.observe("aku/departed", 1);
  assert.equal(f.notices().filter(row => row.metadata_json !== null && JSON.parse(row.metadata_json).keiyaku?.akumaId === "aku/departed").length, 0);
});

test("post-acquisition ACK cannot recall captured export; pre-acquisition deferral prevents it", async (t) => {
  const f = await fixture(t);
  const scope = await f.plugin.waitDeferral!({ akumaIds: ["aku/held"] });
  assert.ok(scope);
  await f.turn("aku/held", 1);
  await f.observe("aku/held", 1);
  await scope.close();
  await f.turn("aku/trigger", 1);
  assert.equal(hasText(await f.cards(f.aliceOwner), "answer aku/held 1"), false);
  const { promise: entered, resolve: markEntered } = deferred<void>();
  const { promise: released, resolve: release } = deferred<void>();
  const originalPost = DeliveryLedger.prototype.post;
  let posted: string | undefined;
  const interception = t.mock.method(DeliveryLedger.prototype, "post", async function (this: DeliveryLedger, input: Parameters<DeliveryLedger["post"]>[0]) {
    if (input.text.includes("answer aku/race 1")) {
      markEntered();
      await released;
      const result = await originalPost.call(this, input);
      posted = result.status;
      return result;
    }
    return await originalPost.call(this, input);
  });
  try {
    const sending = f.turn("aku/race", 1);
    await entered;
    await f.observe("aku/race", 1);
    release();
    await sending;
    assert.equal(posted, "posted", "the ledger call already owned by the producer may still land");
  } finally { release(); interception.mock.restore(); }
});
