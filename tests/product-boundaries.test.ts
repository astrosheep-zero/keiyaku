import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akumas, Keiyaku, World } from "../src/index.js";

test("Contract and Akumas capture only their own composition inputs", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-product-boundaries-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const world = await World.at(root);
  assert.throws(() => Keiyaku.with(null as never), TypeError);
  assert.throws(() => Akumas.of(null as never), TypeError);
  assert.deepEqual(Object.keys(Akumas.of(world)), []);

  const contracts = Keiyaku.with({ actor: "contract-actor" });
  assert.deepEqual(Object.keys(contracts).sort(), ["bind", "list", "observe", "reconcile", "resolve", "select", "wait"]);
  assert.equal("call" in contracts, false);
  assert.equal("nuke" in contracts, false);
  assert.equal("debts" in contracts, false);

  const akumas = Akumas.of(world);
  assert.equal("actor" in akumas, false);
  assert.equal("hooks" in akumas, false);
  assert.equal("requireBranchesToBeUpToDate" in akumas, false);
  assert.equal("debts" in akumas, false);
  assert.throws(
    () => akumas.status({ path: world, akuma: "aku/worker/1234abcd" } as never),
    /does not accept path; select World with Akumas\.of/u,
  );
  await assert.rejects(
    Akumas.of(world).wait({ akuma: ["kei/needs-explicit-repo"] }),
    /Akumas\.wait does not accept Contract selectors/u,
  );
});
