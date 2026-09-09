import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
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
  /** @internal Mechanical output observation only; it does not affect process ownership or outcome. */
  readonly onOutput?: (output: Readonly<{ stream: "stdout" | "stderr"; text: string }>) => void;
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

type ProcessEnd =
  | Readonly<{ kind: "closed"; code: number | null }>
  | Readonly<{ kind: "spawn-error"; error: Error }>
  | Readonly<{ kind: "termination-error"; error: unknown }>;

function waitForProcessEnd(
  child: ChildProcess,
  terminationFailure: Promise<Readonly<{ kind: "termination-error"; error: unknown }>>,
): Promise<ProcessEnd> {
  const childEnd = new Promise<Exclude<ProcessEnd, { kind: "termination-error" }>>((resolve) => {
    child.once("close", (code) => resolve({ kind: "closed", code }));
    child.once("error", (error) => resolve({ kind: "spawn-error", error }));
  });
  return Promise.race([childEnd, terminationFailure]);
}

export type CancellableProcess = Readonly<{
  child: ChildProcess;
  cancelled(): boolean;
  terminationFailure: Promise<never>;
  terminate(force?: boolean): Promise<void>;
  waitTermination(): Promise<void>;
}>;

export function spawnCancellableProcess(input: ProcessLaunch): CancellableProcess {
  const child = spawn(input.argv[0]!, input.argv.slice(1), spawnOptionsFor(input, ["pipe", "pipe", "pipe"]));
  let cancelled = false;
  let termination: Promise<void> | undefined;
  let reportTerminationFailure!: (error: unknown) => void;
  const terminationFailure = new Promise<never>((_resolve, reject) => {
    reportTerminationFailure = reject;
  });
  void terminationFailure.catch(() => undefined);
  const terminate = (force = false): Promise<void> => {
    if (termination === undefined) {
      termination = terminateOwnedProcess(child, force);
      void termination.catch(reportTerminationFailure);
    }
    return termination;
  };
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void terminate();
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted === true) cancel();
  return {
    child,
    cancelled: () => cancelled,
    terminationFailure,
    terminate,
    async waitTermination(): Promise<void> {
      input.signal?.removeEventListener("abort", cancel);
      await termination;
    },
  };
}

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

type ProcessCapture = Readonly<{
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}>;

type ProcessTimeout = Readonly<{ readonly kind: "timeout" }> & ProcessCapture;

type ProcessSpawnError = Readonly<{
  readonly kind: "spawn-error";
  readonly diagnostic: string;
}> &
  ProcessCapture;

type ProcessUnknownExit = Readonly<{ readonly kind: "unknown-exit" }> & ProcessCapture;

type ProcessCancelled = Readonly<{ readonly kind: "cancelled" }> & ProcessCapture;

export type ProcessOutcome =
  | ProcessTerminal
  | ProcessTimeout
  | ProcessSpawnError
  | ProcessUnknownExit
  | ProcessCancelled;

type ProcessStreamError = Readonly<{
  readonly kind: "stream-error";
  readonly diagnostic: string;
  readonly stderr: string;
  readonly truncated: boolean;
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
      let startAt = 0;
      while (startAt < value.length && (value[startAt]! & 0xc0) === 0x80) startAt += 1;
      return { text: value.subarray(startAt).toString("utf8"), truncated: total > limit };
    },
  };
}

export { terminateOwnedProcess } from "./termination.js";

export async function spawnDetachedProcess(input: DetachedProcessInput): Promise<OwnedProcess> {
  if (process.platform === "win32") return spawnWindowsRetainedProcess(input);
  const log = await open(input.log, "a");
  let launched = false;
  try {
    const from = (await log.stat()).size;
    const child = spawn(input.argv[0]!, input.argv.slice(1), spawnOptionsFor(input, ["ignore", log.fd, log.fd]));
    const lifecycle = createProcessLifecycle(
      (force) => terminateOwnedProcess(child, force),
      () => child.unref(),
    );
    const exited = new Promise<DetachedProcessExit>((resolve, reject) => {
      child.once("close", (code, signal) => {
        void (async () => {
          await lifecycle.terminate();
          const status = detachedExitStatus(code, signal);
          let failure: unknown;
          let result: DetachedProcessExit | undefined;
          let exitLog: Awaited<ReturnType<typeof open>> | undefined;
          try {
            exitLog = await open(input.log, "r+");
            result = await retainDetachedExitEvidence(exitLog, input.log, from, code, signal);
          } catch (error) {
            failure = error;
          }
          try {
            await exitLog?.close();
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
    await log.close();
    launched = true;
    return {
      pid,
      exited,
      terminate: lifecycle.terminate,
      release: lifecycle.release,
    };
  } finally {
    if (!launched) await log.close();
  }
}

function capturedOutput(
  stdout: Readonly<{ text: string; truncated: boolean }>,
  stderr: Readonly<{ text: string; truncated: boolean }>,
  consuming: boolean,
): ProcessCapture {
  return {
    stdout: consuming ? "" : stdout.text,
    stderr: stderr.text,
    truncated: (consuming ? false : stdout.truncated) || stderr.truncated,
  };
}

function outputObservation(
  input: ProcessLaunch,
  consumingStdout: boolean,
): Readonly<{
  observe(stream: "stdout" | "stderr", chunk: Buffer): void;
  finish(): void;
}> {
  const decoders =
    input.onOutput === undefined
      ? undefined
      : {
          ...(consumingStdout ? {} : { stdout: new StringDecoder("utf8") }),
          stderr: new StringDecoder("utf8"),
        };
  const report = (stream: "stdout" | "stderr", text: string): void => {
    if (text.length === 0) return;
    try {
      input.onOutput?.({ stream, text });
    } catch {
      // Observation is not process ownership: a consumer cannot strand the owned child.
    }
  };
  return {
    observe(stream, chunk): void {
      const decoder = decoders?.[stream];
      if (decoder !== undefined) report(stream, decoder.write(chunk));
    },
    finish(): void {
      if (decoders === undefined) return;
      for (const stream of ["stdout", "stderr"] as const) {
        const decoder = decoders[stream];
        if (decoder !== undefined) report(stream, decoder.end());
      }
    },
  };
}

async function executeProcess(
  input: ProcessLaunch,
  timeoutMs: number | undefined,
  consumeStdout?: (chunk: Buffer) => void,
  spawnProcess: ProcessSpawner = spawn,
): Promise<ProcessConsumption> {
  if (input.signal?.aborted === true) {
    return { outcome: { kind: "cancelled", stdout: "", stderr: "", truncated: false }, pid: null };
  }
  const child = spawnProcess(input.argv[0]!, input.argv.slice(1), spawnOptionsFor(input, ["ignore", "pipe", "pipe"]));
  const stdout = tailCapture(STREAM_TAIL_BYTES);
  const stderr = tailCapture(STREAM_TAIL_BYTES);
  const output = outputObservation(input, consumeStdout !== undefined);

  let stop: "timeout" | "cancelled" | undefined;
  let streamError: unknown;
  let termination: Promise<void> | undefined;
  let reportTerminationFailure!: (error: unknown) => void;
  const terminationFailure = new Promise<Readonly<{ kind: "termination-error"; error: unknown }>>((resolve) => {
    reportTerminationFailure = (error) => resolve({ kind: "termination-error", error });
  });
  const requestStop = (reason: "timeout" | "cancelled"): void => {
    if (stop !== undefined) return;
    stop = reason;
    termination = terminateOwnedProcess(child);
    void termination.catch(reportTerminationFailure);
  };
  const failStream = (error: unknown): void => {
    if (streamError !== undefined) return;
    streamError = error;
    requestStop("cancelled");
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    if (consumeStdout === undefined) {
      stdout.append(chunk);
    } else {
      try {
        consumeStdout(chunk);
      } catch (error) {
        failStream(error);
      }
    }
    output.observe("stdout", chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr.append(chunk);
    output.observe("stderr", chunk);
  });
  if (consumeStdout !== undefined) {
    child.stdout!.once("error", failStream);
    child.stderr!.once("error", failStream);
  }
  const cancel = (): void => requestStop("cancelled");
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => requestStop("timeout"), timeoutMs);

  const terminal = await waitForProcessEnd(child, terminationFailure);
  if (timeout !== undefined) clearTimeout(timeout);
  input.signal?.removeEventListener("abort", cancel);
  if (terminal.kind === "termination-error") throw terminal.error;
  await termination;
  output.finish();

  const pid = child.pid ?? null;
  const capture = capturedOutput(stdout.result(), stderr.result(), consumeStdout !== undefined);
  if (terminal.kind === "spawn-error") {
    return { outcome: { kind: "spawn-error", diagnostic: terminal.error.message, ...capture }, pid };
  }
  if (streamError !== undefined) {
    return {
      outcome: {
        kind: "stream-error",
        diagnostic: streamError instanceof Error ? streamError.message : String(streamError),
        stderr: capture.stderr,
        truncated: capture.truncated,
      },
      pid,
    };
  }
  if (stop !== undefined) return { outcome: { kind: stop, ...capture }, pid };
  if (terminal.code === null) return { outcome: { kind: "unknown-exit", ...capture }, pid };
  return { outcome: { kind: "terminal", code: terminal.code, ...capture }, pid };
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

export function consumeProcessStdout(
  input: ProcessInput,
  consume: (chunk: Buffer) => void,
): Promise<ProcessConsumption> {
  return executeProcess(input, input.timeoutMs, consume);
}
