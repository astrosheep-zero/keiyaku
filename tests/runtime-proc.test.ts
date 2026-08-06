import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../src/runtime/proc/run.js";

function input(argv: readonly string[], limits: Readonly<{ stdout: number; stderr: number }> = { stdout: 1_024, stderr: 1_024 }) {
  return {
    argv,
    timeoutMs: 2_000,
    stdoutLimitBytes: limits.stdout,
    stderrLimitBytes: limits.stderr,
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

test("runProcess reports a normal exit and captures both streams", async () => {
  const outcome = await runProcess(input([
    process.execPath,
    "-e",
    'process.stdout.write("out"); process.stderr.write("err");',
  ]));

  assert.deepEqual(outcome.kind, "exit");
  if (outcome.kind !== "exit") return;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.stdout.toString("utf8"), "out");
  assert.equal(outcome.stderr.toString("utf8"), "err");
  assert.equal(outcome.stdoutTruncated, false);
  assert.equal(outcome.stderrTruncated, false);
  assert.ok(outcome.durationMs >= 0);
});

test("runProcess bounds each captured stream by bytes", async () => {
  const outcome = await runProcess(input([
    process.execPath,
    "-e",
    'process.stdout.write("0123456789"); process.stderr.write("abcdef");',
  ], { stdout: 4, stderr: 3 }));

  assert.equal(outcome.kind, "exit");
  assert.equal(outcome.stdout.toString("utf8"), "0123");
  assert.equal(outcome.stderr.toString("utf8"), "abc");
  assert.equal(outcome.stdoutTruncated, true);
  assert.equal(outcome.stderrTruncated, true);
});

test("runProcess reports spawn errors", async () => {
  const outcome = await runProcess(input(["keiyaku-v4-no-such-executable"]));

  assert.equal(outcome.kind, "spawn-error");
  if (outcome.kind !== "spawn-error") return;
  assert.equal((outcome.error as NodeJS.ErrnoException).code, "ENOENT");
  assert.equal(outcome.stdout.byteLength, 0);
  assert.equal(outcome.stderr.byteLength, 0);
});

test("runProcess timeout kills a POSIX descendant that ignores TERM", { skip: process.platform === "win32" }, async () => {
  const descendant = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
  const parent = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    "console.log(child.pid);",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  let descendantPid: number | undefined;
  try {
    const outcome = await runProcess({ ...input([process.execPath, "-e", parent]), timeoutMs: 100 });
    assert.equal(outcome.kind, "timeout");
    if (outcome.kind !== "timeout") return;
    assert.equal(outcome.reason, "timeout");
    descendantPid = Number.parseInt(outcome.stdout.toString("utf8"), 10);
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
  }
});
