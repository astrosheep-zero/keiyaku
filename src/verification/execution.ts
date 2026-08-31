import type { SnapshotId } from "../core/facts/types.js";
import { runHookCommands, type HookCommand, type HookFailure } from "../git/hooks.js";
import { worktreeHooksFrom } from "../library/configuration.js";
import type { MaterializedScratchCandidate, WorktreeLeak } from "../git/scratch.js";
import type { GitRepository } from "../git/process.js";
import type { Settings } from "../settings.js";
import { runProcess } from "../runtime/proc/run.js";
import type { VerificationDeclaration } from "./declaration.js";

type VerificationVerdict = "satisfied" | "unsatisfied";
const SUMMARY_BYTES = 32 * 1024;
const CLOSED_VERIFICATION_ENVIRONMENT: NodeJS.ProcessEnv = {};

export type VerificationTerminalOutcome = Readonly<{
  kind: "terminal";
  verdict: VerificationVerdict;
  passed: number;
  total: number;
  summary?: string;
}>;

export type VerificationNonterminalOutcome =
  | Readonly<{
      kind: "unknown-exit";
    }>
  | Readonly<{
      kind: "cancelled";
    }>
  | Readonly<{
      kind: "spawn-error";
      diagnostic: string;
    }>;

export type VerificationExecutionStop =
  | VerificationNonterminalOutcome
  | Readonly<{
      kind: "candidate-unavailable" | "environment-failure";
      diagnostic: string;
    }>
  | Readonly<{
      kind: "environment-failure";
      command: number;
      detail: HookFailure;
    }>;

export type VerificationExecution = Readonly<{
  outcome: VerificationTerminalOutcome | VerificationExecutionStop;
  cleanup?: Readonly<{ phase: "destroy"; command: number; detail: HookFailure }>;
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
  signal?: AbortSignal;
}>;

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

async function executeDeclarations(
  input: Readonly<{
    declarations: readonly VerificationDeclaration[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }>,
): Promise<VerificationTerminalOutcome | VerificationNonterminalOutcome> {
  let verdict: VerificationVerdict = "satisfied";
  let passed = 0;
  const total = input.declarations.length;
  let summary: string | undefined;
  for (const [index, declaration] of input.declarations.entries()) {
    const outcome = await runProcess({
      argv: argvFor(declaration),
      cwd: input.cwd,
      env: input.environment,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
    });
    if (outcome.kind === "timeout") {
      verdict = "unsatisfied";
      summary = appendSummary(
        summary,
        `[${index + 1} ${declaration.executor} timeout after ${declaration.timeoutMs}ms]`,
      );
      continue;
    }
    if (outcome.kind === "spawn-error" || outcome.kind === "unknown-exit" || outcome.kind === "cancelled")
      return outcome;
    if (outcome.code === 0) passed += 1;
    else verdict = "unsatisfied";
    summary = appendSummary(summary, processDiagnostic(declaration, index, outcome));
  }
  return { kind: "terminal", verdict, passed, total, ...(summary === undefined ? {} : { summary }) };
}

/** Execute one disposable Verification attempt over the exact integration snapshot. */
export async function executeVerification(input: ExecuteVerificationInput): Promise<VerificationExecution> {
  let scratch: MaterializedScratchCandidate;
  try {
    scratch = await input.materializeScratchCandidate(input.repository, input.candidate);
  } catch (error) {
    return {
      outcome: { kind: "candidate-unavailable", diagnostic: error instanceof Error ? error.message : String(error) },
    };
  }
  let outcome: VerificationTerminalOutcome | VerificationExecutionStop | undefined;
  let cleanup: VerificationExecution["cleanup"];
  let leak: WorktreeLeak | null = null;
  let destroy: readonly HookCommand[] | undefined;
  try {
    try {
      const hooks = worktreeHooksFrom({ settings: await input.projectSettings(scratch.cwd) });
      destroy = hooks.destroy;
      const readiness = await runHookCommands(
        scratch.cwd,
        hooks.create,
        input.signal,
        CLOSED_VERIFICATION_ENVIRONMENT,
      );
      outcome =
        readiness.kind === "cancelled"
          ? { kind: "cancelled" }
          : readiness.kind === "failed"
            ? { kind: "environment-failure", command: readiness.command, detail: readiness.failure }
            : await executeDeclarations({
                declarations: input.declarations,
                cwd: scratch.cwd,
                environment: CLOSED_VERIFICATION_ENVIRONMENT,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              });
    } catch (error) {
      outcome = { kind: "environment-failure", diagnostic: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    if (destroy !== undefined) {
      const result = await runHookCommands(scratch.cwd, destroy, undefined, CLOSED_VERIFICATION_ENVIRONMENT);
      if (result.kind === "cancelled") throw new Error("scratch destroy cancelled without a signal");
      if (result.kind === "failed") cleanup = { phase: "destroy", command: result.command, detail: result.failure };
    }
    leak = await scratch.dispose();
  }
  if (outcome === undefined) throw new Error("Verification ended without an outcome");
  return {
    outcome,
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(leak === null ? {} : { leak }),
  };
}
