import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { terminateProcessTree } from "./run.js";

export type StdioProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
export type StdioProcess = Readonly<{
  input: Writable;
  output: Readable;
  exited: Promise<StdioProcessExit>;
  endInputAndDrain(timeoutMs?: number): Promise<void>;
  close(force?: boolean): Promise<void>;
}>;

const DEFAULT_DRAIN_TIMEOUT_MS = 1_000;

export function spawnStdioProcess(input: Readonly<{
  argv: readonly [string, ...string[]]; cwd: string; env?: NodeJS.ProcessEnv;
}>): StdioProcess {
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env ?? process.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let inputEnded = false;
  let forced: Promise<void> | undefined;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  const exited = new Promise<StdioProcessExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stderr: stderr.trim() }));
    child.once("error", (error) => resolve({ code: null, signal: null, stderr: error.message }));
  });
  const endInput = (): void => {
    if (inputEnded) return;
    inputEnded = true;
    child.stdin.end();
  };
  const forceClose = async (): Promise<void> => {
    forced ??= (async () => {
      if (child.pid !== undefined) await terminateProcessTree(child.pid, true);
      await exited;
    })();
    await forced;
  };
  const endInputAndDrain = async (timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> => {
    endInput();
    if (forced !== undefined) { await forced; return; }
    const timedOut = await Promise.race([
      exited.then(() => false),
      delay(timeoutMs, true, { ref: false }),
    ]);
    if (timedOut) await forceClose();
  };
  const close = async (force = false): Promise<void> => {
    endInput();
    if (force) { await forceClose(); return; }
    if (child.pid !== undefined) await terminateProcessTree(child.pid, false);
    await exited;
  };
  return { input: child.stdin, output: child.stdout, exited, endInputAndDrain, close };
}
