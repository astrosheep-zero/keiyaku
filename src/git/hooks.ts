import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runProcess, type ProcessOutcome } from "../runtime/proc/run.js";

export type HookCommand = Readonly<{ argv: readonly string[]; timeoutMs: number }>;
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
  failure: HookFailure;
}>;

type HookPhase = "create" | "destroy";
type HookProgress =
  | Readonly<{ status: "pending"; next: number }>
  | Readonly<{ status: "failed"; command: number; failure: HookFailure }>
  | Readonly<{ status: "ok" }>;
type HookMarker = Readonly<{
  version: 1;
  commands: WorktreeHooks;
  create: HookProgress;
  destroy: HookProgress;
}>;

const MARKER_VERSION = 1;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], coordinate: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${coordinate} has invalid fields`);
  }
}

function decodeCommand(value: unknown, coordinate: string): HookCommand {
  if (!object(value)) throw new Error(`${coordinate} must be an object`);
  exactKeys(value, ["argv", "timeoutMs"], coordinate);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((item) => typeof item === "string")) {
    throw new Error(`${coordinate}.argv must be a nonempty string array`);
  }
  if (value.argv[0]!.trim().length === 0) throw new Error(`${coordinate}.argv[0] must be nonblank`);
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 2_147_483_647) {
    throw new Error(`${coordinate}.timeoutMs is invalid`);
  }
  return { argv: value.argv, timeoutMs: value.timeoutMs as number };
}

function decodeCommands(value: unknown, coordinate: string): readonly HookCommand[] {
  if (!Array.isArray(value)) throw new Error(`${coordinate} must be an array`);
  return value.map((item, index) => decodeCommand(item, `${coordinate}[${index}]`));
}

function decodeFailure(value: unknown, coordinate: string): HookFailure {
  if (!object(value) || typeof value.kind !== "string") throw new Error(`${coordinate} is invalid`);
  switch (value.kind) {
    case "exit":
      exactKeys(value, ["kind", "code", "stdout", "stderr", "truncated"], coordinate);
      if (!Number.isInteger(value.code) || typeof value.stdout !== "string" || typeof value.stderr !== "string" || typeof value.truncated !== "boolean") {
        throw new Error(`${coordinate} is invalid`);
      }
      return { kind: "exit", code: value.code as number, stdout: value.stdout, stderr: value.stderr, truncated: value.truncated };
    case "timeout":
    case "unknown-exit":
      exactKeys(value, ["kind"], coordinate);
      return { kind: value.kind };
    case "spawn-error":
      exactKeys(value, ["kind", "diagnostic"], coordinate);
      if (typeof value.diagnostic !== "string") throw new Error(`${coordinate}.diagnostic must be a string`);
      return { kind: "spawn-error", diagnostic: value.diagnostic };
    default:
      throw new Error(`${coordinate}.kind is invalid`);
  }
}

function decodeProgress(value: unknown, commands: number, coordinate: string): HookProgress {
  if (!object(value) || typeof value.status !== "string") throw new Error(`${coordinate} is invalid`);
  if (value.status === "ok") {
    exactKeys(value, ["status"], coordinate);
    return { status: "ok" };
  }
  if (value.status === "pending") {
    exactKeys(value, ["status", "next"], coordinate);
    if (!Number.isInteger(value.next) || (value.next as number) < 0 || (value.next as number) > commands) {
      throw new Error(`${coordinate}.next is invalid`);
    }
    return { status: "pending", next: value.next as number };
  }
  if (value.status === "failed") {
    exactKeys(value, ["status", "command", "failure"], coordinate);
    if (!Number.isInteger(value.command) || (value.command as number) < 0 || (value.command as number) >= commands) {
      throw new Error(`${coordinate}.command is invalid`);
    }
    return { status: "failed", command: value.command as number, failure: decodeFailure(value.failure, `${coordinate}.failure`) };
  }
  throw new Error(`${coordinate}.status is invalid`);
}

function decodeMarker(bytes: string): HookMarker {
  const value = JSON.parse(bytes) as unknown;
  if (!object(value)) throw new Error("worktree hook marker must be an object");
  exactKeys(value, ["version", "commands", "create", "destroy"], "worktree hook marker");
  if (value.version !== MARKER_VERSION) throw new Error(`worktree hook marker version must be ${MARKER_VERSION}`);
  if (!object(value.commands)) throw new Error("worktree hook marker commands must be an object");
  exactKeys(value.commands, ["create", "destroy"], "worktree hook marker commands");
  const commands = {
    create: decodeCommands(value.commands.create, "worktree hook marker commands.create"),
    destroy: decodeCommands(value.commands.destroy, "worktree hook marker commands.destroy"),
  };
  return {
    version: MARKER_VERSION,
    commands,
    create: decodeProgress(value.create, commands.create.length, "worktree hook marker create"),
    destroy: decodeProgress(value.destroy, commands.destroy.length, "worktree hook marker destroy"),
  };
}

export function hookMarkerPath(administrationDirectory: string): string {
  return join(administrationDirectory, "keiyaku", "hooks.json");
}

function readMarker(administrationDirectory: string): HookMarker | null {
  try {
    return decodeMarker(readFileSync(hookMarkerPath(administrationDirectory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeMarker(administrationDirectory: string, marker: HookMarker): void {
  const path = hookMarkerPath(administrationDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "w", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(marker)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function freshMarker(commands: WorktreeHooks, createPending: boolean): HookMarker {
  return {
    version: MARKER_VERSION,
    commands,
    create: createPending ? { status: "pending", next: 0 } : { status: "ok" },
    destroy: { status: "pending", next: 0 },
  };
}

function failedOutcome(outcome: ProcessOutcome): HookFailure | null {
  if (outcome.kind === "terminal") {
    return outcome.code === 0 ? null : {
      kind: "exit",
      code: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      truncated: outcome.truncated,
    };
  }
  return outcome;
}

function withProgress(marker: HookMarker, phase: HookPhase, progress: HookProgress): HookMarker {
  return { ...marker, [phase]: progress };
}

async function runPhase(
  worktree: string,
  administrationDirectory: string,
  hooks: WorktreeHooks,
  phase: HookPhase,
  retryHooks: boolean,
): Promise<WorktreeHookLag | null> {
  let marker = readMarker(administrationDirectory);
  if (marker === null) {
    marker = freshMarker(hooks, phase === "create");
    writeMarker(administrationDirectory, marker);
  }
  let progress = marker[phase];
  if (progress.status === "ok") return null;
  if (progress.status === "failed" && !retryHooks) {
    return { kind: "worktree-hook-failed", phase, path: worktree, command: progress.command, failure: progress.failure };
  }
  let index = progress.status === "failed" ? progress.command : progress.next;
  if (progress.status === "failed") {
    marker = withProgress(marker, phase, { status: "pending", next: index });
    writeMarker(administrationDirectory, marker);
  }
  const commands = marker.commands[phase];
  while (index < commands.length) {
    const command = commands[index]!;
    const failure = failedOutcome(await runProcess({ argv: command.argv, timeoutMs: command.timeoutMs, cwd: worktree }));
    if (failure !== null) {
      marker = withProgress(marker, phase, { status: "failed", command: index, failure });
      writeMarker(administrationDirectory, marker);
      return { kind: "worktree-hook-failed", phase, path: worktree, command: index, failure };
    }
    index += 1;
    marker = withProgress(marker, phase, index === commands.length ? { status: "ok" } : { status: "pending", next: index });
    writeMarker(administrationDirectory, marker);
  }
  if (marker[phase].status !== "ok") writeMarker(administrationDirectory, withProgress(marker, phase, { status: "ok" }));
  return null;
}

export function runCreateHooks(worktree: string, administrationDirectory: string, hooks: WorktreeHooks, retryHooks: boolean): Promise<WorktreeHookLag | null> {
  return runPhase(worktree, administrationDirectory, hooks, "create", retryHooks);
}

export function runDestroyHooks(worktree: string, administrationDirectory: string, hooks: WorktreeHooks, retryHooks: boolean): Promise<WorktreeHookLag | null> {
  return runPhase(worktree, administrationDirectory, hooks, "destroy", retryHooks);
}
