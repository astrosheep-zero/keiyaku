import { Writable } from "node:stream";
import {
  contractHead,
  contractId,
  type ContractHead,
  type ContractId,
  type JournalEntry,
} from "../../src/core/facts/types.js";
import type { InvocationEffect, PendingSurface } from "../../src/library/outcome.js";
import { parseArgv } from "../../src/cli/parse.js";
import type { AcceptedContractOutcome } from "../../src/cli/render/contract.js";
import { runCliCommand, type CliRuntimeInput } from "../../src/cli/runtime.js";
import type { ContractList } from "../../src/library/contract-types.js";
import type { ContractKanshiRow, KanshiReport } from "../../src/kanshi/index.js";
import type { ContractRow } from "../../src/protocol/read/status.js";

/** One parsed executable invocation; a help-only argv never reaches a product operation. */
export function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

/** Run one full in-process CLI invocation and capture its process classification and streams. */
export async function runCli(
  argv: readonly string[],
  runtime: CliRuntimeInput = {},
): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return await captureOutput(() => runCliCommand(parsed, runtime));
}

/** Run one invocation in JSON mode; `value` is the native SDK answer parsed from stdout. */
export async function cliJson<Value = unknown>(
  argv: readonly string[],
  runtime: CliRuntimeInput = {},
): Promise<Readonly<{ exit: number; stdout: string; stderr: string; value: Value }>> {
  const result = await runCli([...argv, "--json"], runtime);
  try {
    return { ...result, value: JSON.parse(result.stdout) as Value };
  } catch (error) {
    throw new Error(`cliJson could not parse stdout (exit ${result.exit}): ${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`, { cause: error });
  }
}

/**
 * One native accepted Contract outcome. Every field is explicit over the owner's own shapes: the caller
 * states the operation, the addressed Contract, the native verb value and any admitted facts, tagged
 * effects or pending surfaces. Nothing is inferred from a retired sidecar grammar.
 */
export function acceptedReceipt<Operation extends AcceptedContractOutcome["operation"]>(
  carrier: Readonly<{
    operation: Operation;
    contract: ContractId;
    value: Extract<AcceptedContractOutcome, { operation: Operation }>["value"];
    head?: ContractHead;
    facts?: readonly JournalEntry[];
    effects?: readonly InvocationEffect[];
    pending?: readonly PendingSurface[];
  }>,
): Extract<AcceptedContractOutcome, { operation: Operation }> {
  return {
    kind: "accepted",
    operation: carrier.operation,
    contract: carrier.contract,
    head: carrier.head ?? contractHead("head"),
    facts: carrier.facts ?? [],
    effects: carrier.effects ?? [],
    pending: carrier.pending ?? [],
    value: carrier.value,
  } as Extract<AcceptedContractOutcome, { operation: Operation }>;
}

/**
 * Capture the process outcome of one in-process CLI invocation. The stream objects are replaced,
 * never their write methods: the test runner holds the native streams and keeps reporting on them,
 * while the CLI reads `process.stdout`/`process.stderr` afresh at each write.
 */
export async function captureOutput(
  run: () => Promise<number>,
): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  let stdout = "";
  let stderr = "";
  const nativeStdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
  const nativeStderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr")!;
  const nativeStdout = process.stdout;
  const nativeStderr = process.stderr;
  const sink = (capture: (text: string) => void, native: NodeJS.WriteStream): NodeJS.WriteStream => {
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        capture(String(chunk));
        callback();
      },
    }) as Writable & { isTTY?: boolean; columns?: number };
    stream.isTTY = native.isTTY;
    stream.columns = native.columns;
    return stream as unknown as NodeJS.WriteStream;
  };
  Object.defineProperty(process, "stdout", {
    value: sink((text) => {
      stdout += text;
    }, nativeStdout),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process, "stderr", {
    value: sink((text) => {
      stderr += text;
    }, nativeStderr),
    configurable: true,
    writable: true,
  });
  try {
    return { exit: await run(), stdout, stderr };
  } finally {
    // Restore the exact original descriptors, not merely writable data properties.
    Object.defineProperty(process, "stdout", nativeStdoutDescriptor);
    Object.defineProperty(process, "stderr", nativeStderrDescriptor);
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
  overrides: Partial<Omit<ContractList, "rows">> = {},
): ContractList {
  return {
    root: "/repo",
    state: null,
    observedAt: "2026-08-12T00:00:00.000Z",
    rows,
    hasMore: false,
    ...overrides,
  };
}
