import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

const TERMINATION_GRACE_MS = 250;
const STREAM_TAIL_BYTES = 16 * 1024;

type ProcessLaunch = Readonly<{
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}>;

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

export type ProcessIdentity = Readonly<{
  pid: number;
  spawnedAt: string;
}>;

export type ProcessIdentityProbe =
  | Readonly<{ kind: "gone" | "alive" | "replaced" }>
  | Readonly<{ kind: "unverifiable"; diagnostic: string }>;

export type ProcessCollar = Readonly<{
  pid: number;
  processGroup: number;
  spawnedAt: string;
}>;

export type ProcessTreeProbe =
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "alive" }>
  | Readonly<{ kind: "unverifiable"; diagnostic: string }>;

export type PutDownEvidence = "killed" | "already-dead" | "alive-after-sigkill" | "unavailable";

export type DetachedProcessInput = Readonly<{
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: string;
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

export async function terminateProcessTree(pid: number | undefined, force = false): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await terminateWindowsTree(pid);
    return;
  }
  if (force) {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { ignoreMissingProcess(error); }
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

function processStartToken(pid: number): string | null {
  const command = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`]
    : ["ps", "-o", "lstart=", "-p", String(pid)];
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", windowsHide: true });
  const token = result.status === 0 ? result.stdout.trim() : "";
  return token.length === 0 ? null : token;
}

export function currentProcessCollar(): ProcessCollar {
  const identity = currentProcessIdentity();
  return { ...identity, processGroup: identity.pid };
}

export function currentProcessIdentity(): ProcessIdentity {
  const spawnedAt = processStartToken(process.pid);
  if (spawnedAt === null) throw new Error(`cannot read process start identity for ${process.pid}`);
  return { pid: process.pid, spawnedAt };
}

export function probeProcessIdentity(identity: ProcessIdentity): ProcessIdentityProbe {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { kind: "gone" };
    return { kind: "unverifiable", diagnostic: error instanceof Error ? error.message : String(error) };
  }
  const current = processStartToken(identity.pid);
  if (current === null) return { kind: "unverifiable", diagnostic: `cannot read process start identity for ${identity.pid}` };
  if (current === identity.spawnedAt) return { kind: "alive" };
  return { kind: "replaced" };
}

export async function spawnDetachedProcess(input: DetachedProcessInput): Promise<ProcessCollar> {
  const log = openSync(input.log, "a");
  try {
    const child = spawn(input.argv[0]!, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("detached process spawned without a pid");
    const spawnedAt = processStartToken(child.pid);
    if (spawnedAt === null) throw new Error(`cannot read process start identity for ${child.pid}`);
    child.unref();
    return { pid: child.pid, processGroup: child.pid, spawnedAt };
  } finally {
    closeSync(log);
  }
}

export function probeProcessTree(collar: ProcessCollar): ProcessTreeProbe {
  try {
    process.kill(process.platform === "win32" ? collar.pid : -collar.processGroup, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { kind: "gone" };
    return { kind: "unverifiable", diagnostic: error instanceof Error ? error.message : String(error) };
  }
  const current = processStartToken(collar.pid);
  if (current === null && process.platform !== "win32") return { kind: "alive" };
  if (current === collar.spawnedAt) return { kind: "alive" };
  return { kind: "unverifiable", diagnostic: `process ${collar.pid} no longer matches its recorded start identity` };
}

export async function putDownProcessTree(collar: ProcessCollar): Promise<PutDownEvidence> {
  const before = probeProcessTree(collar);
  if (before.kind === "gone") return "already-dead";
  if (before.kind === "unverifiable") return "unavailable";
  await terminateProcessTree(collar.pid);
  const after = probeProcessTree(collar);
  if (after.kind === "gone") return "killed";
  return after.kind === "alive" ? "alive-after-sigkill" : "unavailable";
}

async function executeProcess(input: ProcessLaunch, timeoutMs: number | undefined): Promise<ProcessOutcome> {
  if (input.signal?.aborted === true) return { kind: "cancelled" };
  const child = spawn(input.argv[0]!, input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = tailCapture(STREAM_TAIL_BYTES);
  const stderr = tailCapture(STREAM_TAIL_BYTES);
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

  let stop: "timeout" | "cancelled" | undefined;
  let termination: Promise<void> | undefined;
  const requestStop = (reason: "timeout" | "cancelled"): void => {
    if (stop !== undefined) return;
    stop = reason;
    termination = terminateProcessTree(child.pid);
  };
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

  if (terminal.kind === "spawn-error") return { kind: "spawn-error", diagnostic: terminal.error.message };
  if (stop !== undefined) return { kind: stop };
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

export function runProcess(input: ProcessInput): Promise<ProcessOutcome> {
  return executeProcess(input, input.timeoutMs);
}

export function runProcessToExit(input: ProcessLaunch): Promise<ProcessOutcome> {
  return executeProcess(input, undefined);
}
