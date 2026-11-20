import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_REF } from "../../src/git/read-observation.js";
import { withGitShim } from "./git.js";
import { settlementProbe, waitForCondition } from "./process.js";

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
