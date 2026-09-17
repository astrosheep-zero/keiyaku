import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitPrivateStateSeatContentionError,
  withPrivateStatePublicationSeat,
} from "../src/git/private-state-seat.js";
import type { GitRepository } from "../src/git/process.js";

function seatRepository(): GitRepository {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-private-state-seat-"));
  return {
    gitPath: "git",
    effectiveCwd: root,
    invocationWorktree: root,
    primaryWorktree: root,
    commonDirectory: root,
  };
}

test("private-state seat acquisition times out without breaking the holder", async () => {
  const repository = seatRepository();
  const { promise: hold, resolve: releaseHolder } = promiseBarrier<void>();
  const { promise: acquired, resolve: holding } = promiseBarrier<void>();
  const holder = withPrivateStatePublicationSeat(repository, async () => {
    holding?.();
    await hold;
    return "held";
  });
  await acquired;
  const started = performance.now();
  await assert.rejects(
    withPrivateStatePublicationSeat(repository, async () => "waiter", { timeoutMs: 100 }),
    (error: unknown) => error instanceof GitPrivateStateSeatContentionError && error.reason === "timeout",
  );
  assert.ok(performance.now() - started < 1_000);
  releaseHolder?.();
  assert.equal((await holder).value, "held");
});

test("same-context private-state seat reentry fails immediately", async () => {
  const repository = seatRepository();
  const started = performance.now();
  await withPrivateStatePublicationSeat(repository, async () => {
    await assert.rejects(withPrivateStatePublicationSeat(repository, async () => undefined), {
      message: /private-state publication seat reentered/u,
    });
  });
  assert.ok(performance.now() - started < 250);
});
