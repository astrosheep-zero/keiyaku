import type { SnapshotId } from "../core/facts/types.js";
import { runHookCommands, worktreeHooksFrom, type HookCommand, type HookFailure } from "../git/hooks.js";
import type { MaterializedScratchCandidate, WorktreeLeak } from "../git/scratch.js";
import type { GitRepository } from "../git/process.js";
import type { Settings } from "../settings.js";
import { runProcess, type ProcessOutcome } from "../runtime/proc/run.js";
import { inheritVerificationEnvironment } from "../git/verification-environment.js";
import type { VerificationObservation } from "./observation.js";
import type { VerificationDeclaration } from "./declaration.js";

type VerificationVerdict = "satisfied" | "unsatisfied";
const SUMMARY_BYTES = 32 * 1024;

export type VerificationTerminalOutcome = Readonly<{
  kind: "terminal";
  verdict: VerificationVerdict;
  passed: number;
  total: number;
  summary?: string;
}>;

export type CapturedOutput = Readonly<{ stdout?: string; stderr?: string; truncated?: boolean }>;
export type VerificationNonterminalOutcome = CapturedOutput &
  (
    | Readonly<{ kind: "unknown-exit" }>
    | Readonly<{ kind: "cancelled" }>
    | Readonly<{ kind: "spawn-error"; diagnostic: string }>
  );

export function capturedOutput(value: CapturedOutput): CapturedOutput {
  return {
    ...(value.stdout ? { stdout: value.stdout } : {}),
    ...(value.stderr ? { stderr: value.stderr } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
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
      detail: HookFailure;
    }>;

export type VerificationExecution = Readonly<{
  outcome: VerificationTerminalOutcome | VerificationExecutionStop;
  cleanup?: Readonly<{ phase: "destroy"; name: string; detail: HookFailure }>;
  leak?: WorktreeLeak;
}>;

export type ExecuteVerificationInput = Readonly<{
  repository: GitRepository;
  candidate: SnapshotId;
  declarations: readonly VerificationDeclaration[];
  materializeScratchCandidate: (
    repository: GitRepository,
    candidate: SnapshotId,
  ) => Promise<MaterializedScratchCandidate>;
  projectSettings: (root: string) => Promise<Settings>;
  environmentSource?: string;
  observe?: (event: VerificationObservation) => void;
  signal?: AbortSignal;
}>;

function observe(input: Pick<ExecuteVerificationInput, "observe">, event: VerificationObservation): void {
  try {
    input.observe?.(event);
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
  if (outcome.code === 0 && outcome.stdout.length === 0 && outcome.stderr.length === 0 && !outcome.truncated) {
    return null;
  }
  return [
    `[${index + 1} ${declaration.executor} exit ${outcome.code}${outcome.truncated ? " output-truncated" : ""}]`,
    ...(outcome.stdout.length === 0 ? [] : [`stdout:\n${outcome.stdout}`]),
    ...(outcome.stderr.length === 0 ? [] : [`stderr:\n${outcome.stderr}`]),
  ].join("\n");
}

function appendSummary(current: string | undefined, diagnostic: string | null): string | undefined {
  if (diagnostic === null) return current;
  const combined = Buffer.from(current === undefined ? diagnostic : `${current}\n\n${diagnostic}`);
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
  return outcome.kind === "spawn-error"
    ? { kind: outcome.kind, diagnostic: outcome.diagnostic, ...capturedOutput(outcome) }
    : { kind: outcome.kind, ...capturedOutput(outcome) };
}

async function executeDeclarations(
  input: Readonly<{
    declarations: readonly VerificationDeclaration[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    observe?: (event: VerificationObservation) => void;
    signal?: AbortSignal;
  }>,
): Promise<VerificationTerminalOutcome | VerificationNonterminalOutcome> {
  let verdict: VerificationVerdict = "satisfied";
  let passed = 0;
  const total = input.declarations.length;
  let summary: string | undefined;
  for (const [index, declaration] of input.declarations.entries()) {
    const coordinate = { phase: "declaration" as const, cwd: input.cwd, index: index + 1, total };
    const started = performance.now();
    observe(input, { kind: "phase", ...coordinate, state: "started" });
    const outcome = await runProcess({
      argv: argvFor(declaration),
      cwd: input.cwd,
      env: input.environment,
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
    if (outcome.kind === "timeout") {
      verdict = "unsatisfied";
      summary = appendSummary(
        summary,
        [`[${index + 1} ${declaration.executor} timeout after ${declaration.timeoutMs}ms]`, outputSummary(outcome)]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }
    if (outcome.kind === "spawn-error" || outcome.kind === "unknown-exit" || outcome.kind === "cancelled")
      return nonterminalOutcome(outcome);
    if (outcome.code === 0) passed += 1;
    else verdict = "unsatisfied";
    summary = appendSummary(summary, processDiagnostic(declaration, index, outcome));
  }
  return { kind: "terminal", verdict, passed, total, ...(summary === undefined ? {} : { summary }) };
}

async function materializeScratch(
  input: ExecuteVerificationInput,
): Promise<MaterializedScratchCandidate | VerificationExecution> {
  observe(input, { kind: "phase", phase: "materialize", state: "started" });
  try {
    input.signal?.throwIfAborted();
    const scratch = await input.materializeScratchCandidate(input.repository, input.candidate);
    observe(input, { kind: "phase", phase: "materialize", state: "finished", cwd: scratch.cwd, outcome: "ok" });
    return scratch;
  } catch (error) {
    observe(input, {
      kind: "phase",
      phase: "materialize",
      state: "finished",
      outcome: input.signal?.aborted ? "cancelled" : "failed",
    });
    if (input.signal?.aborted) return { outcome: { kind: "cancelled" } };
    return {
      outcome: { kind: "candidate-unavailable", diagnostic: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function inheritEnvironment(input: ExecuteVerificationInput, cwd: string): Promise<void> {
  const coordinate = {
    phase: "environment" as const,
    cwd,
    ...(input.environmentSource === undefined ? {} : { source: input.environmentSource }),
  };
  observe(input, { kind: "phase", ...coordinate, state: "started" });
  try {
    if (input.environmentSource !== undefined)
      await inheritVerificationEnvironment(input.repository, input.environmentSource, cwd, input.signal);
    observe(input, { kind: "phase", ...coordinate, state: "finished", outcome: "ok" });
  } catch (error) {
    observe(input, {
      kind: "phase",
      ...coordinate,
      state: "finished",
      outcome: input.signal?.aborted ? "cancelled" : "failed",
    });
    throw error;
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
    await inheritEnvironment(input, scratch.cwd);
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
      return { outcome: { kind: "cancelled", ...capturedOutput(readiness) }, destroy: hooks.destroy };
    if (readiness.kind === "failed")
      return {
        outcome: { kind: "environment-failure", name: readiness.name, detail: readiness.failure },
        destroy: hooks.destroy,
      };
    return {
      outcome: await executeDeclarations({
        declarations: input.declarations,
        cwd: scratch.cwd,
        environment: process.env,
        ...(input.observe === undefined ? {} : { observe: input.observe }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
      destroy: hooks.destroy,
    };
  } catch (error) {
    return {
      outcome: input.signal?.aborted
        ? { kind: "cancelled" }
        : { kind: "environment-failure", diagnostic: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function retireScratch(
  input: ExecuteVerificationInput,
  scratch: MaterializedScratchCandidate,
  destroy: readonly HookCommand[] | undefined,
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
    if (result.kind === "failed") cleanup = { phase: "destroy", name: result.name, detail: result.failure };
  }
  const leak = await scratch.dispose();
  observe(input, {
    kind: "phase",
    phase: "cleanup",
    cwd: scratch.cwd,
    state: "finished",
    outcome: leak !== null || cleanup !== undefined ? "failed" : "ok",
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
  return { outcome: prepared.outcome, ...(await retireScratch(input, materialized, prepared.destroy)) };
}
