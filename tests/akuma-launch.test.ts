import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { Akuma } from "../src/akuma/index.js";
import { breakBody, HeldAkumaLeash, readHeart, readTell, readTurn, recordTell, recordTellReceipt } from "../src/akuma/heart/index.js";
import { runProcess } from "../src/runtime/proc/run.js";
import { appendNodeOptionsImport, temporaryDirectory } from "./support/process.js";
import { answering, bornWorld } from "./support/akuma-tell.js";
import { spawnAkumaBody } from "../src/akuma/detached-body.js";
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
    const next = await api.tell({ akuma: result.akumaId, body: "second", signal: context.signal });
    assert.deepEqual(next, { result: "told", akumaId: result.akumaId, tellId: next.tellId });
    const queued = await readTell(paths, next.tellId);
    assert.equal(queued?.state, "pending", "durable admission does not require provider submission");
    assert.deepEqual(queued?.deliveries, []);
    assert.deepEqual(inputs, [["first"]]);
    answer.resolve();
    firstClosed = true;
    closed.resolve();
    await Promise.all(bodies);

    assert.equal(aborts, 0);
    assert.deepEqual(inputs, [["first"], ["second"]]);
    const first = await readTell(paths, result.tellId);
    const second = await readTell(paths, next.tellId);
    assert.equal(first?.state, "told");
    assert.equal(second?.state, "told");
    assert.ok(first?.binding && second?.binding);
    assert.ok(first.binding.turnSequence < second.binding.turnSequence);
    assert.equal(second.deliveries[0]?.turnSequence, second.binding.turnSequence);
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

test("an ended successor without this Tell cannot hide its known launch failure", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-ended-tell-successor-");
  const { world, allocated } = await bornWorld(root, "b0000012");
  const at = "2026-11-11T00:00:00.000Z";
  const launch = t.mock.fn(async () => {
    const leash = await HeldAkumaLeash.try(allocated.paths);
    assert.ok(leash);
    try {
      const body = await leash.recordBody(allocated.paths, { leashTakenAt: at });
      await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at });
    } finally { leash.release(); }
    return {
      completed: Promise.resolve({ diagnostic: "successor exited before binding", child: { log: { path: allocated.paths.log } } }),
      async cancel() { assert.fail("the exited launch must not be canceled"); },
      release() {},
    };
  });
  const response = await akumasWithLauncher(world, launch).tell({ akuma: allocated.id, body: "remember this" });
  assert.ok("result" in response && response.result === "failed");
  assert.equal(response.turn, undefined);
  assert.deepEqual(response.failures, [{ stage: "wake", diagnostic: "successor exited before binding", logPath: allocated.paths.log }]);
  assert.equal(launch.mock.callCount(), 1);
  const admitted = await readTell(allocated.paths, response.tellId);
  assert.equal(admitted?.body, "remember this");
  assert.equal(admitted.state, "pending");
  assert.equal(admitted.binding, undefined);
});

test("a rejected wake stays failed when another Body delivers the exact admitted Tell", async (t) => {
  const { world, allocated } = await bornWorld(temporaryDirectory(t, "keiyaku-rejected-tell-wake-"), "b0000013");
  const api = akumasWithLauncher(world, async (launch) => {
    await driveAkumaBody(launch, answering("delivered independently"));
    throw new Error("original wake rejected");
  });
  const result = await api.tell({ akuma: allocated.id, body: "admitted before wake" });
  const tell = await readTell(allocated.paths, result.tellId);
  assert.equal(tell?.state, "told");
  assert.ok(tell.binding);
  assert.ok("result" in result && result.result === "failed");
  assert.equal(result.turn, `turn/${tell.binding.turnSequence}`);
  assert.deepEqual(result.failures, [{ stage: "wake", diagnostic: "original wake rejected" }]);
});

test("native wake exits do not replace an independent exact answer or erase an actual failure", async (t) => {
  for (const code of [7, 75] as const) {
    await t.test(`native exit ${code}`, async (t) => {
      const root = temporaryDirectory(t, "keiyaku-exited-tell-wake-");
      const { world, allocated } = await bornWorld(root, "b0000014");
      const priorOptions = process.env.NODE_OPTIONS;
      if (code === 7) {
        const preload = join(root, "exit.mjs");
        writeFileSync(preload, 'if (process.argv.some(arg => /akuma-body\\.[jt]s$/u.test(arg))) process.exit(7);\n');
        process.env.NODE_OPTIONS = appendNodeOptionsImport(pathToFileURL(preload).href, priorOptions ?? "");
      }
      const at = "2026-11-20T00:00:00.000Z";
      const answer = "independent answer";
      const ready = deferred<void>();
      const api = akumasWithLauncher(world, async (launch) => {
        const deliver = () => driveAkumaBody(launch, answering(answer), { now: () => at });
        try {
          const held = code === 75 ? await HeldAkumaLeash.try(launch.paths) : null;
          if (code === 75) assert.ok(held);
          let child: Awaited<ReturnType<typeof spawnAkumaBody>>;
          try {
            child = await spawnAkumaBody(launch);
            assert.equal((await child.completed).diagnostic, `pre-admission exit ${code}`);
          } finally {
            held?.release();
          }
          await deliver();
          return child;
        } finally {
          ready.resolve();
        }
      });
      try {
        const result = await api.tell({ akuma: allocated.id, body: "same input", wait: true, observe: { admitted: () => ready.promise } });
        const tell = await readTell(allocated.paths, result.tellId);
        assert.equal(tell?.state, "told");
        assert.ok(tell.binding);
        const turn = `turn/${tell.binding.turnSequence}` as const;
        const outcome = { state: "done", turn, at, answer };
        if (code === 7) {
          assert.ok("result" in result && result.result === "failed");
          assert.equal(result.turn, turn);
          assert.deepEqual(result.outcome, outcome);
          assert.deepEqual(result.failures, [{ stage: "wake", diagnostic: "pre-admission exit 7", logPath: allocated.paths.log }]);
        } else {
          assert.deepEqual(result, { akumaId: allocated.id, tellId: result.tellId, ...outcome });
        }
      } finally {
        if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = priorOptions;
      }
    });
  }
});

test("a clean native exit without a Turn leaves admission pending rather than reporting a failed wake", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-clean-pending-wake-");
  const { akuma, allocated } = await bornWorld(root, "b0000016", spawnAkumaBody);
  const preload = join(root, "clean.mjs");
  writeFileSync(preload, 'if (process.argv.some(arg => /akuma-body\\.[jt]s$/u.test(arg))) process.exit(0);\n');
  const priorOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = appendNodeOptionsImport(pathToFileURL(preload).href, priorOptions ?? "");
  try {
    const result = await akuma.tell("remain admitted");
    assert.deepEqual(result, { result: "told", akumaId: allocated.id, tellId: result.tellId });
    const tell = await readTell(allocated.paths, result.tellId);
    assert.equal(tell?.state, "pending");
    assert.equal(tell.binding, undefined);
  } finally {
    if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorOptions;
  }
});

test("finite Tell releases its live wake observer without canceling the admitted input", async (t) => {
  const { world, allocated } = await bornWorld(temporaryDirectory(t, "keiyaku-finite-tell-wake-"), "b0000015");
  const controller = new AbortController();
  const completed = deferred<{ diagnostic: string }>();
  const acquired = deferred<void>();
  const release = t.mock.fn();
  const cancel = t.mock.fn(async () => {});
  const api = akumasWithLauncher(world, async () => {
    acquired.resolve();
    return { completed: completed.promise, release, cancel };
  });
  try {
    const pending = api.tell({ akuma: allocated.id, body: "retain this", wait: true, timeoutMs: 500, signal: controller.signal });
    await Promise.race([acquired.promise, pending.then(() => assert.fail("wake never reached the launcher"))]);
    const result = await pending;
    assert.ok("state" in result && result.state === "waiting");
    assert.equal(release.mock.callCount(), 1);
    assert.equal(cancel.mock.callCount(), 0);
    assert.equal((await readTell(allocated.paths, result.tellId))?.state, "pending");
    await driveAkumaBody({ paths: allocated.paths }, answering("still works"));
    assert.equal((await readTell(allocated.paths, result.tellId))?.state, "told");
  } finally {
    controller.abort();
    completed.resolve({ diagnostic: "fixture exited" });
  }
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
        `if (process.argv.some(arg => /akuma-body\\.[jt]s$/u.test(arg))) {
          if (process.cwd() !== ${JSON.stringify(world)} || process.env.KEIYAKU_ACTOR_ID !== ${JSON.stringify(allocated.id)}) process.exit(99);
          ${scenario.action};\n}\n`,
      );
      process.env.NODE_OPTIONS = appendNodeOptionsImport(pathToFileURL(preload).href, priorOptions ?? "");
      writeFileSync(allocated.paths.log, "prior log\n");
      const result = await Akuma.select(world, allocated.id).tell("pending");
      assert.ok("result" in result && result.result === "failed", "missing detached evidence");
      assert.equal((await readTell(allocated.paths, result.tellId))?.state, "pending");
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
