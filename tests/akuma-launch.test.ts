import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { Akuma } from "../src/akuma/index.js";
import { readHeart } from "../src/akuma/heart/index.js";
import { runProcess } from "../src/runtime/proc/run.js";
import { appendNodeOptionsImport, temporaryDirectory } from "./support/process.js";
import { bornWorld } from "./support/akuma-tell.js";
import { pathToFileURL } from "node:url";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { localExecutionContext } from "../src/akuma/requests.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLaunch, BodyLauncher } from "../src/akuma/body-launch.js";
import { requestForwardedAkumaCall } from "../src/akuma/call-request.js";
import { fixtureAdapter, fixtureAttempt } from "./support/akuma-tell.js";
import type { DriveInput, ProviderAdapter } from "../src/akuma/provider.js";
import { deferred } from "./support/process.js";
import { World } from "../src/world.js";

test("one composed launcher reaches birth, first Tell, and nested birth plus schema Tell", async (context) => {
  const world = await World.at(temporaryDirectory(context, "keiyaku-launch-propagation-"));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const launches: BodyLaunch[] = [];
  const bodies: Promise<unknown>[] = [];
  const submissions: string[] = [];
  let nestedId: string | undefined;
  const adapter = fixtureAdapter(async (input) => {
    const text = input.launchTells[0]!.text;
    submissions.push(text);
    const answer = deferred<string>();
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: `session-${text}` } };
          if (text === "parent") {
            const child = await requestForwardedAkumaCall({
              directory: input.requests!.dir, id: "00000000-0000-4000-8000-000000000001", world, archetype: "worker",
              recipe: { provider: { name: "claude", kind: "claude-agent-sdk" }, options: {}, allowed: [] },
              initialTell: { tellId: "nested-tell", body: "child", schemaJson: '{"type":"object"}' },
            });
            assert.equal(child.kind, "live");
            if (child.kind !== "live") throw new Error("nested call lost its live receipt");
            nestedId = child.id;
            assert.equal(child.tell?.admission.tellId, "nested-tell");
            assert.equal(child.tellFailure, undefined);
            answer.resolve("parent answer");
          } else {
            assert.equal(input.schemaJson, '{"type":"object"}');
            answer.resolve('{"ok":true}');
          }
        },
      },
      completion: answer.promise.then((value) => ({ kind: "answered" as const, answer: value })),
      resource: { abort: async () => { answer.resolve("canceled"); } },
    };
  });
  const spawn: BodyLauncher = async (launch) => {
    launches.push(launch);
    const body = driveAkumaBody(launch, adapter, { spawn, requestSpawn: spawn, world });
    bodies.push(body);
    return {
      completed: body.then((result) => ({ diagnostic: "fixture launch completed", held: result === "held" })),
      async cancel() { throw new Error("confirmed launches must not be canceled"); },
      release() {},
    };
  };
  try {
    const result = await akumasWithLauncher(world, localExecutionContext(), spawn).call({
      archetype: "worker", body: "parent", mode: "wait", signal: context.signal,
    });
    assert.equal(result.observation.kind, "observed");
    if (result.observation.kind === "observed")
      assert.deepEqual(result.observation.observation, { reason: "answered", answer: "parent answer" });
    await Promise.all(bodies);
    assert.deepEqual(submissions, ["parent", "child"], "births submit no provider prompt");
    assert.equal(launches.length, 4);
    assert.deepEqual(launches.map((launch) => launch.seed?.origin.kind ?? "wake"), ["direct", "wake", "request", "wake"]);
    assert.equal(launches[0]!.paths.directory, launches[1]!.paths.directory);
    assert.equal(launches[2]!.paths.directory, launches[3]!.paths.directory);
    assert.notEqual(launches[0]!.paths.directory, launches[2]!.paths.directory);
    assert.equal(launches[2]!.seed?.id, nestedId);
    const child = await readHeart(launches[2]!.paths);
    assert.deepEqual(child.soul?.allowed, []);
    assert.equal(child.latestBody?.end, "exited");
    assert.equal(child.pending.length, 0);
  } finally {
    await Promise.all(bodies);
  }
});

test("the composed launcher also owns ordinary wake and authorized succession", async (context) => {
  const world = await World.at(temporaryDirectory(context, "keiyaku-launch-succession-"));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const started = deferred<void>();
  const retired = deferred<void>();
  const launches: BodyLaunch[] = [];
  const bodies: Promise<unknown>[] = [];
  const inputs: string[] = [];
  const drive = (input: DriveInput) => fixtureAttempt(input, async () => {
    const text = input.launchTells[0]!.text;
    inputs.push(text);
    const finished = text === "first" ? retired.promise : Promise.resolve();
    return {
      events: { async *[Symbol.asyncIterator]() {
        yield { type: "session" as const, coordinate: { sessionId: "succession-session" } };
        if (text === "first") started.resolve();
        await finished;
      } },
      completion: finished.then(() => ({ kind: "answered" as const, answer: text })),
      resource: { abort: async () => { retired.resolve(); } },
    };
  });
  const adapter: ProviderAdapter = { admitOptions: (options) => ({ kind: "admitted", options }), start: drive, resume: drive };
  const spawn: BodyLauncher = async (launch) => {
    launches.push(launch);
    const body = driveAkumaBody(launch, adapter, { spawn, requestSpawn: spawn, world });
    bodies.push(body);
    return { completed: body.then((result) => ({ diagnostic: "fixture launch completed", held: result === "held" })),
      async cancel() {}, release() {} };
  };
  try {
    const api = akumasWithLauncher(world, localExecutionContext(), spawn);
    const result = await api.call({ archetype: "worker", body: "first", signal: context.signal });
    await started.promise;
    const next = await api.ask({ akuma: result.akuma, body: "second", signal: context.signal });
    assert.deepEqual(next.observation, { reason: "answered", answer: "second" });
    await Promise.all(bodies);
    assert.deepEqual(inputs, ["first", "second"]);
    const handoffs = launches.filter((launch) => launch.handoffFromBodySequence !== undefined);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]!.handoffFromBodySequence, 2);
    const heart = await readHeart(handoffs[0]!.paths);
    assert.equal(heart.latestBody?.end, "exited");
    assert.equal(heart.pending.length, 0);
  } finally {
    retired.resolve();
    await Promise.all(bodies);
  }
});

// No OS coordinate or native-exit-shaped fixture: completion is not Heart evidence.
test("a neutral launch completion cannot prove Tell delivery or Body settlement", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-neutral-launch-");
  const { world, allocated } = await bornWorld(root, "b0000001");
  const result = await new AkumaOwner(allocated.id, world).tell("pending", "neutral-tell", undefined, {
    async spawn() {
      return {
        completed: Promise.resolve({ diagnostic: "launch completed without durable progress" }),
        async cancel() {
          throw new Error("completed launch must not be canceled");
        },
        release() {},
      };
    },
  });
  assert.deepEqual(result.wake, { kind: "failed", diagnostic: "launch completed without durable progress" });
  const heart = await readHeart(allocated.paths);
  assert.equal(heart.latestBody, null);
  assert.deepEqual(
    heart.pending.map((tell) => tell.id),
    ["neutral-tell"],
  );
});

test("detached wake retains native exit, signal, and bounded log evidence", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-detached-launch-evidence-");
  const priorOptions = process.env.NODE_OPTIONS;
  const cases = [
    { action: "process.exit(7)", code: 7, signal: null, status: "exit 7" },
    ...(process.platform === "win32"
      ? []
      : [{ action: 'process.kill(process.pid, "SIGTERM")', code: null, signal: "SIGTERM", status: "signal SIGTERM" }]),
  ];
  try {
    for (const [index, scenario] of cases.entries()) {
      const cwd = join(root, String(index));
      mkdirSync(cwd);
      const { world, allocated } = await bornWorld(cwd, `b000000${index + 2}`);
      const preload = join(cwd, "exit.mjs");
      writeFileSync(
        preload,
        `if (process.argv.some(arg => /akuma-body\\.[jt]s$/u.test(arg))) { ${scenario.action}; }\n`,
      );
      process.env.NODE_OPTIONS = appendNodeOptionsImport(pathToFileURL(preload).href, priorOptions ?? "");
      writeFileSync(allocated.paths.log, "prior log\n");
      const { tell: result } = await Akuma.select(world, allocated.id).tell("pending");
      assert.equal(result.wake.kind, "failed");
      if (result.wake.kind !== "failed" || !("child" in result.wake)) throw new Error("missing detached evidence");
      assert.equal(result.wake.diagnostic, `pre-admission ${scenario.status}`);
      const log = readFileSync(allocated.paths.log);
      assert.deepEqual(result.wake.child, {
        code: scenario.code,
        signal: scenario.signal,
        log: { path: allocated.paths.log, from: Buffer.byteLength("prior log\n"), to: log.byteLength },
      });
      assert.match(log.toString(), new RegExp(`\\[child ${scenario.status}\\]\\n$`, "u"));
      assert.deepEqual(
        (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
        [result.admission.tellId],
      );
    }
  } finally {
    if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorOptions;
  }
});

test(
  "released detached birth completion stays handled while exit-evidence rejection remains observable",
  {
    skip: process.platform === "win32" && "Windows inherited log handles cannot be unlinked while alive",
  },
  async (context) => {
    const root = temporaryDirectory(context, "keiyaku-detached-launch-rejection-");
    const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { World } from ${module("../src/world.js")};
    import { publishAkuma } from ${module("../src/akuma/publication.js")};
    import { spawnAkumaBody } from ${module("../src/akuma/detached-body.js")};
    import { readSoul } from ${module("../src/akuma/heart/index.js")};
    import { installAkumaBodyEmptyPublicationBarrier, waitForFixtureFile, waitForProcessExit } from ${module("./support/process.js")};
    const root = ${JSON.stringify(root)};
    const world = await World.at(root);
    mkdirSync(join(root, ".keiyaku"), { recursive: true });
    writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
    const barrier = join(root, "barrier");
    mkdirSync(barrier);
    installAkumaBodyEmptyPublicationBarrier(barrier);
    let launch;
    const child = await publishAkuma({ worldPath: world, archetype: "worker", launch: async (allocated) => {
      launch = await spawnAkumaBody({ paths: allocated.paths, seed: {
        id: allocated.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {}, cwd: world, origin: { kind: "direct" }, allowed: [],
      } });
      await waitForFixtureFile(join(barrier, "ready"));
      return launch;
    } });
    assert.equal((await readSoul(child.paths)).id, child.id);
    const { pid } = JSON.parse(readFileSync(join(barrier, "ready"), "utf8"));
    unlinkSync(child.paths.log);
    writeFileSync(join(barrier, "release"), "release");
    await waitForProcessExit(pid, 15000);
    // Deliberately leave the derived completion unobserved across rejection reporting.
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(launch.completed, /pre-admission exit 0: run-log evidence unavailable/u);
    console.log("handled and observable");
  `;
    const result = await runProcess({
      argv: [
        process.execPath,
        ...(import.meta.url.endsWith(".js") ? [] : ["--import", "tsx"]),
        "--unhandled-rejections=strict",
        "--input-type=module",
        "-e",
        script,
      ],
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    assert.equal(result.kind, "terminal", JSON.stringify(result));
    if (result.kind !== "terminal") return;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "handled and observable\n");
  },
);
