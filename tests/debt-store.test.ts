import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fsPromises, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { deferred as promiseBarrier } from "./support/process.js";
import { debtAuthorityFile, debtDocument, writeDebtAuthority } from "./support/debt.js";
import { DebtAuthorityCorruptionError } from "../src/debt/document.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { Debts, observeRecentDebtStatus } from "../src/debt/index.js";
import { nukeDebt } from "../src/debt/operations.js";
import { type DebtId } from "../src/debt/identity.js";
import { readBoard } from "../src/debt/store.js";
import { World } from "../src/world.js";

test("recent Debt catalogues exclude terminal work before bounding and judge its released prerequisites", async (t) => {
  const root = await world();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const document of [
    debtDocument({ id: "debt/done", title: "Completed", state: "done", updatedAt: "2026-08-20T00:00:00.000Z" }),
    debtDocument({ id: "debt/drop", title: "Dropped", state: "drop", updatedAt: "2026-08-19T00:00:00.000Z" }),
    debtDocument({
      id: "debt/blocked",
      title: "Blocked",
      needs: ["debt/missing"],
      updatedAt: "2026-08-18T00:00:00.000Z",
    }),
    debtDocument({ id: "debt/ready", title: "Ready", needs: ["debt/done", "debt/drop"] }),
  ])
    writeDebtAuthority(root, document);

  assert.deepEqual(await observeRecentDebtStatus(root, { limit: 1 }), {
    rows: [{ id: "debt/blocked", title: "Blocked", priority: 2, disposition: "blocked" }],
    hasMore: true,
  });
  assert.deepEqual(await observeRecentDebtStatus(root), {
    rows: [
      { id: "debt/blocked", title: "Blocked", priority: 2, disposition: "blocked" },
      { id: "debt/ready", title: "Ready", priority: 2, disposition: "ready" },
    ],
    hasMore: false,
  });
});

test("complete Debt reads bound in-flight I/O and retain canonical board and byte order", async (t) => {
  const root = await world();
  const ids = Array.from({ length: 24 }, (_, index) => `debt/read-${String(index).padStart(2, "0")}` as DebtId);
  for (const id of [...ids].reverse()) writeDebtAuthority(root, debtDocument({ id, title: id }));
  const firstWave = promiseBarrier<void>();
  const released = promiseBarrier<void>();
  const originalRead = fsPromises.readFile;
  let active = 0,
    maximum = 0,
    started = 0,
    completed = 0;
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
      let completed = 0,
        settled = false;
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
        () => {
          settled = true;
          assert.fail("expected authority failure");
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
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
    const owned = debtAuthorityFile(root, locked.id);
    const other = debtAuthorityFile(root, otherDebt.id);
    const foreign = join(root, ".keiyaku", "debts", "Not-Valid.md");
    writeFileSync(foreign, "invalid coordinate\n");
    const ownedBytes = readFileSync(owned);
    const otherBytes = readFileSync(other);
    const held = await acquireSqliteTransactionLock({
      path: join(root, ".keiyaku", "locks", "debt", `${locked.id.slice(5)}.sqlite`),
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
    assert.ok(ownedDebt.kind === "accepted", 'expected ownedDebt.kind = "accepted"');
    const existing = debtAuthorityFile(root, ownedDebt.id);
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

test("flat Debt authority remains discoverable after a fresh World observation", async () => {
  const root = await world();
  try {
    const first = Debts.of(root);
    const added = await first.add({ title: "Durable record" });
    assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');

    const second = Debts.of(await World.at(root));
    const read = await second.debt({ id: added.id }).read();
    assert.equal(read.kind, "present");
    if (read.kind !== "present") return;
    assert.equal(read.title, "Durable record");
    const listed = await second.list();
    assert.equal(listed.kind, "present");
    if (listed.kind !== "present") return;
    assert.deepEqual(
      listed.rows?.map((row) => row.id),
      [added.id],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
