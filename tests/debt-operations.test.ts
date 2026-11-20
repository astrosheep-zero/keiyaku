import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Debts, type DebtId } from "../src/debt/index.js";
import { parseDebtDocument, type DebtDocument } from "../src/debt/document.js";
import { debtAuthorityFile } from "./support/debt.js";
import { World, type WorldRoot } from "../src/world.js";

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
      kind: "accepted",
      changes: ["title", "note", "state"],
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
      kind: "accepted",
      changes: ["note"],
    });
    assert.equal((await readDetail(debts, id)).state, "done");
    assert.equal((await readDetail(debts, id)).note, "later testimony");
    assert.deepEqual(await debts.debt({ id }).update({ title: "Edited after completion" }), {
      kind: "accepted",
      changes: ["title"],
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
