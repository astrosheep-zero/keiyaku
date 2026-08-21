import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceFileDurably } from "../coordination/durable-file.js";
import { acquireSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import { runProcess, runProcessToExit, type ProcessOutcome } from "../runtime/proc/run.js";

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
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 1 ||
    (value.timeoutMs as number) > 2_147_483_647
  ) {
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
      if (
        !Number.isInteger(value.code) ||
        typeof value.stdout !== "string" ||
        typeof value.stderr !== "string" ||
        typeof value.truncated !== "boolean"
      ) {
        throw new Error(`${coordinate} is invalid`);
      }
      return {
        kind: "exit",
        code: value.code as number,
        stdout: value.stdout,
        stderr: value.stderr,
        truncated: value.truncated,
      };
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
    return {
      status: "failed",
      command: value.command as number,
      failure: decodeFailure(value.failure, `${coordinate}.failure`),
    };
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

async function readMarker(administrationDirectory: string): Promise<HookMarker | null> {
  try {
    return decodeMarker(await readFile(hookMarkerPath(administrationDirectory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hookFailureDiagnostic(phase: HookPhase, progress: Extract<HookProgress, { status: "failed" }>): string {
  const failure = progress.failure;
  const detail =
    failure.kind === "exit"
      ? `exit=${failure.code}`
      : failure.kind === "spawn-error"
        ? failure.diagnostic
        : failure.kind;
  return `worktree-hook-failed ${phase} command=${progress.command} ${detail}`;
}

export type WorktreeHookMarkerObservation =
  | Readonly<{ kind: "absent" | "pending" | "ok" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

/** Read the durable hook marker without executing commands or taking locks. */
export async function observeWorktreeHookMarker(
  administrationDirectory: string,
): Promise<WorktreeHookMarkerObservation> {
  const marker = await readMarker(administrationDirectory);
  if (marker === null) return { kind: "absent" };
  if (marker.create.status === "failed")
    return { kind: "failed", diagnostic: hookFailureDiagnostic("create", marker.create) };
  if (marker.destroy.status === "failed")
    return { kind: "failed", diagnostic: hookFailureDiagnostic("destroy", marker.destroy) };
  if (marker.create.status === "pending" || marker.destroy.status === "pending") return { kind: "pending" };
  return { kind: "ok" };
}

async function writeMarker(administrationDirectory: string, marker: HookMarker): Promise<void> {
  const path = hookMarkerPath(administrationDirectory);
  await mkdir(dirname(path), { recursive: true });
  await replaceFileDurably(path, `${JSON.stringify(marker)}\n`);
}

function freshMarker(commands: WorktreeHooks, createPending: boolean): HookMarker {
  return {
    version: MARKER_VERSION,
    commands,
    create: createPending ? { status: "pending", next: 0 } : { status: "ok" },
    destroy: { status: "pending", next: 0 },
  };
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

function withProgress(marker: HookMarker, phase: HookPhase, progress: HookProgress): HookMarker {
  return { ...marker, [phase]: progress };
}

type HookRunnerInput = Readonly<{
  administrationDirectory: string;
  worktree: string;
  phase: HookPhase;
  command: number;
}>;

function hookExecutionLockPath(administrationDirectory: string): string {
  return join(administrationDirectory, "keiyaku", "hook-execution.sqlite");
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink())
      throw new Error(`worktree hook custody is not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Remove validated Keiyaku hook state after its worktree has been reset. */
export async function nukeWorktreeHookResidue(administrationDirectory: string): Promise<void> {
  const marker = hookMarkerPath(administrationDirectory);
  const lock = hookExecutionLockPath(administrationDirectory);
  const markerPresent = await regularFile(marker);
  const lockPresent = await regularFile(lock);
  if (!markerPresent && !lockPresent) return;
  const held = await acquireSqliteTransactionLock({ path: lock, mode: "immediate" });
  try {
    const currentMarker = await regularFile(marker);
    if (currentMarker) await readMarker(administrationDirectory);
    if (currentMarker) await unlink(marker);
  } finally {
    held.close();
  }
}

function decodeRunnerInput(encoded: string): HookRunnerInput {
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (!object(value)) throw new Error("Hook runner input must be an object");
  exactKeys(value, ["administrationDirectory", "worktree", "phase", "command"], "Hook runner input");
  if (typeof value.administrationDirectory !== "string" || value.administrationDirectory.length === 0) {
    throw new Error("Hook runner administrationDirectory must be nonempty");
  }
  if (typeof value.worktree !== "string" || value.worktree.length === 0) {
    throw new Error("Hook runner worktree must be nonempty");
  }
  if (value.phase !== "create" && value.phase !== "destroy") throw new Error("Hook runner phase is invalid");
  if (!Number.isSafeInteger(value.command) || (value.command as number) < 0) {
    throw new Error("Hook runner command must be a nonnegative safe integer");
  }
  return {
    administrationDirectory: value.administrationDirectory,
    worktree: value.worktree,
    phase: value.phase,
    command: value.command as number,
  };
}

async function executePendingCommand(input: HookRunnerInput): Promise<void> {
  const held = await acquireSqliteTransactionLock({
    path: hookExecutionLockPath(input.administrationDirectory),
    mode: "immediate",
  });
  try {
    const marker = await readMarker(input.administrationDirectory);
    if (marker === null) throw new Error("worktree hook marker disappeared before execution");
    const progress = marker[input.phase];
    if (progress.status !== "pending" || progress.next !== input.command) return;
    const command = marker.commands[input.phase][input.command];
    if (command === undefined) throw new Error("worktree hook marker pending index is out of range");
    const result = await runHookCommands(input.worktree, [command]);
    if (result.kind === "cancelled") throw new Error("managed hook runner cancelled without a signal");
    const failure = result.kind === "failed" ? result.failure : null;
    const next = input.command + 1;
    await writeMarker(
      input.administrationDirectory,
      withProgress(
        marker,
        input.phase,
        failure === null
          ? next === marker.commands[input.phase].length
            ? { status: "ok" }
            : { status: "pending", next }
          : { status: "failed", command: input.command, failure },
      ),
    );
  } finally {
    held.close();
  }
}

function runnerFailure(outcome: ProcessOutcome): Error {
  if (outcome.kind === "terminal") {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    return new Error(
      detail.length === 0 ? `Hook runner exited ${outcome.code}` : `Hook runner exited ${outcome.code}: ${detail}`,
    );
  }
  if (outcome.kind === "spawn-error") return new Error(`Hook runner failed to spawn: ${outcome.diagnostic}`);
  return new Error(`Hook runner ended with ${outcome.kind}`);
}

async function runPendingCommand(input: HookRunnerInput): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  const outcome = await runProcessToExit({
    argv: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), "--run-hook", encoded],
    cwd: dirname(fileURLToPath(import.meta.url)),
  });
  if (outcome.kind !== "terminal" || outcome.code !== 0) throw runnerFailure(outcome);
}

async function runPhase(
  worktree: string,
  administrationDirectory: string,
  hooks: WorktreeHooks,
  phase: HookPhase,
  retryHooks: boolean,
): Promise<WorktreeHookLag | null> {
  let marker = await readMarker(administrationDirectory);
  if (marker === null) {
    marker = freshMarker(hooks, phase === "create");
    await writeMarker(administrationDirectory, marker);
  }
  let retryFailure = retryHooks && marker[phase].status === "failed";
  for (;;) {
    marker = await readMarker(administrationDirectory);
    if (marker === null) throw new Error("worktree hook marker disappeared during execution");
    const progress = marker[phase];
    if (progress.status === "ok") return null;
    if (progress.status === "failed") {
      if (!retryFailure) {
        return {
          kind: "worktree-hook-failed",
          phase,
          path: worktree,
          command: progress.command,
          failure: progress.failure,
        };
      }
      retryFailure = false;
      await writeMarker(
        administrationDirectory,
        withProgress(marker, phase, { status: "pending", next: progress.command }),
      );
      continue;
    }
    if (progress.next === marker.commands[phase].length) {
      await writeMarker(administrationDirectory, withProgress(marker, phase, { status: "ok" }));
      continue;
    }
    await runPendingCommand({ administrationDirectory, worktree, phase, command: progress.next });
  }
}

export function runCreateHooks(
  worktree: string,
  administrationDirectory: string,
  hooks: WorktreeHooks,
  retryHooks: boolean,
): Promise<WorktreeHookLag | null> {
  return runPhase(worktree, administrationDirectory, hooks, "create", retryHooks);
}

export function runDestroyHooks(
  worktree: string,
  administrationDirectory: string,
  hooks: WorktreeHooks,
  retryHooks: boolean,
): Promise<WorktreeHookLag | null> {
  return runPhase(worktree, administrationDirectory, hooks, "destroy", retryHooks);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1] &&
  process.argv[2] === "--run-hook"
) {
  const encoded = process.argv[3];
  if (encoded === undefined) throw new Error("Hook runner input is missing");
  await executePendingCommand(decodeRunnerInput(encoded));
}
