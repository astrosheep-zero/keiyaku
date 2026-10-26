import { deferred as promiseBarrier, removeTempDirectory, restoreEnvironmentValues } from "./support/process.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
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
import { Akumas, type AkumaKillResult } from "../src/index.js";
import { World, type WorldRoot } from "../src/world.js";

const packagedCli = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));
const acpSdk = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url).href;
/**
 * The empty process home this file owns. A runtime without an explicit home coordinate reads the
 * process home, which Node resolves from HOME on POSIX and USERPROFILE on Windows, so a plugin the
 * developer selected in their own user settings would activate in every child here and its import
 * diagnostic would land in asserted stderr. Both variables are moved before any World or child
 * environment is captured; KEIYAKU_HOME stays the fixtures' own archetype coordinate.
 */
const processHome = mkdtempSync(join(tmpdir(), "keiyaku-packaged-home-"));
const ambientHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = processHome;
process.env.USERPROFILE = processHome;
test.after(async () => {
  restoreEnvironmentValues(ambientHome);
  await removeTempDirectory(processHome);
});

/** The ACP agent every observing-call scenario in this file drives through a real CLI process. */
function fakeAgentSource(): string {
  return [
    'import { Readable, Writable } from "node:stream";',
    `import * as acp from ${JSON.stringify(acpSdk)};`,
    'const mode = process.env.OBS_MODE ?? "notes";',
    'const app = acp.agent({ name: "fake-acp" })',
    "  .onRequest(acp.methods.agent.initialize, ({ params }) => ({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } }))",
    '  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "observing-session" }))',
    "  .onRequest(acp.methods.agent.session.load, () => ({}))",
    "  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {",
    '    const chunk = (sessionUpdate, text) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate, content: { type: "text", text } } });',
    '    if (mode === "notes") {',
    "      for (let index = 1; ; index += 1) {",
    "        await new Promise((resolve) => setTimeout(resolve, 250));",
    '        await chunk("agent_thought_chunk", "retry note " + index);',
    '        await chunk("agent_message_chunk", "attempt " + index);',
    "      }",
    "    }",
    '    if (mode === "holding") {',
    "      // A tool opened and never completed is a live (active) row forever, so it can only ever",
    "      // appear through the close flush; the repeated said marker keeps the waiter observing.",
    '      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "hold", title: "hold", kind: "execute", rawInput: { command: "hold" }, status: "in_progress" } });',
    "      for (let index = 1; ; index += 1) {",
    "        await new Promise((resolve) => setTimeout(resolve, 300));",
    '        await chunk("agent_message_chunk", "attempt " + index);',
    '        await chunk("agent_thought_chunk", "retry note " + index);',
    "      }",
    "    }",
    '    if (mode === "slow") {',
    "      for (let index = 1; index <= 10; index += 1) {",
    "        await new Promise((resolve) => setTimeout(resolve, 250));",
    '        await chunk("agent_thought_chunk", "retry note " + index);',
    '        await chunk("agent_message_chunk", "attempt " + index);',
    "      }",
    "    }",
    '    if (mode === "tools") {',
    "      for (let index = 1; index <= 9; index += 1) {",
    "        await new Promise((resolve) => setTimeout(resolve, 180));",
    '        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-" + index, title: "tool " + index, kind: "execute", rawInput: { command: "tool-" + index }, status: "in_progress" } });',
    '        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-" + index, status: "completed" } });',
    "      }",
    '      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "plan", entries: [{ content: "terminal boundary", priority: "low", status: "completed" }] } });',
    "      // Keep the completed boundary observable through at least one polling turn before ending the session.",
    "      await new Promise((resolve) => setTimeout(resolve, 1000));",
    "    }",
    '    if (mode === "answer" || mode === "slow") await chunk("agent_message_chunk", "the answer");',
    '    return { stopReason: "end_turn" };',
    "  })",
    "  .onNotification(acp.methods.agent.session.cancel, () => {});",
    "app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));",
    "",
  ].join("\n");
}

/** One fake ACP provider recipe whose agent runs the given mode. */
function acpRecipe(
  agent: string,
  mode: "notes" | "holding" | "slow" | "tools" | "answer" | "empty",
): Readonly<Record<string, unknown>> {
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
    ["holder", "fake-holding"],
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
        plugins: { square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false } },
        providers: {
          "fake-notes": acpRecipe(agent, "notes"),
          "fake-holding": acpRecipe(agent, "holding"),
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

async function killAndAwaitPluralTarget(world: WorldRoot, selector: string): Promise<void> {
  const akumas = Akumas.of(world);
  const killed = await akumas.kill({
    akuma: [selector],
  });
  assert.equal(killed.results.length, 1, `public kill selected ${selector} once`);
  const member = killed.results[0]!;
  const settled =
    member.evidence === "killed" || member.evidence === "already-killed" || member.evidence === "already-stopped";
  if (!settled)
    assert.fail(
      [
        `public kill has settled evidence for ${selector}: ${member.evidence}`,
        await unsettledKillEvidence(akumas, selector, killed),
      ].join("\n"),
    );

  const waited = await akumas.wait({
    akuma: [selector],
    timeoutMs: 10_000,
  });
  assert.equal(waited.reason, "completed", `public wait confirms ${selector} settled after kill`);
  assert.equal(waited.observations.length, 1, `public wait observes ${selector} once`);
  assert.equal(waited.observations[0]!.status.id, member.id);
  assert.notEqual(waited.observations[0]!.status.life, "running");
}

/**
 * The evidence an unsettled kill owes a real Windows runner: the complete kill receipt plus the
 * public status and history that say why provider custody stayed hung. Read only on failure, so a
 * settled cleanup pays nothing.
 */
async function unsettledKillEvidence(akumas: Akumas, selector: string, killed: AkumaKillResult): Promise<string> {
  const sections = [`kill receipt for ${selector}: ${JSON.stringify(killed, null, 2)}`];
  try {
    sections.push(`status for ${selector}: ${JSON.stringify(await akumas.status({ akuma: selector }), null, 2)}`);
  } catch (error) {
    sections.push(`status for ${selector} failed: ${String(error)}`);
  }
  try {
    sections.push(`history for ${selector}: ${JSON.stringify(await akumas.history({ akuma: selector }), null, 2)}`);
  } catch (error) {
    sections.push(`history for ${selector} failed: ${String(error)}`);
  }
  return sections.join("\n");
}

test("packaged prompt-free call births without admitting a Tell", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    const born = await runPackagedCli(["-C", world, "call", "worker"], { cwd: world, env });
    assert.equal(born.code, 0, born.stderr);
    assert.match(born.stdout, /^✓ called aku\/worker\/[0-9a-f]{8}$/mu, "the receipt leads with verdict and identity");
    assert.ok(
      born.stdout.split("\n").includes(`  ${await realpath(world)}`),
      `the indented execution directory is the canonical cwd:\n${born.stdout}`,
    );
    assert.doesNotMatch(born.stdout, /└─|├─/u, "an action receipt grows no identity tree");
    assert.equal(born.stderr, "", "prompt-free birth has no progress or Tell output");
    assert.doesNotMatch(born.stdout, /tell/u, "prompt-free birth admits no Tell");
  } finally {
    await removeTempDirectory(root);
  }
});

test(
  "packaged observing calls stream one framed session and one conclusion per outcome",
  { timeout: 120_000 },
  async () => {
    assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
    const { root, world, env } = observingWorld();
    try {
      const unfinished = await runPackagedCli(
        ["-C", world, "call", "worker", "--wait", "10s", "--alias", "@notes", "prompt"],
        { cwd: world, env },
      );
      assert.equal(unfinished.code, 0, unfinished.stderr);
      assert.equal(unfinished.stdout, "", "an unfinished observing call writes no stdout");
      const lines = unfinished.stderr.split("\n");
      assert.match(lines[0]!, /^aku\/worker\/[0-9a-f]{8} \(@notes\)$/u, "one identity frame opens the session");
      assert.equal(
        lines[1],
        `  ${await realpath(world)}`,
        "the known execution directory is static context",
      );
      assert.equal(lines[2], ruleFor(lines[0]!, lines[1]!), "the shared rule underlines the identity head");
      assert.doesNotMatch(unfinished.stderr, /cwd/u, "the directory is a bare coordinate, not a labelled row");
      assert.equal(
        unfinished.stderr.match(/● running — waited /gu)?.length,
        1,
        "one input-bound conclusion states the observed life",
      );
      const attempts = [...unfinished.stderr.matchAll(/attempt (\d+)/gu)].map((match) => Number(match[1]!));
      assert.doesNotMatch(unfinished.stderr, /retry note/u, "thought narration stays out of default live progress");
      assert.ok(attempts.length >= 1, `a settled message streams while the call waits:\n${unfinished.stderr}`);
      assert.equal(new Set(attempts).size, attempts.length, "no settled message streams twice");
      assert.deepEqual(
        attempts,
        [...attempts].sort((left, right) => left - right),
        "messages stream after their predecessors",
      );

      const single = await runPackagedCli(["-C", world, "wait", "@notes", "--timeout", "1s"], { cwd: world, env });
      assert.equal(single.code, 0, single.stderr);
      assert.notEqual(single.stdout, "", "an unfinished single wait writes its status snapshot to stdout");
      assert.equal(single.stderr, "", "snapshot-only wait writes no live progress to stderr");
      assert.match(single.stdout, /aku\/(?:worker|finisher)\/[0-9a-f]{8}/u, "the snapshot names the selected Akuma");
      assert.doesNotMatch(single.stdout, /retry note/u, "single waits omit thought narration");
      await runPackagedCli(["-C", world, "kill", "@notes"], { cwd: world, env });

      let detachedStarted = false;
      try {
        const detached = await runPackagedCli(["-C", world, "call", "worker", "--alias", "@detached", "prompt"], {
          cwd: world,
          env,
        });
        assert.equal(detached.code, 0, detached.stderr);
        detachedStarted = true;
        const afterExit = await runPackagedCli(["-C", world, "wait", "@detached", "--timeout", "1s"], {
          cwd: world,
          env,
        });
        assert.equal(afterExit.code, 0, afterExit.stderr);
        assert.notEqual(afterExit.stdout, "", "detached wait returns its status snapshot");
        assert.equal(afterExit.stderr, "", "detached snapshot wait writes no live progress");
        assert.match(afterExit.stdout, /aku\/worker\/[0-9a-f]{8}/u, "detached snapshot names the Akuma");
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
      // The final narration may be observed while its Turn is still open. Closing must account for
      // that in-flight row with `?`, even when the later Heart projection folds it into the answer.
      const answerNarration = answered.stderr.split("\n").filter((line) => line.includes("the answer"));
      assert.ok(answerNarration.length <= 1, `the stream never repeats answer narration:\n${answered.stderr}`);
      for (const row of answerNarration)
        assert.match(
          row,
          /^(?:\d{2}:\d{2}| {5}) \? the answer$/u,
          "only unresolved narration may contain answer text",
        );
      assert.doesNotMatch(answered.stderr, /(?:^|\n)the answer(?:\n|$)/u, "the stream never replays raw answer bytes");
      const finisherId = answered.stderr.match(/aku\/finisher\/[0-9a-f]{8}/u)?.[0];
      assert.notEqual(finisherId, undefined, "the observing call exposes its one identity frame");
      const tell = await runPackagedCli(["-C", world, "ask", finisherId!, "--wait", "20s", "continue"], {
        cwd: world,
        env,
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
  },
);

test("packaged observing call bounds nine eligible tools across polling callbacks", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    const result = await runPackagedCli(["-C", world, "call", "toolbox", "--wait", "20s", "prompt"], {
      cwd: world,
      env,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "", "an empty answer leaves stdout empty");
    const tools = [...result.stderr.matchAll(/\$ tool-(\d+)/gu)].map((match) => Number(match[1]!));
    // The terminal plan note advances the open frontier; its preceding nine completed tools are
    // eligible during the following polling turn, while the current frontier itself is not rendered.
    assert.deepEqual(tools, [1, 2, 3], `one command prints the first three settled tools:\n${result.stderr}`);
    assert.equal(result.stderr.match(/⋮ 6 omitted/gu)?.length, 1, result.stderr);
    assert.ok(result.stderr.indexOf("$ tool-3") < result.stderr.indexOf("⋮ 6 omitted"));
    assert.match(result.stderr, /✓ answered — \d+s/u, "the final conclusion remains on stderr");
  } finally {
    await removeTempDirectory(root);
  }
});

test("packaged plural waits return each target's status snapshot", { timeout: 120_000 }, async (t) => {
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

    // --any returns snapshots when a selected target completes.
    const any = await runPackagedCli(["-C", world, "wait", "@notes", "@slow", "--any", "--timeout", "6s"], {
      cwd: world,
      env,
    });
    assert.equal(any.code, 0, any.stderr);
    assert.notEqual(any.stdout, "", "an --any plural wait writes status snapshots to stdout");
    assert.equal(any.stderr, "", "an --any snapshot wait writes no live progress");
    assert.match(any.stdout, /aku\/worker\/[0-9a-f]{8}/u, "--any includes the worker snapshot");
    assert.match(any.stdout, /aku\/slowcoach\/[0-9a-f]{8}/u, "--any includes the slowcoach snapshot");
    assert.doesNotMatch(any.stdout, /retry note/u, "--any omits thought narration");

    // `--all` outlives the running target: the already settled and the running one both close.
    const all = await runPackagedCli(["-C", world, "wait", "@notes", "@done", "--all", "--timeout", "2s"], {
      cwd: world,
      env,
    });
    assert.equal(all.code, 0, all.stderr);
    assert.notEqual(all.stdout, "", "an --all plural wait writes status snapshots to stdout");
    assert.equal(all.stderr, "", "an --all snapshot wait writes no live progress");
    assert.match(all.stdout, /aku\/worker\/[0-9a-f]{8}/u, "--all includes the worker snapshot");
    assert.match(all.stdout, /aku\/finisher\/[0-9a-f]{8}/u, "--all includes the finisher snapshot");
    assert.doesNotMatch(all.stdout, /retry note/u, "--all omits thought narration");
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
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false } } }),
  );
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
          resource: {
            abort: async () => {
              finishEvents();
            },
            forceDispose: async () => {
              finishEvents();
            },
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
    assert.notEqual(wait.stdout, "", "snapshot wait returns the selected status");
    assert.equal(wait.stderr, "", "snapshot wait writes no live progress");
    assert.match(wait.stdout, /aku\/worker\/[0-9a-f]{8}/u, "snapshot wait names the child");

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
    assert.match(failed.stderr, /! error .*fixture initial Tell admission failed/u);
    assert.doesNotMatch(failed.stderr, /● tell/u, "a birth reference does not claim Tell admission");
  } finally {
    await pump.close();
    leash.release();
    await removeTempDirectory(root);
  }
});
