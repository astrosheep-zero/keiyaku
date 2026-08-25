import { open, type FileHandle } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { launchFailure, spawnWindowsLauncher, type DetachedProcessInput } from "./launch.js";
import { detachedExitStatus, retainDetachedExitEvidence } from "./process-exit.js";
import { createProcessLifecycle, type ProcessLifecycle } from "./lifecycle.js";
import { terminateWindowsTree } from "./termination.js";
import type { DetachedProcessExit, OwnedProcess } from "./types.js";

type WindowsContext = {
  input: DetachedProcessInput;
  from: number;
  closeLog(): Promise<void>;
  child: ReturnType<typeof spawnWindowsLauncher>;
  reader: Interface;
  stderr: string;
  started: boolean;
  targetPid: number | undefined;
  released: boolean;
  finished: boolean;
  lifecycle?: ProcessLifecycle;
  startedPromise: Promise<number>;
  startedResolve(pid: number): void;
  startedReject(error: unknown): void;
  exited: Promise<DetachedProcessExit>;
  exitResolve(exit: DetachedProcessExit): void;
  exitReject(error: unknown): void;
};

function createWindowsContext(
  input: DetachedProcessInput,
  from: number,
  closeLog: () => Promise<void>,
): WindowsContext {
  const child = spawnWindowsLauncher(input);
  const reader = createInterface({ input: child.stdout! });
  let startedResolve!: (pid: number) => void;
  let startedReject!: (error: unknown) => void;
  let exitResolve!: (exit: DetachedProcessExit) => void;
  let exitReject!: (error: unknown) => void;
  const startedPromise = new Promise<number>((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });
  const exited = new Promise<DetachedProcessExit>((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });
  void exited.catch(() => undefined);
  child.stderr?.setEncoding("utf8");
  const context: WindowsContext = {
    input,
    from,
    closeLog,
    child,
    reader,
    stderr: "",
    started: false,
    targetPid: undefined,
    released: false,
    finished: false,
    startedPromise,
    startedResolve,
    startedReject,
    exited,
    exitResolve,
    exitReject,
  };
  child.stderr?.on("data", (chunk: string) => {
    context.stderr = `${context.stderr}${chunk}`.slice(-4_000);
  });
  return context;
}

function failWindows(context: WindowsContext, error: unknown): void {
  if (context.released) return;
  context.lifecycle?.markInert();
  if (!context.started) context.startedReject(error);
  if (!context.finished) {
    context.finished = true;
    context.exitReject(error);
  }
  context.reader.close();
  context.child.stdout?.resume();
  if (context.targetPid !== undefined) {
    void terminateWindowsTree(context.targetPid)
      .catch(() => undefined)
      .finally(() => context.child.stdin?.end());
  } else if (context.child.pid !== undefined && context.child.exitCode === null && context.child.signalCode === null) {
    void terminateWindowsTree(context.child.pid)
      .catch(() => undefined)
      .finally(() => context.child.stdin?.end());
  } else {
    context.child.stdin?.end();
  }
}

function recordWindowsExit(context: WindowsContext, code: number): void {
  if (context.finished) return;
  context.finished = true;
  context.lifecycle?.markInert();
  void (async () => {
    let failure: unknown;
    let result: DetachedProcessExit | undefined;
    let exitLog: FileHandle | undefined;
    try {
      exitLog = await open(context.input.log, "r+");
      result = await retainDetachedExitEvidence(exitLog, context.input.log, context.from, code, null);
    } catch (error) {
      failure = error;
    }
    try {
      await exitLog?.close();
    } catch (error) {
      failure ??= error;
    }
    context.reader.close();
    context.child.stdin?.end();
    context.child.stdout?.resume();
    if (failure !== undefined) {
      const status = detachedExitStatus(code, null);
      throw new Error(
        `pre-admission ${status}: run-log evidence unavailable: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
    context.exitResolve(result!);
  })().catch(context.exitReject);
}

function handleWindowsLine(context: WindowsContext, line: string): void {
  const startedMatch = /^started ([0-9]+)$/u.exec(line);
  if (startedMatch !== null) {
    const pid = Number.parseInt(startedMatch[1]!, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || context.started) {
      failWindows(context, new Error("Windows launcher returned an invalid started record"));
      return;
    }
    context.started = true;
    context.targetPid = pid;
    context.startedResolve(pid);
    return;
  }
  const exitedMatch = /^exited ([0-9]+)$/u.exec(line);
  if (exitedMatch !== null) {
    if (!context.started) {
      failWindows(context, new Error("Windows launcher returned exit before started"));
      return;
    }
    recordWindowsExit(context, Number.parseInt(exitedMatch[1]!, 10));
    return;
  }
  if (line.length > 0) failWindows(context, new Error(`Windows launcher returned malformed protocol: ${line}`));
}

function installWindowsProtocol(context: WindowsContext): void {
  context.child.once("error", (error) => failWindows(context, error));
  context.child.once("close", () => {
    if (context.released) return;
    if (!context.started) {
      failWindows(context, launchFailure(context.input.argv[0] ?? "windows-launch.exe", context.stderr.trim()));
    } else if (!context.finished) {
      failWindows(context, new Error("Windows launcher exited before target exit evidence"));
    }
  });
  context.reader.on("line", (line) => handleWindowsLine(context, line));
}

function ownedWindowsProcess(context: WindowsContext, pid: number): OwnedProcess {
  const lifecycle = createProcessLifecycle(
    async () => {
      await terminateWindowsTree(pid);
      await context.exited;
    },
    () => {
      context.released = true;
      context.reader.close();
      context.child.stdin?.write("release\n");
      context.child.stdin?.end();
      context.child.stdout?.resume();
      context.child.unref();
      void context.closeLog();
    },
  );
  context.lifecycle = lifecycle;
  return {
    pid,
    exited: context.exited,
    terminate: lifecycle.terminate,
    release: lifecycle.release,
  };
}

export async function spawnWindowsRetainedProcess(input: DetachedProcessInput): Promise<OwnedProcess> {
  const log = await open(input.log, "a");
  let logClosed = false;
  const closeLog = async (): Promise<void> => {
    if (logClosed) return;
    logClosed = true;
    await log.close();
  };
  const context = createWindowsContext(input, (await log.stat()).size, closeLog);
  installWindowsProtocol(context);
  try {
    const pid = await context.startedPromise;
    await closeLog();
    return ownedWindowsProcess(context, pid);
  } catch (error) {
    context.reader.close();
    if (context.child.pid !== undefined) {
      try {
        await terminateWindowsTree(context.child.pid);
      } catch {
        /* preserve the launch error */
      }
    }
    await new Promise<void>((resolve) => {
      if (context.child.exitCode !== null || context.child.signalCode !== null) {
        resolve();
        return;
      }
      context.child.once("close", () => resolve());
    });
    await closeLog();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
