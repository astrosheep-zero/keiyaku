import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { displayColumns } from "../src/cli/render/terminal.js";
import { World } from "../src/world.js";
import { removeTempDirectory } from "./support/process.js";

const packagedCli = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));
const acpSdk = fileURLToPath(new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url));

/** The ACP agent every observing-call scenario in this file drives through a real CLI process. */
function fakeAgentSource(): string {
  return [
    'import { Readable, Writable } from "node:stream";',
    `import * as acp from ${JSON.stringify(acpSdk)};`,
    'const mode = process.env.OBS_MODE ?? "notes";',
    'const app = acp.agent({ name: "fake-acp" })',
    '  .onRequest(acp.methods.agent.initialize, ({ params }) => ({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } }))',
    '  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "observing-session" }))',
    '  .onRequest(acp.methods.agent.session.load, () => ({}))',
    '  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {',
    '    const chunk = (sessionUpdate, text) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate, content: { type: "text", text } } });',
    '    if (mode === "notes") {',
    "      for (let index = 1; ; index += 1) {",
    '        await new Promise((resolve) => setTimeout(resolve, 250));',
    '        await chunk("agent_thought_chunk", "retry note " + index);',
    '        await chunk("agent_message_chunk", "attempt " + index);',
    "      }",
    "    }",
    '    if (mode === "slow") {',
    "      for (let index = 1; index <= 10; index += 1) {",
    '        await new Promise((resolve) => setTimeout(resolve, 250));',
    '        await chunk("agent_thought_chunk", "retry note " + index);',
    '        await chunk("agent_message_chunk", "attempt " + index);',
    "      }",
    "    }",
    '    if (mode === "tools") {',
    "      for (let index = 1; index <= 9; index += 1) {",
    '        await new Promise((resolve) => setTimeout(resolve, 180));',
    '        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-" + index, title: "tool " + index, kind: "execute", rawInput: { command: "tool-" + index }, status: "in_progress" } });',
    '        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-" + index, status: "completed" } });',
    "      }",
    '      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "plan", entries: [{ content: "terminal boundary", priority: "low", status: "completed" }] } });',
    '      // Keep the completed boundary observable through at least one polling turn before ending the session.',
    '      await new Promise((resolve) => setTimeout(resolve, 1000));',
    "    }",
    '    if (mode === "answer" || mode === "slow") await chunk("agent_message_chunk", "the answer");',
    '    return { stopReason: "end_turn" };',
    "  })",
    '  .onNotification(acp.methods.agent.session.cancel, () => {});',
    "app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));",
    "",
  ].join("\n");
}

/** One fake ACP provider recipe whose agent runs the given mode. */
function acpRecipe(agent: string, mode: "notes" | "slow" | "tools" | "answer" | "empty"): Readonly<Record<string, unknown>> {
  return {
    kind: "acp",
    executable: process.execPath,
    env: { OBS_MODE: mode },
    config: {
      argvBefore: [agent],
      argvAfter: ["stdio"],
      modelArg: "--model",
      effortArg: "--effort",
      systemPromptArg: "--system-prompt",
      systemPromptMode: "append",
    },
  };
}

/** A world whose archetypes all reach one fake ACP agent, plus the home holding those archetypes. */
function observingWorld(): Readonly<{ root: string; world: string; env: NodeJS.ProcessEnv }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-observing-")));
  const world = join(root, "world");
  const home = join(root, ".home");
  mkdirSync(join(world, ".keiyaku"), { recursive: true });
  mkdirSync(join(home, "akuma"), { recursive: true });
  const agent = join(root, "fake-acp.mjs");
  writeFileSync(agent, fakeAgentSource());
  for (const [archetype, provider] of [
    ["worker", "fake-notes"],
    ["slowcoach", "fake-slow"],
    ["toolbox", "fake-tools"],
    ["finisher", "fake-answer"],
    ["silent", "fake-empty"],
  ] as const) {
    writeFileSync(join(home, "akuma", `${archetype}.md`), `---\nprovider: ${provider}\n---\nWork.\n`);
  }
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    `${JSON.stringify(
      {
        providers: {
          "fake-notes": acpRecipe(agent, "notes"),
          "fake-slow": acpRecipe(agent, "slow"),
          "fake-tools": acpRecipe(agent, "tools"),
          "fake-answer": acpRecipe(agent, "answer"),
          "fake-empty": acpRecipe(agent, "empty"),
        },
      },
      null,
      2,
    )}\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, KEIYAKU_HOME: home };
  // A local observing call must be made here, never forwarded to an enclosing Body.
  delete env.AKUMA_REQUESTS;
  return { root, world, env };
}

/** The run of U+2500 a frame head of these lines draws, measured in display columns. */
function ruleFor(headLine: string): string {
  return "─".repeat(displayColumns(headLine));
}

/** The display column at which the first occurrence of one mark starts. */
function markColumn(line: string, mark: string): number {
  const index = line.indexOf(mark);
  assert.notEqual(index, -1, `expected ${mark} in ${line}`);
  return displayColumns(line.slice(0, index));
}

/** One identity-frame head line for the given archetype and alias, if present. */
function headFrameCount(stderr: string, archetype: string, alias: string): number {
  return stderr.match(new RegExp(`^aku/${archetype}/[0-9a-f]{8} \\(${alias}\\)$`, "gmu"))?.length ?? 0;
}

/** Ascending message numbers rendered in one attributed source's rows. */
function attributedAttemptNumbers(stderr: string, alias: string): readonly number[] {
  return [...stderr.matchAll(new RegExp(`^.*${alias} +\\S+ +say +“attempt (\\d+)”`, "gmu"))].map((match) =>
    Number(match[1]!),
  );
}

test("packaged observing calls stream one framed session and one conclusion per outcome", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    const unfinished = await runPackagedCli(
      ["-C", world, "call", "worker", "--wait", "2s", "--alias", "@notes", "prompt"],
      { cwd: world, env },
    );
    assert.equal(unfinished.code, 0, unfinished.stderr);
    assert.equal(unfinished.stdout, "", "an unfinished observing call writes no stdout");
    const lines = unfinished.stderr.split("\n");
    assert.match(lines[0]!, /^aku\/worker\/[0-9a-f]{8} \(@notes\)$/u, "one identity frame opens the session");
    assert.equal(lines[1], ruleFor(lines[0]!), "the shared rule underlines the identity head");
    assert.doesNotMatch(unfinished.stderr, /cwd/u, "the observing receipt never shows a detached cwd row");
    assert.equal(unfinished.stderr.match(/● still running — waited /gu)?.length, 1, "one truthful conclusion");
    const attempts = [...unfinished.stderr.matchAll(/attempt (\d+)/gu)].map((match) => Number(match[1]!));
    assert.doesNotMatch(unfinished.stderr, /retry note/u, "thought narration stays out of default live progress");
    assert.ok(attempts.length >= 1, `a settled message streams while the call waits:\n${unfinished.stderr}`);
    assert.equal(new Set(attempts).size, attempts.length, "no settled message streams twice");
    assert.deepEqual(attempts, [...attempts].sort((left, right) => left - right), "messages stream after their predecessors");
    await runPackagedCli(["-C", world, "kill", "@notes"], { cwd: world, env });

    const answered = await runPackagedCli(["-C", world, "call", "finisher", "--wait", "20s", "prompt"], {
      cwd: world,
      env,
    });
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.stdout, "the answer", "an answered observing call writes its bytes exactly once");
    assert.match(answered.stderr, /✓ answered — \d+s/u);
    assert.doesNotMatch(answered.stderr, /the answer/u, "the stream never replays the settled answer");

    const silent = await runPackagedCli(["-C", world, "call", "silent", "--wait", "20s", "prompt"], {
      cwd: world,
      env,
    });
    assert.equal(silent.code, 0, silent.stderr);
    assert.equal(silent.stdout, "", "a valid empty answer writes zero stdout bytes");
    assert.match(silent.stderr, /✓ answered — \d+s/u, "the conclusion distinguishes an empty answer from silence");
  } finally {
    await removeTempDirectory(root);
  }
});

test("packaged observing call bounds nine eligible tools across polling callbacks", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    const result = await runPackagedCli(["-C", world, "call", "toolbox", "--wait", "20s", "prompt"], { cwd: world, env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "", "an empty answer leaves stdout empty");
    const tools = [...result.stderr.matchAll(/\$ tool-(\d+)/gu)].map((match) => Number(match[1]!));
    // The terminal plan note advances the open frontier; its preceding nine completed tools are
    // eligible during the following polling turn, while the current frontier itself is not rendered.
    assert.deepEqual(tools, [1, 2, 3, 8, 9], `one command keeps only its opening and final tools:\n${result.stderr}`);
    assert.equal(result.stderr.match(/⋮ 4 omitted/gu)?.length, 1, result.stderr);
    assert.ok(result.stderr.indexOf("$ tool-3") < result.stderr.indexOf("⋮ 4 omitted"));
    assert.ok(result.stderr.indexOf("⋮ 4 omitted") < result.stderr.indexOf("$ tool-8"));
    assert.match(result.stderr, /✓ answered — \d+s/u, "the final conclusion remains on stderr");
  } finally {
    await removeTempDirectory(root);
  }
});

test("packaged plural waits attribute activity and close every target", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    const running = await runPackagedCli(
      ["-C", world, "call", "worker", "--wait", "1s", "--alias", "@notes", "prompt"],
      { cwd: world, env },
    );
    assert.equal(running.code, 0, running.stderr);
    const settled = await runPackagedCli(
      ["-C", world, "call", "finisher", "--wait", "20s", "--alias", "@done", "prompt"],
      { cwd: world, env },
    );
    assert.equal(settled.code, 0, settled.stderr);
    const slow = await runPackagedCli(
      ["-C", world, "call", "slowcoach", "--wait", "1s", "--alias", "@slow", "prompt"],
      { cwd: world, env },
    );
    assert.equal(slow.code, 0, slow.stderr);

    // `--any` streams rounds until the slow target answers, then closes every target.
    const any = await runPackagedCli(["-C", world, "wait", "@notes", "@slow", "--any", "--timeout", "6s"], {
      cwd: world,
      env,
    });
    assert.equal(any.code, 0, any.stderr);
    assert.equal(any.stdout, "", "an --any plural wait writes no stdout");
    assert.equal(headFrameCount(any.stderr, "worker", "@notes"), 1, `one head frame per observed Akuma:\n${any.stderr}`);
    assert.equal(headFrameCount(any.stderr, "slowcoach", "@slow"), 1, `one head frame per observed Akuma:\n${any.stderr}`);
    assert.match(any.stderr, /@notes +│ say/u, `--any attributed an activity row to its source:\n${any.stderr}`);
    assert.doesNotMatch(any.stderr, /retry note/u, "--any omits thought narration");
    assert.match(any.stderr, /@slow +✓ answered — /u, "--any scored the answered target");
    assert.match(any.stderr, /@notes +● still running — waited \d+s/u, "--any scored the running target");
    const anyLines = any.stderr.split("\n");
    const anyScore = anyLines.find((line) => /@notes +● still running — waited /u.test(line))!;
    const anyRows = anyLines.filter((line) => /@notes +│ /u.test(line));
    assert.ok(anyRows.length >= 1, `--any streamed attributed rows:\n${any.stderr}`);
    for (const row of anyRows) {
      assert.equal(markColumn(row, "│"), markColumn(anyScore, "●"), `rows share the scoreboard mark column:\n${any.stderr}`);
    }
    const anyAttempts = attributedAttemptNumbers(any.stderr, "@notes");
    assert.ok(anyAttempts.length >= 1, `--any streamed messages for its source:\n${any.stderr}`);
    assert.equal(new Set(anyAttempts).size, anyAttempts.length, "no settled message streams twice");
    assert.deepEqual(anyAttempts, [...anyAttempts].sort((left, right) => left - right), "messages stream in order");

    // `--all` outlives the running target: the already settled and the running one both close.
    const all = await runPackagedCli(["-C", world, "wait", "@notes", "@done", "--all", "--timeout", "2s"], {
      cwd: world,
      env,
    });
    assert.equal(all.code, 0, all.stderr);
    assert.equal(all.stdout, "", "an --all plural wait writes no stdout");
    assert.equal(headFrameCount(all.stderr, "worker", "@notes"), 1, `one head frame per observed Akuma:\n${all.stderr}`);
    assert.equal(headFrameCount(all.stderr, "finisher", "@done"), 1, `one head frame per observed Akuma:\n${all.stderr}`);
    assert.match(all.stderr, /@notes +│ say/u, `--all attributed an activity row to its source:\n${all.stderr}`);
    assert.doesNotMatch(all.stderr, /retry note/u, "--all omits thought narration");
    assert.match(all.stderr, /@done +✓ answered — /u, "--all scored the already settled target");
    assert.match(all.stderr, /@notes +● still running — waited 2s/u, "--all scored the running target");
    const allLines = all.stderr.split("\n");
    const allScore = allLines.find((line) => /@notes +● still running — waited /u.test(line))!;
    for (const row of allLines.filter((line) => /@notes +│ /u.test(line))) {
      assert.equal(markColumn(row, "│"), markColumn(allScore, "●"), `rows share the scoreboard mark column:\n${all.stderr}`);
    }
    assert.equal(all.stderr.match(/✓ answered — /gu)?.length, 1, "every target closes exactly once");
    await runPackagedCli(["-C", world, "kill", "@notes"], { cwd: world, env });
  } finally {
    await removeTempDirectory(root);
  }
});

function runPackagedCli(
  args: readonly string[],
  input: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; stdin?: string }>,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packagedCli, ...args], {
      cwd: input.cwd,
      env: { ...(input.env ?? process.env), NODE_NO_WARNINGS: "1" },
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
  const root = (await World.resolve(mkdtempSync(join(tmpdir(), "keiyaku-packaged-akuma-")))).candidate!;
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
    await removeTempDirectory(root);
  }
});
