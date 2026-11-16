import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Akuma, Keiyaku, KeiyakuUsageError, World } from "../src/index.js";
import { harnessOwner, requireOwner } from "@astrosheep/square";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { readHeart, readLatestTurnForBody } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { isolateUserHome } from "./support/user-home.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";

isolateUserHome();

test("host identity admission is synchronous and preserves Square Owner limits", () => {
  const context = { cwd: "/missing-identity-admission", environment: { PI_SESSION_ID: "fallback" } };
  for (const owner of ["   ", "bad\nowner", "\u00e9".repeat(257)]) {
    assert.throws(() => Keiyaku.for({ ...context, identity: { owner } } as never), KeiyakuUsageError);
  }
  assert.throws(() => Keiyaku.for({ ...context, identity: {} } as never), KeiyakuUsageError);
});

test("session lineage stays native while opaque and agent Owners retain their whole identity", async (t) => {
  const cwd = temporaryDirectory(t, "keiyaku-owner-lineage-");
  const home = temporaryDirectory(t, "keiyaku-owner-lineage-home-");
  const self = async (owner: ReturnType<typeof requireOwner>) =>
    (await Keiyaku.for({ cwd, environment: {}, home, identity: { owner } }).whoami()).self;
  assert.deepEqual(await self(harnessOwner({ channel: "claude-code", session: "legacy:session" })),
    { kind: "external", id: "claude:legacy:session" });
  for (const owner of [
    requireOwner("local owner"),
    harnessOwner({ channel: "pi", session: "shared", agent: "one" }),
    harnessOwner({ channel: "pi", session: "shared", agent: "two" }),
  ]) {
    assert.deepEqual(await self(owner), { kind: "external", id: `square:${owner}` });
  }
});

test("a Square-admitted Owner that cannot round-trip as a harness coordinate stays opaque", async (t) => {
  const cwd = temporaryDirectory(t, "keiyaku-owner-unrepresentable-");
  const home = temporaryDirectory(t, "keiyaku-owner-unrepresentable-home-");
  const owner = requireOwner("pi:session\uD800");
  const facet = Keiyaku.for({ cwd, environment: {}, home, identity: { owner } });
  assert.deepEqual((await facet.whoami()).self, { kind: "external", id: `square:${owner}` });
});

test("one host identity serves spawn, whoami, mine and actor-only operations", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-explicit-caller-");
  const home = temporaryDirectory(t, "keiyaku-explicit-caller-home-");
  const world = await World.at(root);
  installHostAcpFixture(world);
  const inherited = { PI_SESSION_ID: "parent", CODEX_THREAD_ID: "other-host", KEIYAKU_EXTERNAL_CALLER: "bad" };
  const identity = { owner: harnessOwner({ channel: "pi", session: "current-session" }) };
  const explicit = Keiyaku.for({ cwd: world, environment: inherited, identity, home });
  identity.owner = harnessOwner({ channel: "pi", session: "changed-after-construction" });
  const other = Keiyaku.for({ cwd: world, environment: inherited, identity, home });
  assert.deepEqual((await other.whoami()).self, { kind: "external", id: "pi:changed-after-construction" });
  assert.deepEqual((await explicit.whoami()).self, { kind: "external", id: "pi:current-session" });
  assert.equal((await Keiyaku.for({ cwd: world, environment: inherited, home }).whoami()).self.kind, "invalid");
  assert.deepEqual(
    (await Keiyaku.for({ cwd: world, environment: { PI_SESSION_ID: "ordinary-host" }, home }).whoami()).self,
    { kind: "external", id: "pi:ordinary-host" },
  );
  const actor = { kind: "akuma" as const, world, akumaId: "aku/actor/1234abcd" as const };
  const environment = { ...inherited, KEIYAKU_ACTOR_ID: actor.akumaId, KEIYAKU_ACTOR_WORLD: world };
  const acting = Keiyaku.for({ cwd: world, environment, identity, home });
  assert.deepEqual((await acting.whoami()).self, actor);
  const partial = Keiyaku.for({
    cwd: world, environment: { ...inherited, KEIYAKU_ACTOR_ID: actor.akumaId }, identity, home,
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
  await assert.rejects(explicit.report({ text: "external callers are not actors" }), /explicit Akuma execution identity/u);

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
      const paths = pathsForAkumaId(world, child.id);
      const body = (await readHeart(paths)).latestBody!;
      assert.equal((await readLatestTurnForBody(paths, body.sequence))?.initiator,
        facet === explicit ? "pi:current-session" : identity.owner);
      const mine = await facet.ls({ selector: "aku/*", mine: true, selection: "all" });
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
