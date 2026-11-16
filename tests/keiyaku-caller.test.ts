import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Akuma, Keiyaku, World } from "../src/index.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { isolateUserHome } from "./support/user-home.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";

isolateUserHome();

test("one effective caller selection serves spawn, whoami, mine and actor-only operations", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-explicit-caller-");
  const home = temporaryDirectory(t, "keiyaku-explicit-caller-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const inherited = { PI_SESSION_ID: "parent", CODEX_THREAD_ID: "other-host", KEIYAKU_EXTERNAL_CALLER: "bad" };
  const caller = { kind: "external" as const, integration: "pi", id: "current-session" };
  const explicit = Keiyaku.at({ cwd: world, environment: inherited, caller, home });
  caller.id = "changed-after-construction";
  assert.deepEqual((await explicit.whoami()).self, { kind: "external", id: "pi:current-session" });
  assert.equal((await Keiyaku.at({ cwd: world, environment: inherited, home }).whoami()).self.kind, "invalid");
  assert.deepEqual(
    (await Keiyaku.at({ cwd: world, environment: { PI_SESSION_ID: "ordinary-host" }, home }).whoami()).self,
    { kind: "external", id: "pi:ordinary-host" },
  );
  const actor = { kind: "akuma" as const, world, akumaId: "aku/actor/1234abcd" as const };
  const environment = { ...inherited, KEIYAKU_ACTOR_ID: actor.akumaId, KEIYAKU_ACTOR_WORLD: world };
  const acting = Keiyaku.at({ cwd: world, environment, caller, home });
  assert.deepEqual((await acting.whoami()).self, actor);
  const partial = Keiyaku.at({
    cwd: world, environment: { ...inherited, KEIYAKU_ACTOR_ID: actor.akumaId }, caller, home,
  });
  const bothRequired = /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u;
  for (const operation of [
    () => partial.spawn({ akumaName: "acp-worker", bare: true }),
    () => partial.ls({ selector: "aku/*", mine: true }),
    () => partial.report({ text: "must not admit" }),
  ]) await assert.rejects(operation, bothRequired);
  const invalid = (await partial.whoami()).self;
  assert.equal(invalid.kind, "invalid");
  if (invalid.kind === "invalid") assert.match(invalid.diagnostic, bothRequired);
  await assert.rejects(explicit.report({ text: "external callers are not actors" }), /explicit Akuma identity/u);

  const receipt = join(root, "body-pids");
  const restore = installAkumaBodyPidReceipt(receipt);
  let operationFailed = true;
  try {
    for (const [facet, expectedCaller] of [
      [explicit, { kind: "external", integration: "pi", id: "current-session" }],
      [acting, actor],
    ] as const) {
      const spawned = await facet.spawn({ akumaName: "acp-worker", bare: true, prompt: "complete" });
      assert.equal(spawned.kind, "spawned");
      if (spawned.kind !== "spawned") assert.fail(JSON.stringify(spawned));
      const child = Akuma.select(world, spawned.akumaId);
      assert.equal((await child.idle({ timeoutMs: 30_000 })).reason, "completed");
      assert.deepEqual((await child.status()).birth.caller, expectedCaller);
      const mine = await facet.ls({ selector: "aku/*", mine: true });
      assert.equal(mine.kind, "akuma-catalogue");
      if (mine.kind !== "akuma-catalogue") assert.fail("expected Akuma list");
      assert.deepEqual(mine.rows?.map((row) => row.id), [spawned.akumaId]);
    }
    operationFailed = false;
  } finally {
    try {
      await cleanupSpawnCapableFixtureForTest(t, { fixturePath: root, pidReceiptPath: receipt, timeoutMs: 30_000, operationFailed });
    } finally {
      restore();
    }
  }
});
