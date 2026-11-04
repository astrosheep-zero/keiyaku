import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLaunchEnd, LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { HeldAkumaLeash, readSeal, readSoul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, type AkuId } from "../src/akuma/identity.js";
import { publishAkuma } from "../src/akuma/publication.js";
import { World } from "../src/world.js";
import { allocatedHeart, noBodyLaunch } from "./support/akuma-fixtures.js";
import { deferred as promiseBarrier, temporaryDirectory } from "./support/process.js";

/** Publish one worker under the fixture root; the launch body stays at the call site. */
function publishWorker(
  root: string,
  signal: AbortSignal | undefined,
  launch: (allocated: Awaited<ReturnType<typeof allocatedHeart>>) => Promise<LiveBodyLaunch | void>,
) {
  return publishAkuma({ worldPath: root, archetype: "worker", ...(signal === undefined ? {} : { signal }), launch });
}

test("cancelled publication returns born when Soul appears during termination behind a successor leash", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-publication-cancelled-soul-")));
  const controller = new AbortController();
  const { promise: launchStarted, resolve: launched } = promiseBarrier<void>();
  const { promise: termination, resolve: terminate } = promiseBarrier<void>();
  let terminateCount = 0;
  let releaseCount = 0;
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  let successor: HeldAkumaLeash | undefined;
  try {
    const publication = publishWorker(root, controller.signal, async (allocated) => {
        childPaths = allocated.paths;
        const leash = (await HeldAkumaLeash.try(allocated.paths))!;
        const child: LiveBodyLaunch = {
          completed: Promise.resolve({ diagnostic: "fixture Body canceled" }),
          cancel: async () => {
            terminateCount += 1;
            await leash.birth(allocated.paths, {
              id: allocated.id,
              archetype: "worker",
              provider: { name: "codex-app-server", kind: "codex-app-server" },
              options: {},
              cwd: root,
              origin: { kind: "direct" },
              createdAt: "2026-08-26T00:00:00.000Z",
            });
            leash.release();
            successor = (await HeldAkumaLeash.try(allocated.paths))!;
            await termination;
          },
          release: () => {
            releaseCount += 1;
          },
        };
        launched();
        return child;
    });
    await launchStarted;
    controller.abort(new Error("cancelled publication"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(terminateCount, 1);
    assert.equal(releaseCount, 0);
    terminate();
    const born = await publication;
    assert.equal(born.paths, childPaths);
    assert.equal((await readSoul(childPaths!))?.id, born.id);
    assert.equal(releaseCount, 1);
  } finally {
    successor?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled publication waits for an already-born child to exit before releasing custody", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-born-pending-exit-"));
  const controller = new AbortController();
  const { promise: launchStarted, resolve: launched } = promiseBarrier<void>();
  const { promise: completed, resolve: resolveExit } = promiseBarrier<BodyLaunchEnd>();
  let terminated = false;
  let released = false;
  const publication = publishWorker(root, controller.signal, async (allocated) => {
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      await leash.birth(allocated.paths, {
        id: allocated.id,
        archetype: "worker",
        provider: { name: "codex-app-server", kind: "codex-app-server" },
        options: {},
        cwd: root,
        origin: { kind: "direct" },
        createdAt: "2026-08-26T00:00:00.000Z",
      });
      leash.release();
      const child: LiveBodyLaunch = {
        completed,
        cancel: async () => {
          terminated = true;
        },
        release: () => {
          released = true;
        },
      };
      launched();
      return child;
  });
  await launchStarted;
  controller.abort(new Error("cancel born pending exit"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(terminated, false);
  assert.equal(released, false);
  resolveExit({ diagnostic: "fixture Body completed" });
  await publication;
  assert.equal(released, true);
});

test("cancelled publication terminates its child, observes Seal, and then rejects the original reason", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-cancelled-seal-"));
  const controller = new AbortController();
  const reason = new Error("cancelled publication");
  const { promise: launchStarted, resolve: launched } = promiseBarrier<void>();
  let terminateCount = 0;
  let releaseCount = 0;
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  const publication = publishWorker(root, controller.signal, async (allocated) => {
      childPaths = allocated.paths;
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      const child: LiveBodyLaunch = {
        completed: Promise.resolve({ diagnostic: "fixture Body canceled" }),
        cancel: async () => {
          terminateCount += 1;
          leash.release();
        },
        release: () => {
          releaseCount += 1;
        },
      };
      launched();
      return child;
  });
  await launchStarted;
  controller.abort(reason);
  await assert.rejects(publication, (error: unknown) => error === reason);
  assert.equal(terminateCount, 1);
  assert.equal(releaseCount, 1);
  assert.equal((await readSeal(childPaths!))?.evidence, "cancelled publication");
  const leash = (await HeldAkumaLeash.try(childPaths!))!;
  try {
    assert.equal(
      await leash.birth(childPaths!, {
        id: "aku/worker/00000000" as AkuId,
        archetype: "worker",
        provider: { name: "codex-app-server", kind: "codex-app-server" },
        options: {},
        cwd: root,
        origin: { kind: "direct" },
        createdAt: "2026-08-26T00:00:00.000Z",
      }),
      "sealed",
    );
  } finally {
    leash.release();
  }
  assert.equal(await readSoul(childPaths!), null);
});

test("cancelled publication remains pending with child custody until termination is confirmed", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-cancelled-pending-"));
  const controller = new AbortController();
  const { promise: launchStarted, resolve: launched } = promiseBarrier<void>();
  const { promise: termination, resolve: confirmTermination } = promiseBarrier<void>();
  let confirmExit!: () => void;
  const completed = new Promise<BodyLaunchEnd>((resolve) => {
    confirmExit = () => resolve({ diagnostic: "fixture Body canceled" });
  });
  let releaseCount = 0;
  const publication = publishWorker(root, controller.signal, async (allocated) => {
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      const child: LiveBodyLaunch = {
        completed,
        cancel: async () => {
          await termination;
          leash.release();
        },
        release: () => {
          releaseCount += 1;
        },
      };
      launched();
      return child;
  });
  await launchStarted;
  controller.abort(new Error("cancelled publication"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(releaseCount, 0);
  confirmTermination();
  confirmExit();
  await assert.rejects(publication, /cancelled publication/u);
  assert.equal(releaseCount, 1);
});

test("publication releases process custody after bounded observation of unsettled termination", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-publication-unsettled-custody-")));
  const controller = new AbortController();
  const reason = new Error("cancel unsettled custody");
  const { promise: launchStarted, resolve: started } = promiseBarrier<void>();
  let held: HeldAkumaLeash | undefined;
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  let released = false;
  try {
    const publication = publishWorker(root, controller.signal, async (allocated) => {
        childPaths = allocated.paths;
        held = (await HeldAkumaLeash.try(allocated.paths))!;
        started();
        return {
          completed: new Promise<BodyLaunchEnd>(() => {}),
          cancel: async () => await new Promise<void>(() => {}),
          release: () => {
            released = true;
          },
        } satisfies LiveBodyLaunch;
    });
    await launchStarted;
    controller.abort(reason);
    const began = performance.now();
    await assert.rejects(publication, (error: unknown) => error === reason);
    assert.ok(performance.now() - began < 2_000);
    assert.equal(released, true);
    assert.equal(await readSoul(childPaths!), null);
    held!.release();
    held = undefined;
    const leash = (await HeldAkumaLeash.try(childPaths!))!;
    try {
      assert.equal(
        await leash.sealIfUnborn(childPaths!, { evidence: "later leash judgment", at: "2026-08-26T00:00:03.000Z" }),
        "sealed",
      );
    } finally {
      leash.release();
    }
    assert.equal((await readSeal(childPaths!))?.evidence, "later leash judgment");
  } finally {
    held?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication preserves a Body failure that occurs before birth", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-failure-"));
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  await assert.rejects(
    publishWorker(root, undefined, async (allocated) => {
        childPaths = allocated.paths;
        await assert.rejects(driveAkumaBody({ paths: allocated.paths }, undefined, { spawn: noBodyLaunch }), /Akuma wake has no born soul/u);
        assert.equal((await readSeal(allocated.paths))?.evidence, "Akuma wake has no born soul");
    }),
    /Akuma wake has no born soul/u,
  );
  assert.equal(
    childPaths === undefined ? null : (await readSeal(childPaths))?.evidence,
    "Akuma wake has no born soul",
  );
});

test("publication observes an exited child before Soul and releases without terminating", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-exit-"));
  let released = false;
  let terminated = false;
  const child: LiveBodyLaunch = {
    completed: Promise.resolve({ diagnostic: "neutral launch ended before Soul" }),
    cancel: async () => {
      terminated = true;
    },
    release: () => {
      released = true;
    },
  };
  const started = performance.now();
  await assert.rejects(
    publishAkuma({ worldPath: root, archetype: "worker", launch: async () => child }),
    /neutral launch ended before Soul/u,
  );
  assert.ok(performance.now() - started < 1_000);
  assert.equal(released, true);
  assert.equal(terminated, false);
});

test("publication prefers an already-settled launch exit over a pre-written non-exit Seal", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-exit-prewritten-seal-"));
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  let resolveExit!: (end: BodyLaunchEnd) => void;
  const exit = { diagnostic: "neutral launch ended before Soul" };
  const child: LiveBodyLaunch = {
    completed: new Promise((resolve) => {
      resolveExit = resolve;
    }),
    cancel: async () => {},
    release: () => {},
  };
  await assert.rejects(
    publishWorker(root, undefined, async (allocated) => {
        childPaths = allocated.paths;
        const leash = (await HeldAkumaLeash.try(allocated.paths))!;
        await leash.sealIfUnborn(allocated.paths, { evidence: "body failure", at: new Date().toISOString() });
        leash.release();
        resolveExit(exit);
        return child;
    }),
    (error: unknown) => error instanceof Error && error.message === "neutral launch ended before Soul",
  );
  assert.equal((await readSeal(childPaths!))?.evidence, "body failure");
});

test("cancelled publication closes a live child before releasing its custody", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-live-"));
  const controller = new AbortController();
  const { promise: launchStarted, resolve: launched } = promiseBarrier<void>();
  let released = false;
  let terminated = false;
  let confirmExit!: () => void;
  const completed = new Promise<BodyLaunchEnd>((resolve) => {
    confirmExit = () => resolve({ diagnostic: "fixture Body canceled" });
  });
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  const publication = publishWorker(root, controller.signal, async (allocated) => {
      childPaths = allocated.paths;
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      const child: LiveBodyLaunch = {
        completed,
        cancel: async () => {
          terminated = true;
          leash.release();
          confirmExit();
        },
        release: () => {
          released = true;
        },
      };
      launched();
      return child;
  });
  await launchStarted;
  controller.abort(new Error("cancel live birth"));
  await assert.rejects(publication, /cancel live birth/u);
  assert.equal(released, true);
  assert.equal(terminated, true);
  assert.equal((await readSeal(childPaths!))?.evidence, "cancel live birth");
});

test("cancelled publication records a termination rejection and still seals before release", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-terminate-rejection-"));
  const controller = new AbortController();
  const reason = new Error("cancel terminate rejection");
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  let released = false;
  const { promise: launchStarted, resolve: started } = promiseBarrier<void>();
  const publication = publishWorker(root, controller.signal, async (allocated) => {
      childPaths = allocated.paths;
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      started();
      return {
        completed: Promise.resolve({ diagnostic: "fixture Body canceled" }),
        cancel: async () => {
          leash.release();
          throw new Error("terminate denied");
        },
        release: () => {
          released = true;
        },
      } satisfies LiveBodyLaunch;
  });
  await launchStarted;
  controller.abort(reason);
  await assert.rejects(publication, (error: unknown) => error === reason);
  assert.equal((await readSeal(childPaths!))?.evidence, "cancel terminate rejection");
  assert.equal(released, true);
});

test("cancelled publication records an exit rejection and still seals before release", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-akuma-publication-exit-rejection-"));
  const controller = new AbortController();
  const reason = new Error("cancel exit rejection");
  let childPaths: Awaited<ReturnType<typeof allocateAkumaDirectory>>["paths"] | undefined;
  let released = false;
  const { promise: launchStarted, resolve: started } = promiseBarrier<void>();
  const publication = publishWorker(root, controller.signal, async (allocated) => {
      childPaths = allocated.paths;
      const leash = (await HeldAkumaLeash.try(allocated.paths))!;
      started();
      return {
        completed: Promise.reject(new Error("exit evidence unavailable")),
        cancel: async () => {
          leash.release();
        },
        release: () => {
          released = true;
        },
      } satisfies LiveBodyLaunch;
  });
  await launchStarted;
  controller.abort(reason);
  await assert.rejects(publication, (error: unknown) => error === reason);
  assert.equal((await readSeal(childPaths!))?.evidence, "cancel exit rejection");
  assert.equal(released, true);
});

