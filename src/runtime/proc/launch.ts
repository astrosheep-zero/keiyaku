import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DetachedProcessInput = Readonly<{
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: string;
}>;

export function spawnOptionsFor<Stdio>(
  input: Readonly<{ cwd?: string; env?: NodeJS.ProcessEnv }>,
  stdio: Stdio,
): Readonly<{
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  detached: true;
  stdio: Stdio;
  windowsHide: true;
  shell: false;
}> {
  return {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio,
    windowsHide: true,
    shell: false,
  };
}

export function windowsLauncherPath(): string {
  const sourcePath = fileURLToPath(new URL("./windows-launch.exe", import.meta.url));
  if (process.platform === "win32" && !/[\\/]build[\\/]/u.test(sourcePath)) {
    return resolve(sourcePath, "../../../../build/src/runtime/proc/windows-launch.exe");
  }
  return sourcePath;
}

export function launchFailure(command: string, diagnostic: string): NodeJS.ErrnoException {
  const error = new Error(diagnostic.length > 0 ? diagnostic : `spawn ${command} UNKNOWN`) as NodeJS.ErrnoException;
  const code = /\b(?:ENOENT|EACCES|EINVAL)\b/.exec(error.message)?.[0];
  if (code) error.code = code;
  error.syscall = "spawn";
  error.path = command;
  return error;
}

export function spawnWindowsLauncher(input: DetachedProcessInput, launcher = windowsLauncherPath()): ChildProcess {
  return spawn(launcher, ["--retain", input.log, ...input.argv], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}
