import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akumas, Keis, KeiyakuError, Repo, World } from "../src/index.js";

test("Contract and Akumas capture only their own composition inputs", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-product-boundaries-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const world = await World.at(root);
  execFileSync("git", ["init", "--quiet", root]);
  const repo = await Repo.at({ path: root });
  const invalidInput = (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input";
  assert.throws(() => Keis.of(null as never), invalidInput);
  assert.throws(() => Akumas.of(null as never), invalidInput);
  assert.deepEqual(Object.keys(Akumas.of(world)), []);

  const contracts = Keis.of(repo);
  assert.deepEqual(Object.keys(contracts).sort(), ["bind", "kei", "list", "observe", "reconcile", "resolve", "wait"]);
  assert.equal("spawn" in contracts, false);
  assert.equal("nuke" in contracts, false);
  assert.equal("debts" in contracts, false);
  assert.throws(() => contracts.kei({ repo, id: "kei/example" } as never), invalidInput);
  for (const run of [
    () => contracts.bind({ repo, markdown: "" } as never),
    () => contracts.resolve({ repo } as never),
    () => contracts.list({ repo } as never),
    () => contracts.observe({ repo, id: "kei/example" } as never),
    () => contracts.wait({ repo, contracts: ["kei/example"] } as never),
    () => contracts.reconcile({ repo } as never),
  ]) await assert.rejects(run, invalidInput);

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
