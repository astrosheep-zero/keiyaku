import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { driveAkumaBody } from "../src/akuma/body.js";
import { akumaCallRequestCommands, type AkumaCallRequestChildLaunch } from "../src/akuma/call-request.js";
import { HeldAkumaLeash, initializeHeart, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import { World } from "../src/world.js";

const packagedCli = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));

function runPackagedCli(
  args: readonly string[],
  input: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; stdin?: string }>,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packagedCli, ...args], {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input.stdin ?? "");
  });
}

test("packaged Akuma call, wait, and history cross the request boundary", async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-packaged-akuma-")));
  const world = await World.prove(root);
  const home = join(root, ".home");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");

  const parent = await allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  await initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    allowed: ["akuma.call"],
    createdAt: "2026-08-15T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(parent.paths))!;
  await leash.birth(parent.paths, soul);
  const provider: ProviderAdapter = {
    admitOptions(options) {
      return { kind: "admitted", options };
    },
    start() {
      return createProviderAttempt(undefined, async () => {
        let finishEvents!: () => void;
        const eventsFinished = new Promise<void>((resolve) => {
          finishEvents = resolve;
        });
        return {
          admission: { fence: "packaged-akuma" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "packaged-session" } };
              finishEvents();
            },
          },
          completion: eventsFinished.then(() => ({
            kind: "answered" as const,
            answer: "finished",
            historyId: "packaged-history",
          })),
          async abort() {
            finishEvents();
          },
          async forceDispose() {
            finishEvents();
          },
        };
      });
    },
  };
  const spawnChild = async (launch: AkumaCallRequestChildLaunch): Promise<void> => {
    await driveAkumaBody(launch, provider, { now: () => "2026-08-15T00:00:02.000Z" });
  };
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-15T00:00:01.000Z",
    signal: new AbortController().signal,
    commands: composeRequestCommands(akumaCallRequestCommands({ world, paths: parent.paths, parent: soul, spawn: spawnChild })),
  });
  const env = { ...process.env, KEIYAKU_HOME: home, AKUMA_REQUESTS: pump.directory };
  const localEnv = { ...process.env, KEIYAKU_HOME: home };
  try {
    const call = await runPackagedCli(["-C", root, "call", "worker", "--json", "answer"], { cwd: root, env });
    assert.equal(call.code, 0, `${call.stdout}\n${call.stderr}`);
    const child = (JSON.parse(call.stdout) as { akuma: string }).akuma;
    assert.match(child, /^aku\/worker\//u);

    const wait = await runPackagedCli(["-C", root, "wait", child, "--timeout", "0ms"], { cwd: root, env: localEnv });
    assert.equal(wait.code, 0, wait.stderr);
    assert.equal(wait.stdout, "finished");

    const history = await runPackagedCli(["-C", root, "history", child, "--last", "--json"], {
      cwd: root,
      env: localEnv,
    });
    assert.equal(history.code, 0, history.stderr);
    assert.equal(JSON.parse(history.stdout).answer, "finished");
  } finally {
    await pump.close();
    leash.release();
    rmSync(root, { recursive: true, force: true });
  }
});
