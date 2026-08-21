import { execFile, spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import crossSpawn from "cross-spawn";
import {
  spawnOptionsFor,
  type DetachedProcessInput,
} from "./launch.js";

export { handoffProcess, type DetachedProcessInput } from "./launch.js";

const TERMINATION_GRACE_MS = 250;
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

export type ProcessInput = ProcessLaunch & Readonly<{
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

export type ProcessOutcome = ProcessTerminal | ProcessTimeout | ProcessSpawnError | ProcessUnknownExit | ProcessCancelled;

type ProcessStreamError = Readonly<{
  readonly kind: "stream-error";
  readonly diagnostic: string;
}>;

export type ProcessConsumption = Readonly<{
  readonly outcome: ProcessOutcome | ProcessStreamError;
  readonly pid: number | null;
}>;

export type RunLogReference = Readonly<{
  path: string;
  from: number;
  to: number;
}>;

export type DetachedProcessExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  log: RunLogReference;
}>;
export type OwnedProcess = Readonly<{
  pid: number;
  exited: Promise<DetachedProcessExit>;
  terminate(force?: boolean): Promise<void>;
  release(): void;
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
      const value = start === 0
        ? bytes.subarray(0, size)
        : Buffer.concat([bytes.subarray(start), bytes.subarray(0, start)]);
      return { text: value.toString("utf8"), truncated: total > limit };
    },
  };
}

function ignoreMissingProcess(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
}

function detachedExitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
}

const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

async function terminateWindowsTree(pid: number): Promise<void> {
  await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    timeout: WINDOWS_TERMINATION_TIMEOUT_MS,
    windowsHide: true,
  });
}

export async function terminateOwnedProcess(child: ChildProcess, force = false): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => { exited = true; resolve(); });
    child.once("close", () => { exited = true; resolve(); });
  });
  if (process.platform === "win32") {
    await terminateWindowsTree(pid);
    await exit;
    return;
  }
  if (force) {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { ignoreMissingProcess(error); }
    await exit;
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    ignoreMissingProcess(error);
    await exit;
    return;
  }
  await Promise.race([exit, delay(TERMINATION_GRACE_MS)]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    ignoreMissingProcess(error);
  }
  await exit;
}

export async function spawnDetachedProcess(input: DetachedProcessInput): Promise<OwnedProcess> {
  const log = await open(input.log, "a");
  let launched = false;
  try {
    const from = (await log.stat()).size;
    const child = spawn(input.argv[0]!, input.argv.slice(1), spawnOptionsFor("retained", input, ["ignore", log.fd, log.fd]));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("detached process spawned without a pid");
    const pid = child.pid;
    const exited = new Promise<DetachedProcessExit>((resolve, reject) => {
      child.once("close", (code, signal) => {
        void (async () => {
          const status = detachedExitStatus(code, signal);
          let failure: unknown;
          let result: DetachedProcessExit | undefined;
          try {
            const marker = Buffer.from(`[child ${status}]\n`);
            let written = 0;
            while (written < marker.byteLength) {
              const write = await log.write(marker, written, marker.byteLength - written);
              if (write.bytesWritten === 0) throw new Error("run log exit marker write made no progress");
              written += write.bytesWritten;
            }
            const evidence = await log.stat();
            if (evidence.size < from) throw new Error("run log shrank before exit evidence was retained");
            const referenced = await open(input.log, "r");
            try {
              const current = await referenced.stat();
              if (current.dev !== evidence.dev || current.ino !== evidence.ino) {
                throw new Error("run log path changed before exit evidence was retained");
              }
              if (current.size < evidence.size) {
                throw new Error("run log path size changed before exit evidence was retained");
              }
            } finally {
              await referenced.close();
            }
            result = { code, signal, log: { path: input.log, from, to: evidence.size } };
          } catch (error) {
            failure = error;
          }
          try {
            await log.close();
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) {
            throw new Error(`pre-admission ${status}: run-log evidence unavailable: ${failure instanceof Error ? failure.message : String(failure)}`);
          }
          resolve(result!);
        })().catch(reject);
      });
    });
    void exited.catch(() => undefined);
    let state: "active" | "terminating" | "inert" = "active";
    let termination: Promise<void> | undefined;
    const invalidate = (): void => { state = "inert"; };
    child.once("exit", invalidate);
    child.once("close", invalidate);
    launched = true;
    return {
      pid,
      exited,
      terminate(force = false) {
        if (state === "inert") return Promise.resolve();
        if (termination !== undefined) return termination;
        state = "terminating";
        termination = terminateOwnedProcess(child, force).finally(invalidate);
        return termination;
      },
      release: () => {
        if (state === "inert") return;
        state = "inert";
        child.unref();
      },
    };
  } finally {
    if (!launched) await log.close();
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
  const child = spawnProcess(
    input.argv[0]!,
    input.argv.slice(1),
    spawnOptionsFor("retained", input, ["ignore", "pipe", "pipe"]),
  );
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
