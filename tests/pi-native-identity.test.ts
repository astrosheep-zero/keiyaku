import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CreateAgentSessionOptions, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { harnessOwner } from "@astrosheep/square";
import { deliveryOwner } from "../src/library/keiyaku-attribution.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { registerKeiyakuTools } from "../src/pi/index.js";
import { Akumas, World } from "../src/index.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLauncher } from "../src/akuma/body-launch.js";
import { readHeart, readSoul, readLatestTurnForBody, readLastAnsweredTurn } from "../src/akuma/heart/index.js";
import { parseAkumaId, pathsForAkumaId } from "../src/akuma/identity.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { restoreEnvironmentValues, temporaryDirectory } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

const PI_SESSION_VARIABLE = "PI_SESSION_ID";

type NativeBashTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];

function packageProvenance(specifier: string): string {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  return `${manifest.name}@${manifest.version} (${entry})`;
}

async function nativePiSdk(): Promise<{ sdk: PiSdk; options: () => Record<string, unknown> | undefined }> {
  let captured: Record<string, unknown> | undefined;
  const manager = {
    getLeafId: () => null,
    createBranchedSession: () => "/sessions/child.jsonl",
  };
  const session = {
    sessionFile: "/sessions/native.jsonl",
    sessionId: "native-child-session",
    sessionManager: manager,
    agent: {
      subscribe: () => () => {},
      steer: () => {},
    },
    subscribe: () => () => {},
    bindExtensions: async () => {},
    prompt: async () => {},
    abort: async () => {},
    extensionRunner: { emit: async () => {}, onError: () => () => {} },
    dispose: () => {},
  };
  return {
    options: () => captured,
    sdk: {
      createBashToolDefinition: (await import("@earendil-works/pi-coding-agent")).createBashToolDefinition,
      createAgentSessionFromServices: async (options) => {
        captured = options as unknown as Record<string, unknown>;
        return { session } as never;
      },
      createAgentSessionServices: async () => ({ resourceLoader: { getExtensions: () => ({ errors: [] }) } }) as never,
      getAgentDir: () => "/agent",
      SessionManager: { create: () => manager, open: () => manager } as never,
    },
  };
}

/**
 * Boot one fake Pi session wired to Keiyaku's real identity-scoped Bash tool.
 * The attempt is always retired, so a setup or assertion failure inside `body`
 * cannot leak a live session or its child processes.
 */
async function withNativeBashTool<T>(
  root: string,
  body: (tool: NativeBashTool) => Promise<T>,
): Promise<T> {
  const fake = await nativePiSdk();
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const attempt = provider.start({
    body: "work",
    launchTells: [],
    cwd: root,
    options: {},
    signal: new AbortController().signal,
    execution: { akumaId: "aku/pi/1234abcd", world: root },
    session: { kind: "fresh" },
  });
  try {
    const drive = await attempt.result;
    await drive.completion;
    const customTools = fake.options()?.customTools as
      | NonNullable<CreateAgentSessionOptions["customTools"]>
      | undefined;
    const tool = customTools?.[0];
    assert.ok(tool);
    return await body(tool);
  } finally {
    await attempt.closed;
  }
}

function nativeSessionContext(sessionId: string, sessionFile = `/sessions/${sessionId}.jsonl`): ExtensionToolContext {
  return {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  } as never;
}


test("Pi Bash preserves native session identity and the current execution coordinates", async (t) => {
  t.diagnostic(`Pi runtime: ${packageProvenance("@earendil-works/pi-coding-agent")}`);
  const root = mkdtempSync(join(tmpdir(), "keiyaku-pi-native-identity-"));
  const previousSession = process.env[PI_SESSION_VARIABLE];
  process.env[PI_SESSION_VARIABLE] = "ancestor-session";
  try {
    await withNativeBashTool(root, async (tool) => {
      const result = await tool.execute(
        "native-identity",
        { command: `printf '%s' "$PI_SESSION_ID|$PI_SESSION_FILE|$KEIYAKU_ACTOR_ID|$KEIYAKU_ACTOR_WORLD"` },
        new AbortController().signal,
        undefined,
        nativeSessionContext("native-child-session", "/sessions/native.jsonl"),
      );
      assert.deepEqual(result.content, [{ type: "text", text: `native-child-session|/sessions/native.jsonl|aku/pi/1234abcd|${root}` }]);
      assert.equal(process.env[PI_SESSION_VARIABLE], "ancestor-session");
    });
  } finally {
    if (previousSession === undefined) delete process.env[PI_SESSION_VARIABLE];
    else process.env[PI_SESSION_VARIABLE] = previousSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Pi tools bind current Owner once through real product execution", { timeout: 30_000 }, async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-pi-invocation-"));
  const home = temporaryDirectory(t, "keiyaku-pi-invocation-home-");
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const variables = ["KEIYAKU_ACTOR_ID", "KEIYAKU_ACTOR_WORLD", "KEIYAKU_INITIATOR", "KEIYAKU_EXTERNAL_CALLER",
    "PI_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "OPENCODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION", "PASEO_AGENT_ID", "KEIYAKU_HOME"];
  const prior = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  t.after(() => restoreEnvironmentValues(prior));
  variables.forEach((key) => { delete process.env[key]; });
  process.env.PASEO_AGENT_ID = "inherited-paseo";
  process.env.KEIYAKU_HOME = home;

  // Only the execution host is fake: tools, facet, birth, Tell and Turn custody are real.
  let turn = 0;
  let forkInitiator: string | undefined;
  const start: ProviderAdapter["start"] = (input) => createProviderAttempt(input.signal, async () => ({
    admission: { fence: "fixture" },
    events: { async *[Symbol.asyncIterator]() {
      yield { type: "session" as const, coordinate: { sessionId: "fixture-session" } };
    } },
    completion: Promise.resolve({ kind: "answered" as const, answer: '{"ok":true}', historyId: `answer-${++turn}` }),
  }));
  const spawn: BodyLauncher = async (launch) => {
    if (launch.seed?.origin.kind === "fork") forkInitiator = launch.birthInitiator;
    await driveAkumaBody(launch, {
      admitOptions: (options) => ({ kind: "admitted", options }), start,
      resume: (input) => start({ ...input, session: { kind: "fresh" } }),
    }, { spawn: noBodyLaunch, world });
    return { completed: Promise.resolve({ diagnostic: "fixture completed" }), async cancel() {}, release() {} };
  };
  const host = akumasWithLauncher(world, spawn);
  const operations = Object.getPrototypeOf(Akumas.of(world)) as Record<string, (input: unknown) => unknown>;
  for (const name of ["spawn", "tell", "ask", "fork"]) {
    const native = operations[name]!;
    t.mock.method(operations, name, (input: unknown) => native.call(host, input));
  }
  t.mock.method(claudeProvider as Required<Pick<ProviderAdapter, "fork">>, "fork", () => createProviderAttempt(undefined,
    async () => ({ session: { sessionId: "forked-native-session" } })));
  const tools = new Map<string, ToolDefinition>();
  registerKeiyakuTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on() {} } as unknown as ExtensionAPI);
  let session = "current-pi";
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(`keiyaku_${name}`);
    assert.ok(tool);
    const result = await tool.execute(name, args, t.signal, undefined, {
      cwd: world, sessionManager: { getSessionId: () => session },
    } as unknown as ExtensionToolContext);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return (result.structuredContent ?? result) as Record<string, unknown>;
  };
  const owner = harnessOwner({ channel: "pi", session });
  assert.match(JSON.stringify(await invoke("whoami", {})), /pi:current-pi/u);
  const born = await invoke("spawn", { akumaName: "worker", bare: true, prompt: "first" });
  const id = parseAkumaId(born.akumaId as string).id;
  const paths = pathsForAkumaId(world, id);
  assert.deepEqual((await readSoul(paths))?.caller, { kind: "external", integration: "pi", id: session });
  const latestInitiator = async () => {
    const body = (await readHeart(paths)).latestBody!;
    return (await readLatestTurnForBody(paths, body.sequence))?.initiator;
  };
  assert.equal(await latestInitiator(), owner);
  const firstTurn = await readLastAnsweredTurn(paths);
  assert.ok(firstTurn);
  const mine = await invoke("ls", { selector: "aku/*", mine: true, selection: "all" });
  assert.deepEqual((mine.rows as { id: string }[]).map((row) => row.id), [id]);

  session = "next-pi";
  const nextOwner = harnessOwner({ channel: "pi", session });
  await invoke("tell", { akuma: id, prompt: "next" });
  assert.equal(await latestInitiator(), nextOwner);
  const fork = await invoke("fork", { akuma: id, at: `turn/${firstTurn.sequence}`, bare: true });
  assert.deepEqual((await readSoul(pathsForAkumaId(world, parseAkumaId(fork.childAkumaId as string).id)))?.caller,
    { kind: "external", integration: "pi", id: session });

  assert.equal(forkInitiator, nextOwner);

  process.env.KEIYAKU_ACTOR_ID = "aku/actor/1234abcd";
  process.env.KEIYAKU_ACTOR_WORLD = world;
  const actor = await invoke("spawn", { akumaName: "worker", bare: true, prompt: "actor" });
  const actorPaths = pathsForAkumaId(world, parseAkumaId(actor.akumaId as string).id);
  assert.deepEqual((await readSoul(actorPaths))?.caller,
    { kind: "akuma", world, akumaId: process.env.KEIYAKU_ACTOR_ID });
  const actorBody = (await readHeart(actorPaths)).latestBody!;
  assert.equal((await readLatestTurnForBody(actorPaths, actorBody.sequence))?.initiator, nextOwner);
  process.env.KEIYAKU_INITIATOR = "  redirect:recipient  ";
  await invoke("ask", { akuma: id, prompt: "structured", schema: { type: "object" } });
  assert.equal(await latestInitiator(), "redirect:recipient");
  assert.equal(process.env.PI_SESSION_ID, undefined);
  assert.equal(process.env.PASEO_AGENT_ID, "inherited-paseo");
});

test("parent and child native Pi environments resolve distinct delivery Owners", (t) => {
  t.diagnostic(`Square runtime: ${packageProvenance("@astrosheep/square")}`);
  const parent = deliveryOwner({ PI_SESSION_ID: "parent-session" });
  const child = deliveryOwner({ PI_SESSION_ID: "child-session" });
  assert.equal(parent, harnessOwner({ channel: "pi", session: "parent-session" }));
  assert.equal(child, harnessOwner({ channel: "pi", session: "child-session" }));
  assert.notEqual(parent, child);
});
