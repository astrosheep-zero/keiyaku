import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akumas, Keiyaku, World } from "../src/index.js";
import { bodyRequestExecution } from "../src/akuma/requests.js";
import { composeContractLibrary } from "../src/library/keiyaku.js";

test("Contract and Akumas capture only their own composition inputs", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-product-boundaries-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const world = await World.at(root);
  assert.throws(() => Keiyaku.with(null as never), TypeError);
  // Public construction is local at runtime too: no value reaching the public surface selects a
  // private carrier, and the execution field is refused rather than honored.
  assert.throws(
    () =>
      Keiyaku.with({
        execution: { channel: { kind: "body-request", directory: join(root, "contract-requests") } },
      } as never),
    /unknown field: execution/u,
  );
  assert.throws(
    () => Keiyaku.with({ execution: { channel: { kind: "local" } } } as never),
    /unknown field: execution/u,
  );
  assert.throws(() => Akumas.of(null as never), TypeError);
  assert.deepEqual(Object.keys(Akumas.of(world)), []);

  const contracts = composeContractLibrary(bodyRequestExecution({ directory: join(root, "contract-requests") }), {
    actor: "contract-actor",
  });
  assert.deepEqual(Object.keys(contracts).sort(), ["bind", "list", "observe", "reconcile", "select"]);
  assert.equal("call" in contracts, false);
  assert.equal("nuke" in contracts, false);
  assert.equal("tasks" in contracts, false);

  const akumas = Akumas.of(world);
  assert.equal("actor" in akumas, false);
  assert.equal("hooks" in akumas, false);
  assert.equal("requireBranchesToBeUpToDate" in akumas, false);
  assert.equal("tasks" in akumas, false);
  assert.throws(
    () => akumas.status({ path: world, akuma: "aku/worker/1234abcd" } as never),
    /does not accept path; select World with Akumas\.of/u,
  );
  await assert.rejects(
    Akumas.of(world).wait({ akuma: ["kei/needs-explicit-repo"] }),
    /Contract Akuma selector requires repo/u,
  );
});
