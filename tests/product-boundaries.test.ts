import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akumas, Keiyaku, World } from "../src/index.js";
import { bodyRequestExecution } from "../src/akuma/requests.js";

test("Contract and Akumas capture only their own composition inputs", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-product-boundaries-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const world = await World.at(root);
  assert.throws(() => Keiyaku.with(null as never), TypeError);
  assert.throws(() => Akumas.of(world, null as never), TypeError);
  assert.deepEqual(Object.keys(Akumas.of(world)), []);

  const contracts = Keiyaku.with({
    actor: "contract-actor",
    hooks: { create: [], destroy: [] },
    requireBranchesToBeUpToDate: true,
    execution: bodyRequestExecution({ directory: join(root, "contract-requests") }),
  });
  assert.deepEqual(Object.keys(contracts).sort(), ["bind", "list", "observe", "select"]);
  assert.equal("call" in contracts, false);
  assert.equal("nuke" in contracts, false);
  assert.equal("tasks" in contracts, false);

  const akumas = Akumas.of(world, { execution: bodyRequestExecution({ directory: join(root, "akuma-requests") }) });
  assert.equal("actor" in akumas, false);
  assert.equal("hooks" in akumas, false);
  assert.equal("requireBranchesToBeUpToDate" in akumas, false);
  assert.equal("tasks" in akumas, false);
  assert.throws(
    () => Akumas.of(world, { actor: "must stay Contract-local" } as never),
    /Akumas\.of input has unknown field: actor/u,
  );
  assert.throws(
    () => akumas.status({ path: world, akuma: "aku/worker/1234abcd" } as never),
    /does not accept path; select World with Akumas\.of/u,
  );
  await assert.rejects(
    Akumas.of(world).wait({ akuma: ["kei/needs-explicit-repo"] }),
    /Contract Akuma selector requires repo/u,
  );
});
