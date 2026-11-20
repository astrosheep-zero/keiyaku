import assert from "node:assert/strict";
import test from "node:test";
import type { BodyLaunchEnd, LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { HeldAkumaLeash, readSeal, readSoul, type Soul } from "../src/akuma/heart/index.js";
import { akumaId, type AllocatedAkuma } from "../src/akuma/identity.js";
import { publishAkuma } from "../src/akuma/publication.js";
import { KeiyakuError } from "../src/errors.js";
import { World } from "../src/world.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

function soul(child: AllocatedAkuma, cwd: string): Soul {
  return {
    id: child.id,
    akumaName: child.akumaName,
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd,
    origin: { kind: "direct" },
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function assertUnborn(
  error: unknown, child: AllocatedAkuma, verdict: "sealed" | "unresolved",
): asserts error is KeiyakuError {
  assert.ok(error instanceof KeiyakuError);
  assert.ok(error.message.includes(child.id));
  assert.ok(error.message.includes(child.paths.directory));
  assert.match(error.message, new RegExp(`^Akuma birth ${verdict}: allocated `, "u"));
}

test("observation cancellation releases a born launch without waiting for its live Body", { timeout: 5_000 }, async (t) => {
  const worldPath = await World.at(temporaryDirectory(t, "keiyaku-publication-born-"));
  const controller = new AbortController();
  const { promise: completed, resolve: complete } = deferred<BodyLaunchEnd>();
  t.after(() => complete({ diagnostic: "fixture Body retired" }));
  let canceled = 0;
  let released = 0;
  const { child, failureStage } = await publishAkuma({
    worldPath,
    akumaName: "worker",
    signal: controller.signal,
    launch: async (allocated) => {
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      t.after(() => leash.release());
      await leash.birth(allocated.paths, soul(allocated, worldPath));
      controller.abort(new Error("stop observing"));
      return {
        completed,
        cancel: async () => { canceled += 1; },
        release: () => { released += 1; },
      } satisfies LiveBodyLaunch;
    },
  });
  assert.equal(failureStage, undefined);
  assert.equal((await readSoul(child.paths))?.id, child.id);
  assert.equal(canceled, 0);
  assert.equal(released, 1);
});

test("a Soul committed during cancellation is confirmed even while the leash remains held", async (t) => {
  const worldPath = await World.at(temporaryDirectory(t, "keiyaku-publication-racing-soul-"));
  const controller = new AbortController();
  const { promise: completed, resolve: complete } = deferred<BodyLaunchEnd>();
  let cancellations = 0;
  let releases = 0;
  const { child, failureStage } = await publishAkuma({
    worldPath,
    akumaName: "worker",
    signal: controller.signal,
    launch: async (allocated) => {
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      t.after(() => leash.release());
      controller.abort(new Error("stop observing"));
      return {
        completed,
        async cancel() {
          cancellations += 1;
          await leash.birth(allocated.paths, soul(allocated, worldPath));
          complete({ diagnostic: "launch ended during cancellation" });
        },
        release: () => { releases += 1; },
      };
    },
  });
  assert.equal(failureStage, undefined);
  assert.equal((await readSoul(child.paths))?.id, child.id);
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
});

test("unborn cancellation seals under the free leash and retains the original cause", async (t) => {
  const worldPath = await World.at(temporaryDirectory(t, "keiyaku-publication-sealed-"));
  const controller = new AbortController();
  const reason = new Error("stop before birth");
  const { promise: completed, reject: failExit } = deferred<BodyLaunchEnd>();
  let child!: AllocatedAkuma;
  let cancellations = 0;
  let releases = 0;
  await assert.rejects(publishAkuma({
    worldPath,
    akumaName: "worker",
    signal: controller.signal,
    launch: async (allocated) => {
      child = allocated;
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      t.after(() => leash.release());
      controller.abort(reason);
      return {
        completed,
        async cancel() {
          cancellations += 1;
          leash.release();
          failExit(new Error("exit observation failed"));
          throw new Error("cleanup failed");
        },
        release() {
          releases += 1;
          throw new Error("release failed");
        },
      };
    },
  }), (error: unknown) => {
    assertUnborn(error, child, "sealed");
    assert.equal(error.category, "aborted");
    assert.equal(error.cause, reason);
    assert.match(error.message, /stop before birth/u);
    return true;
  });
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  assert.equal((await readSeal(child.paths))?.evidence, reason.message);
  const leash = (await HeldAkumaLeash.try(child.paths))!;
  try {
    assert.equal(await leash.birth(child.paths, soul(child, worldPath)), "sealed");
  } finally {
    leash.release();
  }
  assert.equal(await readSoul(child.paths), null);
});

test("pending owned cancellation is bounded and a held leash leaves unborn custody unresolved", { timeout: 5_000 }, async (t) => {
  const worldPath = await World.at(temporaryDirectory(t, "keiyaku-publication-unresolved-"));
  const controller = new AbortController();
  const reason = new Error("stop with held custody");
  let child!: AllocatedAkuma;
  let held!: HeldAkumaLeash;
  let cancellations = 0;
  let releases = 0;
  await assert.rejects(publishAkuma({
    worldPath,
    akumaName: "worker",
    signal: controller.signal,
    launch: async (allocated) => {
      child = allocated;
      held = (await HeldAkumaLeash.try(child.paths))!;
      t.after(() => held.release());
      controller.abort(reason);
      return {
        completed: deferred<BodyLaunchEnd>().promise,
        cancel() {
          cancellations += 1;
          return deferred<void>().promise;
        },
        release: () => { releases += 1; },
      };
    },
  }), (error: unknown) => {
    assertUnborn(error, child, "unresolved");
    assert.equal(error.cause, reason);
    return true;
  });
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  held.release();
  assert.equal(await readSeal(child.paths), null);
  assert.equal(await readSoul(child.paths), null);
  const later = (await HeldAkumaLeash.try(child.paths))!;
  try {
    assert.equal(await later.sealIfUnborn(child.paths, { evidence: "later judgment", at: soul(child, worldPath).createdAt }), "sealed");
  } finally {
    later.release();
  }
});

test("publication observes a real prebirth Body Seal without replacing it", async (t) => {
  const worldPath = await World.at(temporaryDirectory(t, "keiyaku-publication-body-failed-"));
  let child!: AllocatedAkuma;
  await assert.rejects(publishAkuma({
    worldPath,
    akumaName: "worker",
    launch: async (allocated) => {
      child = allocated;
      const completion = driveAkumaBody({ paths: child.paths }, undefined);
      return {
        completed: completion.then(() => ({ diagnostic: "fixture Body finished" })),
        cancel: async () => { await completion; },
        release() {},
      };
    },
  }), (error: unknown) => {
    assertUnborn(error, child, "sealed");
    assert.match(error.message, /Akuma wake has no born soul/u);
    return true;
  });
  assert.equal((await readSeal(child.paths))?.evidence, "Akuma wake has no born soul");
});

test("a readable Soul for a different identity is corruption, never adopted or sealed", async (t) => {
  const worldPath = await World.at(temporaryDirectory(t, "keiyaku-publication-wrong-soul-"));
  const other = akumaId({ akumaName: "other", suffix: "feed1234" });
  let child!: AllocatedAkuma;
  await assert.rejects(publishAkuma({
    worldPath,
    akumaName: "worker",
    launch: async (allocated) => {
      child = allocated;
      const leash = (await HeldAkumaLeash.try(child.paths))!;
      try {
        await leash.birth(child.paths, { ...soul(child, worldPath), id: other, akumaName: "other" });
      } finally {
        leash.release();
      }
      return {
        completed: Promise.resolve({ diagnostic: "launch exited" }),
        cancel: async () => {},
        release() {},
      };
    },
  }), (error: unknown) => {
    assertUnborn(error, child, "unresolved");
    assert.equal(error.category, "authority-corruption");
    assert.ok(error.message.includes(other));
    return true;
  });
  assert.equal((await readSoul(child.paths))?.id, other);
  assert.equal(await readSeal(child.paths), null);
});
