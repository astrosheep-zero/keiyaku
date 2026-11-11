import { Writable } from "node:stream";
import { contractId } from "../../src/core/facts/types.js";
import type { z } from "zod";
import type {
  bindOutcomeSchema,
  amendOutcomeSchema,
  arcOutcomeSchema,
  abandonOutcomeSchema,
  deliverOutcomeSchema,
  verifyOutcomeSchema,
  reviewOutcomeSchema,
  deliveryPreviewOutcomeSchema,
} from "../../src/index.js";
import { parseArgv } from "../../src/cli/parse.js";
import { runCliCommand, type CliRuntimeInput } from "../../src/cli/runtime.js";
import type { ContractCatalogue, ContractSummary } from "../../src/index.js";
import type { ContractKanshiDetail, KanshiContractReport, KanshiReport } from "../../src/kanshi/index.js";

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
    throw new Error(
      `cliJson could not parse stdout (exit ${result.exit}): ${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
      { cause: error },
    );
  }
}

type AcceptedByOperation = {
  bind: Extract<z.output<typeof bindOutcomeSchema>, { kind: "accepted" }>;
  amend: Extract<z.output<typeof amendOutcomeSchema>, { kind: "accepted" }>;
  arc: Extract<z.output<typeof arcOutcomeSchema>, { kind: "accepted" }>;
  abandon: Extract<z.output<typeof abandonOutcomeSchema>, { kind: "accepted" }>;
  deliver: Extract<z.output<typeof deliverOutcomeSchema>, { kind: "accepted" }>;
  verify: Extract<z.output<typeof verifyOutcomeSchema>, { kind: "accepted" }>;
  review: Extract<z.output<typeof reviewOutcomeSchema>, { kind: "accepted" }>;
  "deliver-preview": Extract<z.output<typeof deliveryPreviewOutcomeSchema>, { kind: "ready" }>;
};

/** Operation selects the native type only; fields are the receipt, never a compatibility envelope. */
export function acceptedReceipt<Operation extends keyof AcceptedByOperation>(
  operation: Operation,
  fields: Omit<AcceptedByOperation[Operation], "kind">,
): AcceptedByOperation[Operation] {
  return { kind: operation === "deliver-preview" ? "ready" : "accepted", ...fields } as AcceptedByOperation[Operation];
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
  const sink = (capture: (text: string) => void, native: NodeJS.WriteStream) =>
    Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          capture(String(chunk));
          callback();
        },
      }),
      { isTTY: native.isTTY, columns: native.columns },
    );
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

/** One catalogue Contract summary; each override is the scenario delta under test. */
export function contractSummary(overrides: Partial<ContractSummary> = {}): ContractSummary {
  return {
    id: contractId("kei/verified-commit"),
    title: "Verified commit",
    phaseAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

/** One selected Contract detail; every absent field stays absent, never a fabricated default. */
export function contractDetail(overrides: Partial<ContractKanshiDetail> = {}): ContractKanshiDetail {
  return {
    kind: "contract",
    id: contractId("kei/verified-commit"),
    title: "Verified commit",
    phase: "bound",
    workspace: { kind: "present", path: "/tmp/wt" },
    ...overrides,
  };
}

/** One exact selected Contract report over an owner detail. */
export function contractReport(
  detail: ContractKanshiDetail,
  overrides: Partial<ContractKanshiDetail> = {},
): KanshiContractReport {
  return { ...detail, ...overrides };
}

/** One Kanshi report skeleton with only the named section present. */
export function kanshiReport(
  contracts: KanshiReport["contracts"],
  overrides: Partial<Omit<KanshiReport, "contracts">> = {},
): KanshiReport {
  return {
    observedAt: "2026-08-12T00:00:00.000Z",
    contracts,
    debts: { kind: "absent" },
    akumas: { kind: "absent" },
    ...overrides,
  };
}

/** One Contract catalogue over fresh summaries; scenario deltas remain explicit overrides. */
export function contractCatalog(
  rows: readonly ContractSummary[],
  overrides: Partial<Omit<ContractCatalogue, "rows">> = {},
): ContractCatalogue {
  return {
    observedAt: "2026-08-12T00:00:00.000Z",
    ...(rows.length === 0 ? {} : { rows }),
    ...overrides,
  };
}
