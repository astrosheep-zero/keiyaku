import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LineRpcProcess } from "../src/runtime/proc/line-rpc.js";
import {
  consumeProcessStdout,
  probeProcessTree,
  putDownProcessTree,
  runProcess,
  spawnDetachedProcess,
  type ProcessInput,
} from "../src/runtime/proc/run.js";

function input(argv: readonly string[], overrides: Partial<ProcessInput> = {}): ProcessInput {
  return {
    argv,
    timeoutMs: 2_000,
    ...overrides,
  };
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (performance.now() >= deadline) throw new Error(`descendant ${pid} survived process-tree termination`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("runProcess returns terminal diagnostics from both streams", async () => {
  const outcome = await runProcess(input([
    process.execPath,
    "-e",
    'process.stdout.write("out"); process.stderr.write("err");',
  ]));

  assert.deepEqual(outcome, {
    kind: "terminal",
    code: 0,
    stdout: "out",
    stderr: "err",
    truncated: false,
  });
});

test("runProcess retains only the final 16 KiB of each stream", async () => {
  const outcome = await runProcess(input([
    process.execPath,
    "-e",
    [
      'process.stdout.write("a".repeat(20 * 1024));',
      'process.stdout.write("stdout-tail");',
      'process.stderr.write("b".repeat(20 * 1024));',
      'process.stderr.write("stderr-tail");',
    ].join(" "),
  ]));

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
  const result = await consumeProcessStdout(input([
    process.execPath,
    "-e",
    'process.stdout.write("x".repeat(2 * 1024 * 1024));',
  ]), (chunk) => {
    consumed += chunk.length;
  });

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
  const result = await consumeProcessStdout(input([
    process.execPath,
    "-e",
    'process.stdout.write("output"); setInterval(() => {}, 1_000);',
  ]), () => {
    throw new Error("consumer refused output");
  });

  assert.deepEqual(result.outcome, {
    kind: "stream-error",
    diagnostic: "consumer refused output",
  });
});

test("runProcess reports unknown exits", async () => {
  const outcome = await runProcess(input([
    process.execPath,
    "-e",
    'process.kill(process.pid, "SIGTERM");',
  ]));

  assert.deepEqual(outcome, { kind: "unknown-exit" });
});

test("runProcess reports spawn errors", async () => {
  const outcome = await runProcess(input(["keiyaku-v4-no-such-executable"]));

  assert.equal(outcome.kind, "spawn-error");
  if (outcome.kind !== "spawn-error") return;
  assert.match(outcome.diagnostic, /ENOENT/);
});

test("runProcess timeout kills a detached descendant tree", async () => {
  const descendant = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-runtime-"));
  const descendantFile = join(root, "descendant-pid");
  const parent = [
    'const { writeFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let descendantPid: number | undefined;
  try {
    const outcome = await runProcess({ ...input([process.execPath, "-e", parent]), cwd: root, timeoutMs: 100 });
    assert.equal(outcome.kind, "timeout");
    if (outcome.kind !== "timeout") return;
    descendantPid = Number.parseInt(readFileSync(descendantFile, "utf8"), 10);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await waitForExit(descendantPid);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The asserted path has already reaped the descendant.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runProcess cancellation kills a detached descendant tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-runtime-cancel-"));
  const descendantFile = join(root, "descendant-pid");
  const descendant = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
  const parent = [
    'const { writeFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const controller = new AbortController();
  let descendantPid: number | undefined;
  try {
    const pending = runProcess({ argv: [process.execPath, "-e", parent], cwd: root, signal: controller.signal });
    const deadline = performance.now() + 2_000;
    while (!existsSync(descendantFile)) {
      if (performance.now() >= deadline) throw new Error("cancelled process did not start its descendant");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    descendantPid = Number.parseInt(readFileSync(descendantFile, "utf8"), 10);
    controller.abort();
    assert.deepEqual(await pending, { kind: "cancelled" });
    await waitForExit(descendantPid);
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess close terminates its complete helper tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-tree-"));
  const descendantFile = join(root, "descendant-pid");
  const descendant = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
  const parent = [
    'const { writeFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let descendantPid: number | undefined;
  try {
    const rpc = new LineRpcProcess({ argv: [process.execPath, "-e", parent], cwd: root });
    const deadline = performance.now() + 2_000;
    while (descendantPid === undefined) {
      try { descendantPid = Number.parseInt(readFileSync(descendantFile, "utf8"), 10); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (performance.now() >= deadline) throw new Error("line RPC descendant was not spawned");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await rpc.close();
    await waitForExit(descendantPid);
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess endInputAndDrain admits delayed notifications before producer EOF", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-drain-"));
  const child = [
    'process.stdin.resume();',
    'const send = (method) => process.stdout.write(JSON.stringify({ method }) + "\\n");',
    'process.stdin.on("end", () => setTimeout(() => { send("item/completed"); process.exit(0); }, 350));',
    'send("turn/completed");',
  ].join(" ");
  try {
    const rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root });
    const notifications: string[] = [];
    let drained: Promise<void> | undefined;
    rpc.onNotification((notification) => {
      notifications.push(notification.method);
      if (notification.method === "turn/completed") drained = rpc.endInputAndDrain();
    });
    const deadline = performance.now() + 2_000;
    while (drained === undefined) {
      if (performance.now() >= deadline) throw new Error("line RPC terminal notification was not admitted");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await drained;
    assert.deepEqual(notifications, ["turn/completed", "item/completed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LineRpcProcess endInputAndDrain force-closes an uncooperative producer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-line-rpc-drain-timeout-"));
  const child = [
    "process.stdin.resume();",
    "process.stdin.on('end',()=>{});",
    "setInterval(()=>{},1000);",
  ].join(" ");
  try {
    const rpc = new LineRpcProcess({ argv: [process.execPath, "-e", child], cwd: root });
    const started = performance.now();
    await rpc.endInputAndDrain(50);
    assert.ok(performance.now() - started < 1_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("detached process collars fence put-down by process identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-collar-"));
  try {
    const collar = await spawnDetachedProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      log: join(root, "stdio.log"),
    });
    assert.deepEqual(probeProcessTree(collar), { kind: "alive" });
    assert.equal(await putDownProcessTree(collar), "killed");
    assert.deepEqual(probeProcessTree(collar), { kind: "gone" });
    assert.equal(await putDownProcessTree(collar), "already-dead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
