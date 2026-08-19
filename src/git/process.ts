import { spawn } from "node:child_process";
import { consumeProcessStdout } from "../runtime/proc/run.js";

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
}>;

export class GitPlumbingError extends Error {
  readonly stdout: Buffer; readonly stderr: Buffer;
  readonly status: number | null; readonly pid: number | null;

  constructor(input: Readonly<{
    stdout?: string | Uint8Array; stderr: string | Uint8Array;
    status: number | null; message: string; pid?: number | null;
  }>) {
    super(input.message);
    this.name = "GitPlumbingError";
    this.stdout = Buffer.from(input.stdout ?? "");
    this.stderr = Buffer.from(input.stderr);
    this.status = input.status;
    this.pid = input.pid ?? null;
  }
}

const GIT_STDERR_BYTES = 16 * 1024;

function commandError(command: readonly string[], error: unknown): GitPlumbingError {
  const candidate = error as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number | null;
    pid?: number;
  };
  const stderr = candidate.stderr === undefined ? Buffer.alloc(0) : Buffer.from(candidate.stderr);
  const stdout = candidate.stdout === undefined ? Buffer.alloc(0) : Buffer.from(candidate.stdout);
  const detail = stderr.length === 0 ? candidate.message ?? "git command failed" : stderr.toString("utf8");
  return new GitPlumbingError({
    stdout,
    stderr,
    status: candidate.status ?? null,
    message: `${command.join(" ")}: ${detail}`,
    pid: candidate.pid ?? null,
  });
}

async function executeGit(
  repository: GitRepository,
  args: readonly string[],
  input: string | Uint8Array | undefined,
  environment?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let inputError: Error | undefined;
  const child = spawn(repository.gitPath, [...args], {
    cwd: repository.effectiveCwd,
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= GIT_STDERR_BYTES) return;
    const retained = chunk.subarray(0, GIT_STDERR_BYTES - stderrBytes);
    stderr.push(retained);
    stderrBytes += retained.length;
  });
  child.stdin.on("error", (error: Error) => { inputError = error; });
  child.stdin.end(input);
  const terminal = await new Promise<Readonly<{ code: number | null; error?: Error }>>((resolveTerminal) => {
    child.once("error", (error) => resolveTerminal({ code: null, error }));
    child.once("close", (code) => resolveTerminal({ code }));
  });
  const output = Buffer.concat(stdout);
  if (terminal.code === 0 && inputError === undefined) return output;
  throw commandError(args, {
    message: terminal.error?.message ?? inputError?.message ?? `git exited with status ${terminal.code ?? "unknown"}`,
    stdout: output,
    stderr: Buffer.concat(stderr),
    status: terminal.code,
    pid: child.pid,
  });
}

export async function runGit(
  repository: GitRepository,
  args: readonly string[],
  input?: string | Uint8Array,
): Promise<Buffer> {
  return await executeGit(repository, args, input);
}

export async function consumeGitStdout(
  repository: GitRepository,
  args: readonly string[],
  consume: (chunk: Buffer) => void,
): Promise<void> {
  const result = await consumeProcessStdout({
    argv: [repository.gitPath, ...args],
    cwd: repository.effectiveCwd,
  }, consume);
  const { outcome } = result;
  if (outcome.kind === "terminal" && outcome.code === 0) return;
  const status = outcome.kind === "terminal" ? outcome.code : null;
  const stderr = outcome.kind === "terminal" ? outcome.stderr : "";
  const message = outcome.kind === "terminal"
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

export async function runGitWithEnvironment(
  repository: GitRepository,
  args: readonly string[],
  input: string | Uint8Array | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return await executeGit(repository, args, input, environment);
}
