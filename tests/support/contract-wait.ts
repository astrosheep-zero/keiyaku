import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withGitShim } from "./git.js";
import { waitForCondition } from "./process.js";

/** Mark each fully retired Git decode reader; the first is the wait's baseline. */
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
