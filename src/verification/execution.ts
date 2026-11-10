import type { ContractId, SnapshotId } from "../core/facts/types.js";
import { runHookCommands, worktreeHooksFrom, type HookCommand } from "../git/hooks.js";
import { ScratchMaterializationError, type MaterializedScratchCandidate, type WorktreeLeak } from "../git/scratch.js";
import type { GitRepository } from "../git/process.js";
import type { Settings } from "../settings.js";
import { runProcess, type ProcessOutcome } from "../runtime/proc/run.js";
import { processDiagnostic as executionDiagnostic } from "../runtime/proc/diagnostic.js";
import type { VerificationObservation } from "./observation.js";
import type { VerificationDeclaration } from "./declaration.js";

type VerificationVerdict = "satisfied" | "unsatisfied";
const SUMMARY_BYTES = 32 * 1024;

export type VerificationTerminalOutcome = Readonly<{
  kind: "terminal";
  verdict: VerificationVerdict;
  summary?: string;
}>;

type CapturedOutput = Readonly<{ stdout?: string; stderr?: string; truncated?: boolean }>;
export type VerificationNonterminalOutcome = Readonly<
  | { kind: "unknown-exit"; diagnostic?: string }
  | { kind: "cancelled"; diagnostic?: string }
  | { kind: "spawn-error"; diagnostic: string }
>;

function hasCapturedOutput(output: CapturedOutput): boolean {
  return (
    (output.stdout !== undefined && output.stdout.length > 0) ||
    (output.stderr !== undefined && output.stderr.length > 0) ||
    output.truncated === true
  );
}

export type VerificationExecutionStop =
  | VerificationNonterminalOutcome
  | Readonly<{
      kind: "candidate-unavailable" | "environment-failure";
      diagnostic: string;
    }>
  | Readonly<{
      kind: "environment-failure";
      name: string;
      diagnostic: string;
    }>;

export type VerificationExecution = Readonly<{
  outcome: VerificationTerminalOutcome | VerificationExecutionStop;
  cleanup?: Readonly<{ name: string; diagnostic: string }>;
  leak?: WorktreeLeak;
}>;

export type ExecuteVerificationInput = Readonly<{
  repository: GitRepository;
  candidate: SnapshotId;
  contractId: ContractId;
  declaration: VerificationDeclaration;
  index: number;
  total: number;
  requirement: string;
  materializeScratchCandidate: (
    repository: GitRepository,
    candidate: SnapshotId,
    contract: ContractId,
    requirement: string,
  ) => Promise<MaterializedScratchCandidate>;
  projectSettings: (root: string) => Promise<Settings>;
  observe?: (event: VerificationObservation) => void;
  signal?: AbortSignal;
}>;

type AttemptObservation<Event = VerificationObservation> = Event extends VerificationObservation
  ? Omit<Event, "requirement" | "index" | "total" | "snapshot">
  : never;

function observe(
  input: Pick<ExecuteVerificationInput, "observe" | "requirement" | "index" | "total" | "candidate">,
  event: AttemptObservation,
): void {
  try {
    input.observe?.({
      ...event,
      requirement: input.requirement,
      index: input.index,
      total: input.total,
      snapshot: input.candidate,
    });
  } catch {
    /* Observation does not own execution. */
  }
}

function outputSummary(output: CapturedOutput): string {
  return [
    ...(output.stdout ? [`stdout:\n${output.stdout}`] : []),
    ...(output.stderr ? [`stderr:\n${output.stderr}`] : []),
    ...(output.truncated ? ["[output truncated]"] : []),
  ].join("\n");
}

function argvFor(declaration: VerificationDeclaration): readonly string[] {
  const args = declaration.executor === "pwsh" ? ["-Command", declaration.script] : ["-c", declaration.script];
  return [declaration.executor, ...args];
}

function processDiagnostic(
  declaration: VerificationDeclaration,
  index: number,
  outcome: Readonly<{ code: number; stdout: string; stderr: string; truncated: boolean }>,
): string | null {
  if (outcome.code === 0) {
    return null;
  }
  return [
    `[${index} ${declaration.executor} exit ${outcome.code}${outcome.truncated ? " output-truncated" : ""}]`,
    ...(outcome.stdout.length === 0 ? [] : [`stdout:\n${outcome.stdout}`]),
    ...(outcome.stderr.length === 0 ? [] : [`stderr:\n${outcome.stderr}`]),
  ].join("\n");
}

function boundedSummary(diagnostic: string | null): string | undefined {
  if (diagnostic === null) return undefined;
  const combined = Buffer.from(diagnostic);
  if (combined.length <= SUMMARY_BYTES) return combined.toString("utf8");
  const marker = Buffer.from("[earlier output truncated]\n");
  let start = combined.length - (SUMMARY_BYTES - marker.length);
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start += 1;
  return Buffer.concat([marker, combined.subarray(start)]).toString("utf8");
}

async function observedHooks(
  input: Readonly<{
    execution: ExecuteVerificationInput;
    cwd: string;
    commands: readonly HookCommand[];
    phase: "setup" | "cleanup";
    signal?: AbortSignal;
    environment: NodeJS.ProcessEnv;
  }>,
): ReturnType<typeof runHookCommands> {
  const { execution, cwd, commands, phase, signal, environment } = input;
  for (const command of commands) {
    const coordinate = { phase, cwd, name: command.name };
    const started = performance.now();
    observe(execution, { kind: "phase", ...coordinate, state: "started" });
    const result = await runHookCommands(cwd, [command], signal, environment, (output) =>
      observe(execution, { kind: "output", ...coordinate, ...output }),
    );
    observe(execution, {
      kind: "phase",
      ...coordinate,
      state: "finished",
      outcome: result.kind,
      elapsedMs: performance.now() - started,
    });
    if (result.kind !== "ok") return result;
  }
  return { kind: "ok" };
}

function nonterminalOutcome(
  outcome: Exclude<ProcessOutcome, Readonly<{ kind: "terminal" }> | Readonly<{ kind: "timeout" }>>,
): VerificationNonterminalOutcome {
  if (outcome.kind === "spawn-error") return { kind: outcome.kind, diagnostic: executionDiagnostic(outcome) };
  return hasCapturedOutput(outcome)
    ? { kind: outcome.kind, diagnostic: executionDiagnostic(outcome) }
    : { kind: outcome.kind };
}

async function executeDeclaration(
  input: ExecuteVerificationInput,
  cwd: string,
): Promise<VerificationTerminalOutcome | VerificationNonterminalOutcome> {
  const { declaration, index } = input;
  const coordinate = { phase: "declaration" as const, cwd };
  const started = performance.now();
  observe(input, { kind: "phase", ...coordinate, state: "started" });
  const outcome = await runProcess({
    argv: argvFor(declaration),
    cwd,
    env: process.env,
    onOutput: (output) => observe(input, { kind: "output", ...coordinate, ...output }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
  });
  observe(input, {
    kind: "phase",
    ...coordinate,
    state: "finished",
    outcome: outcome.kind === "terminal" ? `exit ${outcome.code}` : outcome.kind,
    elapsedMs: performance.now() - started,
  });
  if (outcome.kind === "spawn-error" || outcome.kind === "unknown-exit" || outcome.kind === "cancelled")
    return nonterminalOutcome(outcome);
  const satisfied = outcome.kind === "terminal" && outcome.code === 0;
  const summary = boundedSummary(
    outcome.kind === "timeout"
      ? [`[${index} ${declaration.executor} timeout after ${declaration.timeoutMs}ms]`, outputSummary(outcome)]
          .filter(Boolean)
          .join("\n")
      : processDiagnostic(declaration, index, outcome),
  );
  return {
    kind: "terminal",
    verdict: satisfied ? "satisfied" : "unsatisfied",
    ...(summary === undefined ? {} : { summary }),
  };
}

async function materializeScratch(
  input: ExecuteVerificationInput,
): Promise<MaterializedScratchCandidate | VerificationExecution> {
  observe(input, { kind: "phase", phase: "materialize", state: "started" });
  try {
    input.signal?.throwIfAborted();
    const scratch = await input.materializeScratchCandidate(
      input.repository,
      input.candidate,
      input.contractId,
      input.requirement,
    );
    observe(input, { kind: "phase", phase: "materialize", state: "finished", cwd: scratch.cwd, outcome: "ok" });
    return scratch;
  } catch (error) {
    observe(input, {
      kind: "phase",
      phase: "materialize",
      state: "finished",
      outcome: input.signal?.aborted ? "cancelled" : "failed",
    });
    return {
      outcome: input.signal?.aborted
        ? { kind: "cancelled" }
        : {
            kind: "candidate-unavailable",
            diagnostic: executionDiagnostic({
              kind: "candidate-unavailable",
              diagnostic: error instanceof Error ? error.message : String(error),
            }),
          },
      ...(error instanceof ScratchMaterializationError ? { leak: error.leak } : {}),
    };
  }
}

type PreparedScratchExecution = Readonly<{
  outcome: VerificationTerminalOutcome | VerificationExecutionStop;
  destroy?: readonly HookCommand[];
}>;

async function runScratch(
  input: ExecuteVerificationInput,
  scratch: MaterializedScratchCandidate,
): Promise<PreparedScratchExecution> {
  try {
    input.signal?.throwIfAborted();
    const hooks = worktreeHooksFrom({ settings: await input.projectSettings(scratch.cwd) });
    const readiness = await observedHooks({
      execution: input,
      cwd: scratch.cwd,
      commands: hooks.create,
      phase: "setup",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      environment: process.env,
    });
    if (readiness.kind === "cancelled")
      return {
        outcome: {
          kind: "cancelled",
          ...(hasCapturedOutput(readiness) ? { diagnostic: executionDiagnostic(readiness) } : {}),
        },
        destroy: hooks.destroy,
      };
    if (readiness.kind === "failed")
      return {
        outcome: {
          kind: "environment-failure",
          name: readiness.name,
          diagnostic: executionDiagnostic(readiness.failure),
        },
        destroy: hooks.destroy,
      };
    return {
      outcome: await executeDeclaration(input, scratch.cwd),
      destroy: hooks.destroy,
    };
  } catch (error) {
    return {
      outcome: input.signal?.aborted
        ? { kind: "cancelled" }
        : {
            kind: "environment-failure",
            diagnostic: executionDiagnostic({
              kind: "environment-failure",
              diagnostic: error instanceof Error ? error.message : String(error),
            }),
          },
    };
  }
}

async function retireScratch(
  input: ExecuteVerificationInput,
  scratch: MaterializedScratchCandidate,
  destroy: readonly HookCommand[] | undefined,
  outcome: PreparedScratchExecution["outcome"],
): Promise<Pick<VerificationExecution, "cleanup" | "leak">> {
  observe(input, { kind: "phase", phase: "cleanup", cwd: scratch.cwd, state: "started" });
  let cleanup: VerificationExecution["cleanup"];
  if (destroy !== undefined) {
    const result = await observedHooks({
      execution: input,
      cwd: scratch.cwd,
      commands: destroy,
      phase: "cleanup",
      environment: process.env,
    });
    if (result.kind === "cancelled") throw new Error("scratch destroy cancelled without a signal");
    if (result.kind === "failed") cleanup = { name: result.name, diagnostic: executionDiagnostic(result.failure) };
  }
  const retain = outcome.kind === "terminal" ? outcome.verdict === "unsatisfied" : outcome.kind !== "cancelled";
  const leak = await scratch.dispose(retain);
  observe(input, {
    kind: "phase",
    phase: "cleanup",
    cwd: scratch.cwd,
    state: "finished",
    outcome: cleanup !== undefined ? "failed" : retain ? "retained" : leak !== null ? "failed" : "ok",
  });
  return {
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(leak === null ? {} : { leak }),
  };
}

/** Execute one disposable Verification attempt over the exact integration snapshot. */
export async function executeVerification(input: ExecuteVerificationInput): Promise<VerificationExecution> {
  const materialized = await materializeScratch(input);
  if ("outcome" in materialized) return materialized;
  const prepared = await runScratch(input, materialized);
  return {
    outcome: prepared.outcome,
    ...(await retireScratch(input, materialized, prepared.destroy, prepared.outcome)),
  };
}
