import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import crossSpawn from "cross-spawn";
import { spawnOptionsFor, type DetachedProcessInput } from "./launch.js";
import { detachedExitStatus, retainDetachedExitEvidence } from "./process-exit.js";
import { createProcessLifecycle } from "./lifecycle.js";
import { terminateOwnedProcess } from "./termination.js";
import type { DetachedProcessExit, OwnedProcess } from "./types.js";
import { spawnWindowsRetainedProcess } from "./windows-run.js";

export type { DetachedProcessInput } from "./launch.js";
export type { DetachedProcessExit, OwnedProcess, RunLogReference } from "./types.js";

const STREAM_TAIL_BYTES = 16 * 1024;

type ProcessLaunch = Readonly<{
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}>;

type ProcessSpawnOptions = Readonly<{
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
  shell: false;
}>;

type ProcessSpawner = (command: string, args: readonly string[], options: ProcessSpawnOptions) => ChildProcess;

export type ProcessInput = ProcessLaunch &
  Readonly<{
    readonly timeoutMs?: number;
  }>;

type ProcessTerminal = Readonly<{
  readonly kind: "terminal";
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}>;

type ProcessTimeout = Readonly<{
  readonly kind: "timeout";
}>;

type ProcessSpawnError = Readonly<{
  readonly kind: "spawn-error";
  readonly diagnostic: string;
}>;

type ProcessUnknownExit = Readonly<{
  readonly kind: "unknown-exit";
}>;

type ProcessCancelled = Readonly<{
  readonly kind: "cancelled";
}>;

export type ProcessOutcome =
  | ProcessTerminal
  | ProcessTimeout
  | ProcessSpawnError
  | ProcessUnknownExit
  | ProcessCancelled;

type ProcessStreamError = Readonly<{
  readonly kind: "stream-error";
  readonly diagnostic: string;
}>;

export type ProcessConsumption = Readonly<{
  readonly outcome: ProcessOutcome | ProcessStreamError;
  readonly pid: number | null;
}>;

function tailCapture(limit: number) {
  const bytes = Buffer.allocUnsafe(limit);
  let total = 0;
  let cursor = 0;
  return {
    append(chunk: Buffer): void {
      if (chunk.length >= limit) {
        chunk.copy(bytes, 0, chunk.length - limit);
        total += chunk.length;
        cursor = 0;
        return;
      }
      const first = Math.min(chunk.length, limit - cursor);
      chunk.copy(bytes, cursor, 0, first);
      if (first < chunk.length) chunk.copy(bytes, 0, first);
      total += chunk.length;
      cursor = (cursor + chunk.length) % limit;
    },
    result(): Readonly<{ text: string; truncated: boolean }> {
      const size = Math.min(total, limit);
      const start = total > limit ? cursor : 0;
      const value =
        start === 0 ? bytes.subarray(0, size) : Buffer.concat([bytes.subarray(start), bytes.subarray(0, start)]);
      return { text: value.toString("utf8"), truncated: total > limit };
    },
  };
}

export { terminateOwnedProcess } from "./termination.js";

export async function spawnDetachedProcess(input: DetachedProcessInput): Promise<OwnedProcess> {
  if (process.platform === "win32") return spawnWindowsRetainedProcess(input);
  const log = await open(input.log, "a");
  let launched = false;
  let logClosed = false;
  const closeLog = async (): Promise<void> => {
    if (logClosed) return;
    logClosed = true;
    await log.close();
  };
  try {
    const from = (await log.stat()).size;
    const child = spawn(input.argv[0]!, input.argv.slice(1), spawnOptionsFor(input, ["ignore", log.fd, log.fd]));
    const lifecycle = createProcessLifecycle(
      (force) => terminateOwnedProcess(child, force),
      () => child.unref(),
    );
    const invalidate = (): void => {
      lifecycle.markInert();
    };
    child.once("exit", invalidate);
    child.once("close", invalidate);
    const exited = new Promise<DetachedProcessExit>((resolve, reject) => {
      child.once("close", (code, signal) => {
        void (async () => {
          const status = detachedExitStatus(code, signal);
          let failure: unknown;
          let result: DetachedProcessExit | undefined;
          try {
            result = await retainDetachedExitEvidence(log, input.log, from, code, signal);
          } catch (error) {
            failure = error;
          }
          try {
            await closeLog();
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) {
            throw new Error(
              `pre-admission ${status}: run-log evidence unavailable: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
          }
          resolve(result!);
        })().catch(reject);
      });
    });
    void exited.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("detached process spawned without a pid");
    const pid = child.pid;
    launched = true;
    return {
      pid,
      exited,
      terminate: lifecycle.terminate,
      release: lifecycle.release,
    };
  } finally {
    if (!launched) await closeLog();
  }
}

function terminalOutcome(
  code: number,
  stdout: Readonly<{ text: string; truncated: boolean }>,
  stderr: Readonly<{ text: string; truncated: boolean }>,
  consuming: boolean,
): ProcessTerminal {
  return {
    kind: "terminal",
    code,
    stdout: consuming ? "" : stdout.text,
    stderr: stderr.text,
    truncated: (consuming ? false : stdout.truncated) || stderr.truncated,
  };
}

async function executeProcess(
  input: ProcessLaunch,
  timeoutMs: number | undefined,
  consumeStdout?: (chunk: Buffer) => void,
  spawnProcess: ProcessSpawner = spawn,
): Promise<ProcessConsumption> {
  if (input.signal?.aborted === true) return { outcome: { kind: "cancelled" }, pid: null };
  const child = spawnProcess(input.argv[0]!, input.argv.slice(1), spawnOptionsFor(input, ["ignore", "pipe", "pipe"]));
  const stdout = tailCapture(STREAM_TAIL_BYTES);
  const stderr = tailCapture(STREAM_TAIL_BYTES);

  let stop: "timeout" | "cancelled" | undefined;
  let streamError: unknown;
  let termination: Promise<void> | undefined;
  const requestStop = (reason: "timeout" | "cancelled"): void => {
    if (stop !== undefined) return;
    stop = reason;
    termination = terminateOwnedProcess(child);
  };
  const failStream = (error: unknown): void => {
    if (streamError !== undefined) return;
    streamError = error;
    requestStop("cancelled");
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    if (consumeStdout === undefined) {
      stdout.append(chunk);
      return;
    }
    try {
      consumeStdout(chunk);
    } catch (error) {
      failStream(error);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => stderr.append(chunk));
  if (consumeStdout !== undefined) {
    child.stdout!.once("error", failStream);
    child.stderr!.once("error", failStream);
  }
  const cancel = (): void => requestStop("cancelled");
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => requestStop("timeout"), timeoutMs);

  const terminal = await new Promise<
    | Readonly<{ readonly kind: "closed"; readonly code: number | null }>
    | Readonly<{ readonly kind: "spawn-error"; readonly error: Error }>
  >((resolve) => {
    child.once("close", (code) => resolve({ kind: "closed", code }));
    child.once("error", (error) => resolve({ kind: "spawn-error", error }));
  });
  if (timeout !== undefined) clearTimeout(timeout);
  input.signal?.removeEventListener("abort", cancel);
  await termination;

  const pid = child.pid ?? null;
  if (terminal.kind === "spawn-error") {
    return { outcome: { kind: "spawn-error", diagnostic: terminal.error.message }, pid };
  }
  if (streamError !== undefined) {
    return {
      outcome: {
        kind: "stream-error",
        diagnostic: streamError instanceof Error ? streamError.message : String(streamError),
      },
      pid,
    };
  }
  if (stop !== undefined) return { outcome: { kind: stop }, pid };
  if (terminal.code === null) return { outcome: { kind: "unknown-exit" }, pid };
  const capturedStdout = stdout.result();
  const capturedStderr = stderr.result();
  return {
    outcome: terminalOutcome(terminal.code, capturedStdout, capturedStderr, consumeStdout !== undefined),
    pid,
  };
}

export async function runProcess(input: ProcessInput): Promise<ProcessOutcome> {
  const result = await executeProcess(input, input.timeoutMs);
  if (result.outcome.kind === "stream-error") throw new Error("buffered process produced a stream consumer error");
  return result.outcome;
}

export async function runCrossPlatformProcess(input: ProcessInput): Promise<ProcessOutcome> {
  const result = await executeProcess(input, input.timeoutMs, undefined, crossSpawn);
  if (result.outcome.kind === "stream-error") throw new Error("buffered process produced a stream consumer error");
  return result.outcome;
}

export async function runProcessToExit(input: ProcessLaunch): Promise<ProcessOutcome> {
  const result = await executeProcess(input, undefined);
  if (result.outcome.kind === "stream-error") throw new Error("buffered process produced a stream consumer error");
  return result.outcome;
}

export function consumeProcessStdout(
  input: ProcessInput,
  consume: (chunk: Buffer) => void,
): Promise<ProcessConsumption> {
  return executeProcess(input, input.timeoutMs, consume);
}
