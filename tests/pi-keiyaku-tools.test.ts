import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Akuma, Keiyaku, World } from "../src/index.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { readHeart, readLatestTurnForBody, readSoul, readTell } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
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
    assert.ok(tools.every((tool) => tool.exposure === "codemode"));
    for (const [name, input] of [
      ["bind", { terms: "terms", forkOf: "kei/source" }],
    ] as const) {
      const args = { cwd: join(root, "missing"), ...input };
      await native.run(`await tools.keiyaku_${name}(${JSON.stringify(args)});`, true);
      const rejected = resultFor(native.results, `keiyaku_${name}`);
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent, undefined);
      const failure = rejected.content[1];
      assert.ok(failure?.type === "text");
      assert.equal(JSON.parse(failure.text).category, "invalid-input");
    }
    const read = await native.run(`
      const ns = await describeNamespace("keiyaku");
      text(ns);
      text(await tools.keiyaku_whoami({}));
      text(await tools.keiyaku_ls({selector: "aku/"}));
    `);
    assert.match(text(read), /keiyaku_spawn/u);
    assert.match(text(read), new RegExp(`pi:${native.manager.getSessionId()}`, "u"));
    const expectedRead = await client.callTool({ name: "ls", arguments: { selector: "aku/" } });
    const nativeRead = resultFor(native.results, "keiyaku_ls");
    assert.deepEqual(nativeRead.structuredContent, expectedRead.structuredContent);
    await native.run(`text(await tools.keiyaku_spawn({akumaName: "acp-worker", prompt: "first", alias: "native-child", bare: true}));`);
    const spawned = resultFor(native.results, "keiyaku_spawn");
    assert.equal(spawned.isError, false, text(spawned));
    const { akumaId: id, action } = Keiyaku.verbs.spawn.normal.parse(spawned.structuredContent);
    assert.equal(action?.kind, "started");
    assert.match(text(spawned), new RegExp(`started ${action.historyId}`, "u"));
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
    const turn = await readLatestTurnForBody(paths, body.sequence);
    assert.ok(turn);
    assert.equal(turn.initiator, process.env.KEIYAKU_INITIATOR);
    await native.run(`text(await tools.keiyaku_ls({selector: "aku/*", mine: true}));`);
    const mine = resultFor(native.results, "keiyaku_ls").structuredContent as { rows: { id: string }[] };
    assert.deepEqual(mine.rows.map((row) => row.id), [id]);
    await native.run(`text(await tools.keiyaku_wait({selectors: [${JSON.stringify(id)}], for: "0ms"}));`);
    const immediate = resultFor(native.results, "keiyaku_wait");
    assert.equal(immediate.isError, false, text(immediate));
    const { members: [running] } = Keiyaku.verbs.wait.normal.parse(immediate.structuredContent);
    assert.ok(running?.state === "running");
    assert.equal(running.akuma, id);
    assert.equal(running.turn, `turn/${turn.sequence}`);

    const baseline = deferred<void>();
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (sql === "SELECT sequence FROM reports ORDER BY sequence DESC LIMIT 1") baseline.resolve();
      return prepare.call(this, sql);
    });
    try {
      const waiting = native.run(`text(await tools.keiyaku_wait({selectors: [${JSON.stringify(id)}], for: "10s"}));`);
      await Promise.race([baseline.promise, waiting.then(() => assert.fail("wait stopped before its report baseline"))]);
      const milestone = `worker reached the checkpoint\n${"work in progress ".repeat(50)}\nexact report tail`;
      const recorded = await child.report(milestone);
      assert.ok(recorded.kind === "recorded");
      await waiting;
      const wake = resultFor(native.results, "keiyaku_wait");
      assert.equal(wake.isError, false, text(wake));
      const schema = native.session.getToolDefinition("keiyaku_wait")?.outputSchema;
      assert.ok(schema);
      const validation = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(schema)))(wake.structuredContent);
      assert.equal(validation.valid, true, validation.errorMessage);
      const { members: [member] } = Keiyaku.verbs.wait.normal.parse(wake.structuredContent);
      assert.ok(member?.state === "running" && member.report);
      assert.equal(member.akuma, id);
      assert.equal(member.report.report, recorded.reportId);
      assert.match(member.report.text, /…$/u);
      assert.ok(milestone.startsWith(member.report.text.slice(0, -1)) && member.report.text.length < milestone.length);
      assert.ok(text(wake).includes(recorded.reportId));
      assert.match(text(wake), /worker reached the checkpoint[\s\S]*…/u);
      assert.ok(processExists(pid));
      await native.run(`text(await tools.keiyaku_history(${JSON.stringify({ selector: id, item: recorded.reportId })}));`);
      assert.equal(text(resultFor(native.results, "keiyaku_history")), milestone);
    } finally { t.mock.restoreAll(); }

    const observing = deferred<void>();
    native.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "keiyaku_wait") observing.resolve();
    });
    const pending = native.run(`text(await tools.keiyaku_wait({selectors: [${JSON.stringify(id)}]}));`, true);
    await observing.promise;
    await native.session.abort();
    await pending;
    assert.ok(processExists(pid));
    // Retire the real fixture leash immediately after the new child's first Tell COMMIT.
    // Both adapters run the native birth, Tell admission, and failing wake; neither makes a receipt.
    const prompt = "exceptional wake after admission";
    const args = { akumaName: "acp-worker", prompt, bare: true };
    const exec = DatabaseSync.prototype.exec;
    for (const surface of ["pi", "mcp"] as const) {
      let leash: string | undefined;
      const hook = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
        const result = exec.call(this, sql);
        if (sql !== "COMMIT" || leash !== undefined) return result;
        const location = this.location();
        if (location !== null && basename(location) === "heart.db" &&
            this.prepare("SELECT id FROM tells WHERE body = ?").get(prompt) !== undefined) {
          leash = join(dirname(location), "leash.db");
          renameSync(leash, `${leash}.fixture`);
        }
        return result;
      });
      try {
        const reply = surface === "pi"
          ? (await native.run(`text(await tools.keiyaku_spawn(${JSON.stringify(args)}));`), resultFor(native.results, "keiyaku_spawn"))
          : CallToolResultSchema.parse(await client.callTool({ name: "spawn", arguments: args }));
        assert.equal(reply.isError, false, text(reply));
        const receipt = Keiyaku.verbs.spawn.output.parse(reply.structuredContent);
        const schema = native.session.getToolDefinition("keiyaku_spawn")?.outputSchema;
        assert.ok(schema);
        const validation = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(schema)))(reply.structuredContent);
        assert.equal(validation.valid, true, validation.errorMessage);
        assert.ok(receipt.kind === "failed" && receipt.tellId);
        const paths = pathsForAkumaId(world, receipt.akumaId);
        assert.equal(leash, paths.leash);
        assert.deepEqual(receipt.failures, [{ stage: "wake", diagnostic: `Akuma Heart database is absent: ${paths.leash}` }]);
        assert.equal((await readSoul(paths))?.id, receipt.akumaId);
        const retainedInput = await readTell(paths, receipt.tellId);
        assert.equal(retainedInput?.body, prompt);
        assert.equal(retainedInput.state, "pending");
        const [summary, cause] = reply.content;
        assert.ok(summary?.type === "text" && cause?.type === "text");
        assert.equal(summary.text.split("\n")[0], `! ${receipt.akumaId} born · wake failed · do not respawn`);
        assert.ok(summary.text.includes(`input ${receipt.tellId} admitted`));
        const projected = JSON.parse(cause.text);
        assert.equal(projected.causeClass, "HeartAbsentError");
        assert.equal(projected.causeDiagnostic, `Akuma Heart database is absent: ${paths.leash}`);
        assert.deepEqual(projected.spawn, reply.structuredContent);
      } finally {
        hook.mock.restore();
        if (leash !== undefined) renameSync(`${leash}.fixture`, leash);
      }
    }
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
