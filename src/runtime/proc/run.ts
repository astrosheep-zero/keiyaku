import { spawn } from "node:child_process";

const TERMINATION_GRACE_MS = 250;

export type ProcessInput = Readonly<{
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly signal?: AbortSignal;
}>;

type ProcessOutput = Readonly<{
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}>;

export type ProcessExit = ProcessOutput & Readonly<{
  readonly kind: "exit";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>;

export type ProcessTimeout = ProcessOutput & Readonly<{
  readonly kind: "timeout";
  readonly reason: "timeout" | "cancelled";
}>;

export type ProcessSpawnError = ProcessOutput & Readonly<{
  readonly kind: "spawn-error";
  readonly error: Error;
}>;

export type ProcessOutcome = ProcessExit | ProcessTimeout | ProcessSpawnError;

class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #size = 0;
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Uint8Array): void {
    const available = this.#limit - this.#size;
    if (available <= 0) {
      if (chunk.byteLength > 0) this.#truncated = true;
      return;
    }
    const captured = Buffer.from(chunk.subarray(0, available));
    this.#chunks.push(captured);
    this.#size += captured.byteLength;
    if (captured.byteLength < chunk.byteLength) this.#truncated = true;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }

  get truncated(): boolean {
    return this.#truncated;
  }
}

function validateInput(input: ProcessInput): void {
  if (input.argv.length === 0 || input.argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new TypeError("argv must contain a non-empty executable and arguments");
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") throw new TypeError("cwd must be a string");
  for (const [name, value] of [
    ["timeoutMs", input.timeoutMs],
    ["stdoutLimitBytes", input.stdoutLimitBytes],
    ["stderrLimitBytes", input.stderrLimitBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ignoreMissingProcess(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
}

function terminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", resolve);
    taskkill.once("close", resolve);
  });
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await terminateWindowsTree(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    ignoreMissingProcess(error);
    return;
  }
  await wait(TERMINATION_GRACE_MS);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    ignoreMissingProcess(error);
  }
}

export async function runProcess(input: ProcessInput): Promise<ProcessOutcome> {
  validateInput(input);
  const startedAt = performance.now();
  const stdout = new BoundedOutput(input.stdoutLimitBytes);
  const stderr = new BoundedOutput(input.stderrLimitBytes);
  const output = (): ProcessOutput => ({
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    durationMs: Math.round(performance.now() - startedAt),
  });
  if (input.signal?.aborted) return { kind: "timeout", reason: "cancelled", ...output() };

  const child = spawn(input.argv[0]!, input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Uint8Array) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Uint8Array) => stderr.append(chunk));

  let stopReason: ProcessTimeout["reason"] | undefined;
  let termination: Promise<void> | undefined;
  const requestStop = (reason: ProcessTimeout["reason"]): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    termination = terminateProcessTree(child.pid);
  };
  const onAbort = (): void => requestStop("cancelled");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) requestStop("cancelled");
  const timeout = setTimeout(() => requestStop("timeout"), input.timeoutMs);

  const terminal = await new Promise<
    | Readonly<{ readonly kind: "closed"; readonly code: number | null; readonly signal: NodeJS.Signals | null }>
    | Readonly<{ readonly kind: "spawn-error"; readonly error: Error }>
  >((resolve) => {
    child.once("close", (code, signal) => resolve({ kind: "closed", code, signal }));
    child.once("error", (error) => resolve({ kind: "spawn-error", error }));
  });
  clearTimeout(timeout);
  input.signal?.removeEventListener("abort", onAbort);
  await termination;

  if (terminal.kind === "spawn-error") return { kind: "spawn-error", error: terminal.error, ...output() };
  if (stopReason !== undefined) return { kind: "timeout", reason: stopReason, ...output() };
  return { kind: "exit", code: terminal.code, signal: terminal.signal, ...output() };
}
