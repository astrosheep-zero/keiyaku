import { consumeProcessStdout, spawnCancellableProcess } from "../runtime/proc/run.js";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withPrivateGitIndex<Value>(
  action: (environment: Readonly<{ GIT_INDEX_FILE: string }>) => Value | PromiseLike<Value>,
): Promise<Value> {
  const directory = await mkdtemp(join(tmpdir(), "keiyaku-v4-index-"));
  let value: Value;
  try {
    value = await action({ GIT_INDEX_FILE: join(directory, "index") });
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Private Git index operation and cleanup failed");
    }
    throw error;
  }
  await rm(directory, { recursive: true, force: true });
  return value;
}

export type GitRepository = Readonly<{
  /** The executable selected when this repository capability is created. */
  readonly gitPath: string;
  /** The invocation's effective working directory, including a caller -C worktree. */
  readonly effectiveCwd: string;
  /** The worktree root containing the invocation's effective working directory. */
  readonly invocationWorktree: string;
  /** The canonical primary worktree root for this repository. */
  readonly primaryWorktree: string;
  /** The canonical common Git directory pinned when this capability is created. */
  readonly commonDirectory: string;
  /** A caller-owned cancellation boundary for this capability view. */
  readonly signal?: AbortSignal;
  /** Test-only observation that this capability is waiting for the private-state seat. */
  readonly onPrivateStateSeatContention?: () => void;
  /** Test-only hook after the private-state seat close attempt. */
  readonly onPrivateStateSeatClose?: () => void;
}>;

export class GitPlumbingError extends Error {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: number | null;
  readonly pid: number | null;

  constructor(
    input: Readonly<{
      stdout?: string | Uint8Array;
      stderr: string | Uint8Array;
      status: number | null;
      message: string;
      pid?: number | null;
    }>,
    options?: ErrorOptions,
  ) {
    super(input.message, options);
    this.name = "GitPlumbingError";
    this.stdout = Buffer.from(input.stdout ?? "");
    this.stderr = Buffer.from(input.stderr);
    this.status = input.status;
    this.pid = input.pid ?? null;
  }
}

const GIT_STDERR_BYTES = 16 * 1024;

export function gitChildEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const variable of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
  ]) {
    delete inherited[variable];
  }
  return { ...inherited, ...environment };
}

function gitProcessOptions(repository: GitRepository, args: readonly string[], environment?: NodeJS.ProcessEnv) {
  return {
    argv: [repository.gitPath, ...args],
    cwd: repository.effectiveCwd,
    env: gitChildEnvironment(environment),
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
  };
}

function commandError(command: readonly string[], error: unknown, options?: ErrorOptions): GitPlumbingError {
  const candidate = error as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number | null;
    pid?: number;
  };
  const stderr = candidate.stderr === undefined ? Buffer.alloc(0) : Buffer.from(candidate.stderr);
  const stdout = candidate.stdout === undefined ? Buffer.alloc(0) : Buffer.from(candidate.stdout);
  const detail = stderr.length === 0 ? (candidate.message ?? "git command failed") : stderr.toString("utf8");
  return new GitPlumbingError(
    {
      stdout,
      stderr,
      status: candidate.status ?? null,
      message: `${command.join(" ")}: ${detail}`,
      pid: candidate.pid ?? null,
    },
    options,
  );
}

async function retireFiniteGit(owned: ReturnType<typeof spawnCancellableProcess>) {
  const { child } = owned;
  type Terminal = Readonly<{ code: number | null; error?: Error }>;
  let exit: Terminal | undefined;
  let cancelledExit = false;
  child.once("exit", (code, bySignal) => {
    exit = { code };
    // A stop that arrived only while closing the streams did not cause the exit.
    cancelledExit = owned.cancelled() && (bySignal === "SIGTERM" || bySignal === "SIGKILL");
  });
  const closed = new Promise<Terminal>((resolveTerminal) => {
    child.once("error", (error) => {
      exit = { code: null, error };
      resolveTerminal(exit);
    });
    child.once("close", (code) => resolveTerminal({ code }));
  });
  // If retirement fails before close, don't block on streams it couldn't retire.
  // waitTermination returns that same owned error and also releases the abort listener.
  const close = await Promise.race([closed, owned.terminationFailure]).catch(() => undefined);
  let retirement: { error: unknown } | undefined;
  try {
    await owned.waitTermination();
  } catch (error) {
    retirement = { error };
  }
  return { terminal: close ?? exit, retirement, cancelledExit };
}

function gitExitDiagnostic(status: number | null, cancelled: boolean, error?: Error): string {
  return error?.message ?? (cancelled ? "git process cancelled" : `git exited with status ${status ?? "unknown"}`);
}

export async function executeGit(
  repository: GitRepository,
  args: readonly string[],
  input?: string | Uint8Array,
  environment?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const { signal } = repository;
  if (signal?.aborted === true) {
    throw commandError(args, { message: "git process cancelled", status: null }, { cause: signal.reason });
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let inputError: Error | undefined;
  const owned = spawnCancellableProcess(gitProcessOptions(repository, args, environment));
  const child = owned.child;
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => {
    if (stderrBytes >= GIT_STDERR_BYTES) return;
    const retained = chunk.subarray(0, GIT_STDERR_BYTES - stderrBytes);
    stderr.push(retained);
    stderrBytes += retained.length;
  });
  child.stdin!.on("error", (error: Error) => {
    inputError = error;
  });
  child.stdin!.end(input);
  const { terminal, retirement, cancelledExit } = await retireFiniteGit(owned);
  const status = terminal?.code ?? null;
  const problem = terminal?.error ?? inputError;
  const cancelled = cancelledExit && status === null && problem === undefined;
  if (problem === undefined) {
    if (retirement !== undefined && (terminal === undefined || status === 0 || cancelled)) throw retirement.error;
    if (status === 0) return Buffer.concat(stdout);
  }
  const failure = commandError(
    args,
    {
      message: gitExitDiagnostic(status, cancelled, problem),
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      status,
      pid: child.pid,
    },
    cancelled ? { cause: signal?.reason } : undefined,
  );
  if (retirement !== undefined) {
    const clean = retirement.error instanceof Error ? retirement.error.message : String(retirement.error);
    throw new AggregateError([failure, retirement.error], `${failure.message.trimEnd()}; ${clean}`, { cause: failure });
  }
  throw failure;
}

export function executeLiteralGit(repository: GitRepository, args: readonly string[], input?: string | Uint8Array) {
  return executeGit(repository, args, input, { GIT_NO_REPLACE_OBJECTS: "1" });
}

function boundedPipeOutput(
  child: ReturnType<typeof spawnCancellableProcess>["child"],
  args: readonly string[],
): Promise<Buffer> {
  const stdout: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  return new Promise<Buffer>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof GitPlumbingError ? error : commandError(args, error));
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_STDERR_BYTES) {
        fail(commandError(args, { message: "Git pipe result exceeds its bounded output", status: null }));
      } else stdout.push(chunk);
    });
    child.stdout!.once("error", fail);
    child.once("close", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(stdout));
    });
  });
}

/** Connect two owned Git commands without materializing the intermediate output. */
export async function runGitPipe(
  repository: GitRepository,
  sourceArgs: readonly string[],
  sinkArgs: readonly string[],
): Promise<Buffer> {
  if (repository.signal?.aborted) throw commandError(sourceArgs, { message: "git process cancelled" });
  const processes: ReturnType<typeof spawnCancellableProcess>[] = [];
  const pending: Promise<unknown>[] = [];
  const start = (args: readonly string[]) => {
    const owned = spawnCancellableProcess(gitProcessOptions(repository, args));
    processes.push(owned);
    const { child } = owned;
    const stderr: Buffer[] = [];
    let bytes = 0;
    child.stderr!.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, GIT_STDERR_BYTES - bytes);
      if (kept.length > 0) stderr.push(kept);
      bytes += kept.length;
    });
    const terminal = new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void =>
        reject(
          commandError(args, {
            message: owned.cancelled() ? "git process cancelled" : (error as Error).message,
            stderr: Buffer.concat(stderr),
            status: child.exitCode,
            pid: child.pid,
          }),
        );
      child.once("error", fail);
      child.stdin!.on("error", fail);
      child.once("close", (code) => {
        if (code === 0 && !owned.cancelled()) resolve();
        else fail(new Error(`git exited with status ${code ?? "unknown"}`));
      });
    });
    const completed = Promise.race([terminal, owned.terminationFailure]);
    pending.push(completed);
    // A later spawn can fail synchronously before the common await is installed.
    void completed.catch(() => undefined);
    return child;
  };
  try {
    const source = start(sourceArgs);
    const sink = start(sinkArgs);
    const output = boundedPipeOutput(sink, sinkArgs);
    void output.catch(() => undefined);
    pending.push(output);
    pending.push(pipeline(source.stdout!, sink.stdin!));
    source.stdin!.end();
    await Promise.all(pending);
    await Promise.all(processes.map((owned) => owned.waitTermination()));
    return await output;
  } catch (error) {
    const cleanup = await Promise.allSettled(
      processes.map(async (owned) => {
        try {
          await owned.terminate(true);
        } finally {
          await owned.waitTermination();
        }
      }),
    );
    // A failed termination cannot promise that the pipes will ever close.
    const failures = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length > 0) {
      void Promise.allSettled(pending);
      throw new AggregateError([error, ...failures], "Git pipeline failed and could not retire its processes");
    }
    await Promise.allSettled(pending);
    if (error instanceof GitPlumbingError) throw error;
    throw commandError([...sourceArgs, "|", ...sinkArgs], error);
  }
}

export async function consumeGitStdout(
  repository: GitRepository,
  args: readonly string[],
  consume: (chunk: Buffer) => void,
): Promise<void> {
  const result = await consumeProcessStdout(gitProcessOptions(repository, args), consume);
  const { outcome } = result;
  if (outcome.kind === "terminal" && outcome.code === 0) return;
  const status = outcome.kind === "terminal" ? outcome.code : null;
  const stderr = outcome.kind === "terminal" ? outcome.stderr : "";
  const message =
    outcome.kind === "terminal"
      ? `git exited with status ${outcome.code}`
      : outcome.kind === "spawn-error" || outcome.kind === "stream-error"
        ? outcome.diagnostic
        : `git process ended with ${outcome.kind}`;
  throw commandError(args, {
    message,
    stderr,
    status,
    pid: result.pid ?? undefined,
  });
}
