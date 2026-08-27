import { runProcess, type ProcessOutcome } from "../runtime/proc/run.js";

export type HookCommand = Readonly<{ name: string; argv: readonly string[]; timeoutMs: number }>;
export type WorktreeHooks = Readonly<{
  create: readonly HookCommand[];
  destroy: readonly HookCommand[];
}>;
export type HookFailure =
  | Readonly<{ kind: "exit"; code: number; stdout: string; stderr: string; truncated: boolean }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "spawn-error"; diagnostic: string }>
  | Readonly<{ kind: "unknown-exit" }>;
export type WorktreeHookLag = Readonly<{
  kind: "worktree-hook-failed";
  phase: HookPhase;
  path: string;
  command: number;
  name: string;
  failure: HookFailure;
}>;

export type HookPhase = "create" | "destroy";

function failedOutcome(outcome: Exclude<ProcessOutcome, { kind: "cancelled" }>): HookFailure | null {
  if (outcome.kind === "terminal") {
    return outcome.code === 0
      ? null
      : {
          kind: "exit",
          code: outcome.code,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          truncated: outcome.truncated,
        };
  }
  return outcome;
}

export type HookCommandRun =
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{
      kind: "failed";
      command: number;
      failure: HookFailure;
    }>;

/** Execute an ordered command list without lifecycle state. Scratch owns this policy. */
export async function runHookCommands(
  worktree: string,
  commands: readonly HookCommand[],
  signal?: AbortSignal,
): Promise<HookCommandRun> {
  for (const [command, value] of commands.entries()) {
    const outcome = await runProcess({
      argv: value.argv,
      timeoutMs: value.timeoutMs,
      cwd: worktree,
      ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.kind === "cancelled") return outcome;
    const failure = failedOutcome(outcome);
    if (failure !== null) return { kind: "failed", command, failure };
  }
  return { kind: "ok" };
}

export type HookPhaseRun = Readonly<{ lag: WorktreeHookLag | null; runs: readonly string[] }>;

async function runPhase(worktree: string, hooks: readonly HookCommand[], phase: HookPhase): Promise<HookPhaseRun> {
  const runs: string[] = [];
  for (const [command, value] of hooks.entries()) {
    const outcome = await runProcess({ argv: value.argv, timeoutMs: value.timeoutMs, cwd: worktree });
    if (outcome.kind === "cancelled") {
      return {
        runs,
        lag: {
          kind: "worktree-hook-failed",
          phase,
          path: worktree,
          command,
          name: value.name,
          failure: { kind: "unknown-exit" },
        },
      };
    }
    const failure = failedOutcome(outcome);
    if (failure !== null)
      return { runs, lag: { kind: "worktree-hook-failed", phase, path: worktree, command, name: value.name, failure } };
    runs.push(value.name);
  }
  return { runs, lag: null };
}

export function runCreateHooks(worktree: string, hooks: WorktreeHooks): Promise<HookPhaseRun> {
  return runPhase(worktree, hooks.create, "create");
}

export function runDestroyHooks(worktree: string, hooks: WorktreeHooks): Promise<HookPhaseRun> {
  return runPhase(worktree, hooks.destroy, "destroy");
}
