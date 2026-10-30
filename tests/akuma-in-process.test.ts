import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Akuma, AkumaHost, Akumas, Keiyaku, Repo, World, type AkumaHostOptions, type WorldRoot } from "../src/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { initializeHeart, probeLeash, readHeart, readSeal, readLatestTurnForBody } from "../src/akuma/heart/index.js";
import { launchInProcessBody } from "../src/akuma/in-process-body.js";
import { publishAkuma } from "../src/akuma/publication.js";
import type { BodyLauncher, LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { fixtureAdapter } from "./support/akuma-tell.js";
import { deferred, temporaryDirectory, waitForCondition } from "./support/process.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

const cli = resolve("src/cli/index.ts");
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
    appendFileSync(join(ctx.cwd, "native.jsonl"), JSON.stringify({ event, pid: process.pid, session: ctx.sessionManager.getSessionId() }) + "\\n");
  });
  pi.on("before_agent_start", (event, ctx) => {
    appendFileSync(join(ctx.cwd, "runtime.jsonl"), JSON.stringify({ session: ctx.sessionManager.getSessionId(), prompt: event.systemPrompt }) + "\\n");
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
    AKUMA_REQUESTS: join(world, "outer-requests"),
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
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(world, `${name}.ready`))}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(world, `${name}.release`))})) { clearInterval(timer); console.log(JSON.stringify({ actor: process.env.KEIYAKU_ACTOR_ID, world: process.env.KEIYAKU_ACTOR_WORLD, requests: process.env.AKUMA_REQUESTS, native: process.env.PI_SESSION_ID, external: process.env.KEIYAKU_EXTERNAL_CALLER })); } }, 20);`;
  return [process.execPath, "-e", script].map(quote).join(" ");
}

function nativeEvents(world: string): { event: string; pid: number; session: string }[] {
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
    const firstAsk = first.ask(prompt(holdingCommand(world, "first")), { signal: t.signal });
    const second = await api.call({
      archetype: "worker",
      cwd: world,
      body: prompt(holdingCommand(world, "second")),
      mode: "wait",
      timeoutMs: 0,
      signal: t.signal,
    });
    try {
      assert.equal(second.observation.kind, "observed");
      if (second.observation.kind === "observed") assert.equal(second.observation.observation.reason, "deadline");
      await waitForCondition(
        "both native tools to start",
        () => existsSync(join(world, "first.ready")) && existsSync(join(world, "second.ready")),
      );
      assert.equal(await first.kill({ signal: t.signal }), "killed");
      assert.equal((await firstAsk).observation.reason, "unanswered");
      assert.equal((await api.status({ akuma: second.akuma })).status.life, "running");
      await api.tell({ akuma: second.akuma, body: "keep going", signal: t.signal });
      writeFileSync(join(world, "second.release"), "release");
      const secondHandle = Akuma.select(world, second.akuma, { hosting: "in-process" });
      assert.ok(secondHandle instanceof Akuma);
      assert.equal((await secondHandle.idle({ timeoutMs: 20_000, signal: t.signal })).reason, "completed");
      const heart = await readHeart(pathsForAkuId(world, second.akuma));
      assert.equal(heart.pending.length, 0);
      const outcome = (await readLatestTurnForBody(pathsForAkuId(world, second.akuma), heart.latestBody!.sequence))?.end
        ?.outcome;
      assert.equal(outcome?.kind, "answered");
      if (outcome?.kind !== "answered") throw new Error("second Body lost its answer");
      const identity = JSON.parse(outcome.answer);
      assert.equal(identity.actor, second.akuma);
      assert.equal(identity.world, world);
      assert.ok(identity.requests.startsWith(pathsForAkuId(world, second.akuma).requests));
      assert.notEqual(identity.native, "outer-session");
      assert.equal(identity.external, undefined);
      const selectedAnswer = await secondHandle.ask(prompt("printf selected-answer"), {
        timeoutMs: 20_000,
        signal: t.signal,
      });
      assert.equal(selectedAnswer.observation.reason, "answered");
      if (selectedAnswer.observation.reason === "answered")
        assert.equal(selectedAnswer.observation.answer, "selected-answer");
      const events = nativeEvents(world);
      assert.equal(new Set(events.map((event) => event.pid)).size, 1);
      assert.ok(events.every((event) => event.pid === process.pid));
      assert.equal(new Set(events.map((event) => event.session)).size, 2);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(process.env)])].filter(
        (key) => before[key] !== process.env[key],
      );
      assert.deepEqual(changed, [], "Body setup and retirement must not mutate host declarations");
    } finally {
      writeFileSync(join(world, "first.release"), "release");
      writeFileSync(join(world, "second.release"), "release");
      await first.kill().catch(() => undefined);
      await firstAsk.catch(() => undefined);
      await Akuma.select(world, second.akuma)
        .kill()
        .catch(() => undefined);
    }
  },
);

test("both public hosts preserve Contract runtime context and exact native report custody through wake", { timeout: 60_000 }, async (t) => {
  for (const hosting of ["in-process", "detached"] as const) {
    const repository = repositoryWithMain();
    const world = await nativeWorld(t, repository.path);
    const contract = accepted(await Keiyaku.with().bind({
      repo: await Repo.at({ path: world }), markdown: document(), target: null, gates: ["reviewed"],
    })).value.keiyaku;
    const contractId = present(await contract.state()).id;
    const host = { hosting };
    const api = Akumas.of(world, host);
    const reporting = (text: string, stale?: { bodySequence: number; turnSequence: number }) => {
      const script = `const { execFileSync } = require('node:child_process');
const args = ${JSON.stringify(["--import", import.meta.resolve("tsx"), cli, "report", text, "--json"])};
const run = env => { try { return JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' })); }
catch (error) { if (error.stdout) return JSON.parse(String(error.stdout)); throw error; } };
console.log(JSON.stringify({
  bodySequence: Number(process.env.KEIYAKU_BODY_SEQUENCE), turnSequence: Number(process.env.KEIYAKU_TURN_SEQUENCE),
  current: run(process.env),
  stale: ${stale === undefined ? "undefined" : `run({ ...process.env, KEIYAKU_BODY_SEQUENCE: '${stale.bodySequence}', KEIYAKU_TURN_SEQUENCE: '${stale.turnSequence}' })`}
}));`;
      return prompt([process.execPath, "-e", script].map(quote).join(" "));
    };
    const called = await api.call({
      archetype: "worker", cwd: world, contract, body: reporting("first report"),
      mode: "wait", timeoutMs: 20_000, signal: t.signal,
    });
    assert.equal(called.observation.kind, "observed");
    if (called.observation.kind !== "observed" || called.observation.observation.reason !== "answered")
      assert.fail(JSON.stringify(called));
    const first = JSON.parse(String(called.observation.observation.answer));
    assert.equal(first.current.kind, "recorded");
    assert.equal(first.current.report.bodySequence, first.bodySequence);
    assert.equal(first.current.report.turnSequence, first.turnSequence);
    const handle = Akuma.select(world, called.akuma, host);
    const next = await handle.ask(reporting("wake report", first), { timeoutMs: 20_000, signal: t.signal });
    if (next.observation.reason !== "answered") assert.fail(JSON.stringify(next));
    const resumed = JSON.parse(next.observation.answer);
    assert.ok(resumed.bodySequence > first.bodySequence);
    assert.ok(resumed.turnSequence > first.turnSequence);
    assert.equal(resumed.current.kind, "recorded");
    assert.deepEqual(resumed.stale, { kind: "refused", reason: "not-current-execution" });
    assert.deepEqual((await handle.history()).rows.filter(row => row.kind === "report").map(row => row.text),
      ["first report", "wake report"]);
    const runtime = () => readFileSync(join(world, "runtime.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { prompt: string });
    for (const { prompt: instructions } of runtime()) {
      assert.equal(instructions.split("<keiyaku>").length - 1, 1);
      assert.ok(instructions.includes(called.akuma));
      assert.ok(instructions.includes(`Contract context (not a Dispatch receipt): ${contractId}`));
      assert.ok(instructions.includes('Use `keiyaku report "..."`'));
    }
    const bare = await Akuma.birth("worker", { root: world, cwd: world, host, bare: true });
    const bareAnswer = await bare.ask(reporting("bare report"), { timeoutMs: 20_000, signal: t.signal });
    if (bareAnswer.observation.reason !== "answered") assert.fail(JSON.stringify(bareAnswer));
    assert.equal(JSON.parse(bareAnswer.observation.answer).current.kind, "recorded");
    assert.equal((await readHeart(pathsForAkuId(world, bare.id))).soul?.bare, true);
    assert.equal(runtime().at(-1)!.prompt.includes("<keiyaku>"), false);
    assert.ok(runtime().at(-1)!.prompt.includes("Fixture."), "bare preserves personality");
    assert.ok(nativeEvents(world).every(event => hosting === "in-process" ? event.pid === process.pid : event.pid !== process.pid));
  }
});

test(
  "an in-process Body serves child, selection, Debt, and Contract requests without inheriting hosting",
  { timeout: 60_000 },
  async (t) => {
    const repository = repositoryWithMain();
    const world = await nativeWorld(t, repository.path);
    const bound = accepted(
      await Keiyaku.with().bind({
        repo: await Repo.at({ path: world }),
        markdown: document(),
        target: null,
        gates: ["reviewed"],
      }),
    );
    const contract = bound.value.keiyaku;
    const id = present(await contract.state()).id;
    const parent = await Akuma.birth("worker", {
      root: world,
      cwd: world,
      host: { hosting: "in-process" },
      allowed: ["contract.review", "debt.add", "akuma.call"],
    });
    const script = join(world, "requests.mjs");
    writeFileSync(
      script,
      `import { execFileSync } from "node:child_process";
const cli = ${JSON.stringify(cli)}, world = ${JSON.stringify(world)};
const run = (...args) => JSON.parse(execFileSync(process.execPath, ["--import", ${JSON.stringify(import.meta.resolve("tsx"))}, cli, "-C", world, ...args, "--json"], { encoding: "utf8" }));
const who = run("whoami");
const debt = run("debt", "add", "Body request service");
const review = run("review", ${JSON.stringify(id)}, "--unsatisfied", "--summary", "fixture");
const child = run("call", "worker", ${JSON.stringify(prompt("printf child-answer"))});
const waited = run("wait", child.akuma, "--timeout", "20s");
console.log(JSON.stringify({ who, debt, review, child, waited }));
`,
    );
    const answer = await parent.ask(prompt([process.execPath, script].map(quote).join(" ")), {
      timeoutMs: 40_000,
      signal: t.signal,
    });
    assert.equal(answer.observation.reason, "answered", JSON.stringify(answer));
    if (answer.observation.reason !== "answered") return;
    const result = JSON.parse(answer.observation.answer);
    assert.equal(result.debt.kind, "accepted");
    assert.equal(result.review.kind, "accepted");
    assert.equal(result.child.observation.kind, "detached");
    assert.equal(result.waited.reason, "completed");
    const child = await readHeart(pathsForAkuId(world, result.child.akuma));
    assert.deepEqual(child.soul?.caller, { kind: "akuma", world, akuId: parent.id });
    assert.equal(present(await contract.state()).attestations.at(-1)?.actor, parent.id);
    const events = nativeEvents(world).filter((event) => event.event === "session_start");
    assert.ok(events.some((event) => event.pid === process.pid));
    assert.ok(
      events.some((event) => event.pid !== process.pid),
      "nested default call must retain a detached Body process",
    );
  },
);

test(
  "a noncooperative native Pi tool remains hung instead of certifying logical disposal as closure",
  { timeout: 20_000 },
  async (t) => {
    const world = await nativeWorld(t);
    const akuma = await Akuma.birth("worker", { root: world, cwd: world, host: { hosting: "in-process" } });
    const asking = akuma.ask(prompt("stall"), { signal: t.signal });
    try {
      await waitForCondition(
        "noncooperative native tool to start",
        () =>
          existsSync(join(world, "native.jsonl")) &&
          nativeEvents(world).some((event) => event.event === "stall-started"),
      );
      assert.equal(await akuma.kill({ signal: t.signal }), "hung");
      const paths = pathsForAkuId(world, akuma.id);
      assert.ok((await readHeart(paths)).latestBody?.hung);
      await waitForCondition("hung Body to release its leash", async () => (await probeLeash(paths)) === "free");
      assert.equal(
        nativeEvents(world).some((event) => event.event === "stall-finished"),
        false,
      );
      assert.equal((await asking).observation.reason, "failed");
    } finally {
      writeFileSync(join(world, "stall.release"), "release");
      await waitForCondition("native tool's actual retirement", () =>
        nativeEvents(world).some((event) => event.event === "stall-finished"),
      );
      await asking.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);

test("launch cancellation before preparation cannot create a late Body, and publication alone seals birth", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-in-process-preparation-"));
  const entered = deferred<void>();
  const preparation = deferred<void>();
  const controller = new AbortController();
  let allocated: Parameters<Parameters<typeof publishAkuma>[0]["launch"]>[0] | undefined;
  const birth = publishAkuma({
    worldPath: world,
    archetype: "worker",
    signal: controller.signal,
    launch: async (child) => {
      allocated = child;
      return await launchInProcessBody(
        {
          paths: child.paths,
          seed: {
            id: child.id,
            archetype: "worker",
            cwd: world,
            origin: { kind: "direct" },
            provider: { name: "pi", kind: "pi" },
            options: {},
            allowed: [],
          },
        },
        async () => {
          entered.resolve();
          await preparation.promise;
          return { world, externalCommands: {}, spawn: noBodyLaunch, requestSpawn: noBodyLaunch };
        },
      );
    },
  });
  await entered.promise;
  controller.abort(new Error("cancel unborn"));
  await assert.rejects(birth, /cancel unborn/u);
  preparation.resolve();
  assert.ok(allocated);
  assert.equal((await readHeart(allocated.paths)).soul, null);
  assert.equal((await readHeart(allocated.paths)).latestBody, null);
  assert.ok(await readSeal(allocated.paths));
  assert.equal(await probeLeash(allocated.paths), "free");
});

test("owned in-process cancellation retires only its own prepared Body", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-in-process-cancel-"));
  const first = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker" });
  const second = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker" });
  await Promise.all([initializeHeart(first.paths), initializeHeart(second.paths)]);
  const started = [deferred<void>(), deferred<void>()];
  const finished = [deferred<void>(), deferred<void>()];
  const adapter = fixtureAdapter(async (input) => {
    const index = input.body === "first" ? 0 : 1;
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: String(index) } };
          started[index]!.resolve();
          await finished[index]!.promise;
        },
      },
      completion: finished[index]!.promise.then(() => ({ kind: "answered" as const, answer: input.body })),
      resource: {
        abort: async () => {
          finished[index]!.resolve();
        },
      },
    };
  });
  const launches: LiveBodyLaunch[] = [];
  const spawn: BodyLauncher = async (launch) =>
    await launchInProcessBody(
      launch,
      async () => ({ world, externalCommands: {}, spawn, requestSpawn: noBodyLaunch }),
      adapter,
    );
  for (const [index, child] of [first, second].entries())
    launches.push(
      await spawn({
        paths: child.paths,
        seed: {
          id: child.id,
          archetype: "worker",
          cwd: world,
          origin: { kind: "direct" },
          provider: { name: "pi", kind: "pi" },
          options: {},
          allowed: [],
        },
        initialBody: index === 0 ? "first" : "second",
      }),
    );
  try {
    await Promise.all(started.map((item) => item.promise));
    await launches[0]!.cancel(true);
    assert.equal((await readHeart(first.paths)).latestBody?.end, "put-down");
    assert.equal(await probeLeash(first.paths), "free");
    assert.equal(await probeLeash(second.paths), "held");
    finished[1]!.resolve();
    await launches[1]!.completed;
    assert.equal((await readHeart(second.paths)).latestBody?.end, "exited");
  } finally {
    finished.forEach((item) => item.resolve());
    await Promise.all(launches.map((item) => item.cancel()));
  }
});

test(
  "parallel call observation abort retains each exact birth without canceling work",
  { timeout: 20_000 },
  async (t) => {
    const world = await nativeWorld(t);
    const scope = AkumaHost.inProcess();
    const api = Akumas.of(world, scope);
    const observation = new AbortController();
    const calls = ["left", "right"].map((name) =>
      api
        .call({
          archetype: "worker",
          cwd: world,
          body: prompt(holdingCommand(world, name)),
          mode: "wait",
          signal: observation.signal,
        })
        .catch((error: unknown) => error),
    );
    try {
      await waitForCondition("both call observations in progress", () =>
        ["left", "right"].every((name) => existsSync(join(world, `${name}.ready`))),
      );
      observation.abort(new Error("stop these observations"));
      const errors = await Promise.all(calls);
      const identities = errors.map((error) => {
        assert.ok(error instanceof Error && "akuma" in error && typeof error.akuma === "string");
        assert.match(error.message, /stop these observations/u);
        return error.akuma;
      });
      assert.equal(new Set(identities).size, 2);
      for (const id of identities) assert.equal((await api.status({ akuma: id })).status.life, "running");
    } finally {
      await scope.close();
      await Promise.all(calls);
    }
  },
);

test(
  "a scoped host owns automatic succession and awaits exact Body plugin callbacks",
  { timeout: 30_000 },
  async (t) => {
    const world = await World.at(temporaryDirectory(t, "keiyaku-scope-succession-"));
    installHostAcpFixture(world, true);
    const scope = AkumaHost.inProcess();
    const api = Akumas.of(world, scope);
    const called = await api.call({ archetype: "acp-worker", cwd: world, body: "first", bare: true, signal: t.signal });
    const paths = pathsForAkuId(world, called.akuma);
    const proof = () =>
      readFileSync(join(world, "host-proof.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    try {
      await waitForCondition("first ACP session", () => existsSync(join(world, "first.ready")));
      const before = (await readHeart(paths)).latestBody!.sequence;
      const tell = await api.tell({ akuma: called.akuma, body: "successor", signal: t.signal });
      assert.equal(tell.tell.admission.fact, "recorded");
      await waitForCondition("automatic successor ACP session", () => existsSync(join(world, "successor.ready")));
      assert.ok((await readHeart(paths)).latestBody!.sequence > before);
      // Let the predecessor finish its admission observation and relinquish its
      // launch holder, before scope close takes the live successor snapshot.
      await waitForCondition("predecessor Body-end observation", () =>
        proof().some((row) => row.kind === "akuma.body-ended" && row.body === before),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const closing = scope.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await waitForCondition("successor Body-end callback", () => existsSync(join(world, "successor-end.ready")));
      assert.equal(closed, false, "scope must drain the enrolled successor, not just abort it");
      writeFileSync(join(world, "successor-end.release"), "release");
      await closing;
      assert.equal(await probeLeash(paths), "free");
      const observations = proof();
      assert.ok(observations.filter((row) => row.kind === "akuma.turn-started").length >= 2);
      assert.ok(
        observations.every((row) => row.pid === process.pid),
        "non-Pi provider and succession must retain the invoking Body host",
      );
      assert.ok(
        observations.some((row) => row.kind === "akuma.body-ended" && row.body > before),
        "close awaits the successor's exact Body-end callback",
      );
    } finally {
      writeFileSync(join(world, "first.release"), "release");
      writeFileSync(join(world, "successor.release"), "release");
      writeFileSync(join(world, "successor-end.release"), "release");
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
  const called = await api.call({
    archetype: "worker",
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
    assert.ok(existsSync(join(world, "binding.finished")));
    assert.equal(existsSync(join(world, "late-prompt")), false);
    assert.equal(await probeLeash(pathsForAkuId(world, called.akuma)), "free");
    const retained = await api.tell({ akuma: called.akuma, body: "retained, but no host launch" });
    assert.equal(retained.tell.wake.kind, "failed");
    if (retained.tell.wake.kind === "failed") assert.match(retained.tell.wake.diagnostic, /scope is closed/u);
    assert.ok(
      (await readHeart(pathsForAkuId(world, called.akuma))).pending.length > 0,
      "scope closure is not Tell rollback",
    );
  } finally {
    writeFileSync(join(world, "binding.release"), "release");
    await scope.close();
  }
});

test(
  "scope close preserves exact hung launch evidence even after completion and holder release",
  { timeout: 30_000 },
  async (t) => {
    const world = await nativeWorld(t);
    for (const priorStop of [false, true]) {
      const scope = AkumaHost.inProcess();
      const api = Akumas.of(world, scope);
      const before = existsSync(join(world, "native.jsonl")) ? nativeEvents(world).length : 0;
      const called = await api.call({ archetype: "worker", cwd: world, body: prompt("stall"), signal: t.signal });
      const paths = pathsForAkuId(world, called.akuma);
      try {
        await waitForCondition(
          "noncooperative tool in scoped launch",
          () =>
            existsSync(join(world, "native.jsonl")) &&
            nativeEvents(world)
              .slice(before)
              .some((event) => event.event === "stall-started"),
        );
        if (priorStop) {
          assert.equal((await api.kill({ akuma: [called.akuma], signal: t.signal })).results[0]?.evidence, "hung");
          await waitForCondition(
            "hung launch has ended and released its execution seat",
            async () => (await probeLeash(paths)) === "free",
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const close = scope.close();
        await assert.rejects(
          close,
          (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.some((cause) => /hung provider custody/u.test(String(cause))),
        );
        assert.equal(scope.close(), close);
        assert.ok((await readHeart(paths)).latestBody?.hung);
        assert.equal((await api.status({ akuma: called.akuma })).status.life, "hung");
        assert.equal(
          nativeEvents(world)
            .slice(before)
            .some((event) => event.event === "stall-finished"),
          false,
          "scope close must not claim physical retirement",
        );
      } finally {
        writeFileSync(join(world, "stall.release"), "release");
        await waitForCondition("actual late native retirement", () =>
          nativeEvents(world)
            .slice(before)
            .some((event) => event.event === "stall-finished"),
        );
        // A later physical finish cannot erase the original close failure.
        await assert.rejects(scope.close(), /retirement failed/u);
        const { unlinkSync } = await import("node:fs");
        unlinkSync(join(world, "stall.release"));
      }
    }
  },
);
