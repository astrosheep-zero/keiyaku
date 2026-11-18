import { z } from "zod";
import { processDiagnostic } from "../runtime/proc/diagnostic.js";
import { runProcess, type ProcessOutcome } from "../runtime/proc/run.js";
import { SettingsError, type Settings } from "../settings.js";

export type HookCommand = Readonly<{ name: string; argv: readonly string[]; timeoutMs: number }>;
export type WorktreeHooks = Readonly<{
  create: readonly HookCommand[];
  destroy: readonly HookCommand[];
}>;
export type HookFailure =
  | Readonly<{ kind: "exit"; code: number; stdout: string; stderr: string; truncated: boolean }>
  | Readonly<{ kind: "timeout"; stdout?: string; stderr?: string; truncated?: boolean }>
  | Readonly<{ kind: "unknown-exit"; stdout?: string; stderr?: string; truncated?: boolean }>
  | Readonly<{ kind: "spawn-error"; diagnostic: string }>;
export const worktreeHookLagSchema = z
  .object({
    kind: z.literal("worktree-hook-failed"),
    phase: z.enum(["create", "destroy"]),
    path: z.string().refine((value) => value.trim() !== ""),
    name: z.string().refine((value) => value.trim() !== ""),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export type WorktreeHookLag = z.infer<typeof worktreeHookLagSchema>;
type HookPhase = "create" | "destroy";
type WorktreeHooksFromInput = Readonly<{ settings: Settings }>;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function namespaceFailure(settings: Settings, view: ReturnType<Settings["namespace"]>): never {
  if (view.kind !== "failed") throw new Error("settings namespace failure expected");
  throw new SettingsError(
    view.failures
      .map((failure) => {
        const scope = settings.scopes[failure.scope];
        return `${failure.scope}: ${failure.diagnostic ?? (scope.kind === "failed" ? scope.diagnostic : "namespace unavailable")}`;
      })
      .join("; "),
  );
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
  const parsed = value.map((item, index) => command(item, `${coordinate}[${index}]`, ErrorType));
  const names = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    if (names.has(item.name)) throw new ErrorType(`${coordinate}[${index}].name must be unique within its phase`);
    names.add(item.name);
  }
  return Object.freeze(parsed);
}

export function worktreeHooksFrom(input: WorktreeHooksFromInput): WorktreeHooks {
  if (!record(input)) throw new TypeError("worktreeHooksFrom input must be an object");
  const view = input.settings.namespace("worktree");
  if (view.kind === "failed") namespaceFailure(input.settings, view);
  for (const name of Object.keys(view.entries ?? {})) {
    if (name !== "create" && name !== "destroy") {
      throw new SettingsError(`worktree has unknown entry: ${name}`);
    }
  }
  const selected = (phase: "create" | "destroy"): readonly HookCommand[] => {
    const entry = view.entries?.[phase];
    if (entry === undefined) return Object.freeze([]);
    return commands(entry.value, `worktree.${phase}`, SettingsError);
  };
  return Object.freeze({ create: selected("create"), destroy: selected("destroy") });
}

export const EMPTY_WORKTREE_HOOKS: WorktreeHooks = Object.freeze({
  create: Object.freeze([]),
  destroy: Object.freeze([]),
});

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

type HookCommandRun =
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "cancelled"; name: string; stdout?: string; stderr?: string; truncated?: boolean }>
  | Readonly<{
      kind: "failed";
      name: string;
      failure: HookFailure;
    }>;

/** Execute an ordered command list without lifecycle state; the physical owner owns failure policy. */
export async function runHookCommands(
  worktree: string,
  commands: readonly HookCommand[],
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
  onOutput?: (output: Readonly<{ stream: "stdout" | "stderr"; text: string }>) => void,
): Promise<HookCommandRun> {
  for (const value of commands) {
    const outcome = await runProcess({
      argv: value.argv,
      timeoutMs: value.timeoutMs,
      cwd: worktree,
      ...(signal === undefined ? {} : { signal }),
      ...(environment === undefined ? {} : { env: environment }),
      ...(onOutput === undefined ? {} : { onOutput }),
    });
    if (outcome.kind === "cancelled") return { ...outcome, name: value.name };
    const failure = failedOutcome(outcome);
    if (failure !== null) return { kind: "failed", name: value.name, failure };
  }
  return { kind: "ok" };
}

type HookPhaseRun = Readonly<{ lag: WorktreeHookLag | null }>;

async function runPhase(worktree: string, commands: readonly HookCommand[], phase: HookPhase): Promise<HookPhaseRun> {
  const result = await runHookCommands(worktree, commands);
  if (result.kind === "ok") return { lag: null };
  const failure = result.kind === "cancelled" ? { kind: "unknown-exit" as const } : result.failure;
  return {
    lag: {
      kind: "worktree-hook-failed",
      phase,
      path: worktree,
      name: result.name,
      diagnostic: processDiagnostic(failure),
    },
  };
}

export function runCreateHooks(worktree: string, hooks: WorktreeHooks): Promise<HookPhaseRun> {
  return runPhase(worktree, hooks.create, "create");
}

export function runDestroyHooks(worktree: string, hooks: WorktreeHooks): Promise<HookPhaseRun> {
  return runPhase(worktree, hooks.destroy, "destroy");
}
