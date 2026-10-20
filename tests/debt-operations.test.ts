import { deferred as promiseBarrier } from "./support/process.js";
import { debtDocument } from "./support/debt.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DebtAuthorityCorruptionError, Debts, type DebtId, type DebtTreeNode } from "../src/debt/index.js";
import {
  debtMutationRequestCommand,
  type DebtMutationBodyRequest,
  type DebtMutationRequestPort,
} from "../src/debt/mutation.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { parseDebtDocument, serializeDebtDocument, type DebtDocument } from "../src/debt/document.js";
import { parseDebtId } from "../src/debt/identity.js";
import { settleDebt } from "../src/debt/operations.js";
import { observeCreatedDebtObservations } from "../src/debt/created-observation.js";
import { createDebtRelations, projectCreatedByRows, projectDebtBoardObservation } from "../src/debt/board.js";
import { readBoard, nukeDebtAuthority, replaceAuthority, withDebtLocks } from "../src/debt/store.js";
import { debtAuthorityFile } from "./support/debt.js";
import { World, type WorldRoot } from "../src/world.js";
import { runCli, cliJson } from "./support/cli-fixtures.js";
import { parseDebtQueryExpression } from "../src/cli/commands/debt-query.js";

type Assert<Condition extends true> = Condition;

export type DebtBodyWorldRequiresCanonicalMint = Assert<
  [DebtMutationBodyRequest["world"]] extends [WorldRoot] ? false : true
>;

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
  return result.value.id;
}

test("created Debt association rows match complete board views and re-read manual edits", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = acceptedId(await debts.add({ title: "Created parent", actor: "one", priority: 1, body: "body" }));
  const need = acceptedId(await debts.add({ title: "Other creator prerequisite", actor: "two", priority: 0 }));
  const child = acceptedId(
    await debts.add({ title: "Created child", actor: "one", parent, needs: [need], priority: 0 }),
  );
  acceptedId(await debts.add({ title: "Terminal child", parent, state: "done", actor: "two" }));
  acceptedId(await debts.add({ title: "Created dropped", actor: "one", state: "drop", priority: 1 }));
  acceptedId(await debts.add({ title: "Unsigned dependency", needs: [parent] }));
  const ids = ["two", "absent", "one", "one"];
  const expected = projectDebtBoardObservation((await readBoard(root)).board);
  const observed = await observeCreatedDebtObservations(root, ids);
  assert.deepEqual(
    observed,
    ids.map((id) => ({ kind: "present", rows: expected.selectCreatedBy(id) })),
  );
  const rows = observed[2];
  assert.ok(rows?.kind === "present");
  assert.equal(rows.rows[0]?.id, child);
  assert.equal(rows.rows[0]?.disposition, "blocked");
  assert.deepEqual(rows.rows.find((row) => row.id === parent)?.children, { live: 1, total: 2 });
  assert.equal(rows.rows.find((row) => row.id === parent)?.bodyPresent, true);

  const before = await debts.debt({ id: need }).read();
  assert.ok(before !== null);
  writeFileSync(
    debtAuthorityFile(root, need),
    serializeDebtDocument({ ...before.debt, state: "done", createdBy: "one", title: "Manual edit" }),
  );
  const fresh = await observeCreatedDebtObservations(root, ids);
  const freshExpected = projectDebtBoardObservation((await readBoard(root)).board);
  assert.deepEqual(
    fresh,
    ids.map((id) => ({ kind: "present", rows: freshExpected.selectCreatedBy(id) })),
  );
  assert.ok(fresh[2]?.kind === "present");
  assert.equal(fresh[2].rows.find((row) => row.id === child)?.disposition, "ready");
  assert.equal(fresh[2].rows.find((row) => row.id === need)?.title, "Manual edit");

  const corrupt = join(root, ".keiyaku", "debts", "unrelated.md");
  writeFileSync(corrupt, "not Debt authority\n");
  const failed = await observeCreatedDebtObservations(root, ids);
  assert.ok(failed.every((result) => result.kind === "failed"));
  assert.deepEqual(await observeCreatedDebtObservations(root, []), []);
  unlinkSync(corrupt);
  const link = join(root, ".keiyaku", "debts", "linked");
  symlinkSync(root, link, "dir");
  const linked = await observeCreatedDebtObservations(root, ids);
  assert.ok(linked.every((result) => result.kind === "failed" && /custody violation/u.test(result.diagnostic)));
});

test("created Debt projection visits relationships only for requested creators", () => {
  const selected = debtDocument({ id: "debt/selected" as DebtId, title: "Selected", createdBy: "one" });
  const unrelated = debtDocument({ id: "debt/unrelated" as DebtId, title: "Unrelated", createdBy: "two" });
  const board = {
    debts: new Map([
      [selected.id, selected],
      [unrelated.id, unrelated],
    ]),
  };
  const relations = createDebtRelations(board);
  const visited: DebtId[] = [];
  const rows = projectCreatedByRows(
    board,
    {
      ...relations,
      children: (id) => {
        visited.push(id);
        return relations.children(id);
      },
    },
    ["one", "one", "absent"],
  );
  assert.deepEqual(visited, [selected.id]);
  assert.deepEqual([...rows.keys()], ["one"]);
  assert.equal(rows.get("one")?.[0]?.id, selected.id);
});

test("note is replaceable authority and product timestamps advance only on change", async () => {
  const { debts } = await world();
  const added = await debts.add({ title: "Timestamped", note: "first" });
  assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
  assert.equal(added.value.note, "first");
  assert.equal(added.value.createdAt, added.value.updatedAt);
  assert.equal(new Date(added.value.createdAt).toISOString(), added.value.createdAt);

  const replaced = await debts.debt({ id: added.value.id }).update({ note: "second" });
  assert.ok(replaced.kind === "accepted", 'expected replaced.kind = "accepted"');
  assert.equal(replaced.value.debt.note, "second");
  assert.equal(replaced.value.debt.createdAt, added.value.createdAt);
  assert.ok(replaced.value.debt.updatedAt > added.value.updatedAt);
  assert.match(replaced.value.documentDiff, /-note: first/u);
  assert.match(replaced.value.documentDiff, /\+note: second/u);
  assert.deepEqual(replaced.value.changedFields, [{ field: "note", action: "replaced" }]);

  const unchanged = await debts.debt({ id: added.value.id }).update({ note: "second" });
  assert.ok(unchanged.kind === "accepted", 'expected unchanged.kind = "accepted"');
  assert.equal(unchanged.value.documentDiff, "");
  assert.deepEqual(unchanged.value.changedFields, []);
  assert.equal(unchanged.value.debt.updatedAt, replaced.value.debt.updatedAt);
});

test("ordinary mutations advance a non-later timestamp by one millisecond", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Future timestamp" }));
  const before = await debts.debt({ id }).read();
  if (before === null) return;
  const future = "2099-01-01T00:00:00.000Z";
  writeFileSync(debtAuthorityFile(root, id), serializeDebtDocument({ ...before.debt, updatedAt: future }));

  const updated = await debts.debt({ id }).update({ note: "changed" });
  assert.equal(updated.kind, "accepted");
  if (updated.kind === "accepted") {
    assert.equal(updated.value.debt.updatedAt, "2099-01-01T00:00:00.001Z");
  }
});

test("done and drop replace note while preserving creation time", async () => {
  const { debts } = await world();
  const one = acceptedId(await debts.add({ title: "One", note: "old" }));
  const before = await debts.debt({ id: one }).read();
  const done = await debts.debt({ id: one }).done({ note: "finished" });
  assert.equal(done.kind, "accepted");
  if (done.kind === "accepted") {
    assert.equal(done.value.state, "done");
    assert.equal(done.value.note, "finished");
    assert.equal(done.value.createdAt, before?.debt.createdAt);
    assert.ok(done.value.updatedAt > (before?.debt.updatedAt ?? ""));
  }

  const two = acceptedId(await debts.add({ title: "Two" })),
    three = acceptedId(await debts.add({ title: "Three" }));
  const batch = await debts.batch({ verb: "done", ids: [two, "debt/missing", three], note: "completed" });
  assert.deepEqual(
    batch.items.map((item) => item.id),
    [two, "debt/missing", three],
  );
  assert.deepEqual(
    batch.items.map((item) => item.outcome.kind),
    ["accepted", "refused", "accepted"],
  );
  assert.ok(
    batch.items
      .filter((item) => item.outcome.kind === "accepted")
      .every((item) => item.outcome.kind !== "accepted" || item.outcome.value.note === "completed"),
  );
  assert.equal((await debts.debt({ id: three }).read())?.debt.state, "done");
  const dropped = await debts.debt({ id: two }).drop({ note: "cancelled" });
  assert.equal(dropped.kind, "refused");
  const afterRefusal = await debts.debt({ id: two }).read();
  assert.equal(afterRefusal?.debt.state, "done");
  assert.equal(afterRefusal?.debt.note, "completed");
});

test("batch drop preserves order and continues after per-debt refusals", async () => {
  const { debts } = await world();
  const first = acceptedId(await debts.add({ title: "Batch drop first" }));
  const alreadyDone = acceptedId(await debts.add({ title: "Batch drop done", state: "done" }));
  const third = acceptedId(await debts.add({ title: "Batch drop third" }));
  const result = await debts.batch({ verb: "drop", ids: [first, "debt/missing", alreadyDone, third] });
  assert.deepEqual(
    result.items.map((item) => item.id),
    [first, "debt/missing", alreadyDone, third],
  );
  assert.deepEqual(
    result.items.map((item) => item.outcome.kind),
    ["accepted", "refused", "refused", "accepted"],
  );
  assert.equal((await debts.debt({ id: first }).read())?.debt.state, "drop");
  assert.equal((await debts.debt({ id: third }).read())?.debt.state, "drop");
  assert.throws(() => debts.batch({ verb: "drop", ids: [] }), /at least one DebtId/u);
});

test("terminal facts release prerequisites without storing readiness", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const finished = acceptedId(await debts.add({ title: "Complete prerequisite" }));
  const dropped = acceptedId(await debts.add({ title: "Unneeded prerequisite" }));
  const dependent = acceptedId(await debts.add({ title: "Dependent", needs: [finished, dropped] }));
  const blocked = await debts.blocked();
  assert.ok(blocked.kind === "accepted");
  assert.deepEqual(
    blocked.value.rows.map((row) => row.id),
    [dependent],
  );
  assert.deepEqual(
    blocked.value.rows[0]?.blockers.map((row) => row.id),
    [finished, dropped],
  );
  assert.equal((await debts.debt({ id: finished }).done()).kind, "accepted");
  const stillBlocked = await debts.blocked();
  assert.ok(stillBlocked.kind === "accepted");
  assert.deepEqual(
    stillBlocked.value.rows[0]?.blockers.map((row) => row.id),
    [dropped],
  );
  assert.equal((await debts.batch({ verb: "drop", ids: [dropped] })).items[0]?.outcome.kind, "accepted");
  const ready = await debts.ready();
  assert.ok(ready.kind === "accepted");
  assert.deepEqual(
    ready.value.rows.map(({ id, state, disposition }) => ({ id, state, disposition })),
    [{ id: dependent, state: "open", disposition: "ready" }],
  );
  assert.equal(ready.value.hasMore, false);
  const unblocked = await debts.blocked();
  assert.ok(unblocked.kind === "accepted");
  assert.deepEqual(unblocked.value, { rows: [], hasMore: false });
  assert.equal((await debts.debt({ id: dependent }).read())?.debt.state, "open");
});

test("batch cancellation stops between items and preserves its completed closure", async (t) => {
  const { root, debts } = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acceptedId(await debts.add({ title: "First closure" }));
  const second = acceptedId(await debts.add({ title: "Later closure", needs: [first] }));
  const controller = new AbortController();
  const close = DatabaseSync.prototype.close;
  const mock = t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this);
    controller.abort(new Error("stop between items"));
  });
  try {
    await assert.rejects(
      debts.batch({ verb: "done", ids: [first, second], signal: controller.signal }),
      /stop between items/u,
    );
  } finally {
    mock.mock.restore();
  }
  assert.equal((await debts.debt({ id: first }).read())?.debt.state, "done");
  assert.equal((await debts.debt({ id: second }).read())?.debt.state, "open");
  const ready = await debts.ready();
  assert.ok(ready.kind === "accepted");
  assert.deepEqual(
    ready.value.rows.map((row) => row.id),
    [second],
  );
});

function nextDebtLockAttempt(t: TestContext): Promise<void> {
  const { promise: pending, resolve: observed } = promiseBarrier<void>();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    // Lock initialization occurs after the batch has captured its board.
    if (sql === "PRAGMA busy_timeout=0") observed();
    return exec.call(this, sql);
  });
  return pending;
}

test("batch lifecycle reads one board before locks and retries only a concurrently changed Debt", async (t) => {
  const { root, debts } = await world();
  const first = acceptedId(await debts.add({ title: "Batch snapshot first" }));
  const second = acceptedId(await debts.add({ title: "Batch snapshot second" }));
  const firstLock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", `${parseDebtId(first).localId}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const lockAttempt = nextDebtLockAttempt(t);
  const pending = debts.batch({ verb: "done", ids: [first, second] });
  try {
    await lockAttempt;
    writeFileSync(debtAuthorityFile(root, second), "changed after batch observation\n");
  } finally {
    firstLock.close();
  }

  const result = await pending;
  assert.deepEqual(
    result.items.map((item) => item.outcome.kind),
    ["accepted", "retry"],
  );
  assert.deepEqual(result.items[1]?.outcome, { kind: "retry", reason: "concurrent-modification" });
});

test("batch invalid refusal retries when the Debt becomes valid before its lock", async (t) => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Batch stale invalid", state: "done" }));
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", `${parseDebtId(id).localId}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const lockAttempt = nextDebtLockAttempt(t);
  const pending = debts.batch({ verb: "done", ids: [id] });
  try {
    await lockAttempt;
    const current = await debts.debt({ id }).read();
    assert.notEqual(current, null);
    if (current === null) return;
    writeFileSync(debtAuthorityFile(root, id), serializeDebtDocument({ ...current.debt, state: "open" }));
  } finally {
    lock.close();
  }

  const result = await pending;
  assert.deepEqual(result.items[0]?.outcome, { kind: "retry", reason: "concurrent-modification" });
});

test("batch missing refusal retries when the Debt is created before its lock", async (t) => {
  const { root, debts } = await world();
  const id = "debt/batch-stale-missing-0000" as DebtId;
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", "batch-stale-missing-0000.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  const lockAttempt = nextDebtLockAttempt(t);
  const pending = debts.batch({ verb: "drop", ids: [id] });
  try {
    await lockAttempt;
    const created = await debts.add({ title: "Batch stale missing" });
    assert.ok(created.kind === "accepted", 'expected created.kind = "accepted"');
    const source = debtAuthorityFile(root, created.value.id);
    const document = parseDebtDocument(readFileSync(source), parseDebtId(created.value.id));
    writeFileSync(debtAuthorityFile(root, id), serializeDebtDocument({ ...document, id }));
    unlinkSync(source);
  } finally {
    lock.close();
  }

  const result = await pending;
  assert.deepEqual(result.items[0]?.outcome, { kind: "retry", reason: "concurrent-modification" });
});

test("Debt mutation mints raw World once while Debts consumes its branded capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-debts-forged-world-"));
  mkdirSync(join(root, ".keiyaku"));
  const canonical = await World.at(root);
  await assert.rejects(
    debtMutationRequestCommand("debt.add", {
      ...UNUSED_DEBT_ABILITIES,
      add: async () => Promise.reject(new Error("raw World must not reach the Debt executor")),
    }).execute(
      {
        world: `${canonical}/.` as WorldRoot,
        request: { action: "debt.add", input: { title: "must not write", namespace: [] } },
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        admittedAt: "2026-08-18T00:00:00.000Z",
        requester: "aku/parent/00000001",
        signal: new AbortController().signal,
        admissionOpen: () => true,
      },
    ),
    /canonical physical directory/u,
  );
  assert.equal(existsSync(join(canonical, ".keiyaku", "debts")), false);
  const debts = Debts.of(canonical);
  assert.equal(debts.root, canonical);
  assert.equal((await debts.add({ title: "branded capability" })).kind, "accepted");
});

test("appendBody supplies one missing LF boundary without duplicating caller delimiters", async () => {
  const { debts } = await world();
  const plain = acceptedId(await debts.add({ title: "Plain body", body: "first" }));
  const appended = await debts.debt({ id: plain }).update({ appendBody: "second" });
  assert.equal(appended.kind, "accepted");
  if (appended.kind === "accepted") assert.equal(appended.value.debt.body, "first\nsecond");

  const leading = await debts.debt({ id: plain }).update({ appendBody: "\nthird" });
  assert.equal(leading.kind, "accepted");
  if (leading.kind === "accepted") assert.equal(leading.value.debt.body, "first\nsecond\nthird");

  const terminated = acceptedId(await debts.add({ title: "Terminated body", body: "first\n" }));
  const afterTerminated = await debts.debt({ id: terminated }).update({ appendBody: "second" });
  assert.equal(afterTerminated.kind, "accepted");
  if (afterTerminated.kind === "accepted") assert.equal(afterTerminated.value.debt.body, "first\nsecond");
});

test("bounded Debt query filters before limit and parent views recurse", async () => {
  const { debts } = await world();
  const parent = acceptedId(await debts.add({ title: "Area", priority: 3 }));
  const need = acceptedId(await debts.add({ title: "Need", priority: 0, parent }));
  const ready = acceptedId(await debts.add({ title: "Ready auth", priority: 1, parent }));
  const nested = acceptedId(await debts.add({ title: "Nested", priority: 2, parent: ready, needs: [need] }));

  const selected = await debts.query({
    scope: "world",
    where: {
      kind: "and",
      terms: [
        { kind: "predicate", predicate: { field: "under", operator: "=", value: parent } },
        { kind: "predicate", predicate: { field: "priority", operator: "<=", value: 1 } },
      ],
    },
    limit: 1,
  });
  assert.equal(selected.kind, "accepted");
  if (selected.kind === "accepted") {
    assert.deepEqual(
      selected.value.rows.map((row) => row.id),
      [need],
    );
    assert.equal(selected.value.hasMore, true);
  }

  const descendants = await debts.ready({ scope: "world", parent });
  assert.equal(descendants.kind, "accepted");
  if (descendants.kind === "accepted")
    assert.deepEqual(
      descendants.value.rows.map((row) => row.id),
      [need, ready],
    );
  const blocked = await debts.blocked({ scope: "world", parent });
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind === "accepted")
    assert.deepEqual(
      blocked.value.rows.map((row) => row.id),
      [nested],
    );
  assert.deepEqual(await debts.ready({ parent: "debt/missing" }), {
    kind: "refused",
    refusal: { kind: "debt-missing", debtId: "debt/missing" },
  });
  assert.deepEqual(
    await debts.query({
      where: { kind: "predicate", predicate: { field: "under", operator: "=", value: "debt/missing" } },
    }),
    { kind: "refused", refusal: { kind: "debt-missing", debtId: "debt/missing" } },
  );
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

  const views = [
    await debts.list({ scope: "world", selection: "all" }),
    await debts.ready({ scope: "world" }),
    await debts.blocked({ scope: "world" }),
    await debts.query({ scope: "world" }),
  ];
  for (const view of views) {
    assert.equal(view.kind, "accepted");
    if (view.kind !== "accepted") continue;
    assert.deepEqual(Object.keys(view.value).sort(), ["hasMore", "rows"]);
    assert.equal(view.value.rows.length, 50);
    assert.equal(view.value.hasMore, true);
  }
  const maximum = await debts.list({ scope: "world", selection: "all", limit: 500 });
  assert.equal(maximum.kind, "accepted");
  if (maximum.kind === "accepted") {
    assert.equal(maximum.value.rows.length, 102);
    assert.equal(maximum.value.hasMore, false);
  }
  await assert.rejects(() => debts.list({ scope: "world", limit: 501 }), /integer from 1 to 500/u);
});

test("targeted reads expose outbound relations only; board projections derive reverse edges", async () => {
  const { debts } = await world();
  const blocker = acceptedId(await debts.add({ title: "A" }));
  const blocked = acceptedId(await debts.add({ title: "B", needs: [blocker] }));
  const other = acceptedId(await debts.add({ title: "C" }));
  const relatedFrom = acceptedId(await debts.add({ title: "D", relates: [blocker] }));

  const shown = await debts.debt({ id: blocker }).read();
  assert.deepEqual(
    shown?.blocks.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    shown?.children.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    shown?.supersededBy.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    shown?.related.map((item) => item.id),
    [],
  );
  const shownBlocked = await debts.debt({ id: blocked }).read();
  assert.deepEqual(
    shownBlocked?.needs.map((item) => item.id),
    [blocker],
  );
  assert.deepEqual(
    shownBlocked?.blocks.map((item) => item.id),
    [],
  );
  const shownRelatedFrom = await debts.debt({ id: relatedFrom }).read();
  assert.deepEqual(
    shownRelatedFrom?.related.map((item) => item.id),
    [blocker],
  );

  const selectsBlocker = await debts.query({
    scope: "world",
    where: { kind: "predicate", predicate: { field: "blocks", operator: "=", value: blocked } },
  });
  assert.equal(selectsBlocker.kind, "accepted");
  if (selectsBlocker.kind === "accepted") {
    assert.deepEqual(
      selectsBlocker.value.rows.map((row) => row.id),
      [blocker],
    );
    assert.deepEqual(
      selectsBlocker.value.rows[0]?.blocks.map((item) => item.id),
      [blocked],
    );
  }

  const doesNotSelectBlocked = await debts.query({
    scope: "world",
    where: { kind: "predicate", predicate: { field: "blocks", operator: "=", value: blocker } },
  });
  assert.equal(doesNotSelectBlocked.kind, "accepted");
  if (doesNotSelectBlocked.kind === "accepted") {
    assert.deepEqual(
      doesNotSelectBlocked.value.rows.map((row) => row.id),
      [],
    );
  }

  const complement = await debts.query({
    scope: "world",
    where: { kind: "predicate", predicate: { field: "blocks", operator: "!=", value: blocked } },
  });
  assert.equal(complement.kind, "accepted");
  if (complement.kind === "accepted") {
    assert.deepEqual(
      complement.value.rows.map((row) => row.id),
      [blocked, other, relatedFrom],
    );
  }
});

test("Debt query defaults to active Debts", async () => {
  const { debts } = await world();
  const active = acceptedId(await debts.add({ title: "Active" }));
  acceptedId(await debts.add({ title: "Finished", state: "done" }));
  acceptedId(await debts.add({ title: "Dropped", state: "drop" }));
  const result = await debts.query();
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted")
    assert.deepEqual(
      result.value.rows.map((row) => row.id),
      [active],
    );
});

test("CLI Debt selection and parsed filters retain native query semantics", async (context) => {
  const { root, debts } = await world();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const active = acceptedId(await debts.add({ title: "Selected active", priority: 3 }));
  const done = acceptedId(await debts.add({ title: "Selected done", state: "done", priority: 0 }));
  const dropped = acceptedId(await debts.add({ title: "Other dropped", state: "drop", priority: 1 }));
  const rows = async (args: readonly string[]) => {
    const result = await cliJson<{ kind: string; value: { rows: readonly { id: string }[] } }>(
      ["-C", root, "debt", "query", "--world", ...args],
      { environment: {} },
    );
    assert.equal(result.exit, 0, result.stdout + result.stderr);
    return result.value.value.rows.map((row) => row.id);
  };
  assert.deepEqual(await rows([]), [active]);
  assert.deepEqual(await rows(["--closed"]), [done, dropped]);
  assert.deepEqual(await rows(["--all"]), [done, dropped, active]);
  assert.deepEqual(await rows(["--where", 'title ~ "Selected"']), [active]);
  assert.deepEqual(await rows(["--closed", "--where", 'title ~ "Selected"']), [done]);
  assert.deepEqual(await rows(["--all", "--where", 'title ~ "Selected"']), [done, active]);
  // Explicit native filters do not implicitly acquire the CLI's active default.
  const native = await debts.query({
    where: parseDebtQueryExpression("state = done or priority = 3 and not state = done"),
  });
  assert.equal(native.kind, "accepted");
  if (native.kind === "accepted")
    assert.deepEqual(
      native.value.rows.map((row) => row.id),
      [done, active],
    );
  const relation = await rows([
    "--all",
    "--where",
    `id = ${active} and parent = none and created >= "2000-01-01T00:00:00.000Z"`,
  ]);
  assert.deepEqual(relation, [active]);
  const child = acceptedId(await debts.add({ title: 'Child "quoted"', parent: active, needs: [active] }));
  assert.deepEqual(
    await rows(["--where", `under = ${active} and parent = ${active} and needs = ${active} and blocked`]),
    [child],
  );
  assert.deepEqual(await rows(["--where", `blocks = ${child} and not (state = done or state = drop)`]), [active]);
  assert.deepEqual(await rows(["--where", 'title = "Child \\"quoted\\""']), [child]);
  assert.deepEqual(await rows(["--where", "ready"]), [active]);
});

test("Debt query rejects direct JavaScript semantics and CLI reports the responsible source column", async (context) => {
  const { root, debts } = await world();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  // Deliberately cross the JS boundary, rather than trusting TypeScript's public union.
  const query = debts.query.bind(debts) as (input: { where: unknown }) => ReturnType<typeof debts.query>;
  await assert.rejects(
    query({ where: { kind: "predicate", predicate: { field: "priority", operator: "=", value: "1" } } }),
    /priority value must be 0\.\.3/u,
  );
  await assert.rejects(
    query({ where: { kind: "predicate", predicate: { field: "state", operator: "~", value: "open" } } }),
    /state supports only = and !=/u,
  );
  await assert.rejects(
    query({ where: { kind: "predicate", predicate: { field: "needs", operator: "=", value: "debt/team//item" } } }),
    /canonical DebtId/u,
  );
  await assert.rejects(
    query({ where: { kind: "predicate", predicate: { field: "updated", operator: "=", value: "2026-01-01" } } }),
    /canonical UTC ISO timestamp/u,
  );
  await assert.rejects(
    query({ where: { kind: "predicate", predicate: { field: "unknown", operator: "=", value: true } } }),
    TypeError,
  );
  await assert.rejects(query({ where: { kind: "and", terms: [] } }), /and query requires terms/u);
  await assert.rejects(
    query({ where: { kind: "predicate", predicate: { field: "ready", operator: "=", value: "true" } } }),
    /ready value must be boolean/u,
  );
  assert.throws(() => parseDebtQueryExpression("unknown = 1"), /unknown query field: unknown at column 1/u);
  assert.throws(() => parseDebtQueryExpression("state ~ open"), /state supports only = and != at column 7/u);
  assert.throws(() => parseDebtQueryExpression("priority = 4"), /priority value must be 0\.\.3 at column 12/u);
  assert.throws(() => parseDebtQueryExpression("title = unquoted"), /double quotes at column 9/u);
  assert.throws(() => parseDebtQueryExpression("(ready"), /missing closing parenthesis at column 1/u);
  assert.throws(() => parseDebtQueryExpression("needs = debt/team//item"), /canonical DebtId at column 9/u);
  assert.throws(() => parseDebtQueryExpression("ready = maybe"), /ready value must be boolean at column 9/u);
  assert.throws(() => parseDebtQueryExpression("state = finished"), /state value is invalid at column 9/u);
  assert.throws(() => parseDebtQueryExpression('updated = "2026-01-01"'), /canonical UTC ISO timestamp at column 11/u);
});

test("concurrent same-title creation allocates stable unique suffixes", async () => {
  const { debts } = await world();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => debts.add({ title: "Collision" })));
  assert.ok(outcomes.every((outcome) => outcome.kind === "accepted"));
  const ids = outcomes.flatMap((outcome) => (outcome.kind === "accepted" ? [outcome.value.id] : []));
  assert.equal(new Set(ids).size, 6);
  assert.ok(ids.every((id) => /^debt\/collision-[0-9a-f]{4}$/u.test(id)));
});

test("relation mutation rejects only newly declared missing and self targets", async () => {
  const { debts } = await world(),
    id = acceptedId(await debts.add({ title: "Subject" }));
  const missing = await debts.debt({ id }).update({ needs: ["debt/missing"] });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") assert.equal(missing.refusal.kind, "invalid-graph");
  const self = await debts.debt({ id }).update({ relates: [id] });
  assert.equal(self.kind, "refused");
  if (self.kind === "refused") assert.equal(self.refusal.kind, "invalid-graph");
});

test("existing graph disease does not adjudicate an unrelated relation addition", async () => {
  const { root, debts } = await world();
  const subject = acceptedId(await debts.add({ title: "Subject" }));
  const valid = acceptedId(await debts.add({ title: "Valid target" }));
  const path = debtAuthorityFile(root, subject);
  const document = parseDebtDocument(readFileSync(path), parseDebtId(subject));
  writeFileSync(path, serializeDebtDocument({ ...document, needs: ["debt/missing"] }));

  assert.equal((await debts.debt({ id: subject }).update({ addNeeds: [valid] })).kind, "accepted");
  assert.deepEqual((await debts.doctor()).issues, [
    { kind: "missing-target", debtId: subject, relation: "needs", target: "debt/missing" },
  ]);
});

test("reset re-resolves authority after a namespace swap while the debt lock is held", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Reset custody race", namespace: ["foo"] }));
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "debt", "foo", `${parseDebtId(id).localId}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const outside = mkdtempSync(join(tmpdir(), "keiyaku-debt-outside-"));
  const outsideFile = join(outside, "reset-custody-race.md");
  writeFileSync(outsideFile, "outside\n");
  const namespace = join(root, ".keiyaku", "debts", "foo");
  const pending = nukeDebtAuthority(debts.root, { timeoutMs: 1_000 });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    rmSync(namespace, { recursive: true, force: true });
    symlinkSync(outside, namespace, "dir");
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
  const path = join(debts.root, ".keiyaku", "locks", "debt", `${parseDebtId(id).localId}.sqlite`);
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  const controller = new AbortController();
  const pending = debts.debt({ id }).done({ signal: controller.signal });
  controller.abort(new Error("cancel debt"));
  await assert.rejects(pending, /cancel debt/u);
  held.close();

  await assert.rejects(
    withDebtLocks({ world: debts.root, allocation: false, ids: [id] }, async () => {
      throw new Error("action failed");
    }),
    /action failed/u,
  );
  assert.equal((await debts.debt({ id }).done()).kind, "accepted");
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
  const lock = join(debts.root, ".keiyaku", "locks", "debt", `${parseDebtId(id).localId}.sqlite`);
  unlinkSync(lock);
  assert.equal((await debts.debt({ id }).done()).kind, "accepted");
  assert.equal((await debts.debt({ id }).read())?.debt.state, "done");
});

test("direct package Debts uses root namespace without reading local context", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Existing" }));
  mkdirSync(join(root, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "namespace", "current"), "Bad Namespace\n");
  const listed = await debts.list();
  assert.equal(listed.kind, "accepted");
  assert.equal((await debts.debt({ id }).read())?.debt.id, id);
});

function treeIds(node: DebtTreeNode): readonly string[] {
  return [node.debt.id, ...node.children.flatMap(treeIds)];
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
  assert.ok(tree.kind === "accepted", 'expected tree.kind = "accepted"');
  assert.deepEqual(treeIds(tree.value), [root, child, nested, later]);
  assert.deepEqual(
    tree.value.children.map((node) => node.debt.id),
    [child, later],
  );
  assert.deepEqual(
    tree.value.children[0]?.children.map((node) => node.debt.id),
    [nested],
  );
  assert.equal("needs" in tree.value, false);
  assert.equal("reference" in tree.value, false);
  assert.equal(treeIds(tree.value).includes(need), false);

  const shown = await debts.debt({ id: nested }).read();
  assert.deepEqual(
    shown?.needs.map((item) => item.id),
    [need],
  );
  assert.deepEqual(
    shown?.blockers.map((item) => item.id),
    [need],
  );
  assert.deepEqual(shown?.parent?.id, child);
  const blocked = await debts.blocked({ scope: "world" });
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind === "accepted")
    assert.deepEqual(
      blocked.value.rows.map((row) => row.id),
      [root, nested],
    );
  const ready = await debts.ready({ scope: "world" });
  assert.equal(ready.kind, "accepted");
  if (ready.kind === "accepted") {
    assert.deepEqual(
      ready.value.rows.map((row) => row.id),
      [child, need, later],
    );
  }

  assert.deepEqual(await debts.debt({ id: "debt/missing" }).tree(), {
    kind: "refused",
    refusal: { kind: "debt-missing", debtId: "debt/missing" },
  });
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
  assert.ok(tree.kind === "accepted", 'expected tree.kind = "accepted"');
  assert.equal(tree.value.cycle, undefined);
  assert.equal(tree.value.children.length, 1);
  assert.equal(tree.value.children[0]?.debt.id, second);
  assert.equal(tree.value.children[0]?.cycle, undefined);
  assert.deepEqual(tree.value.children[0]?.children, [
    {
      debt: { id: first, title: "First", state: "open", priority: 2 },
      cycle: true,
      children: [],
    },
  ]);
  assert.equal("reference" in (tree.value.children[0]?.children[0] ?? {}), false);
  assert.deepEqual((await debts.doctor()).issues, [{ kind: "cycle", relation: "parent", debts: [first, second] }]);
});

test("creation actor persists as createdBy and later mutations leave it unchanged", async () => {
  const { root, debts } = await world();
  const envKey = "KEIYAKU_ACTOR_ID";
  const previous = process.env[envKey];
  process.env[envKey] = "env-must-not-leak";
  try {
    const unsigned = await debts.add({ title: "Unsigned" });
    assert.equal(unsigned.kind, "accepted");
    if (unsigned.kind === "accepted") assert.equal("createdBy" in unsigned.value, false);

    const added = await debts.add({ title: "Authored", actor: "flagship" });
    assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
    assert.equal(added.value.createdBy, "flagship");
    const addedPath = debtAuthorityFile(root, added.value.id);
    assert.match(readFileSync(addedPath, "utf8"), /^createdBy: flagship$/mu);

    const fromDocument = await debts.addDocument({
      markdown: "---\ntitle: From document\n---\n",
      actor: "document-actor",
    });
    assert.equal(fromDocument.kind, "accepted");
    if (fromDocument.kind === "accepted") assert.equal(fromDocument.value.createdBy, "document-actor");
    await assert.rejects(
      debts.addDocument({ markdown: "---\ntitle: Illegal\ncreatedBy: sneaky\n---\n" }),
      /unknown debt front matter key/u,
    );
    assert.equal(await debts.debt({ id: "debt/illegal" }).read(), null);

    const mutated = await debts.debt({ id: added.value.id }).update({ note: "changed" });
    assert.equal(mutated.kind, "accepted");
    if (mutated.kind === "accepted") assert.equal(mutated.value.debt.createdBy, "flagship");
    const next = await debts.debt({ id: added.value.id }).done();
    assert.equal(next.kind, "accepted");
    if (next.kind === "accepted") assert.equal(next.value.createdBy, "flagship");
    const dropped = acceptedId(await debts.add({ title: "Drop me", actor: "flagship" }));
    const drop = await debts.debt({ id: dropped }).drop();
    assert.equal(drop.kind, "accepted");
    if (drop.kind === "accepted") assert.equal(drop.value.createdBy, "flagship");
    const batchId = acceptedId(await debts.add({ title: "Batch me", actor: "flagship" }));
    const batch = await debts.batch({ verb: "done", ids: [batchId] });
    assert.equal(batch.items[0]?.outcome.kind, "accepted");
    if (batch.items[0]?.outcome.kind === "accepted") assert.equal(batch.items[0].outcome.value.createdBy, "flagship");
    const settledId = acceptedId(await debts.add({ title: "Settle me", actor: "flagship" }));
    const settled = await settleDebt(debts.root, settledId);
    assert.equal(settled.kind, "changed");
    if (settled.kind === "changed") assert.equal(settled.debt.createdBy, "flagship");
    assert.equal((await debts.debt({ id: added.value.id }).read())?.debt.createdBy, "flagship");

    const legacyPath = join(root, ".keiyaku", "debts", "legacy.md");
    writeFileSync(
      legacyPath,
      serializeDebtDocument({
        id: "debt/legacy" as DebtId,
        title: "Legacy",
        state: "open",
        priority: 2,
        needs: [],
        parent: null,
        supersedes: [],
        relates: [],
        note: "",
        createdAt: "2026-08-07T01:02:03.004Z",
        updatedAt: "2026-08-07T01:02:03.004Z",
        body: "",
      }),
    );
    const legacy = await debts.debt({ id: "debt/legacy" }).read();
    assert.equal("createdBy" in (legacy?.debt ?? {}), false);
    assert.equal((await debts.debt({ id: "debt/legacy" }).update({ note: "still unsigned" })).kind, "accepted");
    assert.equal((await debts.debt({ id: "debt/legacy" }).done()).kind, "accepted");
    assert.equal("createdBy" in ((await debts.debt({ id: "debt/legacy" }).read())?.debt ?? {}), false);
    assert.throws(() => debts.add({ title: "Blank", actor: "  " }), /actor must be a nonblank string/u);
    assert.throws(() => debts.debt({ id: added.value.id }).update({ actor: "nope" } as never), /unknown field/u);
    assert.throws(() => debts.debt({ id: added.value.id }).done({ actor: "nope" } as never), /unknown field/u);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});

test("public inputs reject unknown fields before observing authority", async () => {
  const { debts } = await world();
  assert.throws(() => debts.add({ title: "Bad", extra: true } as never), /unknown field/u);
  assert.throws(() => debts.add({ title: "Bad", namespace: ["nested/escape"] }), /canonical segments/u);
  assert.throws(() => debts.add({ title: "Bad", needs: ["debt/a", "debt/a"] }), /must not contain duplicates/u);
  assert.throws(() => debts.add({ title: "Bad", state: "started" as never }), /state is invalid/u);
  const id = acceptedId(await debts.add({ title: "Valid" }));
  assert.throws(() => debts.debt({ id }).update({ title: "   " }), /title must be nonblank/u);
  assert.throws(() => debts.debt({ id }).done({ extra: true } as never), /unknown field/u);
  await assert.rejects(debts.list({ scope: "nearby" } as never), /scope must be namespace or world/u);
  assert.throws(() => Debts.of({ root: debts.root } as never), /Debts.of world/u);
});

test("board reports malformed Markdown Debt authority as corruption", async () => {
  const { root, debts } = await world();
  acceptedId(await debts.add({ title: "Corrupted authority" }));
  writeFileSync(join(root, ".keiyaku", "debts", "corrupted-authority.md"), "not a Debt document\n");

  await assert.rejects(debts.list({ scope: "world", selection: "all" }), DebtAuthorityCorruptionError);
});

test("targeted reads ignore unrelated malformed and symlink authorities", async () => {
  const { root, debts } = await world();
  const id = acceptedId(await debts.add({ title: "Targeted authority" }));
  const directory = join(root, ".keiyaku", "debts");
  for (let index = 0; index < 25; index += 1)
    writeFileSync(join(directory, `unrelated-${String(index).padStart(2, "0")}.md`), "not a Debt document\n");
  symlinkSync(join(root, "outside.md"), join(directory, "unrelated-link.md"));

  const shown = await debts.debt({ id }).read();
  assert.equal(shown?.debt.id, id);
});

const UNUSED_DEBT_ABILITIES: DebtMutationRequestPort = {
  add: async () => {
    throw new Error("unexpected Debt ability");
  },
  addDocument: async () => {
    throw new Error("unexpected Debt ability");
  },
  update: async () => {
    throw new Error("unexpected Debt ability");
  },
  lifecycle: async () => {
    throw new Error("unexpected Debt ability");
  },
  batch: async () => {
    throw new Error("unexpected Debt ability");
  },
};

test("forced-local Debt descriptor preserves owner validation and authenticated creation actor", async () => {
  const { root, debts } = await world();
  const served = await debtMutationRequestCommand("debt.add", {
    ...UNUSED_DEBT_ABILITIES,
    add: async ({ world: proven, options }) => await Debts.of(proven).add(options),
  }).execute(
    {
      world: debts.root,
      request: { action: "debt.add", input: { title: "Forwarded", body: "exact\nbody", namespace: [] } },
    },
    {
      id: "00000000-0000-4000-8000-000000000001",
      admittedAt: "2026-08-18T00:00:00.000Z",
      requester: "aku/parent/00000001",
      signal: new AbortController().signal,
      admissionOpen: () => true,
    },
  );
  if (served.kind !== "served") assert.fail("expected a served Debt mutation");
  const result = served.result;
  assert.equal("kind" in result && result.kind, "accepted");
  if (!("kind" in result) || result.kind !== "accepted" || !("value" in result) || "debt" in result.value)
    assert.fail("expected accepted debt mutation result");
  assert.equal(result.value.createdBy, "aku/parent/00000001");
  assert.equal(
    (
      await Debts.of(await World.at(root))
        .debt({ id: result.value.id })
        .read()
    )?.debt.body,
    "exact\nbody",
  );
});

test("debt show keeps the native addressed read and null with or without an established World", async (context) => {
  const established = mkdtempSync(join(tmpdir(), "keiyaku-debt-show-world-"));
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-debt-show-absent-"));
  context.after(() => {
    rmSync(established, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  });
  mkdirSync(join(established, ".keiyaku"));

  for (const root of [established, absent]) {
    const single = await runCli(["-C", root, "debt", "show", "debt/missing", "--json"], { environment: {} });
    assert.equal(single.exit, 1, single.stderr);
    assert.equal(single.stdout.trim(), "null");

    const plural = await runCli(["-C", root, "debt", "show", "debt/a", "debt/b", "--json"], { environment: {} });
    assert.equal(plural.exit, 1, plural.stderr);
    assert.equal(plural.stdout.trim(), "[null,null]");

    const text = await runCli(["-C", root, "debt", "show", "debt/missing"], { environment: {} });
    assert.equal(text.exit, 1, text.stderr);
    assert.match(text.stdout, /^× show refused$/mu);
    assert.match(text.stdout, /^  debt  debt\/missing$/mu);
    assert.doesNotMatch(text.stdout, /null/u);
  }
});
