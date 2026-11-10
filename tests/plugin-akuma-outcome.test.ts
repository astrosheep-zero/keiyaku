import { akumaWithLauncher } from "../src/akuma/akuma-instance.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryLedger, harnessOwner } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import test, { after, type TestContext } from "node:test";
import { Akuma, Akumas, World, type WorldRoot, type AkumaTellResult } from "../src/index.js";
import { cliJson } from "./support/cli-fixtures.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { readAkumaTimeline } from "../src/akuma/akuma.js";
import { beginTurn, endTurn, finishBodyIfIdle, readTell, recordTell } from "../src/akuma/heart/index.js";
import { createProviderAttempt } from "../src/akuma/provider.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { answering, bornWorld, fixtureAdapter, fixtureLauncher, settleFixtureBodies } from "./support/akuma-tell.js";
import { deferred, restoreEnvironmentValues, temporaryDirectory } from "./support/process.js";

const AT = "2026-10-14T00:00:00.000Z";
type Signal = Readonly<{ kind: "akuma.outcome-observed"; akumaId: string; historyId: string; observer?: string }>;

/**
 * A World resolves user Settings through the process home, so the plugins configured for
 * the developer or machine running this file would activate inside every fixture below and
 * their diagnostics would be counted as this file's own fixtures. This file therefore owns
 * one empty user coordinate: `os.homedir()` names the process home from HOME on POSIX and
 * from USERPROFILE on Windows, so both are pointed at it and only each fixture's project
 * plugins stay selected.
 */
const USER_HOME_NAMES = ["HOME", "USERPROFILE"] as const;
const priorUserHome = Object.fromEntries(USER_HOME_NAMES.map((name) => [name, process.env[name]]));
const isolatedUserHome = mkdtempSync(join(tmpdir(), "keiyaku-plugin-outcome-home-"));
for (const name of USER_HOME_NAMES) process.env[name] = isolatedUserHome;

after(() => {
  restoreEnvironmentValues(priorUserHome);
  rmSync(isolatedUserHome, { recursive: true, force: true });
});

function recordingPlugin(world: WorldRoot, fail = false) {
  const output = join(world, "observations.jsonl");
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "record.mjs"),
    `
    import { appendFileSync } from "node:fs";
    export default {
      manifest: { id: "record", apiVersion: 1 },
      activate(context) { return { signals: {
        "akuma.outcome-observed": (signal) => {
          appendFileSync(context.config.output, JSON.stringify(signal) + "\\n");
          ${fail ? 'throw new Error("observer deliberately failed");' : ""}
        }
      } }; }
    };
  `,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: { record: { package: "./plugins/record.mjs", config: { output } } },
    }),
  );
  return {
    signals: (): Signal[] =>
      existsSync(output)
        ? readFileSync(output, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Signal)
        : [],
    reset: () => writeFileSync(output, ""),
  };
}

test(
  "Body outcomes freeze opening and steered Owners independently of producing environment",
  { timeout: 15_000 },
  async (t) => {
    const source = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-tell-ids-"), "0b500017");
    const output = join(source.world, "outcomes.jsonl");
    mkdirSync(join(source.world, "plugins"), { recursive: true });
    writeFileSync(
      join(source.world, "plugins", "outcomes.mjs"),
      `
    import { appendFileSync } from "node:fs";
    export default { manifest: { id: "outcomes", apiVersion: 1 }, activate(context) {
      return { signals: { "akuma.turn-outcome": signal => appendFileSync(context.config.output, JSON.stringify(signal) + "\\n") } };
    } };
  `,
    );
    writeFileSync(
      join(source.world, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: { outcomes: { package: "./plugins/outcomes.mjs", config: { output } } },
      }),
    );
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received!: () => void;
    const bothReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const steers: string[] = [];
    const adapter = fixtureAdapter(input => createProviderAttempt(input.signal, async (custody) => {
      const abort = async () => { release(); };
      custody.own({ closed: released, abort, forceDispose: abort });
      return {
        admission: { fence: "live-turn" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "live-session" } };
            started();
            await released;
          },
        },
        completion: released.then(() => ({ kind: "answered" as const, answer: "done", historyId: "answer" })),
        async tell(input) {
          steers.push(input.id);
          if (steers.length === 2) received();
          return { kind: "accepted" as const, fence: input.id };
        },
      };
    }));
    const runtime = { spawn: noBodyLaunch, now: () => AT };
    const opening = harnessOwner({ channel: "pi", session: "opening" });
    const steering = harnessOwner({ channel: "codex", session: "steering" });
    const body = driveAkumaBody(
      { paths: source.allocated.paths, initialBody: "work", initiator: opening },
      adapter,
      runtime,
    );
    try {
      await ready;
      await recordTell(source.allocated.paths, {
        kind: "tell",
        id: "live-one",
        body: "one",
        recordedAt: AT,
        initiator: steering,
      });
      await recordTell(source.allocated.paths, {
        kind: "tell",
        id: "live-two",
        body: "two",
        recordedAt: AT,
        initiator: opening,
      });
      await bothReceived;
    } finally {
      release();
      await body;
    }
    const empty = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-empty-ids-"), "0b500018");
    mkdirSync(join(empty.world, "plugins"), { recursive: true });
    writeFileSync(
      join(empty.world, "plugins", "outcomes.mjs"),
      readFileSync(join(source.world, "plugins", "outcomes.mjs")),
    );
    writeFileSync(
      join(empty.world, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: { outcomes: { package: "./plugins/outcomes.mjs", config: { output } } },
      }),
    );
    await driveAkumaBody({ paths: empty.allocated.paths, initialBody: "no tells" }, answering("second"), runtime);
    const canceled = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-canceled-ids-"), "0b500021");
    mkdirSync(join(canceled.world, "plugins"), { recursive: true });
    writeFileSync(
      join(canceled.world, "plugins", "outcomes.mjs"),
      readFileSync(join(source.world, "plugins", "outcomes.mjs")),
    );
    writeFileSync(
      join(canceled.world, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: { outcomes: { package: "./plugins/outcomes.mjs", config: { output } } },
      }),
    );
    const canceledStarted = deferred<void>();
    const bound = deferred<void>();
    const closed = deferred<void>();
    const canceledBody = driveAkumaBody(
      { paths: canceled.allocated.paths, initialBody: "cancel me", initiator: opening },
      fixtureAdapter(input => createProviderAttempt(input.signal, async (custody) => {
        const abort = async () => { closed.resolve(); };
        custody.own({ closed: closed.promise, abort, forceDispose: abort });
        return {
          admission: { fence: "canceled-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              canceledStarted.resolve();
              await closed.promise;
            },
          },
          completion: new Promise<never>(() => {}),
          async tell(input) {
            bound.resolve();
            return { kind: "accepted" as const, fence: input.id };
          },
        };
      })),
      runtime,
    );
    try {
      await canceledStarted.promise;
      await recordTell(canceled.allocated.paths, { kind: "tell", id: "canceled-tell", body: "steer", recordedAt: AT });
      await bound.promise;
      assert.equal(await Akuma.select(canceled.world, canceled.allocated.id).kill({ signal: t.signal }), "killed");
    } finally {
      closed.resolve();
      await canceledBody;
    }
    const outcomes = readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0].initiator, opening);
    assert.deepEqual(outcomes[0].participants, [opening, steering]);
    assert.equal(outcomes[1].participants, undefined);
    assert.equal(outcomes[0].akumaId, source.allocated.id);
    assert.equal(outcomes[1].akumaId, empty.allocated.id);
    assert.deepEqual(outcomes[2].participants, [opening]);
    assert.deepEqual(outcomes[2].outcome, { kind: "canceled" });
    assert.equal((await readTell(source.allocated.paths, "live-one"))?.binding?.turnSequence, outcomes[0].turnSequence);
    assert.equal((await readTell(source.allocated.paths, "live-two"))?.binding?.turnSequence, outcomes[0].turnSequence);
  },
);

test("public hosts capture independent immutable sinks for native and plural observations", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-host-diagnostics-"));
  const recorded = recordingPlugin(world, true);
  const value = await bornBody(world, "0b500011", AT);
  const turn = await outcome(value, "host answer");
  await finish(value);
  const first: string[] = [];
  const second: string[] = [];
  const host = {
    reportDiagnostic: (message: string) => {
      first.push(message);
    },
  };
  const plural = Akumas.of(world, host);
  const native = Akuma.select(world, value.allocated.id, host);
  host.reportDiagnostic = (message) => {
    second.push(message);
  };
  const peer = Akumas.of(world, host);

  assert.equal((await plural.status({ akuma: value.allocated.id })).life, "asleep");
  await plural.history({ akuma: value.allocated.id });
  assert.equal((await plural.wait({ akuma: [value.allocated.id], timeoutMs: 0 })).reason, "completed");
  await native.status();
  await native.history();
  assert.equal((await native.idle({ timeoutMs: 0 })).reason, "completed");
  assert.equal(first.length, 6);
  assert.deepEqual(second, []);
  await peer.status({ akuma: value.allocated.id });
  assert.equal(first.length, 6);
  assert.equal(second.length, 1);
  assert.ok([...first, ...second].every((message) => message.includes("observer deliberately failed")));
  assert.deepEqual(
    recorded.signals(),
    Array.from({ length: 7 }, () => signal(value.allocated.id, turn.sequence)),
    "changing destinations never duplicates semantic emission",
  );
});

test("host callback throws and async rejections cannot alter observation results", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-host-faults-"));
  recordingPlugin(world, true);
  const value = await bornBody(world, "0b500012", AT);
  await outcome(value, "unchanged answer");
  await finish(value);
  let thrown = 0;
  const native = Akuma.select(world, value.allocated.id, {
    reportDiagnostic: () => {
      thrown += 1;
      throw new Error("broken host callback");
    },
  });
  assert.equal((await native.status()).life, "asleep");
  let rejected = 0;
  const plural = Akumas.of(world, {
    reportDiagnostic: async () => {
      rejected += 1;
      throw new Error("rejected host callback");
    },
  });
  const result = await plural.history({ akuma: value.allocated.id, last: true });
  assert.equal(result.kind, "akuma-last");
  assert.ok(result.kind === "akuma-last");
  assert.equal(result.answer, "unchanged answer");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(thrown, 1);
  assert.equal(rejected, 1);
});

test("local observations without a host keep the line-oriented stderr default", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-host-default-"));
  recordingPlugin(world, true);
  const value = await bornBody(world, "0b500013", AT);
  await outcome(value, "answer");
  await finish(value);
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    diagnostics.push(message);
  });
  await Akumas.of(world).status({ akuma: value.allocated.id });
  await Akuma.select(world, value.allocated.id).history();
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((message) => message === "plugin record signal: observer deliberately failed"));
});

test("activation diagnostics belong to the initiating host and are never replayed", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-host-activation-"));
  recordingPlugin(world);
  writeFileSync(
    join(world, "plugins", "record.mjs"),
    `export default {
    manifest: { id: "record", apiVersion: 1 },
    activate() { throw new Error("activation failed"); }
  };`,
  );
  const value = await bornBody(world, "0b500014", AT);
  await outcome(value, "answer");
  await finish(value);
  const first: string[] = [];
  const later: string[] = [];
  await Akumas.of(world, {
    reportDiagnostic: (message) => {
      first.push(message);
    },
  }).status({ akuma: value.allocated.id });
  await Akuma.select(world, value.allocated.id, {
    reportDiagnostic: (message) => {
      later.push(message);
    },
  }).status();
  assert.deepEqual(first, ["plugin record activation: activation failed"]);
  assert.deepEqual(later, []);
});

test("host options reject malformed capabilities before construction or birth effects", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-host-invalid-"));
  for (const host of [null, { reportDiagnostic: "stderr" }, { execution: {} }]) {
    assert.throws(() => Akumas.of(world, host as never), TypeError);
    assert.throws(() => Akuma.select(world, "aku/worker/0b500015", host as never), TypeError);
    await assert.rejects(Akuma.birth("worker", { root: world, host: host as never }), TypeError);
  }
  assert.equal((await Akumas.of(world).list()).rows, undefined, "an empty roster omits rows");
});

function signal(akumaId: string, sequence: number): Signal {
  return { kind: "akuma.outcome-observed", akumaId, historyId: `turn/${sequence}` };
}

async function outcome(value: Awaited<ReturnType<typeof bornBody>>, answer?: string) {
  const turn = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
  await endTurn(value.allocated.paths, {
    turnSequence: turn.sequence,
    completedAt: AT,
    outcome:
      answer === undefined
        ? { kind: "failed", diagnostic: "provider failed" }
        : { kind: "answered", answer, session: { sessionId: "fixture-session" } },
  });
  return turn;
}

async function finish(value: Awaited<ReturnType<typeof bornBody>>) {
  await finishBodyIfIdle(value.allocated.paths, { sequence: value.body.sequence, at: AT });
  value.holder.release();
}

test("public status observes committed identity, not idle or incidental internal reads", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-status-"));
  const recorded = recordingPlugin(world);
  const value = await bornBody(world, "0b500001", AT);
  t.after(() => value.holder.release());
  const empty = await bornBody(world, "0b500002", AT);
  await finish(empty);
  const answered = await outcome(value, "");
  const api = Akumas.of(world);
  await api.list();
  await readAkumaTimeline(world, value.allocated.id);
  await new AkumaOwner(value.allocated.id, world).history();
  await new AkumaOwner(value.allocated.id, world).lastAnswer();
  assert.deepEqual(recorded.signals(), [], "lifecycle production, roster and internal reads are not observers");
  assert.equal((await Akuma.select(world, empty.allocated.id).idle({ timeoutMs: 0 })).reason, "completed");
  await api.status({ akuma: empty.allocated.id });
  await api.history({ akuma: value.allocated.id, id: "turn/9999" });
  assert.deepEqual(recorded.signals(), [], "idle and missing history have no invented result");
  const observed = await api.status({ akuma: value.allocated.id });
  assert.equal(observed.life, "running");
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, answered.sequence)]);
  recorded.reset();
  const failed = await outcome(value);
  await Akuma.select(world, value.allocated.id).status();
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, failed.sequence)]);
  recorded.reset();
  await api.status({ akuma: value.allocated.id });
  assert.deepEqual(
    recorded.signals(),
    [signal(value.allocated.id, failed.sequence)],
    "a distinct operation may observe the same result again",
  );
  recorded.reset();
  await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
  const open = await api.status({ akuma: value.allocated.id });
  assert.equal(open.timeline.kind, "open");
  assert.deepEqual(recorded.signals(), [], "a past outcome read to build an open view is not caller observation");
});

test("history page, exact and last use the identity of the actual retained result", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-history-"));
  const recorded = recordingPlugin(world);
  const value = await bornBody(world, "0b500003", AT);
  t.after(() => value.holder.release());
  const answered = await outcome(value, "answer before failure");
  const failed = await outcome(value);
  const api = Akumas.of(world);
  const last = await api.history({ akuma: value.allocated.id, last: true });
  assert.equal(last.kind, "akuma-last");
  assert.deepEqual(
    recorded.signals(),
    [signal(value.allocated.id, answered.sequence)],
    "last must not guess the newer failed Turn",
  );
  recorded.reset();
  const exact = await api.history({ akuma: value.allocated.id, id: `turn/${failed.sequence}` });
  assert.equal(exact.kind, "akuma-exact");
  assert.deepEqual(recorded.signals(), [signal(value.allocated.id, failed.sequence)]);
  recorded.reset();
  await api.history({ akuma: value.allocated.id });
  assert.deepEqual(recorded.signals(), [
    signal(value.allocated.id, answered.sequence),
    signal(value.allocated.id, failed.sequence),
  ]);
  recorded.reset();
  await Akuma.select(world, value.allocated.id).history();
  assert.deepEqual(recorded.signals(), [
    signal(value.allocated.id, answered.sequence),
    signal(value.allocated.id, failed.sequence),
  ]);
});

test("all-wait observes final snapshot outcomes once per operation", { timeout: 10_000 }, async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-wait-"));
  const recorded = recordingPlugin(world);
  const first = await bornBody(world, "0b500004", AT);
  const peer = await bornBody(world, "0b500005", AT);
  t.after(() => {
    first.holder.release();
    peer.holder.release();
  });
  const turn = await outcome(first, "already committed");
  await finish(first);
  const result = await Akumas.of(world).wait({
    akuma: [first.allocated.id, peer.allocated.id],
    completion: "all",
    timeoutMs: 0,
    signal: t.signal,
  });
  assert.equal(result.reason, "deadline");
  assert.deepEqual(recorded.signals(), [signal(first.allocated.id, turn.sequence)]);
  recorded.reset();
  await Akuma.select(world, first.allocated.id).idle({ timeoutMs: 0 });
  assert.deepEqual(recorded.signals(), [signal(first.allocated.id, turn.sequence)]);
});

async function squareObserver(t: TestContext, world: WorldRoot) {
  const variables = [
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
    "PASEO_AGENT_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "KEIYAKU_INITIATOR",
    "SQUARE_DELIVERY",
  ];
  const prior = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  variables.forEach((key) => {
    delete process.env[key];
  });
  process.env.PI_SESSION_ID = "requester-session";
  process.env.SQUARE_DELIVERY = join(world, "delivery.sqlite");
  t.after(() => restoreEnvironmentValues(prior));
  const owner = harnessOwner({ channel: "pi", session: "requester-session" });
  const other = harnessOwner({ channel: "pi", session: "other-session" });
  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
  for (const recipient of [owner, other])
    assert.ok(await ledger.attach({ owner: recipient, expectedGeneration: null, routes: [] }));
  t.after(async () => {
    await ledger.close();
  });
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "square.mjs"),
    `export { default } from ${JSON.stringify(new URL("../plugins/square/index.js", import.meta.url).href)};`,
  );
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { square: { package: "./plugins/square.mjs" } } }),
  );
  const plugin = await squarePlugin.activate({ world, config: undefined, writablePath: () => join(world, ".square") });
  return {
    owner,
    plugin,
    async cards(recipient = owner) {
      const session = await ledger.session(recipient);
      assert.ok(session);
      return await ledger.pending(recipient, { generation: session.generation });
    },
    other,
  };
}

test("CLI native Owners survive coalesced Tell admission into direct Body ledger delivery", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-cli-ledger-"));
  const target = await bornBody(world, "0b500023", AT);
  t.after(() => target.holder.release());
  const observed = await squareObserver(t, world);
  process.env.PI_SESSION_ID = "producing-body";
  process.env.KEIYAKU_INITIATOR = "producing-body-owner";
  const receipts = [];
  for (const [session, owner] of [
    ["requester-session", observed.owner],
    ["other-session", observed.other],
  ] as const) {
    const result = await cliJson<AkumaTellResult>(["-C", world, "tell", target.allocated.id, `input ${session}`], {
      environment: { PI_SESSION_ID: session, SQUARE_DELIVERY: process.env.SQUARE_DELIVERY },
    });
    assert.equal(result.exit, 0, result.stderr);
    const fact = await readTell(target.allocated.paths, result.value.tellId);
    assert.equal(fact?.initiator, owner);
    receipts.push(result.value.tellId);
  }
  target.holder.release();
  await driveAkumaBody(
    { paths: target.allocated.paths, initiator: "unrelated-launch-owner" },
    answering("coalesced result"),
    {
      spawn: noBodyLaunch,
      now: () => AT,
    },
  );
  for (const owner of [observed.owner, observed.other]) {
    const cards = await observed.cards(owner);
    assert.equal(cards.length, 1);
    assert.ok(cards[0]!.text.includes("coalesced result"));
    assert.equal(cards[0]!.owner, owner);
  }
  const turns = await Promise.all(
    receipts.map(async (id) => (await readTell(target.allocated.paths, id))?.binding?.turnSequence),
  );
  assert.ok(turns[0] !== undefined);
  assert.equal(turns[0], turns[1], "both submitted Owners belong to the same frozen Turn audience");
});

for (const route of ["wait", "idle"] as const) {
  test(`${route} suppresses the exact outcome before its direct ledger card is posted`, async (t) => {
    const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-square-wait-"));
    const target = await bornBody(world, "0b500009", AT);
    t.after(() => target.holder.release());
    const turn = await outcome(target, "known answer");
    await finish(target);
    const observed = await squareObserver(t, world);
    const api = Akumas.of(world);
    const result =
      route === "idle"
        ? await Akuma.select(world, target.allocated.id).idle({ timeoutMs: 0 })
        : await api.wait({ akuma: [target.allocated.id], timeoutMs: 0, signal: t.signal });
    assert.equal(result.reason, "completed");
    const signal = {
      kind: "akuma.turn-outcome" as const,
      akumaId: target.allocated.id,
      bodySequence: target.body.sequence,
      turnSequence: turn.sequence,
      participants: [observed.owner, observed.other],
      outcome: { kind: "answered" as const, text: "known answer" },
    };
    await observed.plugin.signals?.["akuma.turn-outcome"]?.(signal);
    assert.deepEqual(await observed.cards(), []);
    assert.equal((await observed.cards(observed.other)).length, 1, "other recipient still posts");
    await observed.plugin.signals?.["akuma.turn-outcome"]?.({ ...signal, turnSequence: turn.sequence + 1 });
    assert.equal((await observed.cards()).length, 1, "another Turn remains deliverable");
  });
}

test("a deadline without an established outcome releases deferral without consuming a later notice", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-outcome-square-deadline-"));
  const target = await bornBody(world, "0b500022", AT);
  t.after(() => target.holder.release());
  const observed = await squareObserver(t, world);
  const result = await Akuma.select(world, target.allocated.id).idle({ timeoutMs: 0, signal: t.signal });
  assert.equal(result.reason, "deadline");
  const turn = await outcome(target, "after deadline");
  await finish(target);
  await observed.plugin.signals?.["akuma.turn-outcome"]?.({
    kind: "akuma.turn-outcome",
    akumaId: target.allocated.id,
    bodySequence: target.body.sequence,
    turnSequence: turn.sequence,
    participants: [observed.owner],
    outcome: { kind: "answered", text: "after deadline" },
  });
  assert.equal((await observed.cards()).length, 1);
});

for (const route of ["ask", "standalone-ask"] as const) {
  test(`${route} observes parsed JSON before its delayed real notice is inserted`, { timeout: 15_000 }, async (t) => {
    const source = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-square-ask-"), "0b500019");
    const observed = await squareObserver(t, source.world);
    const bodies: Promise<unknown>[] = [];
    const spawn = fixtureLauncher(
      bodies,
      new Map([[source.allocated.paths.directory, { adapter: answering('{"ok":true}'), now: AT }]]),
    );
    const post = DeliveryLedger.prototype.post;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(
      DeliveryLedger.prototype,
      "post",
      async function (this: DeliveryLedger, ...args: Parameters<typeof post>) {
        if (args[0].key.startsWith(`keiyaku/${source.allocated.id}/turn/`)) {
          entered();
          await released;
        }
        return await post.apply(this, args);
      },
    );
    try {
      const schema = { type: "object" };
      const result =
        route === "standalone-ask"
          ? await akumaWithLauncher(source.world, source.allocated.id, spawn).ask("work", {
              schema,
              initiator: observed.owner,
              signal: t.signal,
            })
          : await akumasWithLauncher(source.world, spawn).ask({
              akuma: source.allocated.id,
              body: "work",
              schema,
              initiator: observed.owner,
              signal: t.signal,
            });
      assert.equal(result.kind, "answered");
      await sending;
      release();
      await settleFixtureBodies(bodies);
      assert.deepEqual(
        await observed.cards(),
        [],
        "exact early ACK survives scope release",
      );
    } finally {
      release();
      await settleFixtureBodies(bodies);
    }
  });
}

test(
  "ask retains the observed outcome through plugin failure using its host sink",
  { timeout: 15_000 },
  async (t) => {
    const source = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-ask-"), "0b500008");
    const peer = await bornWorld(temporaryDirectory(t, "keiyaku-outcome-plural-ask-"), "0b500016");
    const recorded = recordingPlugin(source.world, true);
    const peerRecorded = recordingPlugin(peer.world, true);
    const diagnostics: string[] = [];
    const bodies: Promise<unknown>[] = [];
    const spawn = fixtureLauncher(
      bodies,
      new Map([
        [source.allocated.paths.directory, { adapter: answering('{"ok":true}'), now: AT }],
        [peer.allocated.paths.directory, { adapter: answering('{"ok":true}'), now: AT }],
      ]),
    );
    try {
      const schema = { type: "object" };
      const result = await akumaWithLauncher(source.world, source.allocated.id, spawn, {
        reportDiagnostic: (message) => {
          diagnostics.push(message);
        },
      }).ask("work", { schema, signal: t.signal });
      assert.equal(result.kind, "answered");
      const tell = await readTell(source.allocated.paths, result.tellId);
      assert.ok(tell?.binding);
      assert.deepEqual(recorded.signals(), [signal(source.allocated.id, tell.binding.turnSequence)]);
      const pluralResult = await akumasWithLauncher(peer.world, spawn, {
        reportDiagnostic: (message) => {
          diagnostics.push(message);
        },
      }).ask({ akuma: peer.allocated.id, body: "work", schema, signal: t.signal });
      assert.equal(pluralResult.kind, "answered");
      const peerTell = await readTell(peer.allocated.paths, pluralResult.tellId);
      assert.ok(peerTell?.binding);
      assert.deepEqual(peerRecorded.signals(), [signal(peer.allocated.id, peerTell.binding.turnSequence)]);
      assert.equal(diagnostics.filter((message) => message.includes("observer deliberately failed")).length, 2);
    } finally {
      await settleFixtureBodies(bodies);
    }
  },
);
