import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fsPromises, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { deferred as promiseBarrier } from "./support/process.js";
import { debtAuthorityFile, debtDocument, writeDebtAuthority } from "./support/debt.js";
import { DebtAuthorityCorruptionError } from "../src/debt/document.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { Debts } from "../src/debt/index.js";
import { nukeDebt } from "../src/debt/operations.js";
import { parseDebtId, type DebtId } from "../src/debt/identity.js";
import { readBoard } from "../src/debt/store.js";
import { World } from "../src/world.js";

test("an unmigrated board is not silently presented as an empty Debt ledger", async () => {
  const root = await world();
  try {
    mkdirSync(join(root, ".keiyaku", "tasks"));
    await assert.rejects(Debts.of(root).list(), /Unmigrated ledger authority/u);
    await assert.rejects(Debts.of(root).add({ title: "Not a second board" }), /Unmigrated ledger authority/u);
    assert.equal(existsSync(join(root, ".keiyaku", "debts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline board upgrade preserves testimony, identities and prerequisites with original bytes backed up", async () => {
  const root = await world();
  const old = join(root, ".keiyaku", "tasks", "task");
  const source = (id: string, state: string, needs: string) =>
    `---\nid: task/task/${id}\ntitle: Keep task in the title\nstate: ${state}\npriority: 1\nneeds: ${needs}\nparent: null\nsupersedes: []\nrelates: []\nnote: "task/test is testimony"\ncreatedAt: 2026-08-07T01:02:03.004Z\nupdatedAt: 2026-08-07T01:02:03.004Z\n---\nKeep task/test in the body.\n`;
  try {
    mkdirSync(old, { recursive: true });
    const first = source("first", "in_progress", "[]");
    const second = source("second", "on_hold", "\n  - task/task/first");
    writeFileSync(join(old, "first.md"), first);
    writeFileSync(join(old, "second.md"), second);
    execFileSync(process.execPath, ["scripts/migrate-task-board.mjs", root]);
    const debts = Debts.of(root);
    const detail = await debts.debt({ id: "debt/task/second" }).read();
    assert.ok(detail);
    assert.equal(detail.debt.state, "open");
    assert.deepEqual(detail.debt.needs, ["debt/task/first"]);
    assert.equal(detail.debt.title, "Keep task in the title");
    assert.equal(detail.debt.note, "task/test is testimony");
    assert.equal(detail.debt.body, "Keep task/test in the body.\n");
    assert.equal(readFileSync(join(root, ".keiyaku", "tasks.pre-debt", "task", "second.md"), "utf8"), second);
    assert.equal(existsSync(join(root, ".keiyaku", "tasks")), false);
    assert.equal((await debts.doctor()).issues.length, 0);
    assert.deepEqual((await debts.ready({ scope: "world" })).kind, "accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline board upgrade refuses a document that does not sit at its own identity path", async () => {
  const root = await world();
  const board = join(root, ".keiyaku", "tasks", "ns");
  const source = "---\nid: task/other/first\ntitle: Elsewhere\nstate: open\n---\nBody.\n";
  try {
    mkdirSync(board, { recursive: true });
    writeFileSync(join(board, "first.md"), source);
    assert.throws(
      () => execFileSync(process.execPath, ["scripts/migrate-task-board.mjs", root], { stdio: "pipe" }),
      /Ledger identity does not match its authority path/u,
    );
    assert.equal(readFileSync(join(board, "first.md"), "utf8"), source);
    assert.equal(existsSync(join(root, ".keiyaku", "debts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete Debt reads bound in-flight I/O and retain canonical board and byte order", async (t) => {
  const root = await world();
  const ids = Array.from({ length: 24 }, (_, index) => `debt/read-${String(index).padStart(2, "0")}` as DebtId);
  for (const id of [...ids].reverse()) writeDebtAuthority(root, debtDocument({ id, title: id }));
  const firstWave = promiseBarrier<void>();
  const released = promiseBarrier<void>();
  const originalRead = fsPromises.readFile;
  let active = 0, maximum = 0, started = 0, completed = 0;
  const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
    if (!String(args[0]).startsWith(join(root, ".keiyaku", "debts"))) return originalRead(...args);
    active += 1;
    started += 1;
    maximum = Math.max(maximum, active);
    if (started === 8) firstWave.resolve();
    try {
      await released.promise;
      return await originalRead(...args);
    } finally {
      active -= 1;
      completed += 1;
    }
  });
  syncBuiltinESMExports();
  const pending = readBoard(root);
  try {
    await firstWave.promise;
    assert.equal(started, 8);
    assert.equal(active, 8);
    released.resolve();
    const snapshot = await pending;
    assert.equal(maximum, 8);
    assert.equal(completed, ids.length);
    assert.equal(active, 0);
    assert.deepEqual([...snapshot.board.debts.keys()], ids);
    assert.deepEqual([...snapshot.bytes.keys()], ids);
    for (const id of ids) assert.deepEqual(snapshot.bytes.get(id), readFileSync(debtAuthorityFile(root, id)));
  } finally {
    released.resolve();
    await pending.catch(() => undefined);
    mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete Debt reads drain before reporting the first canonical authority failure", async (t) => {
  for (const corrupt of [false, true]) {
    await t.test(corrupt ? "earlier corrupt Markdown" : "earlier I/O failure", async (t) => {
      const root = await world();
      const ids = Array.from({ length: 16 }, (_, index) => `debt/failure-${String(index).padStart(2, "0")}` as DebtId);
      for (const id of ids) writeDebtAuthority(root, debtDocument({ id, title: id }));
      const first = debtAuthorityFile(root, ids[0]!);
      const later = debtAuthorityFile(root, ids[1]!);
      if (corrupt) writeFileSync(first, "not Debt authority\n");
      const earlyError = new Error("earlier read failed");
      const laterError = new Error("later read failed");
      const released = promiseBarrier<void>();
      const othersFinished = promiseBarrier<void>();
      const originalRead = fsPromises.readFile;
      let completed = 0, settled = false;
      const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
        const path = String(args[0]);
        if (!path.startsWith(join(root, ".keiyaku", "debts"))) return originalRead(...args);
        try {
          if (path === first) {
            await released.promise;
            if (!corrupt) throw earlyError;
          }
          if (path === later) throw laterError;
          return await originalRead(...args);
        } finally {
          completed += 1;
          if (completed === ids.length - 1) othersFinished.resolve();
        }
      });
      syncBuiltinESMExports();
      const pending = readBoard(root).then(
        () => { settled = true; assert.fail("expected authority failure"); },
        (error: unknown) => { settled = true; return error; },
      );
      try {
        await othersFinished.promise;
        assert.equal(settled, false);
        released.resolve();
        const error = await pending;
        assert.equal(completed, ids.length);
        if (corrupt) {
          assert.ok(error instanceof DebtAuthorityCorruptionError);
          assert.equal(error.message, "debt document must begin with YAML front matter");
        } else assert.equal(error, earlyError);
      } finally {
        released.resolve();
        await pending;
        mock.mock.restore();
        syncBuiltinESMExports();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

async function world() {
  return await World.at(mkdtempSync(join(tmpdir(), "keiyaku-v4-debt-store-")));
}

test("Debt nuke lock contention is busy and does not delete unlocked files", async () => {
  const root = await world();
  try {
    const debts = Debts.of(root);
    const locked = await debts.add({ title: "Keep locked" });
    const otherDebt = await debts.add({ title: "Also owned" });
    assert.equal(locked.kind, "accepted");
    assert.equal(otherDebt.kind, "accepted");
    if (locked.kind !== "accepted" || otherDebt.kind !== "accepted") return;
    const owned = debtAuthorityFile(root, locked.value.id);
    const other = debtAuthorityFile(root, otherDebt.value.id);
    const foreign = join(root, ".keiyaku", "debts", "Not-Valid.md");
    writeFileSync(foreign, "invalid coordinate\n");
    const ownedBytes = readFileSync(owned);
    const otherBytes = readFileSync(other);
    const held = await acquireSqliteTransactionLock({
      path: join(root, ".keiyaku", "locks", "debt", `${parseDebtId(locked.value.id).localId}.sqlite`),
      mode: "immediate",
      timeoutMs: 100,
    });
    try {
      await assert.rejects(nukeDebt(root, { timeoutMs: 25 }), /Debt reset lock contention/u);
      assert.deepEqual(readFileSync(owned), ownedBytes);
      assert.deepEqual(readFileSync(other), otherBytes);
      assert.equal(readFileSync(foreign, "utf8"), "invalid coordinate\n");
    } finally {
      held.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Debt nuke re-enumerates after the allocation lock so a Debt created while waiting is removed", async () => {
  const root = await world();
  try {
    const debts = Debts.of(root);
    const ownedDebt = await debts.add({ title: "Already owned" });
    assert.ok(ownedDebt.kind === "accepted", "expected ownedDebt.kind = \"accepted\"");
    const existing = debtAuthorityFile(root, ownedDebt.value.id);
    const created = join(root, ".keiyaku", "debts", "created-while-waiting.md");
    const held = await acquireSqliteTransactionLock({
      path: join(root, ".keiyaku", "locks", "debt-allocation.sqlite"),
      mode: "immediate",
      timeoutMs: 100,
    });
    const pending = nukeDebt(root, { timeoutMs: 1000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(created, "not Debt authority\n");
    } finally {
      held.close();
    }
    await pending;
    assert.equal(existsSync(existing), false);
    assert.equal(existsSync(created), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Debt nuke removes empty nested Debt directories when there are no owned files", async () => {
  const root = await world();
  try {
    const debts = join(root, ".keiyaku", "debts");
    mkdirSync(join(debts, "nested", "deeper"), { recursive: true });
    await nukeDebt(root);
    assert.equal(existsSync(join(debts, "nested", "deeper")), false);
    assert.equal(existsSync(join(debts, "nested")), false);
    assert.equal(existsSync(debts), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested Debt authority remains discoverable after a fresh World observation", async () => {
  const root = await world();
  try {
    const first = Debts.of(root);
    const added = await first.add({ title: "Nested durable", namespace: ["deep", "inside"] });
    assert.ok(added.kind === "accepted", "expected added.kind = \"accepted\"");

    const second = Debts.of(await World.at(root));
    const read = await second.debt({ id: added.value.id }).read();
    assert.equal(read?.debt.title, "Nested durable");
    const listed = await second.list({ namespace: ["deep", "inside"] });
    assert.equal(listed.kind, "accepted");
    if (listed.kind === "accepted")
      assert.deepEqual(
        listed.value.rows.map((row) => row.id),
        [added.value.id],
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
