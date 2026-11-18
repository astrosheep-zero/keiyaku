import { removeTempDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Akumas, type AkumaKillResult } from "../src/index.js";
import { World, type WorldRoot } from "../src/world.js";
import { isolateUserHome } from "./support/user-home.js";

const packagedCli = fileURLToPath(new URL("../build/src/cli/index.js", import.meta.url));
const acpSdk = import.meta.resolve("@agentclientprotocol/sdk");
/**
 * The empty process home this file owns. A runtime without an explicit home coordinate reads the
 * process home, so a plugin the developer selected in their own user settings would activate in
 * every child here and its import diagnostic would land in asserted stderr. KEIYAKU_HOME stays the
 * fixtures' own akumaName coordinate.
 */
isolateUserHome();

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
  mkdirSync(join(home, "akumas"), { recursive: true });
  const agent = join(root, "fake-acp.mjs");
  writeFileSync(agent, fakeAgentSource());
  for (const [akumaName, provider] of [
    ["worker", "fake-notes"],
    ["holder", "fake-holding"],
    ["slowcoach", "fake-slow"],
    ["toolbox", "fake-tools"],
    ["finisher", "fake-answer"],
    ["silent", "fake-empty"],
  ] as const) {
    writeFileSync(join(home, "akumas", `${akumaName}.md`), `---\nprovider: ${provider}\n---\nWork.\n`);
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
  return { root, world, env };
}

async function killAndAwaitPluralTarget(world: WorldRoot, selector: string): Promise<void> {
  const akumas = Akumas.of(world);
  const killed = await akumas.kill({
    akuma: selector,
  });
  assert.equal(killed.results.length, 1, `public kill selected ${selector} once`);
  const member = killed.results[0]!;
  const settled =
    member.outcome === "killed" || member.outcome === "already-killed" || member.outcome === "already-stopped";
  if (!settled)
    assert.fail(
      [
        `public kill has settled evidence for ${selector}: ${member.outcome}`,
        await unsettledKillEvidence(akumas, selector, killed),
      ].join("\n"),
    );

  const waited = await akumas.wait({
    akuma: [selector],
    timeoutMs: 10_000,
  });
  assert.equal(waited.reason, "completed", `public wait confirms ${selector} settled after kill`);
  assert.equal(waited.results.length, 1, `public wait observes ${selector} once`);
  const observed = waited.results[0]!;
  assert.equal(observed.kind, "observed");
  if (observed.kind === "observed") {
    assert.equal(observed.id, member.id);
    assert.notEqual(observed.life, "running");
  }
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

test("packaged prompt-free spawn births without admitting a Tell", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    const born = await runPackagedCli(["-C", world, "spawn", "worker", "--bare"], { cwd: world, env });
    assert.equal(born.code, 0, born.stderr);
    assert.match(born.stdout, /^✓ spawned aku\/worker\/[0-9a-f]{8}$/mu, "the receipt leads with verdict and identity");
    assert.equal(
      born.stdout.trimEnd().split("\n").length,
      1,
      `a birth without --workdir claims no execution directory:\n${born.stdout}`,
    );
    assert.doesNotMatch(born.stdout, /└─|├─/u, "an action receipt grows no identity tree");
    assert.equal(born.stderr, "", "prompt-free birth has no progress or Tell output");
    assert.doesNotMatch(born.stdout, /tell/u, "prompt-free birth admits no Tell");

    const located = await runPackagedCli(["-C", world, "spawn", "worker", "--bare", "--workdir", world], {
      cwd: world,
      env,
    });
    assert.equal(located.code, 0, located.stderr);
    assert.match(located.stdout, /^✓ spawned aku\/worker\/[0-9a-f]{8}$/mu, "the receipt leads with verdict and identity");
    assert.ok(
      located.stdout.split("\n").includes(`  ${await realpath(world)}`),
      `an explicit --workdir is the indented execution directory:\n${located.stdout}`,
    );
  } finally {
    await removeTempDirectory(root);
  }
});

test("packaged spawn and tell refuse the removed --wait option", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  try {
    for (const argv of [
      ["-C", world, "spawn", "worker", "--bare", "--wait", "1s", "prompt"],
      ["-C", world, "tell", "@worker", "--wait", "1s", "continue"],
    ] as const) {
      const result = await runPackagedCli(argv, { cwd: world, env });
      assert.equal(result.code, 64, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /reason  option --wait is not valid for (?:spawn|tell)/u);
      assert.match(result.stderr, /help  keiyaku (?:spawn|tell) --help/u);
    }
  } finally {
    await removeTempDirectory(root);
  }
});

test(
  "packaged spawn and tell confirm submission and leave answers to separate waits",
  { timeout: 120_000 },
  async () => {
    assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
    const { root, world, env } = observingWorld();
    try {
      const started = await runPackagedCli(
        ["-C", world, "spawn", "worker", "--bare", "--alias", "@notes", "prompt"],
        { cwd: world, env },
      );
      assert.equal(started.code, 0, started.stderr);
      assert.match(
        started.stdout,
        /^✓ spawned aku\/worker\/[0-9a-f]{8} \(@notes\)$/mu,
        "spawn identifies the born Akuma",
      );
      assert.match(started.stdout, /^  started turn\/[1-9][0-9]*$/mu);
      assert.doesNotMatch(started.stdout, /attempt \d+|answered|● running/u, "spawn waits for no answer");
      assert.equal(started.stderr, "", "spawn writes no live progress");

      const single = await runPackagedCli(["-C", world, "wait", "@notes", "--timeout", "10s"], { cwd: world, env });
      assert.equal(single.code, 0, single.stderr);
      assert.notEqual(single.stdout, "", "an unfinished single wait writes its status snapshot to stdout");
      assert.equal(single.stderr, "", "snapshot-only wait writes no live progress to stderr");
      assert.match(single.stdout, /aku\/worker\/[0-9a-f]{8}/u, "the snapshot names the selected Akuma");
      assert.match(
        single.stdout,
        /● aku\/worker\/[0-9a-f]{8}(?: \(@notes\))? — running/u,
        "the snapshot states the observed life",
      );
      assert.match(single.stdout, /^deadline$/mu, "a running single wait reports its deadline");
      assert.match(
        single.stdout,
        /retry note|attempt \d+/u,
        "a running deadline retains bounded recent fixture activity",
      );
      await runPackagedCli(["-C", world, "kill", "@notes"], { cwd: world, env });

      let detachedStarted = false;
      try {
        const detached = await runPackagedCli(
          ["-C", world, "spawn", "worker", "--bare", "--alias", "@detached", "prompt"],
          {
            cwd: world,
            env,
          },
        );
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

      const answered = await runPackagedCli(
        ["-C", world, "spawn", "finisher", "--bare", "--alias", "@answer", "prompt"],
        { cwd: world, env },
      );
      assert.equal(answered.code, 0, answered.stderr);
      assert.match(answered.stdout, /^✓ spawned aku\/finisher\/[0-9a-f]{8} \(@answer\)$/mu);
      assert.doesNotMatch(answered.stdout, /the answer|answered/u, "spawn returns admission, not the opening answer");
      assert.equal(answered.stderr, "");
      const finisherId = answered.stdout.match(/aku\/finisher\/[0-9a-f]{8}/u)?.[0];
      assert.notEqual(finisherId, undefined, "the admission receipt names its Akuma");
      const answerWait = await runPackagedCli(["-C", world, "wait", finisherId!, "--timeout", "20s"], {
        cwd: world,
        env,
      });
      assert.equal(answerWait.code, 0, answerWait.stderr);
      assert.match(answerWait.stdout, /^completed$/mu, "the opening work completes");
      assert.match(
        answerWait.stdout,
        new RegExp(`^✓ ${finisherId!} — answered$`, "mu"),
        "the wait snapshot carries the settled answered outcome",
      );
      assert.match(
        answerWait.stdout,
        /^[ \t]*turn\/[1-9][0-9]* · answered$/mu,
        "the wait snapshot names its exact answered Turn",
      );
      assert.match(
        answerWait.stdout,
        /^[ \t]*the answer$/mu,
        "the full answer bytes stay in their own block",
      );
      assert.equal(answerWait.stderr, "", "wait keeps its snapshot off the progress channel");

      const tell = await runPackagedCli(["-C", world, "tell", finisherId!, "continue"], {
        cwd: world,
        env,
      });
      assert.equal(tell.code, 0, tell.stderr);
      assert.match(tell.stdout, new RegExp(`^✓ ${finisherId} started turn/[1-9][0-9]*\\n$`, "u"));
      assert.doesNotMatch(tell.stdout, /the answer/u, "tell returns submission, not an answer");
      assert.equal(tell.stderr, "");
      const toldWait = await runPackagedCli(["-C", world, "wait", finisherId!, "--timeout", "20s"], {
        cwd: world,
        env,
      });
      assert.equal(toldWait.code, 0, toldWait.stderr);
      assert.match(toldWait.stdout, /^completed$/mu, "the told Turn completes");
      assert.match(
        toldWait.stdout,
        new RegExp(`^✓ ${finisherId!} — answered$`, "mu"),
        "the told wait carries the settled answered outcome",
      );
      assert.match(
        toldWait.stdout,
        /^[ \t]*turn\/[1-9][0-9]* · answered$/mu,
        "the told wait names its exact answered Turn",
      );
      assert.match(
        toldWait.stdout,
        /^[ \t]*the answer$/mu,
        "the told answer stays whole in its own block",
      );

      const silent = await runPackagedCli(
        ["-C", world, "spawn", "silent", "--bare", "--alias", "@silent", "prompt"],
        { cwd: world, env },
      );
      assert.equal(silent.code, 0, silent.stderr);
      assert.equal(silent.stderr, "");
      const silentWait = await runPackagedCli(["-C", world, "wait", "@silent", "--timeout", "20s"], {
        cwd: world,
        env,
      });
      assert.equal(silentWait.code, 0, silentWait.stderr);
      assert.match(silentWait.stdout, /^completed$/mu);
      assert.match(
        silentWait.stdout,
        /✓ aku\/silent\/[0-9a-f]{8}(?: \(@silent\))? — answered/u,
        "the wait conclusion distinguishes an empty answer from silence",
      );
    } finally {
      await removeTempDirectory(root);
    }
  },
);

test("packaged plural waits return each target's status snapshot", { timeout: 120_000 }, async (t) => {
  assert.equal(existsSync(packagedCli), true, "npm run build must produce the packaged CLI before this test");
  const { root, world, env } = observingWorld();
  const worldRoot = await World.at(world);
  const cleanupAliases: string[] = [];
  try {
    const running = await runPackagedCli(
      ["-C", world, "spawn", "worker", "--bare", "--alias", "@notes", "prompt"],
      { cwd: world, env },
    );
    cleanupAliases.push("@notes");
    assert.equal(running.code, 0, running.stderr);
    const settled = await runPackagedCli(
      ["-C", world, "spawn", "finisher", "--bare", "--alias", "@done", "prompt"],
      { cwd: world, env },
    );
    assert.equal(settled.code, 0, settled.stderr);
    const slow = await runPackagedCli(
      ["-C", world, "spawn", "slowcoach", "--bare", "--alias", "@slow", "prompt"],
      { cwd: world, env },
    );
    cleanupAliases.push("@slow");
    assert.equal(slow.code, 0, slow.stderr);
    const done = await runPackagedCli(["-C", world, "wait", "@done", "--timeout", "20s"], { cwd: world, env });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /^completed$/mu, "the finisher settles before the plural wait");

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
    assert.match(all.stdout, /^deadline$/mu, "an --all wait that outlives its running target reports its deadline");
    assert.match(
      all.stdout,
      /retry note|attempt \d+/u,
      "a running deadline retains bounded recent fixture activity",
    );
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
