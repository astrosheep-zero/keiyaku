import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
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

export type PlatformLaunchPolicy =
  | Readonly<{ kind: "windows-launcher" }>
  | SpawnLaunchPolicy;

export function platformLaunchPolicy(
  intent: LaunchIntent,
  platform: NodeJS.Platform = process.platform,
): PlatformLaunchPolicy {
  if (platform === "win32" && intent === "handoff") return { kind: "windows-launcher" };
  return {
    kind: "spawn",
    detached: platform !== "win32",
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
  return fileURLToPath(new URL("./windows-launch.exe", import.meta.url));
}

function envRecord(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (value !== undefined) record[key] = value;
  }
  return record;
}

export function encodeLaunchSpec(input: DetachedProcessInput): Buffer {
  return Buffer.from(JSON.stringify({
    argv: input.argv,
    cwd: input.cwd,
    env: envRecord(input.env),
    log: input.log,
  }), "utf8");
}

function launchFailure(command: string, diagnostic: string): NodeJS.ErrnoException {
  const error = new Error(diagnostic.length > 0 ? diagnostic : `spawn ${command} UNKNOWN`) as NodeJS.ErrnoException;
  if (/\bENOENT\b/.test(error.message)) error.code = "ENOENT";
  else if (/\bEACCES\b/.test(error.message)) error.code = "EACCES";
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
    const child = spawn(input.argv[0]!, input.argv.slice(1), spawnOptionsFor(intent, input, ["ignore", log.fd, log.fd]));
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
  const spec = encodeLaunchSpec(input);
  const child = spawn(launcher, [], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (exitCode) => resolve(exitCode));
  });
  try {
    await waitSpawned(child);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  await new Promise<void>((resolve, reject) => {
    child.stdin!.once("error", reject);
    child.stdin!.end(spec, resolve);
  });
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
