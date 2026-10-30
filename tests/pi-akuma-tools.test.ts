import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { Akuma, AkumaHost, Akumas, World } from "../src/index.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { temporaryDirectory, waitForCondition } from "./support/process.js";

const root = resolve(import.meta.dirname, import.meta.url.endsWith(".js") ? "../.." : "..");
const shippedExtension = join(root, "build/plugins/pi/keiyaku.ts");
const sourceCli = join(root, "src/cli/index.ts");
const toolNames = ["call", "status", "list", "definitions", "tell", "ask", "wait", "history", "fork", "kill"].map(
  (name) => `akuma_${name}`,
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (value: string) => JSON.stringify({ tool: "bash", args: { command: value } });

// Only the model transport is synthetic. Pi's loader, session, tools, bash,
// publication, host scope, Heart and detached launches are the shipped code.
const fixture = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default function(pi) {
  pi.registerTool({ name: "nested-fixture", label: "Nested fixture", description: "Invoke another native tool", parameters: { type: "object", properties: { name: { type: "string" }, args: { type: "object", additionalProperties: true } }, required: ["name", "args"] },
    async execute(_id, input, signal, _update, ctx) { const outcome = await ctx.executeTool(input.name, input.args, { signal }); return { ...outcome.result, isError: outcome.isError }; }
  });
  for (const event of ["session_start", "session_shutdown"]) pi.on(event, (_e, ctx) => {
    appendFileSync(join(ctx.cwd, "native.jsonl"), JSON.stringify({ event, pid: process.pid, session: ctx.sessionManager.getSessionId() }) + "\\n");
  });
  pi.registerProvider("native-fixture", {
    baseUrl: "https://unused.invalid", api: "native-fixture", apiKey: "fixture",
    models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let index = -1, text = "", input;
      for (let i = 0; i < context.messages.length; i++) {
        const message = context.messages[i];
        if (message.role !== "user") continue;
        index = i;
        text = typeof message.content === "string" ? message.content : message.content.filter(x => x.type === "text").map(x => x.text).join("");
      }
      try { input = JSON.parse(text.split("\\n")[0]); } catch {}
      const result = context.messages.slice(index + 1).filter(x => x.role === "toolResult").at(-1);
      const content = result ? [{ type: "text", text: result.content.filter(x => x.type === "text").map(x => x.text).join("") }]
        : input?.tool ? [{ type: "toolCall", id: "invoke-" + index, name: input.tool, arguments: input.args }]
        : [{ type: "text", text: input?.answer === undefined ? "ack:" + text : JSON.stringify(input.answer) }];
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    },
  });
}
`;

async function fixtureWorld(t: TestContext) {
  const world = await World.at(temporaryDirectory(t, "keiyaku-pi-native-tools-"));
  const agent = join(world, "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  writeFileSync(join(agent, "extensions", "fixture.js"), fixture);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ extensions: [shippedExtension], compaction: { enabled: false }, retry: { enabled: false } }),
  );
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(
    join(world, ".keiyaku", "akumas", "worker.md"),
    "---\nprovider: pi\nmodel: native-fixture/model\nallowed: []\n---\nFixture.\n",
  );
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return { world, agent };
}

async function hostAt(t: TestContext, world: string, agent: string) {
  const modelRuntime = await pi.ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("no credential writes");
      },
      delete: async () => {
        throw new Error("no credential writes");
      },
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const services = await pi.createAgentSessionServices({
    cwd: world,
    agentDir: agent,
    modelRuntime,
    settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [shippedExtension, join(agent, "extensions", "fixture.js")],
    },
  });
  const extensions = services.resourceLoader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  const shipped = extensions.extensions.find((extension) => extension.resolvedPath === shippedExtension);
  assert.ok(shipped);
  assert.ok(shipped.commands.has("keiyaku"));
  assert.deepEqual([...shipped.tools.keys()].sort(), [...toolNames].sort());
  const model = services.modelRuntime.getModel("native-fixture", "model");
  assert.ok(model);
  const { session } = await pi.createAgentSessionFromServices({
    services,
    model,
    sessionManager: pi.SessionManager.inMemory(world),
    tools: toolNames,
  });
  await session.bindExtensions({});
  const results: { toolName: string; result: any; isError: boolean }[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") results.push(event);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    const off = session.extensionRunner?.onError((error) => errors.push(error));
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    off?.();
    assert.deepEqual(errors, []);
  };
  t.after(async () => {
    await close();
    session.dispose();
  });
  const invoke = async (name: string, args: Record<string, unknown>, failure = false) => {
    const index = results.length;
    await session.prompt(JSON.stringify({ tool: name, args }));
    const result = results[index];
    assert.ok(result, `${name} did not execute`);
    assert.equal(result.toolName, name);
    assert.equal(result.isError, failure, JSON.stringify(result.result));
    if (!failure) assert.deepEqual(result.result.structuredContent, result.result.details);
    return result.result;
  };
  return { session, invoke, close };
}

function holding(world: string, name: string): string {
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(world, name + ".ready"))},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(world, name + ".release"))})){clearInterval(timer);console.log(JSON.stringify({actor:process.env.KEIYAKU_ACTOR_ID,world:process.env.KEIYAKU_ACTOR_WORLD,session:process.env.PI_SESSION_ID}));}},20);`;
  return [process.execPath, "-e", script].map(quote).join(" ");
}

function events(world: string): { event: string; pid: number; session: string }[] {
  return readFileSync(join(world, "native.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test(
  "shipped Pi tools use the public SDK, host wake/fork explicitly, preserve observation and permission boundaries",
  { timeout: 90_000 },
  async (t) => {
    const { world, agent } = await fixtureWorld(t);
    const host = await hostAt(t, world, agent);
    const native = async (name: string, args: Record<string, unknown>) => (await host.invoke(name, args)).details;
    const api = Akumas.of(world);
    installHostAcpFixture(world);
    const nonPi = await native("akuma_call", {
      akuma: "acp-worker",
      body: "ordinary provider",
      bare: true,
      writableDirectories: [],
      wait: true,
      timeoutMs: 20_000,
    });
    assert.equal(nonPi.observation.observation.answer, "acp-answer", JSON.stringify(nonPi));
    const unsupported = await host.invoke("akuma_call", {
      akuma: "worker", body: "must not start", writableDirectories: [world],
    }, true);
    assert.match(JSON.stringify(unsupported), /writableDirectories.*pi|pi.*writableDirectories/u);
    const ambient = {
      KEIYAKU_ACTOR_ID: process.env.KEIYAKU_ACTOR_ID,
      KEIYAKU_ACTOR_WORLD: process.env.KEIYAKU_ACTOR_WORLD,
      AKUMA_REQUESTS: process.env.AKUMA_REQUESTS,
    };
    Object.assign(process.env, {
      KEIYAKU_ACTOR_ID: "aku/not-the-caller/12345678",
      KEIYAKU_ACTOR_WORLD: world,
      AKUMA_REQUESTS: join(world, "unrelated-host-route"),
    });
    t.after(() => {
      for (const [key, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const called = await native("akuma_call", { akuma: "worker", body: command(holding(world, "first")) });
    assert.equal(called.kind, "called");
    assert.equal(called.observation.kind, "detached", "return without answer observation is independent of hosting");
    const id = called.akuma;
    await waitForCondition("native child bash", () => existsSync(join(world, "first.ready")));
    const status = await native("akuma_status", { akuma: id });
    assert.equal(status.status.life, "running");
    assert.deepEqual(status.status.birth.caller, { kind: "external", integration: "pi", id: host.session.sessionId });
    assert.equal((await native("akuma_list", { limit: 1 })).rows[0].id, id);
    assert.ok((await native("akuma_definitions", {})).rows.some((row: { name: string }) => row.name === "worker"));
    assert.equal((await native("akuma_wait", { akuma: [id], completion: "all", timeoutMs: 0 })).reason, "deadline");
    assert.equal((await api.status({ akuma: id })).status.life, "running");
    let waitStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const offWait = host.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "akuma_wait") waitStarted();
    });
    const canceledWait = host.invoke("akuma_wait", { akuma: [id] }, true);
    await started;
    await host.session.abort();
    await canceledWait;
    offWait();
    assert.equal(
      (await api.status({ akuma: id })).status.life,
      "running",
      "aborting a native wait only ends observation",
    );
    const busy = await host.invoke(
      "akuma_ask",
      { akuma: id, body: "schema while busy", schema: { type: "object" }, timeoutMs: 0 },
      true,
    );
    assert.match(JSON.stringify(busy), /busy|running/iu);
    const tell = await native("akuma_tell", { akuma: id, body: "additional live input", detach: true });
    assert.equal(tell.tell.admission.fact, "recorded");
    writeFileSync(join(world, "first.release"), "release");
    assert.equal((await native("akuma_wait", { akuma: [id], timeoutMs: 20_000 })).reason, "completed");
    assert.ok(
      events(world).every((event) => event.pid === process.pid),
      "live detached choice must not move the running Body",
    );
    const history = await native("akuma_history", { akuma: id });
    const at = history.history.rows.find((row: any) => row.kind === "outcome" && row.outcome.kind === "answered")
      .outcome.historyId;
    assert.equal((await native("akuma_history", { akuma: id, id: at })).kind, "exact");
    assert.equal(typeof (await native("akuma_history", { akuma: id, last: true })).answer, "string");
    assert.equal((await native("akuma_history", { akuma: id, since: 1, limit: 1 })).kind, "history");
    assert.equal((await native("akuma_fork", { akuma: id, at: "turn/99999" })).kind, "unknown-history");
    const fork = await native("akuma_fork", { akuma: id, at });
    assert.equal(fork.kind, "forked");
    assert.deepEqual((await api.status({ akuma: fork.child })).status.birth.caller, {
      kind: "external",
      integration: "pi",
      id: host.session.sessionId,
    });
    const answer = await native("akuma_ask", {
      akuma: fork.child,
      body: command("printf fork-answer"),
      timeoutMs: 20_000,
    });
    assert.equal(answer.observation.answer, "fork-answer", JSON.stringify(answer));
    const structured = await native("akuma_ask", {
      akuma: id,
      body: JSON.stringify({ answer: { ok: true } }),
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      timeoutMs: 20_000,
    });
    assert.deepEqual(structured.observation, { reason: "answered", answer: { ok: true } });
    await native("akuma_wait", { akuma: [id, fork.child], completion: "all", timeoutMs: 20_000 });
    assert.ok(
      events(world).every((event) => event.pid === process.pid),
      "ordinary native wake/fork must stay in the selected in-process host",
    );

    // The extension is actually discovered in the provider-owned child. Local
    // tools must refuse there; the existing CLI must still authenticate and deny.
    const nested = await native("akuma_ask", {
      akuma: id,
      body: JSON.stringify({
        tool: "nested-fixture",
        args: { name: "akuma_call", args: { akuma: "worker", body: "must not be born" } },
      }),
      timeoutMs: 20_000,
    });
    assert.match(nested.observation.answer, /request-aware keiyaku CLI/u);
    const denied = await native("akuma_ask", {
      akuma: id,
      body: command(
        [
          process.execPath,
          "--import",
          import.meta.resolve("tsx"),
          sourceCli,
          "-C",
          world,
          "call",
          "worker",
          "forbidden",
          "--json",
        ]
          .map(quote)
          .join(" ") + " 2>&1",
      ),
      timeoutMs: 20_000,
    });
    assert.match(denied.observation.answer, /not allowed|permission|refus/iu);
    assert.equal((await api.list()).rows.length, 3, "neither native bypass nor denied request may birth a child");

    // Tool schema validation is real Pi validation, before any owner mutation.
    await host.invoke("akuma_call", { akuma: "worker", body: "x", detach: "yes" }, true);
    const invalid = await host.invoke("akuma_call", { akuma: "worker", body: "x", timeoutMs: 0 }, true);
    assert.match(JSON.stringify(invalid), /requires wait/u);
    const deadlineCall = await native("akuma_call", {
      akuma: "worker",
      body: command(holding(world, "deadline")),
      wait: true,
      timeoutMs: 0,
    });
    assert.equal(deadlineCall.observation.observation.reason, "deadline");
    await waitForCondition("deadline work remains active", () => existsSync(join(world, "deadline.ready")));
    const killed = await native("akuma_kill", { akuma: [deadlineCall.akuma] });
    assert.equal(killed.results[0].evidence, "killed");

    const aborting = host.invoke(
      "akuma_call",
      { akuma: "worker", body: command(holding(world, "aborted")), wait: true },
      true,
    );
    await waitForCondition("call observation ready for abort", () => existsSync(join(world, "aborted.ready")));
    await host.session.abort();
    const aborted = await aborting;
    assert.equal(
      typeof aborted.structuredContent.akuma,
      "string",
      "aborted observation keeps its leading birth in structured error data",
    );
    assert.equal((await api.status({ akuma: aborted.structuredContent.akuma })).status.life, "running");
    await native("akuma_kill", { akuma: [aborted.structuredContent.akuma] });

    const detached = await native("akuma_call", {
      akuma: "worker",
      body: command(holding(world, "detached")),
      detach: true,
    });
    const scoped = await native("akuma_call", { akuma: "worker", body: command(holding(world, "scoped")) });
    // Wake the earlier identity through a different scope. The old Pi session
    // must not kill it just because it originally called this AkuId.
    const foreignScope = AkumaHost.inProcess();
    const foreign = Akuma.select(world, id, foreignScope);
    const asking = foreign.ask(command(holding(world, "foreign")), { signal: t.signal });
    try {
      await waitForCondition("all shutdown witnesses active", () =>
        ["detached", "scoped", "foreign"].every((name) => existsSync(join(world, `${name}.ready`))),
      );
      await host.close();
      assert.equal(
        (await api.status({ akuma: scoped.akuma })).status.life,
        "stranded",
        "scope retirement is an exact put-down, not an identity-wide kill witness",
      );
      assert.equal((await api.status({ akuma: detached.akuma })).status.life, "running");
      assert.equal((await foreign.status()).life, "running");
      const scopedSession = events(world)
        .filter((event) => event.event === "session_start" && event.pid === process.pid)
        .at(-2)?.session;
      assert.ok(scopedSession);
      assert.ok(
        events(world).some((event) => event.pid !== process.pid),
        "explicit detach uses a real detached Body",
      );
    } finally {
      for (const name of ["first", "deadline", "aborted", "detached", "scoped", "foreign"])
        writeFileSync(join(world, `${name}.release`), "release");
      await api.kill({ akuma: [detached.akuma, scoped.akuma] }).catch(() => undefined);
      await foreignScope.close();
      await asking.catch(() => undefined);
    }
  },
);
