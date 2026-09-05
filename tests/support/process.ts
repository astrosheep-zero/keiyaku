import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROCESS_EXIT_POLL_MS = 20;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const TEMP_DIRECTORY_TIMEOUT_MS = 2_000;

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export async function waitForProcessExit(pid: number, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (processExists(pid)) {
    if (performance.now() >= deadline) throw new Error(`process ${pid} survived`);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
}

export async function waitForFixtureFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for barrier file: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
}

export function akumaBodyPidReceiptImport(): string {
  return pathToFileURL(resolve("tests/support/akuma-body-pid-receipt.mjs")).href;
}

export function appendNodeOptionsImport(moduleUrl: string, existing = process.env.NODE_OPTIONS): string {
  const flag = `--import=${moduleUrl}`;
  if (existing === undefined || existing.length === 0) return flag;
  if (existing.split(/\s+/u).includes(flag)) return existing;
  return `${existing} ${flag}`;
}

export function installAkumaBodyPidReceipt(receiptPath: string): () => void {
  const previousReceipt = process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT = receiptPath;
  process.env.NODE_OPTIONS = appendNodeOptionsImport(akumaBodyPidReceiptImport(), previousNodeOptions);
  return () => {
    if (previousReceipt === undefined) delete process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT;
    else process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT = previousReceipt;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  };
}

export function readPidReceipt(path: string): number[] {
  if (!existsSync(path)) return [];
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    if (!/^[1-9][0-9]*$/u.test(line)) throw new Error(`malformed fixture child pid receipt: ${line}`);
    const pid = Number(line);
    if (!Number.isSafeInteger(pid)) throw new Error(`malformed fixture child pid receipt: ${line}`);
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

export type SpawnCapableFixtureCleanup =
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "retained"; diagnostic: string }>;

export async function cleanupSpawnCapableFixture(
  input: Readonly<{
    fixturePath: string;
    pidReceiptPath: string;
    timeoutMs?: number;
    operationFailed: boolean;
  }>,
): Promise<SpawnCapableFixtureCleanup> {
  try {
    if (input.operationFailed && readPidReceipt(input.pidReceiptPath).length === 0) {
      return { kind: "retained", diagnostic: "spawn-capable operation failed before birth proof" };
    }
    await waitForPidReceiptExit(input.pidReceiptPath, input.timeoutMs, { requireBirth: !input.operationFailed });
  } catch (error) {
    if (!input.operationFailed) throw error;
    return { kind: "retained", diagnostic: error instanceof Error ? error.message : String(error) };
  }
  if (input.operationFailed) {
    return {
      kind: "retained",
      diagnostic: "spawn-capable operation failed without proof that its launch set is closed",
    };
  }
  await removeTempDirectory(input.fixturePath);
  return { kind: "removed" };
}

export async function waitForPidReceiptExit(
  receiptPath: string,
  timeoutMs = PROCESS_EXIT_TIMEOUT_MS,
  options: Readonly<{ requireBirth?: boolean }> = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  if (options.requireBirth === true) {
    while (readPidReceipt(receiptPath).length === 0) {
      if (performance.now() >= deadline) throw new Error(`missing fixture child pid receipt: ${receiptPath}`);
      await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
    }
  }
  let known = readPidReceipt(receiptPath);
  for (;;) {
    for (const pid of known) await waitForProcessExit(pid, Math.max(0, deadline - performance.now()));
    const next = readPidReceipt(receiptPath);
    const newcomers = next.filter((pid) => !known.includes(pid));
    if (newcomers.length === 0 && next.every((pid) => !processExists(pid))) return;
    known = next;
    if (performance.now() >= deadline) {
      const alive = next.filter(processExists);
      throw new Error(`fixture child process(es) survived: ${alive.join(", ") || next.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
}

export async function removeTempDirectory(path: string): Promise<void> {
  const deadline = performance.now() + TEMP_DIRECTORY_TIMEOUT_MS;
  while (true) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      if (performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
