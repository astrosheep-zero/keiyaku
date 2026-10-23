import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type * as PiTypes from "@earendil-works/pi-coding-agent";
const sdk: typeof PiTypes = await import(process.env.POC_PI_SDK_MODULE ?? "@earendil-works/pi-coding-agent");
import { AkumaOwner } from "../../src/akuma/akuma-owner.js";
import { readHeart } from "../../src/akuma/heart/index.js";
import { pathsForAkuId, type AkuId } from "../../src/akuma/identity.js";
import { akumaExecutionEnvironment } from "../../src/akuma/providers/execution-environment.js";
import { World } from "../../src/world.js";
import { createPocExtension } from "./extension.js";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = join(repo, "src/cli/index.ts");
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("PoC condition did not become true within six seconds");
}

async function offlineRuntime() {
  return sdk.ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("PoC must not modify credentials");
      },
      delete: async () => {
        throw new Error("PoC must not delete credentials");
      },
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

/** A deterministic model transport, not a mocked AgentSession, Body, tool, or CLI. */
function fixtureProvider(reply: (context: unknown, signal?: AbortSignal) => Promise<unknown[]>) {
  return (pi: PiTypes.ExtensionAPI) =>
    pi.registerProvider("poc-fixture", {
      baseUrl: "https://unused.invalid",
      api: "poc-fixture-api",
      apiKey: "not-a-real-key",
      models: [
        {
          id: "runner",
          name: "Offline PoC fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      streamSimple(model, context, options) {
        const result = (async () => {
          let content: unknown[];
          try {
            content = await reply(context, options?.signal);
          } catch (error) {
            if (!options?.signal?.aborted) throw error;
            return {
              role: "assistant",
              api: "poc-fixture-api",
              provider: model.provider,
              model: model.id,
              content: [],
              stopReason: "aborted",
              timestamp: Date.now(),
              usage: zeroUsage,
            };
          }
          return {
            role: "assistant",
            api: "poc-fixture-api",
            provider: model.provider,
            model: model.id,
            content,
            stopReason: content.some((block: any) => block.type === "toolCall") ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: zeroUsage,
          };
        })();
        return {
          async *[Symbol.asyncIterator]() {
            const message = await result;
            yield { type: "start", partial: message };
            yield message.stopReason === "aborted"
              ? { type: "error", reason: "aborted", error: message }
              : { type: "done", reason: message.stopReason, message };
          },
          result: () => result,
        } as never;
      },
    });
}

async function cli(world: string, ...args: string[]) {
  const result = await run(process.execPath, ["--import", "tsx", cliEntry, "-C", world, ...args, "--json"], {
    cwd: repo,
    env: akumaExecutionEnvironment(process.env),
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

test(
  "native tool owns an in-process Pi Akuma which a foreign CLI can observe, tell and kill",
  { timeout: 45_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiyaku-pi-host-poc-")));
    const world = await World.at(root);
    const workdir = join(root, "work");
    await mkdir(workdir);
    await mkdir(join(root, ".keiyaku/akuma"), { recursive: true });
    await writeFile(
      join(root, ".keiyaku/settings.json"),
      JSON.stringify({ plugins: { square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false } } }),
    );
    await writeFile(
      join(root, ".keiyaku/akuma/poc.md"),
      "---\nprovider: pi\nmodel: poc-fixture/runner\neffort: low\n---\nA local test agent.\n",
    );
    await writeFile(join(root, ".keiyaku/akuma/not-pi.md"), "---\nprovider: claude\n---\nNot Pi.\n");

    const beforeEnvironment = { ...process.env };
    const childSessions: PiTypes.AgentSession[] = [];
    const pids: number[] = [];
    const gates: ReturnType<typeof barrier>[] = [];
    const ready: ReturnType<typeof barrier>[] = [];
    const childInputs: string[] = [];
    const returnedIds: AkuId[] = [];
    const failures: unknown[] = [];
    const calls: Array<{ akuma: string; body: string; workdir?: string }> = [];
    const nativeCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const nativeResults: Array<{ isError: boolean; result: any }> = [];
    const loadSdk = async () => ({
      ...sdk,
      getAgentDir: () => root,
      SessionManager: {
        create: (cwd: string) => sdk.SessionManager.create(cwd, join(root, "sessions")),
        open: sdk.SessionManager.open,
      } as typeof sdk.SessionManager,
      createAgentSessionServices: async (options: Parameters<typeof sdk.createAgentSessionServices>[0]) => {
        const gate = barrier();
        const waiting = barrier();
        gates.push(gate);
        ready.push(waiting);
        let requests = 0;
        const provider = fixtureProvider(async (context, signal) => {
          pids.push(process.pid);
          childInputs.push(JSON.stringify(context));
          requests += 1;
          if (requests === 1) {
            const script = `require('node:fs').writeFileSync('child-environment.json', JSON.stringify({cwd:process.cwd(),actor:process.env.KEIYAKU_ACTOR_ID,world:process.env.KEIYAKU_ACTOR_WORLD,requests:process.env.AKUMA_REQUESTS,pi:process.env.PI_SESSION_ID}))`;
            return [
              {
                type: "toolCall",
                id: "inspect-environment",
                name: "bash",
                arguments: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` },
              },
            ];
          }
          if (requests === 2) {
            waiting.resolve();
            const abort = new AbortController();
            const onAbort = () => abort.abort(signal?.reason);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
            try {
              await Promise.race([
                gate.promise,
                delay(30_000, undefined, { signal: abort.signal }).then(() => {
                  throw new Error("fixture gate expired");
                }),
              ]);
            } finally {
              signal?.removeEventListener("abort", onAbort);
              abort.abort();
            }
            return [{ type: "text", text: "checkpoint" }];
          }
          return [{ type: "text", text: "FOREIGN_TELL_TOKEN received" }];
        });
        return sdk.createAgentSessionServices({
          ...options,
          modelRuntime: await offlineRuntime(),
          settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
          resourceLoaderOptions: {
            ...options.resourceLoaderOptions,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [provider],
          },
        });
      },
      createAgentSessionFromServices: async (options: Parameters<typeof sdk.createAgentSessionFromServices>[0]) => {
        const created = await sdk.createAgentSessionFromServices(options);
        childSessions.push(created.session);
        return created;
      },
    });
    const hostProvider = fixtureProvider(async (context: any) => {
      const last = context.messages.at(-1);
      if (last.role === "user" && JSON.stringify(last).includes("NATIVE_OPERATION")) {
        return [{ type: "toolCall", id: `native-${randomId++}`, ...nativeCalls.shift()! }];
      }
      if (last.role === "user" && JSON.stringify(last).includes("LAUNCH")) {
        return [{ type: "toolCall", id: `launch-${randomId++}`, name: "akuma_call", arguments: calls.shift()! }];
      }
      return [{ type: "text", text: "HOST_OK" }];
    });
    let randomId = 0;
    const services = await sdk.createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime: await offlineRuntime(),
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [hostProvider, createPocExtension(loadSdk)],
      },
    });
    const model = services.modelRuntime.getModel("poc-fixture", "runner");
    assert.ok(model);
    const { session: host } = await sdk.createAgentSessionFromServices({
      services,
      model,
      sessionManager: sdk.SessionManager.inMemory(root),
      tools: [
        "akuma_call",
        "akuma_status",
        "akuma_list",
        "akuma_definitions",
        "akuma_tell",
        "akuma_ask",
        "akuma_wait",
        "akuma_history",
        "akuma_fork",
        "akuma_kill",
      ],
    });
    await host.bindExtensions({});
    host.subscribe((event) => {
      if (event.type !== "tool_execution_end") return;
      if (event.toolName === "akuma_call") {
        if (event.isError) failures.push(event.result);
        else returnedIds.push(event.result.details.id);
      } else if (event.toolName.startsWith("akuma_")) {
        nativeResults.push({ isError: event.isError, result: event.result });
      }
    });
    async function invoke(name: string, input: Record<string, unknown>, expectError = false) {
      const index = nativeResults.length;
      nativeCalls.push({ name, arguments: input });
      await host.prompt("NATIVE_OPERATION");
      const result = nativeResults[index];
      assert.ok(result, `${name} must execute through Pi`);
      assert.equal(result.isError, expectError, JSON.stringify(result.result));
      if (expectError) return result.result;
      assert.deepEqual(result.result.structuredContent, result.result.details);
      return result.result.details;
    }
    let shutDown = false;
    t.after(async () => {
      for (const gate of gates) gate.resolve();
      if (!shutDown) await host.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      host.dispose();
      await rm(root, { recursive: true, force: true });
    });

    // Exercise Pi's actual model -> tool execution path, not a direct execute() call.
    calls.push({ akuma: "poc", body: "Perform the local environment probe", workdir: "work" });
    await host.prompt("LAUNCH the first Akuma");
    assert.deepEqual(failures, []);
    assert.equal(returnedIds.length, 1);
    const id = returnedIds[0]!;
    await eventually(async () => ready.length === 1);
    await ready[0]!.promise;
    const owner = new AkumaOwner(id, world);
    assert.equal((await owner.status()).life, "running");
    assert.equal(host.getLastAssistantText(), "HOST_OK", "host must finish while its Akuma still runs");
    assert.notEqual(childSessions[0]!.sessionId, host.sessionId);
    assert.ok(childSessions[0]!.sessionFile);
    assert.ok(pids.length > 0 && pids.every((pid) => pid === process.pid));
    const environment = JSON.parse(await readFile(join(workdir, "child-environment.json"), "utf8"));
    assert.equal(environment.cwd, workdir);
    assert.equal(environment.actor, id);
    assert.equal(environment.world, root);
    assert.ok(environment.requests);
    assert.equal(environment.pi, childSessions[0]!.sessionId);
    const changedKeys = [...new Set([...Object.keys(process.env), ...Object.keys(beforeEnvironment)])].filter(
      (key) => process.env[key] !== beforeEnvironment[key],
    );
    assert.deepEqual(changedKeys, [], "child must not mutate the host environment");
    const status = await cli(root, "status", id);
    assert.match(JSON.stringify(status), /running/);

    assert.equal((await invoke("akuma_status", { akuma: id })).status.life, "running");
    assert.equal((await invoke("akuma_list", { archetype: "poc", limit: 1 })).rows[0].id, id);
    assert.ok((await invoke("akuma_definitions", { limit: 20 })).rows.some((row: any) => row.name === "poc"));
    const deadline = await invoke("akuma_wait", { akuma: [id], completion: "all", timeoutMs: 0 });
    assert.equal(deadline.reason, "deadline");
    assert.equal(deadline.mode, "all");
    const nativeTell = await invoke("akuma_tell", { akuma: id, body: "NATIVE_TELL_TOKEN" });
    assert.equal(nativeTell.tell.admission.fact, "recorded");
    const busy = await invoke(
      "akuma_ask",
      { akuma: id, body: "No schema while running", schema: { type: "object" }, timeoutMs: 0 },
      true,
    );
    assert.match(JSON.stringify(busy), /busy|running/i);
    const asked = invoke("akuma_ask", { akuma: id, body: "NATIVE_ASK_TOKEN", timeoutMs: 5_000 });
    await eventually(async () =>
      (await readHeart(pathsForAkuId(world, id))).pending.some((tell) => tell.body === "NATIVE_ASK_TOKEN"),
    );
    const tellReceipt = await cli(root, "tell", id, "FOREIGN_TELL_TOKEN");
    // The adapter submits one live message at a time, fenced by native message_end.
    await eventually(async () =>
      childSessions[0]!.agent
        .peekQueuedMessages()
        .some((message) => JSON.stringify(message).includes("NATIVE_TELL_TOKEN")),
    );
    gates[0]!.resolve();
    assert.equal(tellReceipt.tell.admission.fact, "recorded");
    const answer = await asked;
    assert.equal(answer.observation.reason, "answered");
    assert.equal(answer.observation.answer, "FOREIGN_TELL_TOKEN received");
    assert.equal((await owner.wait(undefined, { timeoutMs: 5_000 })).life, "asleep");
    assert.equal(childSessions.length, 1, "live Tell must continue the same native session");
    const history = await cli(root, "history", id);
    assert.match(JSON.stringify(history), /FOREIGN_TELL_TOKEN received/);
    assert.ok(childInputs.some((input) => input.includes("FOREIGN_TELL_TOKEN")));
    const heart = await readHeart(pathsForAkuId(world, id));
    assert.ok(heart.soul);
    assert.equal(heart.latestBody?.end, "exited");
    assert.ok(childInputs.some((input) => input.includes("NATIVE_TELL_TOKEN") && input.includes("NATIVE_ASK_TOKEN")));
    assert.equal((await invoke("akuma_history", { akuma: id, last: true })).answer, "FOREIGN_TELL_TOKEN received");
    const nativeHistory = await invoke("akuma_history", { akuma: id });
    const answeredAt = nativeHistory.history.rows.find(
      (row: any) => row.kind === "outcome" && row.outcome.kind === "answered",
    ).outcome.historyId;
    const exact = await invoke("akuma_history", { akuma: id, id: answeredAt });
    assert.equal(exact.kind, "exact");
    assert.equal((await invoke("akuma_history", { akuma: id, id: "turn/99999" })).kind, "unknown-history");
    const page = await invoke("akuma_history", { akuma: id, since: 1, limit: 1 });
    assert.equal(page.kind, "history");
    assert.ok(page.history.rows.length <= 1);
    const conflict = await invoke("akuma_history", { akuma: id, id: "turn/1", last: true }, true);
    assert.match(JSON.stringify(conflict), /cannot be combined/);
    const idle = await invoke("akuma_wait", { akuma: [id], timeoutMs: 1_000 });
    assert.equal(idle.mode, "any");
    assert.equal(idle.reason, "completed");
    assert.equal((await invoke("akuma_fork", { akuma: id, at: "turn/99999" })).kind, "unknown-history");
    const forked = await invoke("akuma_fork", { akuma: id, at: answeredAt });
    assert.equal(forked.kind, "forked", JSON.stringify(forked));
    assert.notEqual(forked.child, id);
    const forkStatus = await invoke("akuma_status", { akuma: forked.child });
    assert.equal(forkStatus.status.life, "asleep");
    assert.equal(forkStatus.status.birth.origin.kind, "fork");

    // A foreign kill stops only the child; the host remains usable.
    calls.push({ akuma: "poc", body: "Wait for external kill", workdir: "work" });
    await host.prompt("LAUNCH the second Akuma");
    await eventually(async () => ready.length === 2);
    await ready[1]!.promise;
    const second = returnedIds[1]!;
    await cli(root, "kill", second);
    assert.equal((await new AkumaOwner(second, world).status()).life, "killed");
    await host.prompt("Ping after foreign kill");
    assert.equal(host.getLastAssistantText(), "HOST_OK");

    // The unsupported provider refuses before allocating any Akuma.
    calls.push({ akuma: "not-pi", body: "Must refuse" });
    await host.prompt("LAUNCH unsupported provider");
    assert.equal(failures.length, 1);
    assert.match(JSON.stringify(failures[0]), /Pi-backed/);
    assert.equal(returnedIds.length, 2);

    // Native plural kill uses the same owner and leaves the host usable.
    calls.push({ akuma: "poc", body: "Wait for native kill", workdir: "work" });
    await host.prompt("LAUNCH a native-kill target");
    await eventually(async () => ready.length === 3);
    await ready[2]!.promise;
    const killed = await invoke("akuma_kill", { akuma: [returnedIds[2]!, second] });
    assert.deepEqual(
      killed.results.map((row: any) => row.evidence),
      ["killed", "already-killed"],
    );
    assert.equal((await invoke("akuma_status", { akuma: returnedIds[2]! })).status.life, "killed");

    // Orderly host shutdown retires its remaining child session, not just the tool.
    calls.push({ akuma: "poc", body: "Wait for host shutdown", workdir: "work" });
    await host.prompt("LAUNCH the shutdown target");
    await eventually(async () => ready.length === 4);
    await ready[3]!.promise;
    await host.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    shutDown = true;
    assert.equal((await new AkumaOwner(returnedIds[3]!, world).status()).life, "killed");
    for (const session of childSessions) {
      assert.throws(() => session.resourceLoader.getExtensions().runtime.assertActive(), /stale/);
    }
    console.log(
      JSON.stringify({
        verification: "offline model transport; real Pi sessions, native tool execution, Body, Heart and foreign CLI",
        hostPid: process.pid,
        childSdkPids: [...new Set(pids)],
        akuma: id,
        foreignTell: "received",
        foreignKill: "isolated",
        hostShutdown: "child retired",
      }),
    );
  },
);

test("Pi's native extension loader loads the standalone PoC file", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "keiyaku-pi-poc-loader-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const services = await sdk.createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: await offlineRuntime(),
    settingsManager: sdk.SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [join(repo, "experiments/pi-inprocess/extension.ts")],
    },
  });
  const loaded = services.resourceLoader.getExtensions();
  try {
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual(
      [...loaded.extensions[0]!.tools.keys()].sort(),
      [
        "akuma_call",
        "akuma_status",
        "akuma_list",
        "akuma_definitions",
        "akuma_tell",
        "akuma_ask",
        "akuma_wait",
        "akuma_history",
        "akuma_fork",
        "akuma_kill",
      ].sort(),
    );
  } finally {
    loaded.runtime.invalidate();
  }
});
