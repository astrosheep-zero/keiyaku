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
  let releaseHolder: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let holding: (() => void) | undefined;
  const acquired = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const holder = withPrivateStatePublicationSeat(repository, async () => {
    holding?.();
    await hold;
    return "held";
  });
  await acquired;
  const started = performance.now();
  await assert.rejects(
    withPrivateStatePublicationSeat(repository, async () => "waiter"),
    (error: unknown) => error instanceof GitPrivateStateSeatContentionError && error.reason === "timeout",
  );
  assert.ok(performance.now() - started < 8_000);
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

test("a held private-state seat callback may outlive the acquire timeout", async () => {
  const repository = seatRepository();
  const outcome = await withPrivateStatePublicationSeat(repository, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    return "held";
  });
  assert.equal(outcome.value, "held");
  assert.equal(outcome.closeLag, undefined);
});
