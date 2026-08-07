import { spawn } from "node:child_process";

const TERMINATION_GRACE_MS = 250;
const STREAM_TAIL_BYTES = 16 * 1024;

type ProcessInput = Readonly<{
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
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

type ProcessOutcome = ProcessTerminal | ProcessTimeout | ProcessSpawnError | ProcessUnknownExit;

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
  const child = spawn(input.argv[0]!, input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = tailCapture(STREAM_TAIL_BYTES);
  const stderr = tailCapture(STREAM_TAIL_BYTES);
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

  let timedOut = false;
  let termination: Promise<void> | undefined;
  const requestStop = (): void => {
    if (timedOut) return;
    timedOut = true;
    termination = terminateProcessTree(child.pid);
  };
  const timeout = setTimeout(requestStop, input.timeoutMs);

  const terminal = await new Promise<
    | Readonly<{ readonly kind: "closed"; readonly code: number | null }>
    | Readonly<{ readonly kind: "spawn-error"; readonly error: Error }>
  >((resolve) => {
    child.once("close", (code) => resolve({ kind: "closed", code }));
    child.once("error", (error) => resolve({ kind: "spawn-error", error }));
  });
  clearTimeout(timeout);
  await termination;

  if (terminal.kind === "spawn-error") return { kind: "spawn-error", diagnostic: terminal.error.message };
  if (timedOut) return { kind: "timeout" };
  if (terminal.code === null) return { kind: "unknown-exit" };
  const capturedStdout = stdout.result();
  const capturedStderr = stderr.result();
  return {
    kind: "terminal",
    code: terminal.code,
    stdout: capturedStdout.text,
    stderr: capturedStderr.text,
    truncated: capturedStdout.truncated || capturedStderr.truncated,
  };
}
