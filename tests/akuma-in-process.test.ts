import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Akuma, AkumaHost, Akumas, World, type AkumaHostOptions, type WorldRoot } from "../src/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { probeLeash, readHeart, readTell, readTurn, readLatestTurnForBody } from "../src/akuma/heart/index.js";
import { temporaryDirectory, waitForCondition } from "./support/process.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const prompt = (script: string) => JSON.stringify({ command: script });

// A real Pi extension and local model: no network, SDK mocks, prototype patches,
// or replacement Body loop. The model calls native bash once, then returns its output.
const nativeExtension = `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export default function(pi) {
  pi.registerTool({ name: "stall", label: "Stall", description: "Fixture that ignores cancellation", parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _update, ctx) {
      const cwd = ctx.cwd, session = ctx.sessionManager.getSessionId();
      const log = event => appendFileSync(join(cwd, "native.jsonl"), JSON.stringify({ event, pid: process.pid, session }) + "\\n");
      log("stall-started");
      await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(cwd, "stall.release"))) { clearInterval(timer); resolve(); } }, 20); });
      log("stall-finished");
      return { content: [{ type: "text", text: "retired" }], details: undefined };
    },
  });
  for (const event of ["session_start", "session_shutdown"]) pi.on(event, (_event, ctx) => {
    let actor;
    pi.events.emit("keiyaku:actor:request", { reply: pair => { actor = pair; } });
    appendFileSync(join(ctx.cwd, "native.jsonl"), JSON.stringify({ event, actor, pid: process.pid, session: ctx.sessionManager.getSessionId() }) + "\\n");
  });
  pi.registerProvider("host-fixture", {
    baseUrl: "https://unused.invalid", api: "host-fixture", apiKey: "fixture",
    models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      let index = -1, command;
      for (let i = 0; i < context.messages.length; i++) {
        const message = context.messages[i];
        if (message.role !== "user") continue;
        const text = typeof message.content === "string" ? message.content : message.content.filter(x => x.type === "text").map(x => x.text).join("");
        try { const parsed = JSON.parse(text); if (typeof parsed.command === "string") { index = i; command = parsed.command; } } catch {}
      }
      const result = context.messages.slice(index + 1).filter(x => x.role === "toolResult").at(-1);
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: result ? [{ type: "text", text: result.content.filter(x => x.type === "text").map(x => x.text).join("") }]
          : [{ type: "toolCall", id: "bash-" + index, name: command === "stall" ? "stall" : "bash", arguments: command === "stall" ? {} : { command } }],
        stopReason: result ? "stop" : "toolUse", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    },
  });
}
`;

async function nativeWorld(t: TestContext, path = temporaryDirectory(t, "keiyaku-in-process-")): Promise<WorldRoot> {
  const world = await World.at(path);
  const agent = join(world, "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  writeFileSync(join(agent, "extensions", "fixture.js"), nativeExtension);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ["bash", "stall"] }),
  );
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(
    join(world, ".keiyaku", "akumas", "worker.md"),
    "---\nprovider: pi\nmodel: host-fixture/model\n---\nFixture.\n",
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
        paseo: { package: "@astrosheep/keiyaku-plugin-paseo", enabled: false },
      },
    }),
  );
  const environment = {
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SESSION_ID: "outer-session",
    KEIYAKU_ACTOR_ID: "aku/outer/12345678",
    KEIYAKU_ACTOR_WORLD: world,
    KEIYAKU_EXTERNAL_CALLER: "outer:caller",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return world;
}

function holdingCommand(world: string, name: string): string {
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(world, `${name}.ready`))}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(world, `${name}.release`))})) { clearInterval(timer); console.log(JSON.stringify({ actor: process.env.KEIYAKU_ACTOR_ID, world: process.env.KEIYAKU_ACTOR_WORLD, native: process.env.PI_SESSION_ID, external: process.env.KEIYAKU_EXTERNAL_CALLER })); } }, 20);`;
  return [process.execPath, "-e", script].map(quote).join(" ");
}

function nativeEvents(world: string): { event: string; pid: number; session: string; actor?: { world: string; akuId: string } }[] {
  return readFileSync(join(world, "native.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test(
  "public hosts run concurrent Pi Bodies in this Node, isolate kill, and leave deadline work alive",
  { timeout: 60_000 },
  async (t) => {
    const world = await nativeWorld(t);
    const host: { hosting: NonNullable<AkumaHostOptions["hosting"]> } = { hosting: "in-process" };
    const first = await Akuma.birth("worker", { root: world, cwd: world, host });
    const api = Akumas.of(world, host);
    host.hosting = "detached"; // Both public constructions captured the original choice.
    assert.ok(first instanceof Akuma);
    const before = { ...process.env };
    const firstAsk = first.tell(prompt(holdingCommand(world, "first")), { wait: true, signal: t.signal });
    const second = await api.spawn({
      akumaName: "worker",
      cwd: world,
      body: prompt(holdingCommand(world, "second")),
      mode: "wait",
      timeoutMs: 0,
      signal: t.signal,
    });
    try {
      assert.equal(second.input?.kind, "deadline");
      await waitForCondition(
        "both native tools to start",
        () => existsSync(join(world, "first.ready")) && existsSync(join(world, "second.ready")),
      );
      assert.equal(await first.kill({ signal: t.signal }), "killed");
      const stopped = await firstAsk;
      assert.ok("state" in stopped && stopped.state === "canceled");
      assert.equal((await api.status({ akuma: second.akumaId })).life, "running");
      const paths = pathsForAkumaId(world, second.akumaId);
      const running = await readLatestTurnForBody(paths, (await readHeart(paths)).latestBody!.sequence);
      assert.ok(running);
      const telling = await api.tell({ akuma: second.akumaId, body: "keep going", signal: t.signal });
      assert.ok("result" in telling && telling.result === "told");
      assert.equal((await readTell(paths, telling.tellId))?.body, "keep going");
      writeFileSync(join(world, "second.release"), "release");
      const secondHandle = Akuma.select(world, second.akumaId, { hosting: "in-process" });
      assert.ok(secondHandle instanceof Akuma);
      assert.equal((await secondHandle.idle({ timeoutMs: 20_000, signal: t.signal })).reason, "completed");
      assert.equal((await readHeart(paths)).pending.length, 0);
      assert.ok((await readTell(paths, telling.tellId))?.binding);
      const outcome = (await readTurn(paths, running.sequence))?.end?.outcome;
      assert.equal(outcome?.kind, "answered");
      if (outcome?.kind !== "answered") throw new Error("second Body lost its answer");
      const identity = JSON.parse(outcome.answer);
      assert.equal(identity.actor, second.akumaId);
      assert.equal(identity.world, world);
      assert.notEqual(identity.native, "outer-session");
      assert.equal(identity.external, undefined);
      const events = nativeEvents(world);
      assert.equal(new Set(events.map((event) => event.pid)).size, 1);
      assert.ok(events.every((event) => event.pid === process.pid));
      assert.equal(new Set(events.map((event) => event.session)).size, 2);
      assert.deepEqual(new Set(events.map(({ actor }) => actor?.akuId)), new Set([first.id, second.akumaId]));
      for (const { session, actor } of events) {
        assert.equal(actor?.world, world);
        assert.equal(actor?.akuId, events.find((event) => event.session === session)?.actor?.akuId);
      }
      const changed = [...new Set([...Object.keys(before), ...Object.keys(process.env)])].filter(
        (key) => before[key] !== process.env[key],
      );
      assert.deepEqual(changed, [], "Body setup and retirement must not mutate host declarations");
    } finally {
      writeFileSync(join(world, "first.release"), "release");
      writeFileSync(join(world, "second.release"), "release");
      await first.kill().catch(() => undefined);
      await firstAsk.catch(() => undefined);
      await Akuma.select(world, second.akumaId)
        .kill()
        .catch(() => undefined);
    }
  },
);

test(
  "a scoped host drains queued ACP work and awaits the same Body's end callback",
  { timeout: 30_000 },
  async (t) => {
    const world = await World.at(temporaryDirectory(t, "keiyaku-scope-queue-"));
    installHostAcpFixture(world);
    const scope = AkumaHost.inProcess();
    const api = Akumas.of(world, scope);
    const called = await api.spawn({ akumaName: "acp-worker", cwd: world, body: "first", bare: true, signal: t.signal });
    const paths = pathsForAkumaId(world, called.akumaId);
    const proof = () =>
      readFileSync(join(world, "host-proof.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    try {
      await waitForCondition("first ACP session", () => existsSync(join(world, "first.ready")));
      const before = (await readHeart(paths)).latestBody!.sequence;
      const telling = api.tell({ akuma: called.akumaId, body: "second", signal: t.signal });
      await waitForCondition("second Tell is admitted behind the first ACP Turn", async () =>
        (await readHeart(paths)).pending.some((tell) => tell.body === "second"),
      );
      writeFileSync(join(world, "first.release"), "release");
      await waitForCondition("second ACP Turn", () => existsSync(join(world, "second.ready")));
      const tell = await telling;
      assert.ok("result" in tell && tell.result === "told");
      const second = await readTell(paths, tell.tellId);
      assert.equal(second?.state, "told");
      assert.ok(second.binding);
      assert.equal((await readTurn(paths, second.binding.turnSequence))?.bodySequence, before);
      assert.equal((await readHeart(paths)).latestBody?.sequence, before);
      writeFileSync(join(world, "hold-body-end"), String(before));
      const closing = scope.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await waitForCondition("exact Body-end callback", () => existsSync(join(world, "body-end.ready")));
      assert.equal(closed, false, "scope must drain its enrolled Body, not just abort it");
      writeFileSync(join(world, "body-end.release"), "release");
      await closing;
      assert.equal(await probeLeash(paths), "free");
      const observations = proof();
      assert.equal(observations.filter((row) => row.kind === "akuma.turn-started").length, 2);
      assert.ok(observations.every((row) => row.pid === process.pid), "both Turns retain the invoking Body host");
    } finally {
      writeFileSync(join(world, "first.release"), "release");
      writeFileSync(join(world, "second.release"), "release");
      writeFileSync(join(world, "body-end.release"), "release");
      await scope.close();
    }
  },
);

test("public scope close races native setup without starting a late prompt", { timeout: 20_000 }, async (t) => {
  const world = await nativeWorld(t);
  writeFileSync(
    join(world, "agent/extensions/binding.js"),
    `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default pi => {
  pi.on("session_start", async (_event, ctx) => {
    writeFileSync(join(ctx.cwd, "binding.ready"), "ready");
    await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(ctx.cwd, "binding.release"))) { clearInterval(timer); resolve(); } }, 5); });
    writeFileSync(join(ctx.cwd, "binding.finished"), "finished");
  });
  pi.on("before_agent_start", (_event, ctx) => { writeFileSync(join(ctx.cwd, "late-prompt"), "unexpected"); });
};
`,
  );
  const scope = AkumaHost.inProcess();
  const api = Akumas.of(world, scope);
  const calling = api.spawn({
    akumaName: "worker",
    cwd: world,
    body: prompt("printf should-not-run"),
    signal: t.signal,
  });
  try {
    await waitForCondition("native binding to enter", () => existsSync(join(world, "binding.ready")));
    const close = scope.close();
    assert.equal(scope.close(), close, "close must retain one idempotent result");
    let done = false;
    void close.then(() => {
      done = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(done, false, "in-flight extension setup is still real custody");
    writeFileSync(join(world, "binding.release"), "release");
    await close;
    const called = await calling;
    assert.equal(called.kind, "failed");
    assert.ok(existsSync(join(world, "binding.finished")));
    assert.equal(existsSync(join(world, "late-prompt")), false);
    assert.equal(await probeLeash(pathsForAkumaId(world, called.akumaId)), "free");
    const retained = await api.tell({ akuma: called.akumaId, body: "retained, but no host launch" });
    assert.ok("result" in retained && retained.result === "failed");
    assert.match(retained.failures[0].diagnostic, /scope is closed/u);
    assert.ok(
      (await readHeart(pathsForAkumaId(world, called.akumaId))).pending.length > 0,
      "scope closure is not Tell rollback",
    );
  } finally {
    writeFileSync(join(world, "binding.release"), "release");
    await scope.close();
    await calling.catch(() => undefined);
  }
});

test(
  "scope close preserves exact hung launch evidence even after completion and holder release",
  { timeout: 30_000 },
  async (t) => {
    const world = await nativeWorld(t);
    const scope = AkumaHost.inProcess();
    const api = Akumas.of(world, scope);
    const called = await api.spawn({ akumaName: "worker", cwd: world, body: prompt("stall"), signal: t.signal });
    const paths = pathsForAkumaId(world, called.akumaId);
    try {
      await waitForCondition("noncooperative tool in scoped launch", () =>
        existsSync(join(world, "native.jsonl")) && nativeEvents(world).some((event) => event.event === "stall-started"),
      );
      assert.equal((await api.kill({ akuma: called.akumaId, signal: t.signal })).results[0]?.outcome, "hung");
      await waitForCondition("hung launch has ended and released its execution seat", async () =>
        (await probeLeash(paths)) === "free",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const close = scope.close();
      await assert.rejects(
        close,
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some((cause) => /hung provider custody/u.test(String(cause))),
      );
      assert.equal(scope.close(), close);
      assert.ok((await readHeart(paths)).latestBody?.hung);
      assert.equal((await api.status({ akuma: called.akumaId })).life, "hung");
      assert.equal(
        nativeEvents(world).some((event) => event.event === "stall-finished"),
        false,
        "scope close must not claim physical retirement",
      );
    } finally {
      writeFileSync(join(world, "stall.release"), "release");
      await waitForCondition("actual late native retirement", () =>
        nativeEvents(world).some((event) => event.event === "stall-finished"),
      );
      // A later physical finish cannot erase the original close failure.
      await assert.rejects(scope.close(), /retirement failed/u);
    }
  },
);
