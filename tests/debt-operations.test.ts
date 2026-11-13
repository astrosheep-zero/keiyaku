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
  type DebtTreeNode,
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
  const id = acceptedId(await debts.add({ title: "Cancellation fixture", note: "original" }));
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
  const added = await debts.add({ title: "Timestamped", note: "first" });
  assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
  const created = await readDetail(debts, added.id);
  assert.equal(created.note, "first");
  assert.equal(created.createdAt, created.updatedAt);
  assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);

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

test("fields and terminal state publish together once and same-state updates preserve authority", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Atomic update", note: "old" }));
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
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("illegal transitions and refused relationships write neither facts nor state", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "Unresolved", note: "original" }));
  const other = acceptedId(await debts.add({ title: "Relation owner", relates: [id] }));
  const path = debtAuthorityFile(root, id);
  const original = readFileSync(path);
  const invalid = await debts.debt({ id }).update({ title: "Lost", state: "done", needs: ["debt/missing"] });
  assert.equal(invalid.kind, "refused");
  if (invalid.kind === "refused") assert.equal(invalid.reason, "invalid-graph");
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(await debts.debt({ id }).update({ note: "Lost", state: "drop", dropRelates: [other] }), {
    kind: "refused", reason: "relation-owned-by-other", related: other,
  });
  assert.deepEqual(readFileSync(path), original);
  for (const state of ["done", "drop"] as const) {
    const terminal = acceptedId(await debts.add({ title: `Terminal ${state}`, state }));
    const terminalPath = debtAuthorityFile(root, terminal);
    const bytes = readFileSync(terminalPath);
    for (const target of ["open", state === "done" ? "drop" : "done"] as const) {
      assert.deepEqual(await debts.debt({ id: terminal }).update({ title: "Lost", state: target }), {
        kind: "refused", reason: "invalid-lifecycle-transition", state,
      });
      assert.deepEqual(readFileSync(terminalPath), bytes);
    }
    assert.deepEqual(await debts.debt({ id: terminal }).update({ state }), { kind: "accepted" });
    assert.deepEqual(readFileSync(terminalPath), bytes);
  }
});

test("CLI update changes facts and state atomically through the addressed owner", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = acceptedId(await debts.add({ title: "CLI lifecycle", note: "original" }));
  const updated = await cliJson(["-C", root, "debt", "update", id, "--state", "done", "--note", "finished"], {
    environment: {},
  });
  assert.equal(updated.exit, 0, updated.stderr);
  assert.deepEqual(updated.value, { kind: "accepted", changes: ["note", "state"] });
  const after = await readDetail(debts, id);
  assert.equal(after.state, "done");
  assert.equal(after.note, "finished");
  const path = debtAuthorityFile(root, id);
  const bytes = readFileSync(path);
  const refused = await cliJson(["-C", root, "debt", "update", id, "--state", "drop", "--note", "lost"], {
    environment: {},
  });
  assert.equal(refused.exit, 1, refused.stderr);
  assert.deepEqual(refused.value, { kind: "refused", reason: "invalid-lifecycle-transition", state: "done" });
  assert.deepEqual(readFileSync(path), bytes);
});

test("terminal facts release prerequisites without storing readiness", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const finished = acceptedId(await debts.add({ title: "Complete prerequisite" }));
  const dropped = acceptedId(await debts.add({ title: "Unneeded prerequisite" }));
  const dependent = acceptedId(await debts.add({ title: "Dependent", needs: [finished, dropped] }));
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
  const pending = debts.debt({ id }).update({ title: "Must not publish", state: "done" });
  let bytes: Uint8Array;
  try {
    await lockAttempt;
    const current = parseDebtDocument(readFileSync(path), id);
    bytes = serializeDebtDocument({ ...current, state: "drop", note: "manual winner" });
    writeFileSync(path, bytes);
  } finally {
    lock.close();
  }
  assert.deepEqual(await pending, { kind: "refused", reason: "invalid-lifecycle-transition", state: "drop" });
  assert.deepEqual(readFileSync(path), Buffer.from(bytes));
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
  const id = acceptedId(await debts.add({ title: "Settlement replay", note: "original" }));
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

test("appendBody supplies one missing LF boundary without duplicating caller delimiters", async () => {
  const { debts } = await world();
  const plain = acceptedId(await debts.add({ title: "Plain body", body: "first" }));
  const appended = await debts.debt({ id: plain }).update({ appendBody: "second" });
  assert.equal(appended.kind, "accepted");
  assert.equal((await readDetail(debts, plain)).body, "first\nsecond");

  const leading = await debts.debt({ id: plain }).update({ appendBody: "\nthird" });
  assert.equal(leading.kind, "accepted");
  assert.equal((await readDetail(debts, plain)).body, "first\nsecond\nthird");

  const terminated = acceptedId(await debts.add({ title: "Terminated body", body: "first\n" }));
  const afterTerminated = await debts.debt({ id: terminated }).update({ appendBody: "second" });
  assert.equal(afterTerminated.kind, "accepted");
  assert.equal((await readDetail(debts, terminated)).body, "first\nsecond");
});

test("parent-scoped ready and blocked views traverse before bounding", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = acceptedId(await debts.add({ title: "Area", priority: 3 }));
  const need = acceptedId(await debts.add({ title: "Need", priority: 0, parent }));
  const ready = acceptedId(await debts.add({ title: "Ready auth", priority: 1, parent }));
  const nested = acceptedId(await debts.add({ title: "Nested", priority: 2, parent: ready, needs: [need] }));
  const other = acceptedId(await debts.add({ title: "Other blocked", priority: 3, parent, needs: [need] }));
  acceptedId(await debts.add({ title: "Unrelated ready", priority: 0 }));
  acceptedId(await debts.add({ title: "Unrelated blocked", priority: 0, needs: [need] }));

  assert.deepEqual(await debts.ready({ parent, limit: 1 }), {
    kind: "present",
    rows: [{ id: need, title: "Need", priority: 0 }],
    more: true,
  });
  const descendants = await debts.ready({ parent });
  assert.equal(descendants.kind, "present");
  if (descendants.kind === "present")
    assert.deepEqual(descendants.rows!.map((row) => row.id), [need, ready]);
  assert.deepEqual(await debts.blocked({ parent, limit: 1 }), {
    kind: "present",
    rows: [{ id: nested, title: "Nested", priority: 2, blockers: [{ id: need }] }],
    more: true,
  });
  const blocked = await debts.blocked({ parent });
  assert.equal(blocked.kind, "present");
  if (blocked.kind === "present") assert.deepEqual(blocked.rows!.map((row) => row.id), [nested, other]);
  assert.deepEqual(await debts.ready({ parent: "debt/missing" }), { kind: "refused", reason: "debt-missing" });
  assert.deepEqual(await debts.blocked({ parent: "debt/missing" }), { kind: "refused", reason: "debt-missing" });

  const bridge = acceptedId(await debts.add({ title: "Completed bridge", parent: ready, state: "done" }));
  const beyond = acceptedId(await debts.add({ title: "Beyond bridge", parent: bridge, priority: 1 }));
  const waiting = acceptedId(await debts.add({ title: "Waiting beyond bridge", parent: bridge, priority: 1, needs: [need] }));
  assert.deepEqual(await debts.ready({ parent: ready, limit: 1 }), {
    kind: "present",
    rows: [{ id: beyond, title: "Beyond bridge", priority: 1 }],
  });
  assert.deepEqual(await debts.blocked({ parent: ready, limit: 1 }), {
    kind: "present",
    rows: [{ id: waiting, title: "Waiting beyond bridge", priority: 1, blockers: [{ id: need }] }],
    more: true,
  });
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

test("targeted reads expose outbound relations only", async () => {
  const { debts } = await world();
  const blocker = acceptedId(await debts.add({ title: "A" }));
  const blocked = acceptedId(await debts.add({ title: "B", needs: [blocker] }));
  const relatedFrom = acceptedId(await debts.add({ title: "D", relates: [blocker] }));

  const shown = await readDetail(debts, blocker);
  assert.equal(shown.needs, undefined);
  assert.equal(shown.parent, undefined);
  assert.equal(shown.supersedes, undefined);
  assert.equal(shown.relates, undefined);
  const shownBlocked = await readDetail(debts, blocked);
  assert.deepEqual(
    shownBlocked.needs?.map((item) => item.id),
    [blocker],
  );
  assert.equal(shownBlocked.relates, undefined);
  const shownRelatedFrom = await readDetail(debts, relatedFrom);
  assert.deepEqual(
    shownRelatedFrom.relates?.map((item) => item.id),
    [blocker],
  );
  assert.equal(shownRelatedFrom.needs, undefined);
});

test("native, invocation and CLI listings select lifecycle before bounding the World ledger", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const done = acceptedId(await debts.add({ title: "Finished", state: "done", priority: 0 }));
  const dropped = acceptedId(await debts.add({ title: "Dropped", state: "drop", priority: 1 }));
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

test("relation mutation rejects only newly declared missing and self targets", async () => {
  const { debts } = await world(),
    id = acceptedId(await debts.add({ title: "Subject" }));
  const missing = await debts.debt({ id }).update({ needs: ["debt/missing"] });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") assert.equal(missing.reason, "invalid-graph");
  const self = await debts.debt({ id }).update({ relates: [id] });
  assert.equal(self.kind, "refused");
  if (self.kind === "refused") assert.equal(self.reason, "invalid-graph");
});

test("existing graph disease does not adjudicate an unrelated relation addition", async () => {
  const { root, debts } = await world();
  const subject = acceptedId(await debts.add({ title: "Subject" }));
  const valid = acceptedId(await debts.add({ title: "Valid target" }));
  const path = debtAuthorityFile(root, subject);
  const document = parseDebtDocument(readFileSync(path), subject);
  writeFileSync(path, serializeDebtDocument({ ...document, needs: ["debt/missing"] }));

  assert.equal((await debts.debt({ id: subject }).update({ addNeeds: [valid] })).kind, "accepted");
  const doctor = await debts.doctor();
  assert.equal(doctor.kind, "present");
  assert.deepEqual(doctor.issues, [
    { kind: "missing-target", debtId: subject, relation: "needs", target: "debt/missing" },
  ]);
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

function treeIds(node: DebtTreeNode): readonly string[] {
  return [node.id, ...(node.kind === "cycle" ? [] : (node.children ?? []).flatMap(treeIds))];
}

test("debt tree is parent decomposition with no needs residue", async () => {
  const { debts } = await world();
  const root = acceptedId(await debts.add({ title: "Area" }));
  const need = acceptedId(await debts.add({ title: "Need" }));
  const later = acceptedId(await debts.add({ title: "Zebra", parent: root }));
  const child = acceptedId(await debts.add({ title: "Child", parent: root }));
  const nested = acceptedId(await debts.add({ title: "Nested", parent: child, needs: [need] }));
  assert.equal((await debts.debt({ id: root }).update({ needs: [need] })).kind, "accepted");

  const tree = await debts.debt({ id: root }).tree();
  assert.equal(tree.kind, "present");
  if (tree.kind !== "present") return;
  assert.deepEqual((tree.children ?? []).flatMap(treeIds), [child, nested, later]);
  assert.deepEqual(
    tree.children!.map((node) => node.id),
    [child, later],
  );
  const firstChild = tree.children![0]!;
  assert.equal(firstChild.kind, "node");
  if (firstChild.kind === "node")
    assert.deepEqual(
      firstChild.children!.map((node) => node.id),
      [nested],
    );

  const shown = await readDetail(debts, nested);
  assert.deepEqual(
    shown.needs?.map((item) => item.id),
    [need],
  );
  assert.equal("blockers" in shown, false, "detail keeps only outbound relations");
  assert.equal(shown.parent?.id, child);
  const blocked = await debts.blocked();
  assert.equal(blocked.kind, "present");
  if (blocked.kind === "present")
    assert.deepEqual(
      blocked.rows!.map((row) => row.id),
      [root, nested],
    );
  const ready = await debts.ready();
  assert.equal(ready.kind, "present");
  if (ready.kind === "present") {
    assert.deepEqual(
      ready.rows!.map((row) => row.id),
      [child, need, later],
    );
  }

  assert.deepEqual(await debts.debt({ id: "debt/missing" }).tree(), { kind: "missing" });
  await assert.rejects(
    () => (debts.debt({ id: root }).tree as unknown as (input: unknown) => Promise<unknown>)({ full: true }),
    /tree accepts no input/u,
  );
});

test("debt tree renders a parent cycle as a terminal cycle node", async () => {
  const { debts } = await world();
  const first = acceptedId(await debts.add({ title: "First" }));
  const second = acceptedId(await debts.add({ title: "Second", parent: first }));
  assert.equal((await debts.debt({ id: first }).update({ parent: second })).kind, "accepted");

  const tree = await debts.debt({ id: first }).tree();
  assert.equal(tree.kind, "present");
  if (tree.kind !== "present") return;
  assert.equal(tree.children!.length, 1);
  const child = tree.children![0]!;
  assert.equal(child.id, second);
  assert.equal(child.kind, "node");
  if (child.kind === "node") assert.deepEqual(child.children, [{ kind: "cycle", id: first }]);
  const doctor = await debts.doctor();
  assert.deepEqual(doctor.issues, [{ kind: "cycle", relation: "parent", debts: [first, second] }]);
  assert.deepEqual(await debts.ready({ parent: first, limit: 1 }), {
    kind: "present",
    rows: [{ id: first, title: "First", priority: 2 }],
    more: true,
  });
  assert.deepEqual(await debts.blocked({ parent: first }), { kind: "present" });
});

test("Debt batch detail retains decomposition, missing endpoints, and readable peers from one snapshot", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acceptedId(await debts.add({ title: "Parent" }));
  const second = acceptedId(await debts.add({ title: "Child", parent: first }));
  const removed = acceptedId(await debts.add({ title: "Removed endpoint" }));
  assert.equal((await debts.debt({ id: first }).update({ parent: second, needs: [removed] })).kind, "accepted");
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
    assert.deepEqual([...reads.values()], [1, 1], "selected details and decomposition share one board read");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(batch.kind, "debt-partial");
  assert.deepEqual(batch.items.map(item => item.id), [second, removed, first, second]);
  assert.deepEqual(batch.items[1], { kind: "missing", id: removed });
  const parent = batch.items[2];
  assert.ok(parent?.kind === "found");
  assert.deepEqual(parent.needs, [{ id: removed, state: "missing" }]);
  assert.deepEqual(parent.parent, { id: second, state: "open" });
  assert.deepEqual(parent.children?.[0], {
    kind: "node", id: second, title: "Child", state: "open", priority: 2,
    children: [{ kind: "cycle", id: first }],
  });
  const facet = Keiyaku.at({ cwd: root, environment: {} });
  assert.deepEqual(await facet.show({ ids: [second, removed, first, second] }), batch);
  const complete = await facet.show({ ids: [first] });
  assert.equal(complete.kind, "debt-complete");
  if (complete.kind === "debt-complete") assert.deepEqual(complete.items, [parent]);
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
  assert.throws(() => debts.add({ title: "Bad", state: "started" as never }), /Invalid option/u);
  const id = acceptedId(await debts.add({ title: "Valid" }));
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

  const plural = await runCli(["-C", established, "show", "debt/a", "debt/b", "--json"], {
    environment: {},
  });
  assert.equal(plural.exit, 1, plural.stderr);
  assert.deepEqual(JSON.parse(plural.stdout), {
    kind: "debt-missing",
    items: [{ kind: "missing", id: "debt/a" }, { kind: "missing", id: "debt/b" }],
  });

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
