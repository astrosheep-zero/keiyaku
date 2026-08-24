import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LaunchIntent = "handoff" | "retained";

export type DetachedProcessInput = Readonly<{
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: string;
}>;

export type SpawnLaunchPolicy = Readonly<{
  kind: "spawn";
  detached: boolean;
  windowsHide: true;
  shell: false;
}>;

export type PlatformLaunchPolicy = Readonly<{ kind: "windows-launcher" }> | SpawnLaunchPolicy;

export function platformLaunchPolicy(
  intent: LaunchIntent,
  platform: NodeJS.Platform = process.platform,
): PlatformLaunchPolicy {
  if (platform === "win32" && intent === "handoff") return { kind: "windows-launcher" };
  return {
    kind: "spawn",
    detached: true,
    windowsHide: true,
    shell: false,
  };
}

export function spawnOptionsFor<Stdio>(
  intent: LaunchIntent,
  input: Readonly<{ cwd?: string; env?: NodeJS.ProcessEnv }>,
  stdio: Stdio,
  platform: NodeJS.Platform = process.platform,
): Readonly<{
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  detached: boolean;
  stdio: Stdio;
  windowsHide: true;
  shell: false;
}> {
  const policy = platformLaunchPolicy(intent, platform);
  if (policy.kind !== "spawn") throw new Error("Windows Body handoff uses the GUI launcher");
  return {
    cwd: input.cwd,
    env: input.env,
    detached: policy.detached,
    stdio,
    windowsHide: policy.windowsHide,
    shell: policy.shell,
  };
}

export function windowsLauncherPath(): string {
  const sourcePath = fileURLToPath(new URL("./windows-launch.exe", import.meta.url));
  if (process.platform === "win32" && !/[\\/]build[\\/]/u.test(sourcePath)) {
    return resolve(sourcePath, "../../../../build/src/runtime/proc/windows-launch.exe");
  }
  return sourcePath;
}

function launchFailure(command: string, diagnostic: string): NodeJS.ErrnoException {
  const error = new Error(diagnostic.length > 0 ? diagnostic : `spawn ${command} UNKNOWN`) as NodeJS.ErrnoException;
  const code = /\b(?:ENOENT|EACCES|EINVAL)\b/.exec(error.message)?.[0];
  if (code) error.code = code;
  error.syscall = "spawn";
  error.path = command;
  return error;
}

async function waitSpawned(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("detached process spawned without a pid");
}

export async function spawnLoggedProcess(input: DetachedProcessInput, intent: LaunchIntent): Promise<ChildProcess> {
  const log = await open(input.log, "a");
  try {
    const child = spawn(
      input.argv[0]!,
      input.argv.slice(1),
      spawnOptionsFor(intent, input, ["ignore", log.fd, log.fd]),
    );
    await waitSpawned(child);
    return child;
  } finally {
    await log.close();
  }
}

export async function handoffWindowsLaunch(
  input: DetachedProcessInput,
  launcher = windowsLauncherPath(),
): Promise<void> {
  const child = spawn(launcher, [input.log, ...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (exitCode) => resolve(exitCode));
  });
  try {
    await waitSpawned(child);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  const code = await closed;
  if (code === 0) return;
  throw launchFailure(input.argv[0] ?? launcher, stderr.trim());
}

export async function handoffProcess(input: DetachedProcessInput): Promise<void> {
  const policy = platformLaunchPolicy("handoff");
  if (policy.kind === "windows-launcher") {
    await handoffWindowsLaunch(input);
    return;
  }
  const child = await spawnLoggedProcess(input, "handoff");
  child.unref();
}
