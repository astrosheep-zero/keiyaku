import { runProcess, type ProcessOutcome } from "../runtime/proc/run.js";
import { SettingsError, type Settings } from "../settings.js";

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
export type WorktreeHooksFromInput = Readonly<{ settings: Settings }>;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function namespaceFailure(view: ReturnType<Settings["namespace"]>): never {
  if (view.kind !== "failed") throw new Error("settings namespace failure expected");
  throw new SettingsError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
}

function command(value: unknown, coordinate: string, ErrorType: typeof TypeError | typeof SettingsError): HookCommand {
  if (!record(value)) throw new ErrorType(`${coordinate} must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "name" && key !== "argv" && key !== "timeoutMs")
      throw new ErrorType(`${coordinate} has unknown field: ${key}`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0)
    throw new ErrorType(`${coordinate}.name must be nonblank`);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((item) => typeof item === "string")) {
    throw new ErrorType(`${coordinate}.argv must be a nonempty string array`);
  }
  if (value.argv[0]!.trim().length === 0) throw new ErrorType(`${coordinate}.argv[0] must be nonblank`);
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 1 ||
    (value.timeoutMs as number) > 2_147_483_647
  ) {
    throw new ErrorType(`${coordinate}.timeoutMs must be an integer from 1 through 2147483647`);
  }
  return Object.freeze({
    name: value.name.trim(),
    argv: Object.freeze([...value.argv]),
    timeoutMs: value.timeoutMs as number,
  });
}

function commands(
  value: unknown,
  coordinate: string,
  ErrorType: typeof TypeError | typeof SettingsError,
): readonly HookCommand[] {
  if (!Array.isArray(value)) throw new ErrorType(`${coordinate} must be an array`);
  return Object.freeze(value.map((item, index) => command(item, `${coordinate}[${index}]`, ErrorType)));
}

export function worktreeHooksFrom(input: WorktreeHooksFromInput): WorktreeHooks {
  if (!record(input)) throw new TypeError("worktreeHooksFrom input must be an object");
  const view = input.settings.namespace("worktree");
  if (view.kind === "failed") namespaceFailure(view);
  for (const entry of view.entries) {
    if (entry.name !== "create" && entry.name !== "destroy") {
      throw new SettingsError(`worktree has unknown entry: ${entry.name}`);
    }
  }
  const selected = (phase: "create" | "destroy"): readonly HookCommand[] => {
    const entry = view.entries.find((item) => item.name === phase);
    if (entry === undefined) return Object.freeze([]);
    return commands(entry.value, `worktree.${phase}`, SettingsError);
  };
  return Object.freeze({ create: selected("create"), destroy: selected("destroy") });
}

export function normalizedWorktreeHooks(value: unknown): WorktreeHooks {
  if (!record(value)) throw new TypeError("hooks must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "create" && key !== "destroy") throw new TypeError(`hooks has unknown field: ${key}`);
  }
  return Object.freeze({
    create: commands(value.create, "hooks.create", TypeError),
    destroy: commands(value.destroy, "hooks.destroy", TypeError),
  });
}

export const EMPTY_WORKTREE_HOOKS: WorktreeHooks = Object.freeze({
  create: Object.freeze([]),
  destroy: Object.freeze([]),
});

export function worktreeHooksOption(value: unknown): WorktreeHooks {
  return value === undefined ? EMPTY_WORKTREE_HOOKS : normalizedWorktreeHooks(value);
}

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
  environment?: NodeJS.ProcessEnv,
): Promise<HookCommandRun> {
  for (const [command, value] of commands.entries()) {
    const outcome = await runProcess({
      argv: value.argv,
      timeoutMs: value.timeoutMs,
      cwd: worktree,
      ...(signal === undefined ? {} : { signal }),
      ...(environment === undefined ? {} : { env: environment }),
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
