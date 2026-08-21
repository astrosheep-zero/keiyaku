import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  encodeLaunchSpec,
  handoffProcess,
  handoffWindowsLaunch,
  platformLaunchPolicy,
  spawnOptionsFor,
  windowsLauncherPath,
} from "../src/runtime/proc/launch.js";
import { consumeProcessStdout, runProcess, spawnDetachedProcess } from "../src/runtime/proc/run.js";
import { spawnStdioProcess } from "../src/runtime/proc/stdio.js";

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const sourceLauncher = fileURLToPath(new URL("../src/runtime/proc/windows-launch.exe", import.meta.url));
const packagedLauncher = resolve("build/src/runtime/proc/windows-launch.exe");

function peSubsystem(path: string): number {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ");
  const offset = bytes.readUInt32LE(0x3C);
  assert.equal(bytes.toString("ascii", offset, offset + 4), "PE\0\0");
  const optional = offset + 24;
  const magic = bytes.readUInt16LE(optional);
  assert.ok(magic === 0x10B || magic === 0x20B);
  return bytes.readUInt16LE(optional + 68);
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (true) {
    try { process.kill(pid, 0); }
    catch { return; }
    if (performance.now() >= deadline) throw new Error(`process ${pid} survived`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(path: string): Promise<string> {
  const deadline = performance.now() + 2_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`missing ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return readFileSync(path, "utf8");
}

function writeFakeLauncher(root: string, dump: string): string {
  const path = join(root, "fake-launch");
  writeFileSync(path, [
    "#!/usr/bin/env node",
    'const { openSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    "const chunks = [];",
    'process.stdin.on("data", (chunk) => chunks.push(chunk));',
    'process.stdin.on("end", () => {',
    "  const bytes = Buffer.concat(chunks);",
    `  writeFileSync(${JSON.stringify(dump)}, bytes);`,
    "  const spec = JSON.parse(bytes.toString('utf8'));",
    "  const log = openSync(spec.log, 'a');",
    "  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', log, log] });",
    "  child.unref();",
    "  process.exit(0);",
    "});",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

test("the Windows launcher artifact is a GUI-subsystem PE", async () => {
  assert.equal(windowsLauncherPath(), sourceLauncher);
  assert.equal(existsSync(sourceLauncher), true);
  assert.equal(peSubsystem(sourceLauncher), IMAGE_SUBSYSTEM_WINDOWS_GUI);
  if (!existsSync(packagedLauncher)) return;
  assert.deepEqual(readFileSync(sourceLauncher), readFileSync(packagedLauncher));
  const built = await import(pathToFileURL(resolve("build/src/runtime/proc/launch.js")).href) as {
    windowsLauncherPath(): string;
  };
  assert.equal(built.windowsLauncherPath(), packagedLauncher);
  assert.equal(peSubsystem(packagedLauncher), IMAGE_SUBSYSTEM_WINDOWS_GUI);
});

test("launch intent maps to one private platform policy", () => {
  assert.deepEqual(platformLaunchPolicy("handoff", "win32"), { kind: "windows-launcher" });
  assert.deepEqual(platformLaunchPolicy("retained", "win32"), {
    kind: "spawn",
    detached: false,
    windowsHide: true,
    shell: false,
  });
  assert.deepEqual(platformLaunchPolicy("handoff", "darwin"), {
    kind: "spawn",
    detached: true,
    windowsHide: true,
    shell: false,
  });
  assert.deepEqual(platformLaunchPolicy("retained", "linux"), {
    kind: "spawn",
    detached: true,
    windowsHide: true,
    shell: false,
  });
  assert.deepEqual(spawnOptionsFor("retained", { cwd: "/tmp", env: process.env }, ["ignore", "pipe", "pipe"], "win32"), {
    cwd: "/tmp",
    env: process.env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  assert.throws(() => spawnOptionsFor("handoff", { cwd: "/tmp" }, ["ignore", "ignore", "ignore"], "win32"), /GUI launcher/);
});

test("Windows launch spec preserves Unicode argv, cwd, environment, and log routing", () => {
  const input = {
    argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "a && b ✨"],
    cwd: join("/tmp", "目录-ä-✨"),
    env: { PATH: "/bin", KEIYAKU_UNICODE: "café-✨", EMPTY: "" },
    log: join("/tmp", "目录-ä-✨", "stdio.log"),
  };
  const decoded = JSON.parse(encodeLaunchSpec(input).toString("utf8")) as {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    log: string;
  };
  assert.deepEqual(decoded.argv, input.argv);
  assert.equal(decoded.cwd, input.cwd);
  assert.equal(decoded.log, input.log);
  assert.equal(decoded.env.KEIYAKU_UNICODE, "café-✨");
  assert.equal(decoded.env.EMPTY, "");
  assert.equal(Array.isArray(decoded.argv), true);
});

test("a missing Windows launcher fails with the typed spawn error", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-missing-launch-"));
  try {
    await assert.rejects(
      () => handoffWindowsLaunch({
        argv: [process.execPath, "-e", ""],
        cwd: root,
        log: join(root, "stdio.log"),
      }, join(root, "missing-windows-launch.exe")),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ENOENT/);
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Body handoff returns no pid and leaves the child alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-handoff-"));
  const pidFile = join(root, "pid");
  const log = join(root, "stdio.log");
  let pid: number | undefined;
  try {
    const result = await handoffProcess({
      argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
      cwd: root,
      log,
    });
    assert.equal(result, undefined);
    pid = Number.parseInt(await waitForFile(pidFile), 10);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
      await waitForExit(pid);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff and retained paths preserve no-shell argv and log bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-launch-bytes-"));
  const cwd = join(root, "目录-ä");
  mkdirSync(cwd);
  const payload = "a && b ✨";
  const script = 'process.stdout.write([process.argv[1], process.cwd(), process.env.KEIYAKU_UNICODE].join("\\n"))';
  try {
    const handoffLog = join(cwd, "handoff.log");
    await handoffProcess({
      argv: [process.execPath, "-e", script, payload],
      cwd,
      env: { ...process.env, KEIYAKU_UNICODE: "café-✨" },
      log: handoffLog,
    });
    const deadline = performance.now() + 2_000;
    let handoffText = "";
    while (performance.now() < deadline) {
      if (existsSync(handoffLog)) handoffText = readFileSync(handoffLog, "utf8");
      if (handoffText.includes(payload)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(handoffText, `${payload}\n${realpathSync(cwd)}\ncafé-✨`);

    const retainedLog = join(cwd, "retained.log");
    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", script, payload],
      cwd,
      env: { ...process.env, KEIYAKU_UNICODE: "café-✨" },
      log: retainedLog,
    });
    await waitForExit(owned.pid);
    const childBytes = `${payload}\n${realpathSync(cwd)}\ncafé-✨`;
    assert.equal(readFileSync(retainedLog, "utf8"), `${childBytes}[child exit 0]\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows handoff transport writes the launch spec without a shell", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows uses the GUI launcher binary rather than a POSIX fake");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-win-transport-"));
  const dump = join(root, "spec.json");
  const cwd = join(root, "目录-ä");
  mkdirSync(cwd);
  const launcher = writeFakeLauncher(root, dump);
  try {
    const input = {
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "a && b ✨"],
      cwd,
      env: { ...process.env, KEIYAKU_UNICODE: "café-✨" },
      log: join(cwd, "stdio.log"),
    };
    const result = await handoffWindowsLaunch(input, launcher);
    assert.equal(result, undefined);
    const spec = JSON.parse(await waitForFile(dump)) as { argv: string[]; cwd: string; env: Record<string, string>; log: string };
    assert.deepEqual(spec.argv, input.argv);
    assert.equal(spec.cwd, input.cwd);
    assert.equal(spec.log, input.log);
    assert.equal(spec.env.KEIYAKU_UNICODE, "café-✨");
    const deadline = performance.now() + 2_000;
    let logText = "";
    while (performance.now() < deadline) {
      if (existsSync(input.log)) logText = readFileSync(input.log, "utf8");
      if (logText === "a && b ✨") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(logText, "a && b ✨");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained buffered, streaming, stdio, and logged children still terminate their trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-retained-windows-policy-"));
  const descendant = "setInterval(() => {}, 1_000);";
  const parent = (file: string) => [
    'const { writeFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(file)}, String(child.pid));`,
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const descendantFile = join(root, "descendant-pid");
  let descendantPid: number | undefined;
  try {
    const outcome = await runProcess({
      argv: [process.execPath, "-e", parent(descendantFile)],
      cwd: root,
      timeoutMs: 1_000,
    });
    assert.equal(outcome.kind, "timeout");
    descendantPid = Number.parseInt(readFileSync(descendantFile, "utf8"), 10);
    await waitForExit(descendantPid);

    const streamed = await consumeProcessStdout({
      argv: [process.execPath, "-e", 'process.stdout.write("x")'],
      timeoutMs: 2_000,
    }, () => {});
    assert.equal(streamed.outcome.kind, "terminal");

    const stdio = spawnStdioProcess({
      argv: [process.execPath, "-e", parent(join(root, "stdio-descendant"))],
      cwd: root,
    });
    const stdioPid = Number.parseInt(await waitForFile(join(root, "stdio-descendant")), 10);
    await stdio.close(true);
    await waitForExit(stdioPid);

    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", parent(join(root, "logged-descendant"))],
      cwd: root,
      log: join(root, "logged.log"),
    });
    const loggedPid = Number.parseInt(await waitForFile(join(root, "logged-descendant")), 10);
    await owned.terminate(true);
    await waitForExit(owned.pid);
    await waitForExit(loggedPid);
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function consoleProbe(file: string, linger: boolean): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    'const { execFileSync } = require("node:child_process");',
    `const script = "Add-Type -TypeDefinition '" +`,
    String.raw`'using System; using System.Runtime.InteropServices; public class C { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'`,
    ` + "'; [C]::GetConsoleWindow()";`,
    "let handle = 'unknown';",
    "try { handle = String(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })).trim(); } catch (error) { handle = error.message; }",
    `writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid, handle, tty: Boolean(process.stdout.isTTY) }));`,
    linger ? "setInterval(() => {}, 1000);" : "",
  ].join(" ");
}

function assertHiddenConsole(reported: { handle: string; tty: boolean }): void {
  assert.equal(reported.tty, false);
  assert.ok(reported.handle === "0" || reported.handle === "0x0", reported.handle);
}

test("Windows hosts hide consoles for Body handoff and retained children", async (t) => {
  if (process.platform !== "win32") {
    t.skip("visible-console observation requires a Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-windows-console-"));
  let pid: number | undefined;
  try {
    const result = await handoffProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "handoff-console"), true)],
      cwd: root,
      log: join(root, "handoff.log"),
    });
    assert.equal(result, undefined);
    const handoff = JSON.parse(await waitForFile(join(root, "handoff-console"))) as { pid: number; handle: string; tty: boolean };
    pid = handoff.pid;
    assertHiddenConsole(handoff);

    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "logged-console"), true)],
      cwd: root,
      log: join(root, "logged.log"),
    });
    assertHiddenConsole(JSON.parse(await waitForFile(join(root, "logged-console"))) as { handle: string; tty: boolean });
    await owned.terminate(true);
    await waitForExit(owned.pid);

    await runProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "buffered-console"), false)],
      cwd: root,
      timeoutMs: 5_000,
    });
    assertHiddenConsole(JSON.parse(await waitForFile(join(root, "buffered-console"))) as { handle: string; tty: boolean });

    await consumeProcessStdout({
      argv: [process.execPath, "-e", consoleProbe(join(root, "stream-console"), false)],
      cwd: root,
      timeoutMs: 5_000,
    }, () => {});
    assertHiddenConsole(JSON.parse(await waitForFile(join(root, "stream-console"))) as { handle: string; tty: boolean });

    const stdio = spawnStdioProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "stdio-console"), true)],
      cwd: root,
    });
    assertHiddenConsole(JSON.parse(await waitForFile(join(root, "stdio-console"))) as { handle: string; tty: boolean });
    await stdio.close(true);
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
      await waitForExit(pid);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
