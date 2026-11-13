import { deferred as promiseBarrier } from "./support/process.js";
import { debtDocument } from "./support/debt.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DebtAuthorityCorruptionError,
  Debts,
  type DebtId,
} from "../src/debt/index.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { parseDebtDocument, serializeDebtDocument, type DebtDocument } from "../src/debt/document.js";
import { settleDebt } from "../src/debt/operations.js";
import { Keiyaku } from "../src/library/keiyaku.js";
import { nukeDebtAuthority, replaceAuthority, withDebtLocks } from "../src/debt/store.js";
import { debtAuthorityFile } from "./support/debt.js";
import { World, type WorldRoot } from "../src/world.js";
import { runCli, cliJson } from "./support/cli-fixtures.js";

async function world(): Promise<{ root: WorldRoot; debts: ReturnType<typeof Debts.of> }> {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-debts-"));
  mkdirSync(join(root, ".keiyaku"));
  const worldRoot = await World.at(root);
  return {
    root: worldRoot,
    debts: Debts.of(worldRoot),
  };
}

function acceptedId(result: Awaited<ReturnType<ReturnType<typeof Debts.of>["add"]>>): DebtId {
  assert.ok(result.kind === "accepted", 'expected result.kind = "accepted"');
  return result.id;
}

async function readDetail(debts: ReturnType<typeof Debts.of>, id: DebtId) {
  const read = await debts.debt({ id }).read();
  assert.equal(read.kind, "present");
  if (read.kind !== "present") throw new Error("missing Debt detail");
  return read;
}

test("a pre-aborted Debt CLI mutation leaves authority unchanged", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Cancellation fixture" }));
  assert.equal((await debts.debt({ id }).update({ note: "original" })).kind, "accepted");
  const path = debtAuthorityFile(root, id);
  const before = readFileSync(path, "utf8");
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled Debt mutation"));
  const read = await runCli(["-C", root, "show", id, "--json"], {
    environment: {},
    signal: controller.signal,
  });
  assert.equal(read.exit, 0, read.stderr);
  const shown = JSON.parse(read.stdout) as {
    kind: "debt-complete";
    items: readonly { kind: "found"; title: string }[];
  };
  assert.equal(shown.kind, "debt-complete");
  assert.equal(shown.items[0]?.kind, "found");
  assert.equal(shown.items[0]?.title, "Cancellation fixture");
  const result = await runCli(["-C", root, "debt", "update", id, "--note", "changed"], {
    environment: {},
    signal: controller.signal,
  });
  assert.notEqual(result.exit, 0);
  assert.match(result.stdout + result.stderr, /caller cancelled Debt mutation/u);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("note is replaceable authority and product timestamps advance only on change", async () => {
  const { debts } = await world();
  const added = await debts.add({ title: "Timestamped" });
  assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
  const initial = await readDetail(debts, added.id);
  assert.equal(initial.note, undefined);
  assert.equal(initial.createdAt, initial.updatedAt);
  assert.equal(new Date(initial.createdAt).toISOString(), initial.createdAt);
  assert.deepEqual(await debts.debt({ id: added.id }).update({ note: "first" }), {
    kind: "accepted", changes: ["note"],
  });
  const created = await readDetail(debts, added.id);
  assert.equal(created.note, "first");
  assert.equal(created.createdAt, initial.createdAt);
  assert.ok(created.updatedAt > initial.updatedAt);

  const replaced = await debts.debt({ id: added.id }).update({ note: "second" });
  assert.ok(replaced.kind === "accepted", 'expected replaced.kind = "accepted"');
  const updated = await readDetail(debts, added.id);
  assert.equal(updated.note, "second");
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt);
  assert.deepEqual(replaced.changes, ["note"]);

  const unchanged = await debts.debt({ id: added.id }).update({ note: "second" });
  assert.ok(unchanged.kind === "accepted", 'expected unchanged.kind = "accepted"');
  assert.equal(unchanged.changes, undefined, "an empty change list is omitted");
  assert.equal((await readDetail(debts, added.id)).updatedAt, updated.updatedAt);
});

test("ordinary mutations advance a non-later timestamp by one millisecond", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Future timestamp" }));
  const before = parseDebtDocument(readFileSync(debtAuthorityFile(root, id)), id);
  const future = "2099-01-01T00:00:00.000Z";
  writeFileSync(debtAuthorityFile(root, id), serializeDebtDocument({ ...before, updatedAt: future }));

  const updated = await debts.debt({ id }).update({ note: "changed" });
  assert.equal(updated.kind, "accepted");
  assert.equal((await readDetail(debts, id)).updatedAt, "2099-01-01T00:00:00.001Z");
});

test("fields and every lifecycle transition publish together once while same state preserves authority", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Atomic update" }));
  assert.equal((await debts.debt({ id }).update({ note: "old" })).kind, "accepted");
  const path = debtAuthorityFile(root, id);
  const before = await readDetail(debts, id);
  // Ordinary manual YAML spelling remains authoritative even on a no-op.
  const manual = readFileSync(path, "utf8").replace("title: Atomic update", 'title: "Atomic update"');
  writeFileSync(path, manual);
  const published: DebtDocument[] = [];
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    if (String(args[1]) === path) published.push(parseDebtDocument(readFileSync(args[0]), id));
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    const original = readFileSync(path);
    assert.deepEqual(await debts.debt({ id }).update({ state: "open" }), { kind: "accepted" });
    assert.deepEqual(readFileSync(path), original);
    assert.equal(published.length, 0);
    assert.deepEqual(await debts.debt({ id }).update({ title: "Finished", note: "complete", state: "done" }), {
      kind: "accepted", changes: ["title", "note", "state"],
    });
    const after = await readDetail(debts, id);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.title, "Finished");
    assert.equal(published[0]?.note, "complete");
    assert.equal(published[0]?.state, "done");
    assert.equal(after.createdAt, before.createdAt);
    assert.ok(after.updatedAt > before.updatedAt);
    const bytes = readFileSync(path, "utf8").replace("title: Finished", 'title: "Finished"');
    writeFileSync(path, bytes);
    assert.deepEqual(await debts.debt({ id }).update({ state: "done" }), { kind: "accepted" });
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(published.length, 1);
    assert.deepEqual(await debts.debt({ id }).update({ note: "later testimony", state: "done" }), {
      kind: "accepted", changes: ["note"],
    });
    assert.equal((await readDetail(debts, id)).state, "done");
    assert.equal((await readDetail(debts, id)).note, "later testimony");
    assert.deepEqual(await debts.debt({ id }).update({ title: "Edited after completion" }), {
      kind: "accepted", changes: ["title"],
    });
    assert.equal((await readDetail(debts, id)).state, "done");
    for (const state of ["open", "drop", "open", "done", "drop"] as const) {
      assert.deepEqual(await debts.debt({ id }).update({ state }), { kind: "accepted", changes: ["state"] });
      assert.equal((await readDetail(debts, id)).state, state);
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("invalid needs rejects the complete update including reopen", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Unresolved" }));
  assert.deepEqual(
    await debts.debt({ id }).update({ title: "Done", body: "done body", note: "done note", state: "done" }),
    { kind: "accepted", changes: ["title", "body", "note", "state"] },
  );
  const path = debtAuthorityFile(root, id);
  const original = readFileSync(path);
  const invalid = await debts.debt({ id }).update({
    title: "Lost",
    body: "lost body",
    note: "lost note",
    state: "open",
    needs: ["debt/missing"],
  });
  assert.equal(invalid.kind, "refused");
  if (invalid.kind === "refused") {
    assert.equal(invalid.reason, "invalid-graph");
    assert.match(invalid.diagnostic, /needs target does not exist: debt\/missing/u);
  }
  assert.deepEqual(readFileSync(path), original);
  const self = await debts.debt({ id }).update({ state: "open", needs: [id] });
  assert.equal(self.kind, "refused");
  if (self.kind === "refused") assert.equal(self.reason, "invalid-graph");
  assert.deepEqual(readFileSync(path), original);

  const target = acceptedId(await debts.add({ title: "Existing target" }));
  assert.throws(() => debts.debt({ id }).update({ needs: [target, target] }), /must not contain duplicates/u);
  assert.deepEqual(await debts.debt({ id }).update({
    title: "Reopened",
    body: "",
    note: "",
    state: "open",
    needs: [target],
  }), { kind: "accepted", changes: ["title", "body", "note", "state", "needs"] });
  const reopened = await readDetail(debts, id);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.body, undefined);
  assert.equal(reopened.note, undefined);
  assert.deepEqual(reopened.needs, [{ id: target, state: "open" }]);
});

test("CLI update changes facts and state atomically through the addressed owner", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "CLI lifecycle" }));
  const updated = await cliJson(["-C", root, "debt", "update", id, "--state", "done", "--note", "finished"], {
    environment: {},
  });
  assert.equal(updated.exit, 0, updated.stderr);
  assert.deepEqual(updated.value, { kind: "accepted", changes: ["note", "state"] });
  const after = await readDetail(debts, id);
  assert.equal(after.state, "done");
  assert.equal(after.note, "finished");
  const reopened = await cliJson(["-C", root, "debt", "update", id, "--state", "drop", "--note", "lost"], {
    environment: {},
  });
  assert.equal(reopened.exit, 0, reopened.stderr);
  assert.deepEqual(reopened.value, { kind: "accepted", changes: ["note", "state"] });
  assert.equal((await readDetail(debts, id)).state, "drop");
  const path = debtAuthorityFile(root, id);
  const bytes = readFileSync(path);
  const refused = await cliJson(
    ["-C", root, "debt", "update", id, "--state", "open", "--needs", "debt/missing", "--note", "lost"],
    { environment: {} },
  );
  assert.equal(refused.exit, 1, refused.stderr);
  const refusal = refused.value as { kind: string; reason: string; diagnostic: string };
  assert.equal(refusal.kind, "refused");
  assert.equal(refusal.reason, "invalid-graph");
  assert.match(refusal.diagnostic, /does not exist/u);
  assert.deepEqual(readFileSync(path), bytes);
});

test("CLI replaces prerequisites and clears body, note and empty body stdin", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acceptedId(await debts.add({ title: "Prerequisite A" }));
  const second = acceptedId(await debts.add({ title: "Prerequisite B" }));
  const id = acceptedId(await debts.add({ title: "CLI body", body: "original" }));
  assert.equal((await debts.debt({ id }).update({ note: "status" })).kind, "accepted");

  const replaced = await cliJson(
    ["-C", root, "debt", "update", id, "--needs", `${first},${second}`],
    { environment: {} },
  );
  assert.equal(replaced.exit, 0, replaced.stderr);
  assert.deepEqual(replaced.value, { kind: "accepted", changes: ["needs"] });
  assert.deepEqual((await readDetail(debts, id)).needs, [
    { id: first, state: "open" },
    { id: second, state: "open" },
  ]);

  const cleared = await cliJson(
    ["-C", root, "debt", "update", id, "--needs", "", "--body", "", "--note", ""],
    { environment: {} },
  );
  assert.equal(cleared.exit, 0, cleared.stderr);
  assert.deepEqual(cleared.value, { kind: "accepted", changes: ["body", "note", "needs"] });
  const clearedDetail = await readDetail(debts, id);
  assert.equal(clearedDetail.body, undefined);
  assert.equal(clearedDetail.note, undefined);
  assert.equal(clearedDetail.needs, undefined);

  const refilled = await cliJson(
    ["-C", root, "debt", "update", id, "--body", "replacement", "--note", "later"],
    { environment: {} },
  );
  assert.deepEqual(refilled.value, { kind: "accepted", changes: ["body", "note"] });
  const emptyStdin = await cliJson(["-C", root, "debt", "update", id, "--body", "-"], {
    environment: {},
    readStdin: async () => "",
  });
  assert.equal(emptyStdin.exit, 0, emptyStdin.stderr);
  assert.deepEqual(emptyStdin.value, { kind: "accepted", changes: ["body"] });
  const final = await readDetail(debts, id);
  assert.equal(final.body, undefined);
  assert.equal(final.note, "later");
});

test("terminal facts release prerequisites while reopening re-blocks open dependents without writing them", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const finished = acceptedId(await debts.add({ title: "Complete prerequisite" }));
  const dropped = acceptedId(await debts.add({ title: "Unneeded prerequisite" }));
  const dependent = acceptedId(await debts.add({ title: "Dependent", needs: [finished, dropped] }));
  const closedDependent = acceptedId(await debts.add({ title: "Closed dependent", needs: [finished, dropped] }));
  assert.equal((await debts.debt({ id: closedDependent }).update({ state: "done" })).kind, "accepted");
  const blocked = await debts.blocked();
  assert.equal(blocked.kind, "present");
  if (blocked.kind !== "present") return;
  assert.deepEqual(
    blocked.rows!.map((row) => row.id),
    [dependent],
  );
  assert.deepEqual(
    blocked.rows![0]?.blockers.map((row) => row.id),
    [finished, dropped],
  );
  assert.equal((await debts.debt({ id: finished }).update({ state: "done" })).kind, "accepted");
  const stillBlocked = await debts.blocked();
  assert.equal(stillBlocked.kind, "present");
  if (stillBlocked.kind !== "present") return;
  assert.deepEqual(
    stillBlocked.rows![0]?.blockers.map((row) => row.id),
    [dropped],
  );
  assert.equal((await debts.debt({ id: dropped }).update({ state: "drop" })).kind, "accepted");
  const ready = await debts.ready();
  assert.equal(ready.kind, "present");
  if (ready.kind !== "present") return;
  assert.deepEqual(
    ready.rows!.map(({ id }) => id),
    [dependent],
  );
  assert.equal(ready.more, undefined);
  const unblocked = await debts.blocked();
  assert.deepEqual(unblocked, { kind: "present" });
  assert.equal((await readDetail(debts, dependent)).state, "open");

  const dependentBytes = readFileSync(debtAuthorityFile(root, dependent));
  const closedBytes = readFileSync(debtAuthorityFile(root, closedDependent));
  const closedBefore = await readDetail(debts, closedDependent);
  assert.equal((await debts.debt({ id: dropped }).update({ state: "open" })).kind, "accepted");
  const reblocked = await debts.blocked();
  assert.equal(reblocked.kind, "present");
  if (reblocked.kind === "present")
    assert.deepEqual(reblocked.rows, [
      { id: dependent, title: "Dependent", priority: 2, blockers: [{ id: dropped }] },
    ]);
  const readyAfterReopen = await debts.ready();
  assert.equal(readyAfterReopen.kind, "present");
  if (readyAfterReopen.kind === "present")
    assert.deepEqual(readyAfterReopen.rows, [{ id: dropped, title: "Unneeded prerequisite", priority: 2 }]);
  const active = await debts.list({ selection: "active" });
  assert.deepEqual(active.rows, [
    { id: dependent, title: "Dependent", priority: 2, disposition: "blocked" },
    { id: dropped, title: "Unneeded prerequisite", priority: 2, disposition: "ready" },
  ]);
  assert.equal((await readDetail(debts, dependent)).state, "open");
  const closedAfter = await readDetail(debts, closedDependent);
  assert.equal(closedAfter.state, "done");
  assert.equal(closedAfter.updatedAt, closedBefore.updatedAt);
  assert.deepEqual(readFileSync(debtAuthorityFile(root, dependent)), dependentBytes);
  assert.deepEqual(readFileSync(debtAuthorityFile(root, closedDependent)), closedBytes);
});

function nextDebtLockAttempt(t: TestContext): Promise<void> {
  const { promise: pending, resolve: observed } = promiseBarrier<void>();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA busy_timeout=0") observed();
    return exec.call(this, sql);
  });
  return pending;
}

test("addressed update observes authority after acquiring its lock", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Lock observation" }));
  const path = debtAuthorityFile(root, id);
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", `${id.slice(5)}.sqlite`),
    mode: "immediate", timeoutMs: 100,
  });
  const lockAttempt = nextDebtLockAttempt(t);
  const pending = debts.debt({ id }).update({ title: "Must publish", state: "done" });
  try {
    await lockAttempt;
    const current = parseDebtDocument(readFileSync(path), id);
    writeFileSync(path, serializeDebtDocument({ ...current, state: "drop", note: "manual winner" }));
  } finally {
    lock.close();
  }
  assert.deepEqual(await pending, { kind: "accepted", changes: ["title", "state"] });
  const published = await readDetail(debts, id);
  assert.equal(published.title, "Must publish");
  assert.equal(published.state, "done");
  assert.equal(published.note, "manual winner");
});

test("combined update distinguishes contention from a moved predecessor and preserves the winner", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Concurrent update" }));
  const path = debtAuthorityFile(root, id);
  const original = readFileSync(path);
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", `${id.slice(5)}.sqlite`),
    mode: "immediate", timeoutMs: 100,
  });
  try {
    assert.deepEqual(await debts.debt({ id }).update({ state: "done", note: "loser" }), {
      kind: "retry", reason: "busy",
    });
    assert.deepEqual(readFileSync(path), original);
  } finally {
    lock.close();
  }
  const current = parseDebtDocument(original, id);
  const manual = serializeDebtDocument({ ...current, title: "Manual winner", note: "keep me" });
  const read = fsPromises.readFile;
  let moved = false;
  const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof read>) => {
    const bytes = await read(...args);
    if (!moved && String(args[0]) === path) {
      moved = true;
      writeFileSync(path, manual);
    }
    return bytes;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await debts.debt({ id }).update({ state: "done", note: "loser" }), {
      kind: "retry", reason: "concurrent-modification",
    });
    assert.deepEqual(readFileSync(path), Buffer.from(manual));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("internal settlement remains idempotent after explicit updates", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Settlement replay" }));
  assert.equal((await debts.debt({ id }).update({ note: "original" })).kind, "accepted");
  const path = debtAuthorityFile(root, id);
  assert.deepEqual(await settleDebt(root, id), { kind: "changed" });
  const settled = readFileSync(path);
  assert.deepEqual(await settleDebt(root, id), { kind: "unchanged" });
  assert.deepEqual(readFileSync(path), settled);
  assert.equal((await debts.debt({ id }).update({ note: "later testimony", state: "done" })).kind, "accepted");
  const updated = readFileSync(path);
  assert.deepEqual(await settleDebt(root, id), { kind: "unchanged" });
  assert.deepEqual(readFileSync(path), updated);
  const dropped = acceptedId(await debts.add({ title: "Dropped settlement" }));
  assert.equal((await debts.debt({ id: dropped }).update({ note: "not owed", state: "drop" })).kind, "accepted");
  const droppedPath = debtAuthorityFile(root, dropped);
  const before = readFileSync(droppedPath);
  assert.deepEqual(await settleDebt(root, dropped), {
    kind: "refused", reason: "invalid-lifecycle-transition", state: "drop",
  });
  assert.deepEqual(readFileSync(droppedPath), before);
});

test("needs cycles remain writable and doctor names their complete component", async () => {
  const { debts } = await world();
  const first = acceptedId(await debts.add({ title: "First" }));
  const second = acceptedId(await debts.add({ title: "Second" }));
  assert.deepEqual(await debts.debt({ id: first }).update({ needs: [second] }), {
    kind: "accepted", changes: ["needs"],
  });
  assert.deepEqual(await debts.debt({ id: second }).update({ needs: [first] }), {
    kind: "accepted", changes: ["needs"],
  });
  assert.deepEqual((await readDetail(debts, first)).needs, [{ id: second, state: "open" }]);
  assert.deepEqual(await debts.doctor(), {
    kind: "present",
    issues: [{ kind: "cycle", relation: "needs", debts: [first, second] }],
  });
  const blocked = await debts.blocked();
  assert.equal(blocked.kind, "present");
  if (blocked.kind === "present")
    assert.deepEqual(blocked.rows, [
      { id: first, title: "First", priority: 2, blockers: [{ id: second }] },
      { id: second, title: "Second", priority: 2, blockers: [{ id: first }] },
    ]);
  assert.deepEqual(await debts.ready(), { kind: "present" });
});

test("Debt row views share the bounded-list contract and complete their graph judgment first", async () => {
  const { root, debts } = await world();
  mkdirSync(join(root, ".keiyaku", "debts"), { recursive: true });
  const document = (id: DebtId, needs: readonly DebtId[] = []): DebtDocument =>
    debtDocument({
      id,
      title: id,
      needs,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
  for (let index = 0; index < 51; index += 1) {
    const ready = `debt/ready-${String(index).padStart(2, "0")}` as DebtId;
    const blocked = `debt/blocked-${String(index).padStart(2, "0")}` as DebtId;
    writeFileSync(debtAuthorityFile(root as WorldRoot, ready), serializeDebtDocument(document(ready)));
    writeFileSync(
      debtAuthorityFile(root as WorldRoot, blocked),
      serializeDebtDocument(document(blocked, ["debt/missing" as DebtId])),
    );
  }

  const views = [await debts.list({ selection: "all" }), await debts.ready(), await debts.blocked()];
  for (const view of views) {
    assert.ok(view.kind === "debt-catalogue" || view.kind === "present");
    assert.deepEqual(Object.keys(view).sort(), ["kind", "more", "rows"]);
    assert.equal(view.rows!.length, 50);
    assert.equal(view.more, true);
  }
  const maximum = await debts.list({ selection: "all", limit: 500 });
  assert.equal(maximum.kind, "debt-catalogue");
  assert.equal(maximum.rows!.length, 102);
  assert.equal(maximum.more, undefined);
  await assert.rejects(() => debts.list({ limit: 501 }), /integer from 1 to 500/u);
});

test("targeted reads expose prerequisite endpoints only", async () => {
  const { debts } = await world();
  const blocker = acceptedId(await debts.add({ title: "A" }));
  const blocked = acceptedId(await debts.add({ title: "B", needs: [blocker] }));

  const shown = await readDetail(debts, blocker);
  assert.equal(shown.needs, undefined);
  const shownBlocked = await readDetail(debts, blocked);
  assert.deepEqual(shownBlocked.needs, [{ id: blocker, state: "open" }]);
});

test("native, invocation and CLI listings select lifecycle before bounding the World ledger", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const done = acceptedId(await debts.add({ title: "Finished", priority: 0 }));
  const dropped = acceptedId(await debts.add({ title: "Dropped", priority: 1 }));
  assert.equal((await debts.debt({ id: done }).update({ state: "done" })).kind, "accepted");
  assert.equal((await debts.debt({ id: dropped }).update({ state: "drop" })).kind, "accepted");
  const zebra = acceptedId(await debts.add({ title: "Zebra", priority: 2 }));
  const alpha = acceptedId(await debts.add({ title: "Alpha", priority: 2, needs: [zebra] }));

  const facet = Keiyaku.at({ cwd: root, environment: {} });
  const cases = [
    { input: {}, ids: [alpha, zebra] },
    { input: { selection: "closed" }, ids: [done, dropped] },
    { input: { selection: "all" }, ids: [done, dropped, alpha, zebra] },
  ] as const;
  for (const { input, ids } of cases) {
    const native = await debts.list(input);
    assert.deepEqual(native.rows?.map((row) => row.id) ?? [], ids);
    assert.equal(native.more, undefined);
    assert.deepEqual(await facet.ls({ selector: "debt/", ...input }), native);
    const bounded = await debts.list({ ...input, limit: 1 });
    assert.deepEqual(bounded.rows?.map((row) => row.id) ?? [], ids.slice(0, 1));
    assert.equal(bounded.more, ids.length > 1 ? true : undefined);
    assert.deepEqual(await facet.run("ls", { selector: "debt/", ...input, limit: 1 }), bounded);
    const flags = "selection" in input ? [input.selection === "closed" ? "--closed" : "--all"] : [];
    for (const selector of ["debt", "debt/"]) {
      const cli = await cliJson(["-C", root, "ls", selector, ...flags, "--limit", "1"], { environment: {} });
      assert.equal(cli.exit, 0, cli.stderr);
      assert.deepEqual(cli.value, bounded);
    }
  }
  assert.deepEqual((await debts.list()).rows, [
    { id: alpha, title: "Alpha", priority: 2, disposition: "blocked" },
    { id: zebra, title: "Zebra", priority: 2, disposition: "ready" },
  ]);
});

test("listing failures retain corrupt authority and unavailable custody rather than empty pages", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facet = Keiyaku.at({ cwd: root, environment: {} });
  assert.deepEqual(await facet.ls({ selector: "debt/" }), { kind: "debt-catalogue" });
  const id = acceptedId(await debts.add({ title: "Readable" }));
  const corrupt = join(root, ".keiyaku", "debts", "broken.md");
  writeFileSync(corrupt, "not Debt authority\n");
  await assert.rejects(debts.list({ limit: 1 }), DebtAuthorityCorruptionError);
  await assert.rejects(facet.ls({ selector: "debt/", limit: 1 }), DebtAuthorityCorruptionError);
  const failed = await cliJson(["-C", root, "ls", "debt/", "--limit", "1"], { environment: {} });
  assert.equal(failed.exit, 3, failed.stderr);
  unlinkSync(corrupt);
  const link = join(root, ".keiyaku", "debts", "linked");
  symlinkSync(root, link, "dir");
  await assert.rejects(debts.list({ limit: 1 }), /custody violation/u);
  await assert.rejects(facet.ls({ selector: "debt/", limit: 1 }), /custody violation/u);
  assert.equal((await debts.debt({ id }).read()).kind, "present");
});

test("concurrent same-title creation allocates stable unique suffixes", async () => {
  const { debts } = await world();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => debts.add({ title: "Collision" })));
  assert.ok(outcomes.every((outcome) => outcome.kind === "accepted"));
  const ids = outcomes.flatMap((outcome) => (outcome.kind === "accepted" ? [outcome.id] : []));
  assert.equal(new Set(ids).size, 6);
  assert.ok(ids.every((id) => /^debt\/collision-[0-9a-f]{4}$/u.test(id)));
});

test("needs input rejects only newly declared missing and self targets", async () => {
  const { debts } = await world(),
    id = acceptedId(await debts.add({ title: "Subject" }));
  const missing = await debts.debt({ id }).update({ needs: ["debt/missing"] });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") assert.equal(missing.reason, "invalid-graph");
  const self = await debts.debt({ id }).update({ needs: [id] });
  assert.equal(self.kind, "refused");
  if (self.kind === "refused") assert.equal(self.reason, "invalid-graph");
});

test("stored needs disease tolerates unrelated edits and whole replacement heals it", async () => {
  const { root, debts } = await world();
  const subject = acceptedId(await debts.add({ title: "Subject" }));
  const valid = acceptedId(await debts.add({ title: "Valid target" }));
  const path = debtAuthorityFile(root, subject);
  const document = parseDebtDocument(readFileSync(path), subject);
  writeFileSync(path, serializeDebtDocument({ ...document, needs: ["debt/missing"] }));

  assert.equal((await debts.debt({ id: subject }).update({ title: "Renamed" })).kind, "accepted");
  const doctor = await debts.doctor();
  assert.equal(doctor.kind, "present");
  assert.deepEqual(doctor.issues, [
    { kind: "missing-target", debtId: subject, relation: "needs", target: "debt/missing" },
  ]);
  assert.deepEqual(await debts.debt({ id: subject }).update({ needs: [valid] }), {
    kind: "accepted", changes: ["needs"],
  });
  assert.deepEqual(await debts.doctor(), { kind: "present" });
});

test("reset re-resolves authority after a ledger swap while the debt lock is held", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Reset custody race" }));
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", `${id.slice(5)}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const outside = mkdtempSync(join(tmpdir(), "keiyaku-debt-outside-"));
  const outsideFile = join(outside, "reset-custody-race.md");
  writeFileSync(outsideFile, "outside\n");
  const ledger = join(root, ".keiyaku", "debts");
  const pending = nukeDebtAuthority(debts.root, { timeoutMs: 1_000 });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    rmSync(ledger, { recursive: true, force: true });
    symlinkSync(outside, ledger, "dir");
  } finally {
    lock.close();
  }

  await assert.rejects(pending, /Debt authority custody violation/u);
  assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");
  rmSync(outside, { recursive: true, force: true });
});

test("debt lock cancellation propagates and exceptional actions release held locks", async () => {
  const { debts } = await world(),
    id = acceptedId(await debts.add({ title: "Cancel" }));
  const path = join(debts.root, ".keiyaku", "locks", "debt", `${id.slice(5)}.sqlite`);
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  const controller = new AbortController();
  const pending = debts.debt({ id }).update({ state: "done", signal: controller.signal });
  controller.abort(new Error("cancel debt"));
  await assert.rejects(pending, /cancel debt/u);
  held.close();

  await assert.rejects(
    withDebtLocks({ world: debts.root, allocation: false, ids: [id] }, async () => {
      throw new Error("action failed");
    }),
    /action failed/u,
  );
  assert.equal((await debts.debt({ id }).update({ state: "done" })).kind, "accepted");
});

test("debt action failure retains a close failure", { concurrency: false }, async () => {
  const { debts } = await world();
  const id = acceptedId(await debts.add({ title: "Action failure" }));
  const originalClose = DatabaseSync.prototype.close;
  let releases = 0;
  DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
    releases += 1;
    try {
      throw new Error("release after action failure");
    } finally {
      originalClose.call(this);
    }
  };
  try {
    await assert.rejects(
      withDebtLocks({ world: debts.root, allocation: false, ids: [id] }, async () => {
        throw new Error("action failure");
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /action failure/u);
        assert.match(String(error.errors[1]), /cannot release SQLite lock: release after action failure/u);
        return true;
      },
    );
    assert.equal(releases, 1);
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }
});

test("manual predecessor movement is best-effort detected and idle lock deletion never changes authority", async () => {
  const { debts } = await world(),
    id = acceptedId(await debts.add({ title: "Manual" }));
  const path = debtAuthorityFile(debts.root, id),
    original = readFileSync(path),
    manual = Buffer.concat([original, Buffer.from("manual edit\n")]);
  writeFileSync(path, manual);
  // This covers an external edit observed before replacement; portable rename
  // cannot prove an arbitrary writer stayed absent after the comparison.
  assert.equal(
    await replaceAuthority({ world: debts.root, id, expected: original, next: Buffer.from("replacement") }),
    "concurrent-modification",
  );
  assert.deepEqual(readFileSync(path), manual);
  writeFileSync(path, original);
  assert.equal((await debts.debt({ id }).update({ note: "before lock deletion" })).kind, "accepted");
  const lock = join(debts.root, ".keiyaku", "locks", "debt", `${id.slice(5)}.sqlite`);
  unlinkSync(lock);
  assert.equal((await debts.debt({ id }).update({ state: "done" })).kind, "accepted");
  assert.equal((await readDetail(debts, id)).state, "done");
});

test("Debt batch detail retains prerequisite endpoints and readable peers from one snapshot", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acceptedId(await debts.add({ title: "First peer" }));
  const second = acceptedId(await debts.add({ title: "Second peer", needs: [first] }));
  const removed = acceptedId(await debts.add({ title: "Removed endpoint" }));
  assert.equal((await debts.debt({ id: first }).update({ needs: [removed] })).kind, "accepted");
  unlinkSync(debtAuthorityFile(root, removed));
  const read = fsPromises.readFile;
  const reads = new Map<string, number>();
  const mocked = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof read>) => {
    const path = String(args[0]);
    if (path === debtAuthorityFile(root, first) || path === debtAuthorityFile(root, second))
      reads.set(path, (reads.get(path) ?? 0) + 1);
    return read(...args);
  });
  syncBuiltinESMExports();
  let batch;
  try {
    batch = await debts.read({ ids: [second, removed, first, second] });
    assert.deepEqual([...reads.values()], [1, 1], "selected details share one board read");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(batch.kind, "debt-partial");
  assert.equal(Keiyaku.verbs.show.output.safeParse(JSON.parse(JSON.stringify(batch))).success, true);
  assert.equal(Keiyaku.verbs.show.normal.safeParse(JSON.parse(JSON.stringify(batch))).success, false);
  assert.deepEqual(batch.items.map(item => item.id), [second, removed, first, second]);
  assert.deepEqual(batch.items[1], { kind: "missing", id: removed });
  const peer = batch.items[0];
  assert.ok(peer?.kind === "found");
  assert.deepEqual(peer.needs, [{ id: first, state: "open" }]);
  const prerequisiteOwner = batch.items[2];
  assert.ok(prerequisiteOwner?.kind === "found");
  assert.deepEqual(prerequisiteOwner.needs, [{ id: removed, state: "missing" }]);
  const facet = Keiyaku.at({ cwd: root, environment: {} });
  const complete = await facet.show({ id: first });
  assert.equal(complete.kind, "debt-complete");
  if (complete.kind === "debt-complete") assert.deepEqual(complete.items, [prerequisiteOwner]);
  assert.deepEqual(await debts.read({ ids: [removed] }), { kind: "debt-missing", items: [{ kind: "missing", id: removed }] });
});

test("unknown persisted Debt content survives reads and no-ops then disappears on ordinary rewrite", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.addDocument({ markdown: "---\ntitle: Existing\n---\nOriginal body\n" }));
  const expected = await readDetail(debts, id);
  const path = debtAuthorityFile(root, id);
  const original = readFileSync(path, "utf8");
  const extended = original.replace("createdAt:", "futureMetadata: { opaque: true }\ncreatedAt:");
  writeFileSync(path, extended);

  assert.deepEqual(await readDetail(debts, id), expected);
  const shown = await cliJson<unknown>(["-C", root, "show", id], { environment: {} });
  assert.equal(shown.exit, 0, shown.stderr);
  assert.equal(readFileSync(path, "utf8"), extended, "reads preserve original bytes");
  assert.equal((await debts.debt({ id }).update({ title: "Existing" })).kind, "accepted");
  assert.equal(readFileSync(path, "utf8"), extended, "an unchanged update preserves authority");

  assert.equal((await debts.debt({ id }).update({ note: "changed" })).kind, "accepted");
  assert.equal((await readDetail(debts, id)).note, "changed");
  assert.equal(readFileSync(path, "utf8").includes("futureMetadata:"), false);
});

test("accepted mutation retains a lock-release warning from its own invocation", { concurrency: false }, async () => {
  const { debts } = await world();
  const id = acceptedId(await debts.add({ title: "Warning" }));
  const originalClose = DatabaseSync.prototype.close;
  let fail = true;
  DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
    try {
      if (
        fail &&
        (this.location() ?? "").includes(
          `${join(".keiyaku", "locks", "debt")}${process.platform === "win32" ? "\\" : "/"}`,
        )
      ) {
        fail = false;
        throw new Error("debt lock release failed");
      }
    } finally {
      originalClose.call(this);
    }
  };
  try {
    const done = await debts.debt({ id }).update({ state: "done" });
    assert.equal(done.kind, "accepted");
    if (done.kind === "accepted")
      assert.equal(done.warning, "Debt lock release failed: cannot release SQLite lock: debt lock release failed");
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }
});

test("public inputs reject unknown fields before observing authority", async () => {
  const { debts } = await world();
  assert.throws(() => debts.debt({ id: "debt/one/two" }), /debt ID must be debt\/<id>/u);
  assert.throws(() => debts.add({ title: "Bad", needs: ["debt/one/two"] }), /expected flat DebtId/u);
  assert.throws(() => debts.add({ title: "Bad", extra: true } as never), /Unrecognized key/u);
  assert.throws(() => debts.add({ title: "Bad", needs: ["debt/a", "debt/a"] }), /must not contain duplicates/u);
  const id = acceptedId(await debts.add({ title: "Valid" }));
  assert.throws(
    () => debts.debt({ id }).update({ signal: new AbortController().signal }),
    /update requires at least one field/u,
  );
  assert.throws(() => debts.debt({ id }).update({ title: "   " }), /title must be nonblank/u);
  assert.throws(() => debts.debt({ id }).update({ state: "started" } as never), /Invalid option/u);
  assert.throws(() => debts.debt({ id }).update({ state: "done", extra: true } as never), /Unrecognized key/u);
  await assert.rejects(debts.list({ extra: true } as never), /unknown field/u);
  await assert.rejects(debts.list({ selection: "paused" } as never), /selection must be active, closed, or all/u);
  assert.throws(() => Debts.of({ root: debts.root } as never), /Debts.of world/u);
});

test("board reports malformed Markdown Debt authority as corruption", async () => {
  const { root, debts } = await world();
  acceptedId(await debts.add({ title: "Corrupted authority" }));
  writeFileSync(join(root, ".keiyaku", "debts", "corrupted-authority.md"), "not a Debt document\n");

  await assert.rejects(debts.list({ selection: "all" }), DebtAuthorityCorruptionError);
});

test("targeted reads ignore unrelated malformed and symlink authorities", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Targeted authority" }));
  const directory = join(root, ".keiyaku", "debts");
  for (let index = 0; index < 25; index += 1)
    writeFileSync(join(directory, `unrelated-${String(index).padStart(2, "0")}.md`), "not a Debt document\n");
  symlinkSync(join(root, "outside.md"), join(directory, "unrelated-link.md"));

  assert.equal((await readDetail(debts, id)).title, "Targeted authority");
});

test("Debt ls returns its native page and distinguishes absent Worlds", async (t) => {
  const { root, debts } = await world();
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-debt-list-absent-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  });
  const id = acceptedId(await debts.add({ title: "Catalogue member" }));
  const listed = await cliJson(["-C", root, "ls", "debt/"], { environment: {} });
  assert.equal(listed.exit, 0, listed.stderr);
  assert.deepEqual(listed.value, {
    kind: "debt-catalogue",
    rows: [{ id, title: "Catalogue member", priority: 2, disposition: "ready" }],
  });
  const noWorld = await cliJson(["-C", absent, "ls", "debt/"], { environment: {} });
  assert.equal(noWorld.exit, 1, noWorld.stderr);
  assert.deepEqual(noWorld.value, { kind: "debt-catalogue", absent: true });
});

test("show distinguishes an absent World from a missing addressed Debt", async (context) => {
  const established = mkdtempSync(join(tmpdir(), "keiyaku-debt-show-world-"));
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-debt-show-absent-"));
  context.after(() => {
    rmSync(established, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  });
  mkdirSync(join(established, ".keiyaku"));

  const single = await runCli(["-C", established, "show", "debt/missing", "--json"], { environment: {} });
  assert.equal(single.exit, 1, single.stderr);
  assert.deepEqual(JSON.parse(single.stdout), {
    kind: "debt-missing",
    items: [{ kind: "missing", id: "debt/missing" }],
  });

  await assert.rejects(
    runCli(["-C", established, "show", "debt/a", "debt/b", "--json"], { environment: {} }),
    /show accepts at most one selector/u,
  );

  const text = await runCli(["-C", established, "show", "debt/missing"], { environment: {} });
  assert.equal(text.exit, 1, text.stderr);
  assert.match(text.stdout, /^× show refused$/mu);
  assert.match(text.stdout, /^  debt  debt\/missing$/mu);

  const absentRead = await runCli(["-C", absent, "show", "debt/missing", "--json"], { environment: {} });
  assert.equal(absentRead.exit, 1, absentRead.stderr);
  assert.deepEqual(JSON.parse(absentRead.stdout), { kind: "absent" });
  const absentText = await runCli(["-C", absent, "show", "debt/missing"], { environment: {} });
  assert.equal(absentText.exit, 1, absentText.stderr);
  assert.match(absentText.stdout, /^debt world absent$/mu);
  assert.doesNotMatch(absentText.stdout, /refused|debt\/missing/u);
});
