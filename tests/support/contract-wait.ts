import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { TimerOptions } from "node:timers";
import timers from "node:timers/promises";
import { GIT_REF } from "../../src/git/read-observation.js";
import { withGitShim } from "./git.js";
import { settlementProbe, waitForCondition } from "./process.js";

/** Drive the native deadline without charging fixture I/O against it. */
export async function withWaitClock<T>(
  t: TestContext,
  timeoutMs: number,
  run: (clock: { within<R>(action: () => R): R; expire(): void }) => Promise<T>,
  { advancePolls = false } = {},
): Promise<T> {
  const wait = new AsyncLocalStorage<true>();
  const realNow = performance.now.bind(performance);
  let now = Math.floor(realNow());
  const deadline = now + timeoutMs;
  const realTimeout = setTimeout;
  let alarm: (() => void) | undefined;
  const clock = t.mock.method(performance, "now", () => wait.getStore() ? now : realNow());
  const timer = t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (wait.getStore() && ms === timeoutMs) alarm = () => callback(...args);
    return realTimeout(callback, ms, ...args);
  });
  const expire = () => wait.run(true, () => {
    assert.ok(alarm, "the wait armed its deadline");
    now = deadline;
    alarm();
  });
  const realDelay = timers.setTimeout;
  const delay = !advancePolls ? undefined : t.mock.method(timers, "setTimeout", async <R>(
    ms?: number, value?: R, options?: TimerOptions,
  ): Promise<R> => {
    // Advance on the wait's polling sleep, not on physical I/O or retirement timers.
    if (!wait.getStore() || ms === undefined || value !== undefined || options?.ref === false || !options?.signal)
      return await realDelay(ms, value, options);
    options.signal.throwIfAborted();
    now += Math.max(1, ms);
    if (now >= deadline) expire();
    options.signal.throwIfAborted();
    return value as R;
  });
  if (delay) syncBuiltinESMExports();
  try {
    return await run({ within: (action) => wait.run(true, action), expire });
  } finally {
    timer.mock.restore();
    clock.mock.restore();
    if (delay) {
      delay.mock.restore();
      syncBuiltinESMExports();
    }
  }
}

/** Batch exits are raw Git markers, not completed Contract observations. */
export function withContractWaitBarrier<T>(root: string, run: (barrier: Readonly<{
  gitPath: string;
  reset(): void;
  reads(count?: number): Promise<void>;
}>) => Promise<T>): Promise<T> {
  const log = join(root, "contract-wait-reader.log");
  return withGitShim([
    'if [ "$1 $2" = "cat-file --batch" ]; then',
    '  "$KEIYAKU_REAL_GIT" "$@"',
    '  status=$?',
    '  printf "closed\\n" >> "$WAIT_READER_LOG"',
    '  exit "$status"',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { WAIT_READER_LOG: log }, async (gitPath) => await run({
    gitPath,
    reset: () => writeFileSync(log, ""),
    reads: async (count = 1) => await waitForCondition("Contract wait reader retirement", () =>
      existsSync(log) && readFileSync(log, "utf8").split("\n").filter(Boolean).length >= count,
    ),
  }));
}

/** A subsequent round for the same epoch proves the prior exact observation returned. */
export function withContractWaitEpochs<T>(root: string, run: (barrier: Readonly<{
  gitPath: string;
  observed(epoch: string, pending: Promise<unknown>): Promise<void>;
}>) => Promise<T>): Promise<T> {
  const log = join(root, "contract-wait-epochs.log");
  return withGitShim([
    'if [ "$1 $2 $3 $4" = "rev-parse --verify --quiet $WAIT_STATE_REF" ]; then',
    '  epoch=$("$KEIYAKU_REAL_GIT" "$@") || exit $?',
    '  printf "%s\\n" "$epoch" >> "$WAIT_EPOCH_LOG"',
    '  printf "%s\\n" "$epoch"',
    '  exit 0',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { WAIT_EPOCH_LOG: log, WAIT_STATE_REF: GIT_REF }, async gitPath => await run({
    gitPath,
    observed: async (epoch, pending) => await waitForCondition(`Contract observation of ${epoch}`, () =>
      existsSync(log) && readFileSync(log, "utf8").split("\n").filter(mark => mark === epoch).length >= 2,
      { terminalState: settlementProbe(pending, () => "wait returned before the observation barrier") },
    ),
  }));
}
