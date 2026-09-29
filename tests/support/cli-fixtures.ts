import { contractHead, contractId } from "../../src/core/facts/types.js";
import type { Catalog } from "../../src/cli/catalog.js";
import { parseArgv } from "../../src/cli/parse.js";
import type { ContractKanshiRow, KanshiReport } from "../../src/kanshi/index.js";
import type { ContractRow } from "../../src/protocol/read/status.js";

/** One parsed executable invocation; a help-only argv never reaches a product operation. */
export function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

/** Fresh receipt carriers only; expected renderings stay independent at the call site. */
export function receipt<const T extends { verb: string }>(values: T) {
  return { kind: "accepted" as const, head: contractHead("head"), facts: [], settlementLags: [], ...values };
}

/** Capture the process outcome of one in-process CLI invocation. */
export async function captureOutput(
  run: () => Promise<number>,
): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write;
  const writeStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { exit: await run(), stdout, stderr };
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
}

/** One settled Contract row; each override is the scenario delta under test. */
export function contractRow(overrides: Partial<ContractKanshiRow> = {}): ContractKanshiRow {
  return {
    id: contractId("kei/verified-commit"),
    title: "Verified commit",
    phase: "claimed",
    phaseAt: "2026-08-12T00:00:00.000Z",
    lastJournalAt: "2026-08-12T00:00:00.000Z",
    disposition: "terminal",
    workspace: "worktree",
    worktreePath: null,
    workspaceObservation: { kind: "unappointed" },
    target: "refs/heads/main",
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    gates: { satisfied: true, reports: [] },
    after: [],
    dependents: [],
    holder: { kind: "none" },
    roster: [],
    ...overrides,
  };
}

/** One Kanshi report skeleton with only the named section present. */
export function kanshiReport(
  contracts: KanshiReport["contracts"],
  overrides: Partial<Omit<KanshiReport, "contracts">> = {},
): KanshiReport {
  return {
    root: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    branch: null,
    contracts,
    tasks: { kind: "absent" },
    akuma: { kind: "absent" },
    ...overrides,
  };
}

/** One Contract catalogue over fresh rows; scenario deltas remain explicit overrides. */
export function contractCatalog(
  rows: readonly ContractRow[],
  overrides: Partial<Omit<Extract<Catalog, { kind: "contracts" }>, "kind" | "rows">> = {},
): Extract<Catalog, { kind: "contracts" }> {
  return {
    kind: "contracts",
    root: "/repo",
    state: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows,
    hasMore: false,
    ...overrides,
  };
}
