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
const toolNames = ["spawn", "status", "list", "definitions", "tell", "ask", "wait", "history", "fork", "kill"].map(
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
  // Exercise the unfinished implementation explicitly, not the shipped hidden loadout.
  const developmentExtension = join(agent, "native-tools.ts");
  writeFileSync(developmentExtension,
    `import { registerAkumaTools } from ${JSON.stringify(join(root, "build/plugins/pi/akuma-tools.ts"))};\nexport default pi => registerAkumaTools(pi, "direct");\n`);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ extensions: [developmentExtension], compaction: { enabled: false }, retry: { enabled: false } }),
  );
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(
    join(world, ".keiyaku", "akumas", "worker.md"),
    "---\nprovider: pi\nmodel: native-fixture/model\n---\nFixture.\n",
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

async function hostAt(t: TestContext, world: string, agent: string, development = true) {
  const extensionPath = development ? join(agent, "native-tools.ts") : shippedExtension;
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
      additionalExtensionPaths: [extensionPath, join(agent, "extensions", "fixture.js")],
    },
  });
  const extensions = services.resourceLoader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  const loaded = extensions.extensions.find((extension) => extension.resolvedPath === extensionPath);
  assert.ok(loaded);
  if (!development) assert.ok(loaded.commands.has("keiyaku"));
  assert.deepEqual([...loaded.tools.keys()].sort(), [...toolNames].sort());
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

test("the shipped Pi entry keeps native tools hidden even when explicitly selected", async (t) => {
  const { world, agent } = await fixtureWorld(t);
  const host = await hostAt(t, world, agent, false);
  const tools = host.session.getAllTools().filter((tool) => toolNames.includes(tool.name));
  assert.equal(tools.length, toolNames.length);
  assert.ok(tools.every((tool) => tool.exposure === "hidden"));
  assert.ok(host.session.getActiveToolNames().every((name) => !toolNames.includes(name)));
  await host.close();
});

test(
  "development Pi tools use local SDK owners, host wake/fork explicitly, and preserve observation boundaries",
  { timeout: 90_000 },
  async (t) => {
    const { world, agent } = await fixtureWorld(t);
    const host = await hostAt(t, world, agent);
    const native = async (name: string, args: Record<string, unknown>) => (await host.invoke(name, args)).details;
    const api = Akumas.of(world);
    installHostAcpFixture(world);
    const nonPi = await native("akuma_spawn", {
      akumaName: "acp-worker",
      body: "ordinary provider",
      bare: true,
      writableDirectories: [],
      wait: true,
      timeoutMs: 20_000,
    });
    assert.equal(nonPi.input?.kind, "answered", JSON.stringify(nonPi));
    assert.equal(nonPi.input.answer, "acp-answer", JSON.stringify(nonPi));
    const unsupported = await host.invoke("akuma_spawn", {
      akumaName: "worker", body: "must not start", writableDirectories: [world],
    }, true);
    assert.match(JSON.stringify(unsupported), /writableDirectories.*pi|pi.*writableDirectories/u);
    const ambient = {
      KEIYAKU_ACTOR_ID: process.env.KEIYAKU_ACTOR_ID,
      KEIYAKU_ACTOR_WORLD: process.env.KEIYAKU_ACTOR_WORLD,
    };
    Object.assign(process.env, {
      KEIYAKU_ACTOR_ID: "aku/not-the-caller/12345678",
      KEIYAKU_ACTOR_WORLD: world,
    });
    t.after(() => {
      for (const [key, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const called = await native("akuma_spawn", { akumaName: "worker", body: command(holding(world, "first")) });
    assert.equal(typeof called.tellId, "string", "the spawn receipt names the initial Tell it admitted");
    assert.equal(called.input, undefined, "return without answer observation is independent of hosting");
    const id = called.akumaId;
    await waitForCondition("native child bash", () => existsSync(join(world, "first.ready")));
    const status = await native("akuma_status", { akuma: id });
    assert.equal(status.life, "running");
    const report = await Akuma.select(world, id).report("Pi exact report\n");
    assert.equal(report.kind, "recorded");
    if (report.kind !== "recorded") assert.fail("report refused");
    const exactReport = await native("akuma_history", { akuma: id, id: report.reportId });
    assert.equal(exactReport.kind, "akuma-report");
    assert.equal(`report/${exactReport.sequence}`, report.reportId);
    assert.equal(exactReport.text, "Pi exact report\n");
    assert.deepEqual((await Akuma.select(world, id).status()).birth.caller, {
      kind: "external", integration: "pi", id: host.session.sessionId,
    });
    assert.equal((await native("akuma_list", { limit: 1 })).rows[0].id, id);
    assert.ok((await native("akuma_definitions", {})).rows.some((row: { name: string }) => row.name === "worker"));
    assert.equal((await native("akuma_wait", { akuma: [id], completion: "all", timeoutMs: 0 })).reason, "deadline");
    assert.equal((await api.status({ akuma: id })).life, "running");
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
      (await api.status({ akuma: id })).life,
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
    assert.equal(tell.akumaId, id);
    assert.equal(typeof tell.tellId, "string", "the native Tell receipt is one flat admission, not a history row");
    writeFileSync(join(world, "first.release"), "release");
    assert.equal((await native("akuma_wait", { akuma: [id], timeoutMs: 20_000 })).reason, "completed");
    assert.ok(
      events(world).every((event) => event.pid === process.pid),
      "live detached choice must not move the running Body",
    );
    const history = await native("akuma_history", { akuma: id });
    assert.equal(history.kind, "akuma");
    assert.equal(history.akumaId, id);
    const at = `turn/${history.events.find((row: any) => row.kind === "outcome" && row.outcome.kind === "answered")
      .turnSequence}`;
    assert.equal((await native("akuma_history", { akuma: id, id: at })).kind, "akuma-exact");
    assert.equal(typeof (await native("akuma_history", { akuma: id, last: true })).answer, "string");
    assert.equal((await native("akuma_history", { akuma: id, since: 1, limit: 1 })).kind, "akuma");
    assert.equal((await native("akuma_fork", { akuma: id, at: "turn/99999" })).kind, "unknown-history");
    const fork = await native("akuma_fork", { akuma: id, at });
    assert.equal(fork.kind, "forked");
    assert.deepEqual((await Akuma.select(world, fork.childAkumaId).status()).birth.caller, {
      kind: "external",
      integration: "pi",
      id: host.session.sessionId,
    });
    const answer = await native("akuma_tell", {
      akuma: fork.childAkumaId,
      wait: true,
      body: command("printf fork-answer"),
      timeoutMs: 20_000,
    });
    assert.equal(answer.input.kind, "answered");
    assert.equal(answer.input.answer, "fork-answer", JSON.stringify(answer));
    const structured = await native("akuma_ask", {
      akuma: id,
      body: JSON.stringify({ answer: { ok: true } }),
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      timeoutMs: 20_000,
    });
    assert.deepEqual({ kind: structured.kind, answer: structured.answer }, { kind: "answered", answer: { ok: true } });
    await native("akuma_wait", { akuma: [id, fork.childAkumaId], completion: "all", timeoutMs: 20_000 });
    assert.ok(
      events(world).every((event) => event.pid === process.pid),
      "ordinary native wake/fork must stay in the selected in-process host",
    );

    // The provider-owned Pi session invokes the real local SDK through a nested
    // native tool, and its bash child invokes the same local owners through CLI.
    const nested = await native("akuma_tell", {
      wait: true,
      akuma: id,
      body: JSON.stringify({
        tool: "nested-fixture",
        args: { name: "akuma_spawn", args: { akumaName: "worker", body: "nested child", wait: true, timeoutMs: 20_000 } },
      }),
      timeoutMs: 20_000,
    });
    const nestedBirth = JSON.parse(nested.input.answer);
    assert.equal(nestedBirth.input.kind, "answered");
    assert.equal(nestedBirth.input.answer, "ack:nested child");
    assert.deepEqual((await Akuma.select(world, nestedBirth.akumaId).status()).birth.caller, {
      kind: "external", integration: "pi", id: events(world).find(event => event.event === "session_start" && event.session !== host.session.sessionId)?.session,
    });
    const local = await native("akuma_tell", {
      wait: true,
      akuma: id,
      body: command(
        [
          process.execPath,
          "--import",
          import.meta.resolve("tsx"),
          sourceCli,
          "-C",
          world,
          "spawn",
          "worker",
          "local child",
          "--wait",
          "20s",
          "--json",
        ]
          .map(quote)
          .join(" ") + ` 2>${quote(join(world, "local-cli.log"))}`,
      ),
      timeoutMs: 30_000,
    });
    const localBirth = JSON.parse(local.input.answer);
    assert.equal(localBirth.input.kind, "answered");
    assert.equal(localBirth.input.answer, "ack:local child");
    assert.deepEqual((await Akuma.select(world, localBirth.akumaId).status()).birth.caller, {
      kind: "akuma", akumaId: id, world,
    });
    assert.equal((await api.list()).rows?.length, 5);

    // Tool schema validation is real Pi validation, before any owner mutation.
    await host.invoke("akuma_spawn", { akumaName: "worker", body: "x", detach: "yes" }, true);
    const invalid = await host.invoke("akuma_spawn", { akumaName: "worker", body: "x", timeoutMs: 0 }, true);
    assert.match(JSON.stringify(invalid), /requires wait/u);
    const deadlineCall = await native("akuma_spawn", {
      akumaName: "worker",
      body: command(holding(world, "deadline")),
      wait: true,
      timeoutMs: 0,
    });
    assert.equal(deadlineCall.input.kind, "deadline");
    await waitForCondition("deadline work remains active", () => existsSync(join(world, "deadline.ready")));
    const killed = await native("akuma_kill", { akuma: [deadlineCall.akumaId] });
    assert.equal(killed.results[0].outcome, "killed");

    const aborting = host.invoke(
      "akuma_spawn",
      { akumaName: "worker", body: command(holding(world, "aborted")), wait: true },
      true,
    );
    await waitForCondition("call observation ready for abort", () => existsSync(join(world, "aborted.ready")));
    await host.session.abort();
    const aborted = await aborting;
    assert.equal(aborted.structuredContent.kind, "failed");
    assert.equal(aborted.structuredContent.category, "aborted");
    assert.equal(aborted.structuredContent.causeClass, "AbortError");
    assert.equal(typeof aborted.structuredContent.diagnostic, "string");
    assert.equal(
      typeof aborted.structuredContent.spawn.akumaId,
      "string",
      "aborted observation keeps its leading birth in structured error data",
    );
    assert.equal((await api.status({ akuma: aborted.structuredContent.spawn.akumaId })).life, "running");
    await native("akuma_kill", { akuma: [aborted.structuredContent.spawn.akumaId] });

    const detached = await native("akuma_spawn", {
      akumaName: "worker",
      body: command(holding(world, "detached")),
      detach: true,
    });
    const scoped = await native("akuma_spawn", { akumaName: "worker", body: command(holding(world, "scoped")) });
    // Wake the earlier identity through a different scope. The old Pi session
    // must not kill it just because it originally called this AkumaId.
    const foreignScope = AkumaHost.inProcess();
    const foreign = Akuma.select(world, id, foreignScope);
    const asking = foreign.tell(command(holding(world, "foreign")), { wait: true, signal: t.signal });
    try {
      await waitForCondition("all shutdown witnesses active", () =>
        ["detached", "scoped", "foreign"].every((name) => existsSync(join(world, `${name}.ready`))),
      );
      await host.close();
      assert.equal(
        (await api.status({ akuma: scoped.akumaId })).life,
        "stranded",
        "scope retirement is an exact put-down, not an identity-wide kill witness",
      );
      assert.equal((await api.status({ akuma: detached.akumaId })).life, "running");
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
      await api.kill({ akuma: [detached.akumaId, scoped.akumaId] }).catch(() => undefined);
      await foreignScope.close();
      await asking.catch(() => undefined);
    }
  },
);
