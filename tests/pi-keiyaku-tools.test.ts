import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { harnessOwner } from "@astrosheep/square";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Akuma, Keiyaku, World } from "../src/index.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { SERVER_DESCRIPTION } from "../src/mcp/description.js";
import { beginTurn, endTurn, readHeart, readLatestTurnForBody } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { isolateUserHome } from "./support/user-home.js";
import {
  cleanupSpawnCapableFixtureForTest,
  deferred,
  installAkumaBodyPidReceipt,
  processExists,
  restoreEnvironmentValues,
  temporaryDirectory,
  waitForFixtureFile,
} from "./support/process.js";

isolateUserHome();
const rootUrl = new URL(import.meta.url.endsWith(".js") ? "../../" : "../", import.meta.url);
const extensionPath = fileURLToPath(new URL("plugins/pi/keiyaku.ts", rootUrl));
const identityVariables = [
  "KEIYAKU_ACTOR_ID", "KEIYAKU_ACTOR_WORLD", "KEIYAKU_INITIATOR", "KEIYAKU_EXTERNAL_CALLER",
  "PI_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "KEIYAKU_HOME",
] as const;

/** Real SDK services, file loader, tool runtime, and QuickJS. Only the model is synthetic. */
async function nativeSession(cwd: string, agentDir: string, codemode = true) {
  let nextScript: string | undefined;
  let toolSequence = 0;
  const results: ToolResultEvent[] = [];
  let mcpServers: ReturnType<ExtensionAPI["getMcpServers"]> | undefined;
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async () => { throw new Error("offline fixture must not write credentials"); },
      delete: async () => { throw new Error("offline fixture must not delete credentials"); },
    },
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const fixture = (pi: ExtensionAPI) => {
    pi.registerProvider("offline-keiyaku", {
      api: "offline-keiyaku", apiKey: "offline", baseUrl: "https://unused.invalid",
      models: [{
        id: "script", name: "script", reasoning: false, input: ["text"],
        contextWindow: 100_000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
      streamSimple(model, context) {
        const declared = context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []);
        assert.ok(declared.some((tool) => tool.name === "codemode"));
        assert.ok(declared.every((tool) => !tool.name.startsWith("keiyaku_") && !tool.name.startsWith("mcp__keiyaku")));
        const code = nextScript;
        nextScript = undefined;
        const message = {
          role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
          content: code === undefined
            ? [{ type: "text" as const, text: "done" }]
            : [{ type: "toolCall" as const, id: `script-${++toolSequence}`, name: "codemode", arguments: { code } }],
          stopReason: code === undefined ? "stop" as const : "toolUse" as const,
          timestamp: Date.now(),
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            yield { type: "done", reason: message.stopReason, message };
          },
          result: async () => message,
        } as never;
      },
    });
    pi.on("session_start", () => { mcpServers = pi.getMcpServers(); });
    pi.on("tool_result", (event) => { results.push(event); });
  };
  const services = await sdk.createAgentSessionServices({
    cwd, agentDir, modelRuntime, settingsManager,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [fixture, ...(codemode ? [sdk.createCodemodeExtension()] : [])],
    },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  assert.deepEqual(services.diagnostics, []);
  const model = services.modelRuntime.getModel("offline-keiyaku", "script");
  assert.ok(model);
  const manager = sdk.SessionManager.inMemory(cwd);
  const { session } = await sdk.createAgentSessionFromServices({
    services, model, sessionManager: manager, noTools: "builtin", thinkingLevel: "off",
  });
  const warnings: string[] = [];
  const errors: unknown[] = [];
  await session.bindExtensions({
    uiContext: { notify: (message: string, type?: string) => { if (type === "warning") warnings.push(message); } } as sdk.ExtensionUIContext,
    onError: (error) => { errors.push(error); },
  });
  return {
    session, manager, warnings, errors, results, mcpServers,
    async run(code: string, allowError = false) {
      nextScript = code;
      await session.prompt("Run the next offline script.");
      assert.deepEqual(errors, []);
      const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
      assert.ok(result?.role === "toolResult");
      if (!allowError) assert.equal(result.isError, false, JSON.stringify(result));
      return result;
    },
    async close() {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : []).join("\n");
}

function resultFor(results: ToolResultEvent[], name: string): ToolResultEvent {
  const result = results.findLast((event) => event.toolName === name);
  assert.ok(result, `${name} must have executed through the native runtime`);
  return result;
}

test("shipped Pi extension exposes the shared catalogue through real codemode and leaves admitted workers detached", async (t) => {
  const root = temporaryDirectory(t, "pi-keiyaku-native-");
  const agentDir = temporaryDirectory(t, "pi-keiyaku-agent-");
  const previous = Object.fromEntries(identityVariables.map((name) => [name, process.env[name]]));
  for (const name of identityVariables) delete process.env[name];
  // Deliberately conflicting inherited hosts must not replace the per-call session caller.
  process.env.PI_SESSION_ID = "inherited-parent";
  process.env.CODEX_THREAD_ID = "inherited-other-host";
  process.env.KEIYAKU_INITIATOR = "pi:independent-notification-owner";
  process.env.KEIYAKU_HOME = agentDir;
  const world = await World.at(root);
  installHostAcpFixture(world);
  const receipt = join(root, "body-pids");
  const restoreReceipt = installAkumaBodyPidReceipt(receipt);
  let operationFailed = true;
  const native = await nativeSession(root, agentDir);
  const mcp = createKeiyakuMcpServer({ cwd: root, environment: { KEIYAKU_HOME: agentDir }, version: "test" });
  const client = new Client({ name: "pi-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), mcp.server.connect(b)]);
    assert.deepEqual(native.warnings, []);
    assert.deepEqual(native.mcpServers, []);
    assert.deepEqual(native.session.getActiveToolNames(), ["codemode"]);
    const catalogue = (await client.listTools()).tools;
    const tools = native.session.getAllTools().filter((tool) => tool.namespace?.name === "keiyaku");
    assert.deepEqual(tools.map((tool) => tool.name), catalogue.map((tool) => `keiyaku_${tool.name}`));
    for (const [index, tool] of tools.entries()) {
      const expected = catalogue[index]!;
      assert.equal(tool.exposure, "codemode");
      assert.deepEqual(tool.namespace, { name: "keiyaku", description: SERVER_DESCRIPTION, instructions: SERVER_DESCRIPTION });
      assert.deepEqual(tool.parameters, expected.inputSchema);
      assert.deepEqual(tool.annotations, expected.annotations);
      assert.deepEqual(native.session.getToolDefinition(tool.name)?.outputSchema, expected.outputSchema);
    }
    const read = await native.run(`
      const ns = await describeNamespace("keiyaku");
      text(ns);
      text(await tools.keiyaku_whoami({}));
      text(await tools.keiyaku_ls({selector: "aku/"}));
    `);
    assert.match(text(read), /keiyaku_spawn/u);
    assert.match(text(read), new RegExp(`pi:${native.manager.getSessionId()}`, "u"));
    await native.run(`await tools.keiyaku_ls({selector: "aku/", mine: true});`, true);
    const usage = resultFor(native.results, "keiyaku_ls");
    assert.equal(usage.isError, true);
    assert.equal(usage.structuredContent, undefined);
    assert.equal(JSON.parse(usage.content[1]!.type === "text" ? usage.content[1]!.text : "").category, "invalid-input");
    await native.run(`text(await tools.keiyaku_ls({selector: "aku/"}));`);
    const expectedRead = await client.callTool({ name: "ls", arguments: { selector: "aku/" } });
    const nativeRead = resultFor(native.results, "keiyaku_ls");
    assert.deepEqual(nativeRead.content, expectedRead.content);
    assert.deepEqual(nativeRead.structuredContent, expectedRead.structuredContent);
    await native.run(`text(await tools.keiyaku_show({selector: "debt/missing"}));`, true);
    const missingDetail = resultFor(native.results, "keiyaku_show");
    const expectedDetail = await client.callTool({ name: "show", arguments: { selector: "debt/missing" } });
    assert.deepEqual(missingDetail.content, expectedDetail.content);
    await native.run(`text(await tools.keiyaku_spawn({akumaName: "acp-worker", prompt: "first", alias: "native-child", bare: true}));`);
    const spawned = resultFor(native.results, "keiyaku_spawn");
    assert.equal(spawned.isError, false, text(spawned));
    const id = (spawned.structuredContent as { akumaId: string }).akumaId;
    const child = Akuma.select(world, id);
    await native.run(`text(await tools.keiyaku_status({selector: "@native-child"}));`);
    const namedStatus = resultFor(native.results, "keiyaku_status");
    assert.equal(namedStatus.isError, false, text(namedStatus));
    assert.equal((namedStatus.structuredContent as { id: string }).id, id);
    await waitForFixtureFile(join(root, "first.ready"), 30_000);
    const status = await child.status();
    assert.deepEqual(status.birth.caller, { kind: "external", integration: "pi", id: native.manager.getSessionId() });
    const paths = pathsForAkumaId(world, child.id);
    const body = (await readHeart(paths)).latestBody!;
    const pid = Number(readFileSync(join(root, "first.ready"), "utf8"));
    assert.equal((await readLatestTurnForBody(paths, body.sequence))?.initiator, process.env.KEIYAKU_INITIATOR);
    await native.run(`text(await tools.keiyaku_ls({selector: "aku/*", mine: true}));`);
    const mine = resultFor(native.results, "keiyaku_ls").structuredContent as { rows: { id: string }[] };
    assert.deepEqual(mine.rows.map((row) => row.id), [id]);
    await native.run(`
      text(await tools.keiyaku_status({selector: ${JSON.stringify(id)}}));
      text(await tools.keiyaku_wait({selectors: [${JSON.stringify(id)}], timeout: "0ms"}));
    `);
    for (const name of ["keiyaku_ls", "keiyaku_status", "keiyaku_wait"]) {
      const result = resultFor(native.results, name);
      assert.equal(result.isError, false, text(result));
      const schema = native.session.getToolDefinition(name)?.outputSchema;
      assert.ok(schema);
      const validation = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(schema)))(result.structuredContent);
      assert.equal(validation.valid, true, validation.errorMessage);
      const facet = Keiyaku.for({
        cwd: root,
        environment: { ...process.env },
        home: agentDir,
        identity: { owner: harnessOwner({ channel: "pi", session: native.manager.getSessionId() }) },
      });
      const expected = name === "keiyaku_ls"
        ? await facet.ls({ selector: "aku/*", mine: true })
        : name === "keiyaku_status"
          ? await facet.status({ selector: id })
          : await facet.wait({ selectors: [id], timeout: "0ms" });
      const withoutObservationTime = (key: string, value: unknown) => key === "observedAt" ? undefined : value;
      assert.deepEqual(
        JSON.parse(JSON.stringify(result.structuredContent, withoutObservationTime)),
        JSON.parse(JSON.stringify(expected, withoutObservationTime)),
      );
    }

    const retained = await bornBody(world, "feed0030", "2026-11-17T00:00:00.000Z");
    try {
      const turn = await beginTurn(retained.allocated.paths, { bodySequence: retained.body.sequence, startedAt: "2026-11-17T00:00:00.000Z" });
      await endTurn(retained.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-11-17T00:00:01.000Z", outcome: { kind: "answered", answer: "exact Pi answer\n", session: { sessionId: "retained-pi" } } });
      for (const selection of [{ limit: 1 }, { item: `turn/${turn.sequence}` }, { item: "answer" }]) {
        const input = { selector: retained.allocated.id, ...selection };
        await native.run(`text(await tools.keiyaku_history(${JSON.stringify(input)}));`);
        const observed = resultFor(native.results, "keiyaku_history");
        const expected = await client.callTool({ name: "history", arguments: input });
        assert.equal(observed.isError, false, text(observed));
        assert.deepEqual(observed.content, expected.content);
      }
    } finally { retained.holder.release(); }

    const observing = deferred<void>();
    native.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "keiyaku_wait") observing.resolve();
    });
    const pending = native.run(`text(await tools.keiyaku_wait({selectors: [${JSON.stringify(id)}]}));`, true);
    await observing.promise;
    await native.session.abort();
    await pending;
    assert.ok(processExists(pid));
    await native.close();
    // Session teardown did not kill the admitted Body; it finishes after its own barrier.
    assert.ok(processExists(pid));
    writeFileSync(join(root, "first.release"), "release");
    assert.equal((await child.idle({ timeoutMs: 30_000 })).reason, "completed");
    assert.equal((await child.status()).work.kind, "idle");
    assert.equal(process.env.PI_SESSION_ID, "inherited-parent");
    assert.equal(process.env.CODEX_THREAD_ID, "inherited-other-host");
    operationFailed = false;
  } finally {
    writeFileSync(join(root, "first.release"), "release");
    native.session.dispose();
    await client.close();
    await mcp.close();
    try {
      await cleanupSpawnCapableFixtureForTest(t, { fixturePath: root, pidReceiptPath: receipt, timeoutMs: 30_000, operationFailed });
    } finally {
      restoreReceipt();
      restoreEnvironmentValues(previous);
    }
  }
});

test("real Pi loader without codemode warns once and never exposes a direct fallback", async (t) => {
  const root = temporaryDirectory(t, "pi-keiyaku-no-codemode-");
  const native = await nativeSession(root, root, false);
  try {
    assert.equal(native.warnings.length, 1);
    assert.match(native.warnings[0]!, /only from codemode.*not loaded/u);
    assert.deepEqual(native.errors, []);
    assert.deepEqual(native.mcpServers, []);
    assert.deepEqual(native.session.getActiveToolNames(), []);
    assert.ok(native.session.getCallableToolNames().includes("keiyaku_spawn"));
  } finally {
    await native.close();
  }
});
