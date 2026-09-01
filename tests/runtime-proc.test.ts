import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createProcessLifecycle } from "../src/runtime/proc/lifecycle.js";
import { LineRpcProcess } from "../src/runtime/proc/line-rpc.js";
import { spawnStdioProcess } from "../src/runtime/proc/stdio.js";
import {
  consumeProcessStdout,
  runProcess,
  spawnCancellableProcess,
  spawnDetachedProcess,
  type ProcessInput,
} from "../src/runtime/proc/run.js";
import { terminateOwnedProcess } from "../src/runtime/proc/termination.js";
import { removeTempDirectory, waitForProcessExit } from "./support/process.js";

function input(argv: readonly string[], overrides: Partial<ProcessInput> = {}): ProcessInput {
  return {
    argv,
    timeoutMs: 2_000,
    ...overrides,
  };
}

function ownedChild(pid: number): ChildProcess & { pid: number } {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as ChildProcess & { pid: number };
}

for (const force of [false, true]) {
  test(`terminateOwnedProcess accepts EPERM after the owned child exits (${force ? "forced" : "graceful"})`, async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX group signals only");
      return;
    }
    const child = ownedChild(10_000 + Number(force));
    t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -child.pid);
      if (signal === 0) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
      assert.equal(signal, force ? "SIGKILL" : "SIGTERM");
      child.emit("exit", 0, null);
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }) as typeof process.kill);

    await terminateOwnedProcess(child, force);
  });

  test(`terminateOwnedProcess rejects live-child EPERM (${force ? "forced" : "graceful"})`, async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX group signals only");
      return;
    }
    const child = ownedChild(10_100 + Number(force));
    t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -child.pid);
      assert.equal(signal, force ? "SIGKILL" : "SIGTERM");
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }) as typeof process.kill);

    await assert.rejects(terminateOwnedProcess(child, force), /kill EPERM/u);
  });
}

test("graceful termination cleans the group after SIGTERM EPERM and leader exit", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups only");
    return;
  }
  const child = ownedChild(10_200);
  const signals: Array<NodeJS.Signals | number> = [];
  t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, -child.pid);
    signals.push(signal ?? 0);
    if (signal === "SIGTERM") {
      child.emit("exit", 0, null);
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    if (signal === 0) return true;
    assert.equal(signal, "SIGKILL");
    child.emit("close", 0, null);
    return true;
  }) as typeof process.kill);

  await terminateOwnedProcess(child);
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL"]);
});

test("runProcess reports termination failure without waiting for child close", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX group signals only");
    return;
  }
  const originalKill = process.kill;
  let ownedPid: number | undefined;
  t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && (signal === "SIGTERM" || signal === "SIGKILL")) {
      ownedPid = -pid;
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);

  try {
    await assert.rejects(
      runProcess({ argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"], timeoutMs: 10 }),
      /kill EPERM/u,
    );
    assert.ok(ownedPid !== undefined);
  } finally {
    if (ownedPid !== undefined) {
      originalKill(-ownedPid, "SIGKILL");
      await waitForProcessExit(ownedPid);
    }
  }
});

test("cancellable process owns termination failure before a later waiter", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX group signals only");
    return;
  }
  const originalKill = process.kill;
  const controller = new AbortController();
  let ownedPid: number | undefined;
  t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && (signal === "SIGTERM" || signal === "SIGKILL")) {
      ownedPid = -pid;
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  const owned = spawnCancellableProcess({
    argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
    signal: controller.signal,
  });

  try {
    controller.abort();
    await assert.rejects(owned.terminationFailure, /kill EPERM/u);
    assert.equal(ownedPid, owned.child.pid);
  } finally {
    if (ownedPid !== undefined) {
      originalKill(-ownedPid, "SIGKILL");
      await waitForProcessExit(ownedPid);
    }
  }
});

test("owned-process lifecycle releases during pending termination exactly once", async () => {
  let finish!: () => void;
  let terminations = 0;
  let releases = 0;
  const lifecycle = createProcessLifecycle(
    async () => {
      terminations += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    () => {
      releases += 1;
    },
  );
  const termination = lifecycle.terminate();
  lifecycle.release();
  assert.equal(releases, 1);
  lifecycle.release();
  assert.equal(releases, 1);
  finish();
  await termination;
  await lifecycle.terminate();
  assert.equal(terminations, 1);
  lifecycle.release();
  assert.equal(releases, 1);
});
function waitForOutputLine(
  expected: string,
  message: string,
): Readonly<{
  wait: Promise<void>;
  observe(chunk: Uint8Array): void;
  dispose(): void;
}> {
  let buffered = "";
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(new Error(message));
    }
  }, 2_000);
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve();
  };
  const wait = new Promise<void>((resolveWait, rejectWait) => {
    resolve = resolveWait;
    reject = rejectWait;
  });
  return {
    wait,
    observe(chunk) {
      buffered += Buffer.from(chunk).toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line === expected) settle();
      }
    },
    dispose() {
      clearTimeout(timeout);
    },
  };
}

async function waitForFile(path: string): Promise<string> {
  const deadline = performance.now() + 2_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`missing ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return readFileSync(path, "utf8");
}

test("runProcess returns terminal diagnostics from both streams", async () => {
  const outcome = await runProcess(
    input([process.execPath, "-e", 'process.stdout.write("out"); process.stderr.write("err");']),
  );

  assert.deepEqual(outcome, {
    kind: "terminal",
    code: 0,
    stdout: "out",
    stderr: "err",
    truncated: false,
  });
});

test("runProcess retains only the final 16 KiB of each stream", async () => {
  const outcome = await runProcess(
    input([
      process.execPath,
      "-e",
      [
        'process.stdout.write("a".repeat(20 * 1024));',
        'process.stdout.write("stdout-tail");',
        'process.stderr.write("b".repeat(20 * 1024));',
        'process.stderr.write("stderr-tail");',
      ].join(" "),
    ]),
  );

  assert.equal(outcome.kind, "terminal");
  if (outcome.kind !== "terminal") return;
  assert.equal(Buffer.byteLength(outcome.stdout), 16 * 1024);
  assert.equal(Buffer.byteLength(outcome.stderr), 16 * 1024);
  assert.equal(outcome.stdout.endsWith("stdout-tail"), true);
  assert.equal(outcome.stderr.endsWith("stderr-tail"), true);
  assert.equal(outcome.truncated, true);
});

test("consumeProcessStdout drains output without retaining it", async () => {
  let consumed = 0;
  const result = await consumeProcessStdout(
    input([process.execPath, "-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024));']),
    (chunk) => {
      consumed += chunk.length;
    },
  );

  assert.equal(consumed, 2 * 1024 * 1024);
  assert.ok(result.pid !== null && result.pid > 0);
  assert.deepEqual(result.outcome, {
    kind: "terminal",
    code: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  });
});

test("consumeProcessStdout terminates after a consumer failure", async () => {
  const result = await consumeProcessStdout(
    input([process.execPath, "-e", 'process.stdout.write("output"); setInterval(() => {}, 1_000);']),
    () => {
      throw new Error("consumer refused output");
    },
  );

  assert.deepEqual(result.outcome, {
    kind: "stream-error",
    diagnostic: "consumer refused output",
  });
});

test("runProcess reports unknown exits", async () => {
  const outcome = await runProcess(input([process.execPath, "-e", 'process.kill(process.pid, "SIGTERM");']));

  assert.deepEqual(
    outcome,
    process.platform === "win32"
      ? { kind: "terminal", code: 1, stdout: "", stderr: "", truncated: false }
      : { kind: "unknown-exit" },
  );
});

test("runProcess reports spawn errors", async () => {
  const outcome = await runProcess(input(["keiyaku-v4-no-such-executable"]));

  assert.equal(outcome.kind, "spawn-error");
  if (outcome.kind !== "spawn-error") return;
  assert.match(outcome.diagnostic, /ENOENT/);
});

test("runProcess timeout closes the directly-owned helper boundary", async () => {
  const descendant = [
    'process.on("SIGTERM", () => process.stdout.write("descendant/exited\\n", () => process.exit(0)));',
    'process.stdout.write("descendant/ready\\n");',
    "setTimeout(() => process.exit(99), 2_000);",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-runtime-"));
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const ready = waitForOutputLine("descendant/ready", "timeout helper did not signal readiness");
  let pending: ReturnType<typeof consumeProcessStdout> | undefined;
  const output: string[] = [];
  try {
    pending = consumeProcessStdout(
      {
        ...input([process.execPath, "-e", parent]),
        cwd: root,
        timeoutMs: 1_000,
      },
      (chunk) => {
        output.push(chunk.toString("utf8"));
        ready.observe(chunk);
      },
    );
    await ready.wait;
    const outcome = (await pending).outcome;
    assert.equal(outcome.kind, "timeout");
    if (process.platform === "win32") assert.doesNotMatch(output.join(""), /descendant\/exited/);
    else assert.match(output.join(""), /descendant\/exited/);
  } finally {
    ready.dispose();
    if (pending !== undefined) await pending;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Unix graceful termination cleans an owned group after its leader exits", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-runtime-leader-exit-"));
  const descendantPidPath = join(root, "descendant-pid");
  const descendant = [
    `require("node:fs").writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
    "process.on(\"SIGTERM\", () => {});",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let owned: Awaited<ReturnType<typeof spawnDetachedProcess>> | undefined;
  let descendantPid: number | undefined;
  try {
    owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", parent],
      cwd: root,
      log: join(root, "stdio.log"),
    });
    descendantPid = Number.parseInt(await waitForFile(descendantPidPath), 10);
    await owned.terminate();
    await waitForProcessExit(descendantPid);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    if (owned !== undefined) await owned.terminate(true).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runProcess timeout settles after cleaning inherited pipes from an owned group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-runtime-inherited-pipes-"));
  const descendantPidPath = join(root, "descendant-pid");
  const descendant = [
    'process.stdout.write("descendant/ready\\n");',
    "process.on(\"SIGTERM\", () => {});",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const parent = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let pending: ReturnType<typeof runProcess> | undefined;
  let descendantPid: number | undefined;
  try {
    pending = runProcess({ ...input([process.execPath, "-e", parent]), cwd: root, timeoutMs: 1_000 });
    descendantPid = Number.parseInt(await waitForFile(descendantPidPath), 10);
    const started = performance.now();
    assert.deepEqual(await pending, { kind: "timeout" });
    assert.ok(performance.now() - started < 3_000);
    await waitForProcessExit(descendantPid);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    if (pending !== undefined) await pending;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runProcess cancellation closes the directly-owned helper boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-runtime-cancel-"));
  const descendant = [
    'process.on("SIGTERM", () => process.stdout.write("descendant/exited\\n", () => process.exit(0)));',
    'process.stdout.write("descendant/ready\\n");',
    "setTimeout(() => process.exit(99), 2_000);",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const controller = new AbortController();
  const ready = waitForOutputLine("descendant/ready", "cancel helper did not signal readiness");
  let pending: ReturnType<typeof consumeProcessStdout> | undefined;
  const output: string[] = [];
  try {
    pending = consumeProcessStdout(
      { argv: [process.execPath, "-e", parent], cwd: root, signal: controller.signal },
      (chunk) => {
        output.push(chunk.toString("utf8"));
        ready.observe(chunk);
      },
    );
    await ready.wait;
    controller.abort();
    assert.deepEqual((await pending).outcome, { kind: "cancelled" });
    if (process.platform === "win32") assert.doesNotMatch(output.join(""), /descendant\/exited/);
    else assert.match(output.join(""), /descendant\/exited/);
  } finally {
    ready.dispose();
    controller.abort();
    if (pending !== undefined) await pending;
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess close closes the directly-owned helper boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-tree-"));
  const descendant = [
    'process.on("SIGTERM", () => process.stdout.write(JSON.stringify({ method: "probe/descendant-exited" }) + "\\n", () => process.exit(0)));',
    'process.stdout.write(JSON.stringify({ method: "probe/ready" }) + "\\n");',
    "setTimeout(() => process.exit(99), 2_000);",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let rpc: LineRpcProcess | undefined;
  let closed = false;
  let ready!: () => void;
  let readyTimer!: ReturnType<typeof setTimeout>;
  const notifications: string[] = [];
  const isReady = new Promise<void>((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error("line RPC helper did not signal readiness")), 2_000);
    ready = () => {
      clearTimeout(readyTimer);
      resolve();
    };
  });
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", parent], cwd: root });
    rpc.onNotification((notification) => {
      notifications.push(notification.method);
      if (notification.method === "probe/ready") ready();
    });
    await isReady;
    await rpc.close(false);
    closed = true;
    if (process.platform !== "win32") assert.ok(notifications.includes("probe/descendant-exited"));
  } finally {
    clearTimeout(readyTimer);
    if (!closed) await rpc?.close(false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess endInputAndDrain admits delayed notifications before producer EOF", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-drain-"));
  const child = [
    "process.stdin.resume();",
    'const send = (method) => process.stdout.write(JSON.stringify({ method }) + "\\n");',
    'process.stdin.on("end", () => setTimeout(() => { send("item/completed"); process.exit(0); }, 350));',
    'send("turn/completed");',
  ].join(" ");
  let rpc: LineRpcProcess | undefined;
  let closed = false;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root });
    const notifications: string[] = [];
    let resolveDrain!: (value: Promise<void>) => void;
    const drainStarted = new Promise<Promise<void>>((resolve, reject) => {
      notificationTimer = setTimeout(() => reject(new Error("line RPC terminal notification was not admitted")), 2_000);
      resolveDrain = (drained) => {
        clearTimeout(notificationTimer);
        resolve(drained);
      };
    });
    rpc.onNotification((notification) => {
      notifications.push(notification.method);
      if (notification.method === "turn/completed") resolveDrain(rpc!.endInputAndDrain());
    });
    const drained = await drainStarted;
    await drained;
    assert.deepEqual(notifications, ["turn/completed", "item/completed"]);
    closed = true;
  } finally {
    clearTimeout(notificationTimer);
    if (!closed) await rpc?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess endInputAndDrain force-closes an uncooperative producer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-drain-timeout-"));
  const child = ["process.stdin.resume();", "process.stdin.on('end',()=>{});", "setInterval(()=>{},1000);"].join(" ");
  let rpc: LineRpcProcess | undefined;
  let closed = false;
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root });
    const started = performance.now();
    await rpc.endInputAndDrain(50);
    assert.ok(performance.now() - started < 1_000);
    closed = true;
  } finally {
    if (!closed) await rpc?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess rejects pending requests and closes on malformed JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-malformed-"));
  const child = [
    "process.stdin.on('data', () => process.stdout.write('{malformed}\\n'));",
    "process.stdin.resume();",
  ].join(" ");
  let rpc: LineRpcProcess | undefined;
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root, requestTimeoutMs: 1_000 });
    await assert.rejects(rpc.request("probe"), /malformed JSON/u);
  } finally {
    await rpc?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess rejects pending requests and closes on oversized input", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-oversized-"));
  const child = [
    "process.stdin.on('data', () => process.stdout.write('x'.repeat(300000) + '\\n'));",
    "process.stdin.resume();",
  ].join(" ");
  let rpc: LineRpcProcess | undefined;
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root, requestTimeoutMs: 1_000 });
    await assert.rejects(rpc.request("probe"), /maximum size/u);
  } finally {
    await rpc?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess rejects pending requests and closes on an oversized unterminated buffer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-buffer-"));
  const child = [
    "process.stdin.on('data', () => process.stdout.write('x'.repeat(1100000)));",
    "process.stdin.resume();",
  ].join(" ");
  let rpc: LineRpcProcess | undefined;
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root, requestTimeoutMs: 1_000 });
    await assert.rejects(rpc.request("probe"), /maximum size/u);
  } finally {
    await rpc?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess times out a stalled request", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-timeout-"));
  const child = ["process.stdin.resume();", "setInterval(() => {}, 1_000);"].join(" ");
  let rpc: LineRpcProcess | undefined;
  try {
    rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root, requestTimeoutMs: 25 });
    await assert.rejects(rpc.request("probe"), /timed out after 25ms/u);
  } finally {
    await rpc?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("StdioProcess endInputAndDrain retains output until producer EOF", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-stdio-drain-"));
  const child = [
    'process.stdout.write("terminal");',
    "process.stdin.resume();",
    'process.stdin.on("end", () => setTimeout(() => { process.stdout.write(" tail"); process.exit(0); }, 50));',
  ].join(" ");
  let stdio: ReturnType<typeof spawnStdioProcess> | undefined;
  let closed = false;
  try {
    stdio = spawnStdioProcess({ argv: [process.execPath, "-e", child], cwd: root });
    const output = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of stdio!.output) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    })();
    await stdio.endInputAndDrain();
    assert.equal(await output, "terminal tail");
    closed = true;
  } finally {
    if (!closed) await stdio?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("StdioProcess close terminates its complete helper tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-stdio-tree-"));
  const descendant = [
    'process.on("SIGTERM", () => process.stdout.write("descendant/exited\\n", () => process.exit(0)));',
    'process.stdout.write("descendant/ready\\n");',
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let stdio: ReturnType<typeof spawnStdioProcess> | undefined;
  let closed = false;
  const ready = waitForOutputLine("descendant/ready", "stdio helper did not signal readiness");
  const terminated = waitForOutputLine("descendant/exited", "stdio descendant did not confirm termination");
  try {
    stdio = spawnStdioProcess({ argv: [process.execPath, "-e", parent], cwd: root });
    stdio.output.on("data", (chunk) => {
      ready.observe(chunk);
      terminated.observe(chunk);
    });
    await ready.wait;
    if (process.platform === "win32") await stdio.close(false);
    else await Promise.all([stdio.close(false), terminated.wait]);
    closed = true;
  } finally {
    ready.dispose();
    terminated.dispose();
    if (!closed) await stdio?.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct spawner terminates through its live owned-process handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-"));
  let owned: Awaited<ReturnType<typeof spawnDetachedProcess>> | undefined;
  let terminated = false;
  try {
    owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      log: join(root, "stdio.log"),
    });
    assert.ok(owned.pid > 0);
    await owned.terminate();
    terminated = true;
  } finally {
    if (!terminated) await owned?.terminate(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct spawner retains its waitpid result and bounded shared-log reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-exit-"));
  try {
    const log = join(root, "stdio.log");
    writeFileSync(log, "prior stdout\n");
    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "process.exit(7)"],
      cwd: root,
      log,
    });
    const exit = await owned.exited;
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 7, signal: null });
    assert.deepEqual(exit.log, { path: log, from: "prior stdout\n".length, to: readFileSync(log).length });
    assert.match(readFileSync(log, "utf8"), /prior stdout/u);
    assert.match(readFileSync(log, "utf8"), /\[child exit 7\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct spawner retains a short exit marker write before its exit receipt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-boundary-"));
  try {
    const log = join(root, "stdio.log");
    const handle = await open(log, "a");
    type WritableHandle = { write(...args: unknown[]): Promise<{ bytesWritten: number }> };
    const prototype = Object.getPrototypeOf(handle) as WritableHandle;
    const originalWrite = prototype.write;
    let shortened = false;
    t.mock.method(prototype, "write", async function (this: WritableHandle, ...args: unknown[]) {
      if (
        !shortened &&
        Buffer.isBuffer(args[0]) &&
        typeof args[1] === "number" &&
        typeof args[2] === "number" &&
        args[2] > 1
      ) {
        shortened = true;
        return Reflect.apply(originalWrite, this, [args[0], args[1], 1, args[3]]);
      }
      return Reflect.apply(originalWrite, this, args);
    });
    await handle.close();

    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: root,
      log,
    });
    const exit = await owned.exited;
    const content = readFileSync(log, "utf8");
    assert.equal(shortened, true);
    assert.match(content, /\[child exit 0\]\n$/u);
    assert.equal(exit.log.to, content.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct spawner rejects exit evidence when its run-log path disappears", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows inherited log handles cannot be unlinked while the child is alive");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-missing-log-"));
  try {
    const log = join(root, "stdio.log");
    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "setTimeout(() => process.exit(7), 50)"],
      cwd: root,
      log,
    });
    rmSync(log);
    await assert.rejects(owned.exited, /pre-admission exit 7: run-log evidence unavailable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owned process capability is inert after termination and repeated terminate", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-reap-"));
  let owned: Awaited<ReturnType<typeof spawnDetachedProcess>> | undefined;
  let terminated = false;
  try {
    owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      cwd: root,
      log: join(root, "stdio.log"),
    });
    const ownedProcess = owned;
    await ownedProcess.terminate();
    terminated = true;
    let signals = 0;
    const originalKill = process.kill;
    const kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ownedProcess.pid && signal !== 0) signals += 1;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    process.kill = kill;
    try {
      await ownedProcess.terminate();
      await ownedProcess.terminate();
    } finally {
      process.kill = originalKill;
    }
    assert.equal(signals, 0);
  } finally {
    if (!terminated) await owned?.terminate(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owned process capability is inert after release and repeated terminate", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-release-"));
  let owned: Awaited<ReturnType<typeof spawnDetachedProcess>> | undefined;
  let released = false;
  try {
    owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      log: join(root, "stdio.log"),
    });
    const ownedProcess = owned;
    ownedProcess.release();
    released = true;
    let signals = 0;
    const originalKill = process.kill;
    const kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ownedProcess.pid && signal !== 0) signals += 1;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    process.kill = kill;
    try {
      await ownedProcess.terminate();
      await ownedProcess.terminate();
    } finally {
      process.kill = originalKill;
    }
    assert.equal(signals, 0);
  } finally {
    if (owned !== undefined && released) {
      try {
        process.kill(owned.pid, "SIGKILL");
      } catch {
        /* already reaped */
      }
    } else {
      await owned?.terminate(true);
    }
    await removeTempDirectory(root);
  }
});

test("release lets the parent reach beforeExit while the detached child continues", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-owned-process-before-exit-"));
  const childPidPath = join(root, "child-pid");
  try {
    const runtime = pathToFileURL(join(process.cwd(), "src/runtime/proc/run.ts")).href;
    const script = [
      `import { spawnDetachedProcess } from ${JSON.stringify(runtime)};`,
      `const owned = await spawnDetachedProcess({ argv: [process.execPath, "-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); setTimeout(() => {}, 1000)`)}], cwd: ${JSON.stringify(root)}, log: ${JSON.stringify(join(root, "stdio.log"))} });`,
      "owned.release();",
      'process.once("beforeExit", () => console.log("before-exit"));',
    ].join("\n");
    const outcome = await runProcess(input([process.execPath, "--import", "tsx", "--input-type=module", "-e", script]));
    assert.deepEqual(outcome, { kind: "terminal", code: 0, stdout: "before-exit\n", stderr: "", truncated: false });
  } finally {
    if (existsSync(childPidPath)) {
      const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
      if (Number.isSafeInteger(childPid) && childPid > 0) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* already stopped */
        }
        await waitForProcessExit(childPid);
      }
    }
    await removeTempDirectory(root);
  }
});
