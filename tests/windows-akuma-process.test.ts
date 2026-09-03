import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AkumaComposition as Akuma } from "./support/akuma-composition.js";
import { spawnOptionsFor, spawnWindowsLauncher } from "../src/runtime/proc/launch.js";
import { consumeProcessStdout, runProcess, spawnDetachedProcess } from "../src/runtime/proc/run.js";
import { spawnStdioProcess } from "../src/runtime/proc/stdio.js";
import { World } from "../src/world.js";
import { removeTempDirectory, waitForProcessExit as waitForExit } from "./support/process.js";

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const packagedLauncher = resolve("build/src/runtime/proc/windows-launch.exe");

function peSubsystem(path: string): number {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ");
  const offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", offset, offset + 4), "PE\0\0");
  const optional = offset + 24;
  const magic = bytes.readUInt16LE(optional);
  assert.ok(magic === 0x10b || magic === 0x20b);
  return bytes.readUInt16LE(optional + 68);
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`missing ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return readFileSync(path, "utf8");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function startChatCompletionFixture() {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "fixture-completion",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-chat",
        choices: [{ index: 0, delta: { role: "assistant", content: "fixture answer" }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "fixture-completion",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-chat",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("chat completion fixture did not bind TCP");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

test("the Windows release launcher is a GUI-subsystem x64 PE", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the native release artifact is built only on Windows");
    return;
  }
  assert.equal(existsSync(packagedLauncher), true);
  const built = (await import(pathToFileURL(resolve("build/src/runtime/proc/launch.js")).href)) as {
    windowsLauncherPath(): string;
  };
  assert.equal(built.windowsLauncherPath(), packagedLauncher);
  assert.equal(peSubsystem(packagedLauncher), IMAGE_SUBSYSTEM_WINDOWS_GUI);
});

test("launch policy keeps detached, hidden, no-shell process semantics", () => {
  assert.deepEqual(spawnOptionsFor({ cwd: "/tmp", env: process.env }, ["ignore", "pipe", "pipe"]), {
    cwd: "/tmp",
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
});

test("a missing Windows launcher fails with the typed spawn error", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-missing-launch-"));
  try {
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawnWindowsLauncher(
            {
              argv: [process.execPath, "-e", ""],
              cwd: root,
              log: join(root, "stdio.log"),
            },
            join(root, "missing-windows-launch.exe"),
          );
          child.once("error", reject);
          child.once("spawn", () => reject(new Error("missing launcher unexpectedly spawned")));
          child.once("close", () => resolve());
        }),
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

test("Windows retained launch accepts a one-element target argv", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the native launcher argv cut is Windows-only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-one-arg-launch-"));
  const log = join(root, "stdio.log");
  const child = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe");
  try {
    const owned = await spawnDetachedProcess({ argv: [child], cwd: root, log });
    await owned.exited;
    const deadline = performance.now() + 2_000;
    let text = "";
    while (performance.now() < deadline) {
      if (existsSync(log)) text = readFileSync(log, "utf8");
      if (text.trim().length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(text, /\S/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained launch returns the target pid and release leaves it alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-retained-"));
  const pidFile = join(root, "pid");
  const log = join(root, "stdio.log");
  let pid: number | undefined;
  try {
    const owned = await spawnDetachedProcess({
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      cwd: root,
      log,
    });
    assert.ok(Number.isSafeInteger(owned.pid) && owned.pid > 0);
    owned.release();
    pid = Number.parseInt(await waitForFile(pidFile), 10);
    assert.equal(pid, owned.pid);
    process.kill(pid, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(pid, 0);
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already reaped */
      }
      await waitForExit(pid);
    }
    await removeTempDirectory(root);
  }
});

test("a released Akuma Body completes through Pi and an OpenAI chat completion endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-windows-akuma-e2e-"));
  const home = join(root, "keiyaku-home");
  const piHome = join(root, "pi-home");
  const fixture = await startChatCompletionFixture();
  const environment = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    offline: process.env.PI_OFFLINE,
    skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
    telemetry: process.env.PI_TELEMETRY,
    openaiApiKey: process.env.OPENAI_API_KEY,
  };
  try {
    mkdirSync(join(home, "akuma"), { recursive: true });
    mkdirSync(piHome);
    writeFileSync(
      join(home, "akuma", "fixture.md"),
      "---\nprovider: pi\nmodel: fixture/fixture-chat\nreadonly: true\n---\n",
    );
    writeFileSync(
      join(piHome, "models.json"),
      `${JSON.stringify(
        {
          providers: {
            fixture: {
              baseUrl: fixture.baseUrl,
              api: "openai-completions",
              apiKey: "fixture",
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              models: [
                {
                  id: "fixture-chat",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 4_096,
                  maxTokens: 128,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    process.env.PI_CODING_AGENT_DIR = piHome;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    process.env.PI_TELEMETRY = "0";
    process.env.OPENAI_API_KEY = "fixture";

    const world = Akuma.of(await World.at(root), { home });
    const handle = await world.call({ archetype: "fixture", body: "Return the fixture answer." });
    const status = await handle.wait(undefined, { timeoutMs: 15_000 });
    assert.equal(fixture.requests, 1);
    assert.equal(status.life, "asleep");
    assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.outcome.kind === "answered", true);
    const history = await handle.history();
    assert.ok("rows" in history);
    const outcome = history.rows.find((row) => row.kind === "outcome")?.outcome;
    assert.equal(outcome?.kind, "answered");
    if (outcome?.kind === "answered") {
      assert.equal(outcome.answer, "fixture answer");
      assert.match(outcome.historyId, /^turn\/[1-9][0-9]*$/u);
      const exact = await handle.history({ id: outcome.historyId });
      if (!("kind" in exact)) throw new Error("expected exact history result");
      assert.equal(exact.kind, "exact");
      if (exact.kind === "exact") assert.deepEqual(exact.outcome.outcome, outcome);
    }
  } finally {
    restoreEnvironment("PI_CODING_AGENT_DIR", environment.agentDir);
    restoreEnvironment("PI_OFFLINE", environment.offline);
    restoreEnvironment("PI_SKIP_VERSION_CHECK", environment.skipVersionCheck);
    restoreEnvironment("PI_TELEMETRY", environment.telemetry);
    restoreEnvironment("OPENAI_API_KEY", environment.openaiApiKey);
    await fixture.close();
    await removeTempDirectory(root);
  }
});

test("Windows retained launch returns while its target remains long-lived", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the launcher stderr inheritance regression is Windows-only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-retained-return-"));
  const pidFile = join(root, "pid");
  let pid: number | undefined;
  try {
    const started = performance.now();
    const owned = await spawnDetachedProcess({
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 10_000)`,
      ],
      cwd: root,
      log: join(root, "stdio.log"),
    });
    assert.ok(performance.now() - started < 1_000);
    pid = Number.parseInt(await waitForFile(pidFile), 10);
    assert.equal(pid, owned.pid);
    owned.release();
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already reaped */
      }
      await waitForExit(pid);
    }
    await removeTempDirectory(root);
  }
});

test("retained launch preserves no-shell argv and log bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-launch-bytes-"));
  const cwd = join(root, "目录-ä");
  mkdirSync(cwd);
  const payload = ["", "a && b ✨", "has space", 'quote"inside', "trailing\\", "目录-ä"];
  const script =
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env.KEIYAKU_UNICODE }))";
  try {
    const retainedLog = join(cwd, "retained.log");
    const owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", script, ...payload],
      cwd,
      env: { ...process.env, KEIYAKU_UNICODE: "café-✨" },
      log: retainedLog,
    });
    await owned.exited;
    const childBytes = JSON.stringify({ argv: payload, cwd: realpathSync(cwd), env: "café-✨" });
    assert.equal(readFileSync(retainedLog, "utf8"), `${childBytes}[child exit 0]\n`);
  } finally {
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

test("Windows hosts hide consoles for retained children", async (t) => {
  if (process.platform !== "win32") {
    t.skip("visible-console observation requires a Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "keiyaku-v4-windows-console-"));
  let owned: Awaited<ReturnType<typeof spawnDetachedProcess>> | undefined;
  let stdio: ReturnType<typeof spawnStdioProcess> | undefined;
  try {
    owned = await spawnDetachedProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "logged-console"), true)],
      cwd: root,
      log: join(root, "logged.log"),
    });
    assertHiddenConsole(
      JSON.parse(await waitForFile(join(root, "logged-console"), 10_000)) as { handle: string; tty: boolean },
    );
    await owned.terminate(true);
    await waitForExit(owned.pid);

    await runProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "buffered-console"), false)],
      cwd: root,
      timeoutMs: 5_000,
    });
    assertHiddenConsole(
      JSON.parse(await waitForFile(join(root, "buffered-console"), 10_000)) as { handle: string; tty: boolean },
    );

    await consumeProcessStdout(
      {
        argv: [process.execPath, "-e", consoleProbe(join(root, "stream-console"), false)],
        cwd: root,
        timeoutMs: 5_000,
      },
      () => {},
    );
    assertHiddenConsole(
      JSON.parse(await waitForFile(join(root, "stream-console"), 10_000)) as { handle: string; tty: boolean },
    );

    stdio = spawnStdioProcess({
      argv: [process.execPath, "-e", consoleProbe(join(root, "stdio-console"), true)],
      cwd: root,
    });
    assertHiddenConsole(
      JSON.parse(await waitForFile(join(root, "stdio-console"), 10_000)) as { handle: string; tty: boolean },
    );
    await stdio.close(true);
  } finally {
    try {
      await stdio?.close(true);
    } catch {
      /* preserve the observation failure */
    }
    try {
      await owned?.terminate(true);
    } catch {
      /* preserve the observation failure */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
