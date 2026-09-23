import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { driveAkumaBody } from "../src/akuma/body.js";
import { akumaCallRequestCommands, type AkumaCallRequestChildLaunch } from "../src/akuma/call-request.js";
import { admitCallInitialTell } from "../src/akuma/call-initial-tell.js";
import { HeldAkumaLeash, initializeHeart, projectTell, readTell, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { Akumas } from "../src/index.js";
import { World, type WorldRoot } from "../src/world.js";
import { removeTempDirectory } from "./support/process.js";

const packagedCli = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));
const acpSdk = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url).href;

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
function ruleFor(...headLines: readonly string[]): string {
  return "─".repeat(headLines.reduce((widest, line) => Math.max(widest, displayColumns(line)), 0));
}

/** Assert one plural wait's aggregate frame maps caller-ordered aliases to identity tags. */
function assertAggregateHead(stderr: string, aliases: readonly [string, string]): readonly [string, string] {
  const lines = stderr.split("\n");
  const head = lines.slice(0, aliases.length);
  const tags = head.map((line, index) => {
    const match = /^([0-9a-f]{4,}) (.+)$/u.exec(line);
    assert.notEqual(match, null, `an aggregate head line maps a tag to its source:\n${stderr}`);
    assert.equal(match![2], aliases[index], `the aggregate head names the selected set in caller order:\n${stderr}`);
    return match![1]!;
  });
  assert.equal(new Set(tags).size, tags.length, `each selected target has a distinct tag:\n${stderr}`);
  const rule = ruleFor(...head);
  assert.equal(lines[aliases.length], rule, `one rule closes the aggregate head:\n${stderr}`);
  assert.equal(
    stderr.match(new RegExp(`^${rule}$`, "gmu"))?.length,
    1,
    `exactly one aggregate frame rule:\n${stderr}`,
  );
  return [tags[0]!, tags[1]!];
}

/** The display column at which the first occurrence of one mark starts. */
function markColumn(line: string, mark: string): number {
  const index = line.indexOf(mark);
  assert.notEqual(index, -1, `expected ${mark} in ${line}`);
  return displayColumns(line.slice(0, index));
}

/** Ascending message numbers rendered in one attributed source's rows. */
function attributedAttemptNumbers(stderr: string, tag: string): readonly number[] {
  return [...stderr.matchAll(new RegExp(`^.*${tag} +\\S+ +say +"attempt (\\d+)`, "gmu"))].map((match) =>
    Number(match[1]!),
  );
}

function assertAttributedInputAndLiveSays(stderr: string, tag: string, score: string, mode: string): void {
  const queuedPrompt = new RegExp(`^.*${tag} +✓ told +"prompt"$`, "gmu");
  assert.equal(
    stderr.match(queuedPrompt)?.length,
    1,
    `${mode} streamed the queued input once for its source:\n${stderr}`,
  );
  assert.match(
    stderr,
    new RegExp(`^.*${tag} +⧖ say +"attempt \\d+`, "mu"),
    `${mode} streamed in-flight say evidence for its source:\n${stderr}`,
  );

  const rowMarker = new RegExp(`^.*${tag} +(✓|⧖|│|⧗|!|\\?|×|⋮) `, "u");
  const rows = stderr.split("\n").filter((line) => rowMarker.test(line));
  assert.ok(rows.length >= 2, `${mode} streamed attributed activity rows:\n${stderr}`);
  for (const row of rows) {
    const marker = rowMarker.exec(row)?.[1];
    assert.notEqual(marker, undefined, `an attributed row has a mark:\n${row}`);
    assert.equal(
      markColumn(row, marker!),
      markColumn(score, "●"),
      `${mode} rows align with the scoreboard:\n${stderr}`,
    );
  }

  const attempts = attributedAttemptNumbers(stderr, tag);
  assert.ok(attempts.length >= 1, `${mode} streamed attributed messages:\n${stderr}`);
  assert.equal(new Set(attempts).size, attempts.length, `${mode} never streams one message twice`);
  assert.deepEqual(
    attempts,
    [...attempts].sort((left, right) => left - right),
    `${mode} streams messages in order`,
  );
}

async function killAndAwaitPluralTarget(world: WorldRoot, selector: string): Promise<void> {
  const killed = await Akumas.of(world).kill({
    akuma: [selector] });
  assert.equal(killed.results.length, 1, `public kill selected ${selector} once`);
  const member = killed.results[0]!;
  assert.ok(
    member.evidence === "killed" || member.evidence === "already-killed" || member.evidence === "already-stopped",
    `public kill has settled evidence for ${selector}: ${member.evidence}`,
  );

  const waited = await Akumas.of(world).wait({
    akuma: [selector], timeoutMs: 10_000 });
  assert.equal(waited.reason, "completed", `public wait confirms ${selector} settled after kill`);
  assert.equal(waited.observations.length, 1, `public wait observes ${selector} once`);
  assert.equal(waited.observations[0]!.status.id, member.id);
  assert.notEqual(waited.observations[0]!.status.life, "running");
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
    assert.equal(unfinished.stderr.match(/⧖ deadline — waited /gu)?.length, 1, "one input-bound deadline conclusion");
    const attempts = [...unfinished.stderr.matchAll(/attempt (\d+)/gu)].map((match) => Number(match[1]!));
    assert.doesNotMatch(unfinished.stderr, /retry note/u, "thought narration stays out of default live progress");
    assert.ok(attempts.length >= 1, `a settled message streams while the call waits:\n${unfinished.stderr}`);
    assert.equal(new Set(attempts).size, attempts.length, "no settled message streams twice");
    assert.deepEqual(attempts, [...attempts].sort((left, right) => left - right), "messages stream after their predecessors");

    const single = await runPackagedCli(["-C", world, "wait", "@notes", "--timeout", "1s"], { cwd: world, env });
    assert.equal(single.code, 0, single.stderr);
    assert.equal(single.stdout, "", "an unfinished single wait writes no stdout");
    assert.doesNotMatch(single.stderr, /retry note/u, "single waits omit thought narration");
    assert.match(single.stderr, /attempt \d+/u, `a single wait still streams eligible activity:\n${single.stderr}`);
    await runPackagedCli(["-C", world, "kill", "@notes"], { cwd: world, env });

    let detachedStarted = false;
    try {
      const detached = await runPackagedCli(["-C", world, "call", "worker", "--alias", "@detached", "prompt"], {
        cwd: world, env,
      });
      assert.equal(detached.code, 0, detached.stderr);
      detachedStarted = true;
      const afterExit = await runPackagedCli(["-C", world, "wait", "@detached", "--timeout", "1s"], {
        cwd: world, env,
      });
      assert.equal(afterExit.code, 0, afterExit.stderr);
      assert.match(afterExit.stderr, /attempt \d+/u, "detached input still drives its Body after the caller exits");
    } finally {
      if (detachedStarted) await killAndAwaitPluralTarget(await World.at(world), "@detached");
    }

    const answered = await runPackagedCli(["-C", world, "call", "finisher", "--wait", "20s", "prompt"], {
      cwd: world,
      env,
    });
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(answered.stdout, "the answer", "an answered observing call writes its bytes exactly once");
    assert.match(answered.stderr, /✓ answered — \d+s/u);
    assert.doesNotMatch(answered.stderr, /the answer/u, "the stream never replays the settled answer");
    const finisherId = answered.stderr.match(/aku\/finisher\/[0-9a-f]{8}/u)?.[0];
    assert.notEqual(finisherId, undefined, "the observing call exposes its one identity frame");
    const tell = await runPackagedCli(["-C", world, "tell", finisherId!, "--wait", "20s", "continue"], {
      cwd: world, env,
    });
    assert.equal(tell.code, 0, tell.stderr);
    assert.equal(tell.stdout, "the answer", "the bounded Tell writes only its exact answer bytes");
    assert.equal(tell.stderr.match(/^aku\/finisher\/[0-9a-f]{8}$/gmu)?.length, 1, "one shared input identity frame");
    assert.equal(tell.stderr.match(/tell +"continue"/gu)?.length, 1, "the admission row appears once");
    assert.equal(tell.stderr.match(/\n\n/gu)?.length, 1, "only the answer separator is blank");
    assert.match(tell.stderr, /✓ answered — \d+s\n\n$/u, "the progress channel separates the raw answer");

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

test("packaged plural waits attribute activity and close every target", { timeout: 120_000 }, async (t) => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  const worldRoot = await World.at(world);
  const cleanupAliases: string[] = [];
  try {
    const running = await runPackagedCli(
      ["-C", world, "call", "worker", "--wait", "1s", "--alias", "@notes", "prompt"],
      { cwd: world, env },
    );
    cleanupAliases.push("@notes");
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
    cleanupAliases.push("@slow");
    assert.equal(slow.code, 0, slow.stderr);

    // `--any` streams rounds until the slow target answers, then closes every target.
    const any = await runPackagedCli(["-C", world, "wait", "@notes", "@slow", "--any", "--timeout", "6s"], {
      cwd: world,
      env,
    });
    assert.equal(any.code, 0, any.stderr);
    assert.equal(any.stdout, "", "an --any plural wait writes no stdout");
    const [anyNotesTag, anySlowTag] = assertAggregateHead(any.stderr, ["@notes", "@slow"]);
    assert.doesNotMatch(
      any.stderr,
      /aku\/(?:worker|slowcoach)\/[0-9a-f]{8} \(@/u,
      `no per-target identity frame follows the aggregate head:\n${any.stderr}`,
    );
    assert.doesNotMatch(any.stderr, /retry note/u, "--any omits thought narration");
    assert.match(any.stderr, new RegExp(`${anySlowTag} +✓ answered — `, "mu"), "--any scored the answered target");
    assert.match(
      any.stderr,
      new RegExp(`${anyNotesTag} +● still running — waited \\d+s`, "mu"),
      "--any scored the running target",
    );
    const anyLines = any.stderr.split("\n");
    const anyScore =
      anyLines.find((line) => new RegExp(`${anyNotesTag} +● still running — waited `, "u").test(line)) ??
      assert.fail(`--any has its running conclusion:\n${any.stderr}`);
    assertAttributedInputAndLiveSays(any.stderr, anyNotesTag, anyScore, "--any");
    const anyAttempts = attributedAttemptNumbers(any.stderr, anySlowTag);
    assert.ok(anyAttempts.length >= 1, `--any streamed messages for its source:\n${any.stderr}`);
    assert.equal(new Set(anyAttempts).size, anyAttempts.length, "no settled message streams twice");
    assert.deepEqual(
      anyAttempts,
      [...anyAttempts].sort((left, right) => left - right),
      "messages stream in order",
    );

    // `--all` outlives the running target: the already settled and the running one both close.
    const all = await runPackagedCli(["-C", world, "wait", "@notes", "@done", "--all", "--timeout", "2s"], {
      cwd: world,
      env,
    });
    assert.equal(all.code, 0, all.stderr);
    assert.equal(all.stdout, "", "an --all plural wait writes no stdout");
    const [allNotesTag, allDoneTag] = assertAggregateHead(all.stderr, ["@notes", "@done"]);
    assert.doesNotMatch(
      all.stderr,
      /aku\/(?:worker|finisher)\/[0-9a-f]{8} \(@/u,
      `no per-target identity frame follows the aggregate head:\n${all.stderr}`,
    );
    assert.doesNotMatch(all.stderr, /retry note/u, "--all omits thought narration");
    assert.match(
      all.stderr,
      new RegExp(`${allDoneTag} +✓ answered$`, "mu"),
      "--all scored the already settled target without inventing a duration",
    );
    assert.match(
      all.stderr,
      new RegExp(`${allNotesTag} +● still running — waited 2s`, "mu"),
      "--all scored the running target",
    );
    const allLines = all.stderr.split("\n");
    const allScore =
      allLines.find((line) => new RegExp(`${allNotesTag} +● still running — waited `, "u").test(line)) ??
      assert.fail(`--all has its running conclusion:\n${all.stderr}`);
    assertAttributedInputAndLiveSays(all.stderr, allNotesTag, allScore, "--all");
    assert.equal(all.stderr.match(/✓ answered/gu)?.length, 1, "every target closes exactly once");
  } finally {
    let cleanupFailure: unknown;
    for (const alias of cleanupAliases) {
      try {
        await killAndAwaitPluralTarget(worldRoot, alias);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure === undefined) await removeTempDirectory(root);
    else t.diagnostic(`retained fixture ${root}; a plural-wait target did not settle: ${String(cleanupFailure)}`);
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
});

function runPackagedCli(
  args: readonly string[],
  input: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; stdin?: string }>,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", packagedCli, ...args], {
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
        const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
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
    commands: composeRequestCommands(
      akumaCallRequestCommands({
        world,
        paths: parent.paths,
        parent: soul,
        spawn: spawnChild,
        admitInitialTell: async ({ id, initialTell, signal }) => {
          if (initialTell.body === "admission-failure")
            return { kind: "birth-failed", diagnostic: "fixture initial Tell admission failed" };
          const admission = await admitCallInitialTell({
            world,
            id,
            initialTell,
            signal,
            now: () => "2026-08-15T00:00:03.000Z",
            wake: async (tell) => {
              const paths = pathsForAkuId(world, id);
              await driveAkumaBody({ paths, refuseIfHeld: true }, provider, {
                now: () => "2026-08-15T00:00:04.000Z",
              });
              const delivered = await readTell(paths, tell.id);
              if (delivered === null) throw new Error(`initial Tell ${tell.id} disappeared`);
              return {
                admission: { tellId: tell.id, fact: "recorded" },
                row: projectTell(delivered),
                wake: { kind: "told" },
              };
            },
          });
          return admission;
        },
      }),
    ),
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

    const failed = await runPackagedCli(["-C", root, "call", "worker", "--wait", "10s", "admission-failure"], {
      cwd: root,
      env,
    });
    assert.equal(failed.code, 2, failed.stderr);
    assert.equal(failed.stdout, "", "a pre-admission failure keeps stdout byte-pure");
    assert.equal(
      failed.stderr.match(/^aku\/worker\/[0-9a-f]{8}$/gmu)?.length,
      1,
      "failure opens the known child identity once",
    );
    assert.match(failed.stderr, /! error recorded Tell .* missing from Heart/u);
    assert.doesNotMatch(failed.stderr, /⧖ tell/u, "a birth reference does not claim Tell admission");
  } finally {
    await pump.close();
    leash.release();
    await removeTempDirectory(root);
  }
});
