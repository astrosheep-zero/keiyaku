import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitPrivateStateSeatContentionError, withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import type { GitRepository } from "../src/git/process.js";

function seatRepository(context: TestContext): GitRepository {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-private-state-seat-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { gitPath: "git", effectiveCwd: root, invocationWorktree: root, primaryWorktree: root, commonDirectory: root };
}

test("private-state acquisition timeout neither breaks the holder nor limits its action", async (context) => {
  const repository = seatRepository(context);
  let enter!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withPrivateStatePublicationSeat(
    repository,
    async () => {
      enter();
      await held;
      return "held";
    },
    { timeoutMs: 1 },
  );
  await acquired;
  try {
    // The holder outlives its own acquisition budget while another caller times out.
    await assert.rejects(
      withPrivateStatePublicationSeat(repository, async () => assert.fail("waiter entered a held seat"), {
        timeoutMs: 25,
      }),
      (error: unknown) => error instanceof GitPrivateStateSeatContentionError && error.reason === "timeout",
    );
  } finally {
    release();
  }
  assert.deepEqual(await holder, { value: "held" });
  assert.equal((await withPrivateStatePublicationSeat(repository, async () => "reacquired")).value, "reacquired");
});

test("same-context private-state seat reentry fails instead of deadlocking", { timeout: 1_000 }, async (context) => {
  const repository = seatRepository(context);
  await withPrivateStatePublicationSeat(repository, async () => {
    await assert.rejects(
      withPrivateStatePublicationSeat(repository, async () => undefined),
      {
        message: /private-state publication seat reentered/u,
      },
    );
  });
});
