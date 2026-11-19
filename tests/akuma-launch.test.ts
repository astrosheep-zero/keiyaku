import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { Akuma } from "../src/akuma/index.js";
import { readHeart, readTell, readTurn, recordTell, recordTellReceipt } from "../src/akuma/heart/index.js";
import { runProcess } from "../src/runtime/proc/run.js";
import { appendNodeOptionsImport, temporaryDirectory, waitForCondition } from "./support/process.js";
import { bornWorld, settledInput } from "./support/akuma-tell.js";
import { pathToFileURL } from "node:url";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLaunch, BodyLauncher } from "../src/akuma/body-launch.js";
import { fixtureAdapter } from "./support/akuma-tell.js";
import { createProviderAttempt, type DriveInput } from "../src/akuma/provider.js";
import { deferred } from "./support/process.js";
import { World } from "../src/world.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("one composed launcher reaches birth, first Tell, and nested birth plus structured ask", async (context) => {
  const world = await World.at(temporaryDirectory(context, "keiyaku-launch-propagation-"));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const launches: BodyLaunch[] = [];
  const bodies: Promise<unknown>[] = [];
  const submissions: string[] = [];
  let nestedId: string | undefined;
  const adapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    const text = input.launchTells[0]!.text;
    submissions.push(text);
    const answer = deferred<string>();
    const abort = async () => { answer.resolve("canceled"); };
    custody.own({ closed: answer.promise.then(() => undefined), abort, forceDispose: abort });
    return {
      admission: { fence: `launch-${text}` },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: `session-${text}` } };
          if (text === "parent") {
            const child = await akumasWithLauncher(world, spawn).spawn({
              akumaName: "worker",

              caller: {
                kind: "akuma",
                world,
                akumaId: input.execution!.akumaId as NonNullable<BodyLaunch["seed"]>["id"],
              },
              signal: context.signal,
            });
            nestedId = child.akumaId;
            await akumasWithLauncher(world, spawn).wait({ akuma: [child.akumaId], signal: context.signal });
            const result = await akumasWithLauncher(world, spawn).ask({ akuma: child.akumaId, body: "child", schema: { type: "object" }, signal: context.signal });
            assert.equal(result.kind, "answered");
            if (result.kind === "answered") assert.deepEqual(result.answer, { ok: true });
            answer.resolve("parent answer");
          } else {
            assert.equal(input.schemaJson, '{"type":"object"}');
            answer.resolve('{"ok":true}');
          }
        },
      },
      completion: answer.promise.then((value) => ({ kind: "answered" as const, answer: value })),
    };
  }));
  const spawn: BodyLauncher = async (launch) => {
    launches.push(launch);
    const body = driveAkumaBody(launch, adapter);
    bodies.push(body);
    return {
      completed: body.then((result) => ({ diagnostic: "fixture launch completed", held: result === "held" })),
      async cancel() {
        throw new Error("confirmed launches must not be canceled");
      },
      release() {},
    };
  };
  try {
    const result = await akumasWithLauncher(world, spawn).spawn({
      akumaName: "worker",
      body: "parent",
      mode: "wait",
      signal: context.signal,
    });
    assert.equal(result.input?.kind, "answered");
    assert.deepEqual(settledInput(result.input), { kind: "answered", answer: "parent answer" });
    await Promise.all(bodies);
    assert.deepEqual(submissions, ["parent", "child"], "births submit no provider prompt");
    assert.equal(launches.length, 4);
    assert.deepEqual(
      launches.map((launch) => launch.seed?.origin.kind ?? "wake"),
      ["direct", "wake", "direct", "wake"],
    );
    assert.equal(launches[0]!.paths.directory, launches[1]!.paths.directory);
    assert.equal(launches[2]!.paths.directory, launches[3]!.paths.directory);
    assert.notEqual(launches[0]!.paths.directory, launches[2]!.paths.directory);
    assert.equal(launches[2]!.seed?.id, nestedId);
    const child = await readHeart(launches[2]!.paths);
    assert.deepEqual(child.soul?.caller, { kind: "akuma", world, akumaId: launches[0]!.seed!.id });
    assert.equal(child.latestBody?.end, "exited");
    assert.equal(child.pending.length, 0);
  } finally {
    await Promise.all(bodies);
  }
});

test("an ordinary Tell waits for provider closure and drains under the same Body", { timeout: 10_000 }, async (context) => {
  const world = await World.at(temporaryDirectory(context, "keiyaku-launch-queue-"));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const started = deferred<void>();
  const answer = deferred<void>();
  const closed = deferred<void>();
  const launches: BodyLaunch[] = [];
  const bodies: Promise<unknown>[] = [];
  const inputs: string[][] = [];
  let firstClosed = false;
  let aborts = 0;
  const drive = (input: DriveInput) => createProviderAttempt(input.signal, async (custody) => {
    const texts = input.launchTells.map((tell) => tell.text);
    inputs.push(texts);
    const text = texts[0]!;
    const first = text === "first";
    if (!first) assert.equal(firstClosed, true, "next Turn must follow provider closure");
    const abort = async () => {
      aborts += 1;
      answer.resolve();
      closed.resolve();
    };
    custody.own({ closed: first ? closed.promise : Promise.resolve(), abort, forceDispose: abort });
    return {
      admission: { fence: `queue-${text}` },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "queue-session" } };
          if (first) {
            started.resolve();
            await answer.promise;
          }
        },
      },
      completion: (first ? answer.promise : Promise.resolve()).then(() => ({ kind: "answered" as const, answer: text })),
    };
  });
  const adapter = { ...fixtureAdapter(drive), resume: drive };
  const spawn: BodyLauncher = async (launch) => {
    launches.push(launch);
    const body = driveAkumaBody(launch, adapter);
    bodies.push(body);
    return {
      completed: body.then((result) => ({ diagnostic: "fixture launch completed", held: result === "held" })),
      async cancel() {},
      release() {},
    };
  };
  try {
    const api = akumasWithLauncher(world, spawn);
    const result = await api.spawn({ akumaName: "worker", body: "first", signal: context.signal });
    assert.equal(result.kind, "spawned");
    assert.ok(result.tellId);
    await started.promise;
    const { paths } = launches[0]!;
    const current = (await readHeart(paths)).latestBody!;
    const opening = (await readTell(paths, result.tellId))!.deliveries[0]!;
    assert.deepEqual(result.action, { kind: "started", historyId: `turn/${opening.turnSequence}` });
    assert.equal((await readTurn(paths, opening.turnSequence))?.end, undefined);
    const submitting = api.tell({ akuma: result.akumaId, body: "second", signal: context.signal });
    let returned = false;
    void submitting.then(() => { returned = true; }, () => { returned = true; });
    await waitForCondition("second Tell admitted", async () => (await readHeart(paths)).pending.length === 1);
    assert.equal(returned, false, "an admitted Tell behind an open Turn is not successful submission");
    assert.deepEqual(inputs, [["first"]]);
    answer.resolve();
    firstClosed = true;
    closed.resolve();
    const next = await submitting;
    assert.equal(next.kind, "admitted");
    await Promise.all(bodies);

    assert.equal(aborts, 0);
    assert.deepEqual(inputs, [["first"], ["second"]]);
    const first = await readTell(paths, result.tellId);
    const second = await readTell(paths, next.tellId);
    assert.equal(first?.state, "told");
    assert.equal(second?.state, "told");
    assert.ok(first?.binding && second?.binding);
    assert.ok(first.binding.turnSequence < second.binding.turnSequence);
    assert.deepEqual(next.action, { kind: "started", historyId: `turn/${second.binding.turnSequence}` });
    const firstTurn = await readTurn(paths, first.binding.turnSequence);
    const secondTurn = await readTurn(paths, second.binding.turnSequence);
    assert.equal(firstTurn?.bodySequence, current.sequence);
    assert.equal(secondTurn?.bodySequence, current.sequence);
    for (const [turn, answer] of [[firstTurn, "first"], [secondTurn, "second"]] as const) {
      const outcome = turn?.end?.outcome;
      assert.equal(outcome?.kind, "answered");
      assert.equal(outcome.answer, answer);
    }
    const heart = await readHeart(paths);
    assert.equal(heart.latestBody?.sequence, current.sequence);
    assert.equal(heart.latestBody?.end, "exited");
    assert.deepEqual(heart.pending, []);
  } finally {
    answer.resolve();
    firstClosed = true;
    closed.resolve();
    await Promise.all(bodies);
  }
});

test("live Tell confirms exact steering, not a binding, receipt, or answer", { timeout: 10_000 }, async (t) => {
  const root = temporaryDirectory(t, "keiyaku-live-action-");
  const { allocated, world } = await bornWorld(root, "b0000011");
  const { paths } = allocated;
  const providerReady = deferred<void>();
  const bound = deferred<void>();
  const accept = deferred<void>();
  const answer = deferred<void>();
  const completion = answer.promise.then(() => ({ kind: "answered" as const, answer: "later" }));
  const adapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    const abort = async () => { accept.resolve(); answer.resolve(); };
    custody.own({ closed: completion.then(() => undefined), abort, forceDispose: abort });
    return {
      admission: { fence: "opening" }, completion,
      async tell() { bound.resolve(); await accept.promise; return { kind: "accepted", fence: "exact-live" }; },
      events: { async *[Symbol.asyncIterator]() {
        yield { type: "session" as const, coordinate: { sessionId: "live-action" } };
        providerReady.resolve();
        await answer.promise;
      } },
      receipts: { async *[Symbol.asyncIterator]() { await answer.promise; } },
    };
  }));
  await recordTell(paths, { kind: "tell", id: "opening", body: "opening", recordedAt: new Date().toISOString() });
  const running = driveAkumaBody({ paths }, adapter);
  t.after(async () => { accept.resolve(); answer.resolve(); await running; });
  try {
    await providerReady.promise;
    const submitting = new AkumaOwner(allocated.id, world).tell("steer", "later", undefined, {
      async spawn() { assert.fail("do not launch into a live Body"); },
    }, { signal: t.signal });
    let returned = false;
    void submitting.then(() => { returned = true; }, () => { returned = true; });
    await bound.promise;
    const recorded = (await readTell(paths, "later"))!;
    assert.ok(recorded.binding);
    assert.deepEqual(recorded.deliveries, []);
    assert.equal(returned, false);
    accept.resolve();
    const receipt = await submitting;
    assert.deepEqual(receipt.wake, { kind: "steering", historyId: `turn/${recorded.binding.turnSequence}` });
    assert.equal((await readTell(paths, "later"))?.state, "pending");
    assert.equal((await readTurn(paths, recorded.binding.turnSequence))?.end, undefined);
    // Complete the real provider receipt independently of the returned action.
    await recordTellReceipt(paths, { evidence: "exact", tellId: "later", kind: "consumed", receivedAt: recorded.recordedAt });
  } finally {
    accept.resolve();
    answer.resolve();
    await running;
  }
});

test("queued schema Tells occupy dedicated Turns in admission order", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-launch-schema-queue-");
  const { allocated } = await bornWorld(root, "b0000002");
  const at = "2026-08-08T00:00:00.000Z";
  const schema = '{"type":"object"}';
  for (const [id, schemaJson] of [["first", undefined], ["schema", schema], ["last", undefined]] as const) {
    await recordTell(allocated.paths, {
      kind: "tell",
      id,
      body: id,
      recordedAt: at,
      ...(schemaJson === undefined ? {} : { schemaJson }),
    });
  }
  const inputs: [readonly string[], string | undefined][] = [];
  const drive = (input: DriveInput) => createProviderAttempt(input.signal, async (custody) => {
    const ids = input.launchTells.map((tell) => tell.id);
    inputs.push([ids, input.schemaJson]);
    custody.own({ closed: Promise.resolve(), async abort() {}, async forceDispose() {} });
    return {
      admission: { fence: ids.join("-") },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "schema-session" } };
        },
      },
      completion: Promise.resolve({ kind: "answered" as const, answer: '{}' }),
    };
  });
  await driveAkumaBody({ paths: allocated.paths }, { ...fixtureAdapter(drive), resume: drive });
  assert.deepEqual(inputs, [[["first"], undefined], [["schema"], schema], [["last"], undefined]]);
  assert.deepEqual((await readHeart(allocated.paths)).pending, []);
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
      const result = await Akuma.select(world, allocated.id).tell("pending");
      assert.equal(result.kind, "failed");
      if (result.kind !== "failed") throw new Error("missing detached evidence");
      const wake = result.failures[0];
      assert.equal(wake.stage, "wake");
      if (wake.stage !== "wake") throw new Error("missing wake evidence");
      assert.equal(wake.diagnostic, `pre-admission ${scenario.status}`);
      assert.equal(wake.logPath, allocated.paths.log, "the failed wake names its retained run-log evidence");
      const log = readFileSync(allocated.paths.log);
      assert.deepEqual(
        log.subarray(Buffer.byteLength("prior log\n")),
        Buffer.from(`[child ${scenario.status}]\n`),
        "the log retains only the child's native exit evidence",
      );
      assert.match(log.toString(), new RegExp(`\\[child ${scenario.status}\\]\\n$`, "u"));
      assert.deepEqual(
        (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
        [result.tellId],
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
    const { child, failureStage } = await publishAkuma({ worldPath: world, akumaName: "worker", launch: async (allocated) => {
      launch = await spawnAkumaBody({ paths: allocated.paths, seed: {
        id: allocated.id, akumaName: "worker", provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {}, cwd: world, origin: { kind: "direct" },
      } });
      await waitForFixtureFile(join(barrier, "ready"));
      return launch;
    } });
    assert.equal(failureStage, undefined);
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
