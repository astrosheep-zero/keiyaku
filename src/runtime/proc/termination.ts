import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const TERMINATION_GRACE_MS = 250;
const WINDOWS_TERMINATION_SETTLE_MS = 250;
const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 10;
const execFileAsync = promisify(execFile);

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

async function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals, exit: Promise<void>): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (isMissingProcess(error)) return;
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    const exited = await Promise.race([
      exit.then(() => true),
      delay(TERMINATION_GRACE_MS, false, { ref: false }).then(() => false),
    ]);
    if (!exited) throw error;
  }
}

function ownedProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForOwnedProcessGroupExit(pid: number): Promise<void> {
  const attempts = Math.ceil(TERMINATION_GRACE_MS / PROCESS_GROUP_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!ownedProcessGroupExists(pid)) return;
    await delay(PROCESS_GROUP_POLL_MS, undefined, { ref: false });
  }
  if (ownedProcessGroupExists(pid)) throw new Error("owned process group did not exit after termination");
}

export async function terminateWindowsTree(pid: number): Promise<void> {
  try {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      timeout: WINDOWS_TERMINATION_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    const diagnostic = error as NodeJS.ErrnoException & { stderr?: string };
    const text = `${diagnostic.stderr ?? ""} ${diagnostic.message ?? ""}`;
    if (diagnostic.code === "ESRCH" || /not found|no running instance|does not exist/iu.test(text)) return;
    throw error;
  }
}

export async function settleWindowsTermination(exit: Promise<void>): Promise<void> {
  const settled = await Promise.race([
    exit.then(() => true),
    delay(WINDOWS_TERMINATION_TIMEOUT_MS, false, { ref: false }).then(() => false),
  ]);
  if (!settled) throw new Error("Windows process did not exit after taskkill");
  await delay(WINDOWS_TERMINATION_SETTLE_MS);
}

function closeWindowsStreams(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export async function terminateOwnedProcess(child: ChildProcess, force = false): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const exit = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    child.once("close", () => {
      resolve();
    });
  });
  if (process.platform === "win32") {
    try {
      await terminateWindowsTree(pid);
      await settleWindowsTermination(exit);
    } finally {
      closeWindowsStreams(child);
    }
    return;
  }
  if (force) {
    await signalOwnedProcessGroup(pid, "SIGKILL", exit);
    await waitForOwnedProcessGroupExit(pid);
    await exit;
    return;
  }
  await signalOwnedProcessGroup(pid, "SIGTERM", exit);
  await delay(TERMINATION_GRACE_MS);
  if (ownedProcessGroupExists(pid)) {
    await signalOwnedProcessGroup(pid, "SIGKILL", exit);
    await waitForOwnedProcessGroupExit(pid);
  }
  await exit;
}
