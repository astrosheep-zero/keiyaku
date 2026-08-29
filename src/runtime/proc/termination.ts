import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const TERMINATION_GRACE_MS = 250;
const WINDOWS_TERMINATION_SETTLE_MS = 250;
const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

function ignoreMissingProcess(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
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
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("close", () => {
      exited = true;
      resolve();
    });
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
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
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      ignoreMissingProcess(error);
    }
    await exit;
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    ignoreMissingProcess(error);
    await exit;
    return;
  }
  await Promise.race([exit, delay(TERMINATION_GRACE_MS)]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    ignoreMissingProcess(error);
  }
  await exit;
}
