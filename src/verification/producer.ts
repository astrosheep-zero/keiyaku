import { type ProcessExit, type ProcessOutcome, type ProcessSpawnError, type ProcessTimeout, runProcess } from "../runtime/proc/run.js";
import type { AttestationData, VerificationDeclaration } from "../core/facts/types.js";
import {
  resolveVerificationPlan,
  type VerificationPlanStep,
} from "./plan.js";

export type VerificationVerdict = AttestationData["verdict"];

export type VerificationExecution = Readonly<{
  readonly step: VerificationPlanStep;
  readonly outcome: ProcessOutcome;
}>;

type VerificationBase = Readonly<{
  readonly plan: readonly VerificationPlanStep[];
}>;

export type VerificationTerminalOutcome = VerificationBase & Readonly<{
  readonly kind: "terminal";
  readonly verdict: VerificationVerdict;
  readonly summary: string;
  readonly executions: readonly VerificationExecution[];
}>;

export type VerificationTimeoutOutcome = VerificationBase & Readonly<{
  readonly kind: "timeout";
  readonly execution: VerificationExecution & Readonly<{ readonly outcome: ProcessTimeout }>;
}>;

export type VerificationSpawnErrorOutcome = VerificationBase & Readonly<{
  readonly kind: "spawn-error";
  readonly execution: VerificationExecution & Readonly<{ readonly outcome: ProcessSpawnError }>;
}>;

export type VerificationUnknownExitOutcome = VerificationBase & Readonly<{
  readonly kind: "unknown-exit";
  readonly execution: VerificationExecution & Readonly<{ readonly outcome: ProcessExit }>;
}>;

export type VerificationOutcome =
  | VerificationTerminalOutcome
  | VerificationTimeoutOutcome
  | VerificationSpawnErrorOutcome
  | VerificationUnknownExitOutcome;

export type ProduceVerificationInput = Readonly<{
  readonly candidateTree: string;
  readonly declarations: readonly VerificationDeclaration[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}>;

function summary(verdict: VerificationVerdict): string {
  return `verification ${verdict}`;
}

function terminal(
  base: VerificationBase,
  verdict: VerificationVerdict,
  executions: readonly VerificationExecution[],
): VerificationTerminalOutcome {
  return { ...base, kind: "terminal", verdict, summary: summary(verdict), executions };
}

function candidateTree(value: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) {
    throw new TypeError("candidate tree must be a lowercase SHA-1 or SHA-256 object ID");
  }
  return value;
}

export async function produceVerification(input: ProduceVerificationInput): Promise<VerificationOutcome> {
  candidateTree(input.candidateTree);
  const plan = resolveVerificationPlan(input.declarations);
  const base: VerificationBase = { plan };
  const executions: VerificationExecution[] = [];
  let verdict: VerificationVerdict = "satisfied";
  for (const step of plan) {
    const outcome = await runProcess({
      argv: step.argv,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      stdoutLimitBytes: input.stdoutLimitBytes,
      stderrLimitBytes: input.stderrLimitBytes,
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const execution: VerificationExecution = { step, outcome };
    executions.push(execution);
    if (outcome.kind === "timeout") return { ...base, kind: "timeout", execution: execution as VerificationTimeoutOutcome["execution"] };
    if (outcome.kind === "spawn-error") return { ...base, kind: "spawn-error", execution: execution as VerificationSpawnErrorOutcome["execution"] };
    if (outcome.code === null) return { ...base, kind: "unknown-exit", execution: execution as VerificationUnknownExitOutcome["execution"] };
    if (outcome.code !== 0) verdict = "unsatisfied";
  }
  return terminal(base, verdict, executions);
}
