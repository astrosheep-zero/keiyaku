import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { deferred, temporaryDirectory, waitForCondition } from "./support/process.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { BodySupervisor, CONTROL_RESPONSE_MS } from "../src/akuma/body-supervisor.js";
import {
  activitySlice,
  heartExists,
  readHeart,
  readTell,
  recordTell,
  requestStop,
  type HeartSnapshot,
  type Soul,
} from "../src/akuma/heart/index.js";
import {
  createProviderAttempt,
  type AgentEvent,
  type ProviderAdapter,
  type TellReceipt,
  type TurnResult,
} from "../src/akuma/provider.js";
import { driveTurn, type DriveTurnInput } from "../src/akuma/turn-drive.js";
import { World } from "../src/world.js";

const AT = "2026-10-01T00:00:00.000Z";
const FENCE = "turn-wait-fence";

/**
 * A never-settling provider event pull that counts the reactions the Turn wait attaches to it.
 * It stays a real Promise so the drive path sees an ordinary pending pull; only this one instance's
 * `then` is counted, never Promise.prototype, so the count is one local fixture fact.
 */
class PendingProviderPull extends Promise<IteratorResult<AgentEvent>> {
  registrations = 0;

  constructor(
    executor: (
      resolve: (value: IteratorResult<AgentEvent> | PromiseLike<IteratorResult<AgentEvent>>) => void,
      reject: (reason?: unknown) => void,
    ) => void = () => undefined,
  ) {
    super(executor);
  }

  override then<TResult1 = IteratorResult<AgentEvent>, TResult2 = never>(
    onfulfilled?: ((value: IteratorResult<AgentEvent>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.registrations += 1;
    return super.then(onfulfilled, onrejected);
  }
}

/** The stalled pull is the whole provider narration: nothing arrives until the Turn is stopped. */
function stalledEvents(pull: Promise<IteratorResult<AgentEvent>>): AsyncIterable<AgentEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => pull }) };
}

async function* narratedEvents(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* events;
}

type ProviderFixture = Readonly<{
  adapter: ProviderAdapter;
  submissions: Array<Readonly<{ id: string; text: string }>>;
  aborts(): number;
}>;

/** One provider attempt over caller-owned events, retiring every owned resource through custody. */
function turnProvider(input: {
  events: AsyncIterable<AgentEvent>;
  completion?: Promise<TurnResult>;
  closure?: Promise<void>;
  receipts?: AsyncIterable<TellReceipt>;
}): ProviderFixture {
  const submissions: Array<Readonly<{ id: string; text: string }>> = [];
  let aborts = 0;
  const adapter: ProviderAdapter = {
    admitOptions: (options) => ({ kind: "admitted", options }),
    start: () =>
      createProviderAttempt(undefined, async (custody) => {
        const completion = input.completion ?? new Promise<TurnResult>(() => undefined);
        const closed = deferred<void>();
        void completion.then(
          () => closed.resolve(),
          () => closed.resolve(),
        );
        custody.own({
          closed: input.closure ?? closed.promise,
          abort: async () => {
            aborts += 1;
            closed.resolve();
          },
          forceDispose: async () => closed.resolve(),
        });
        return {
          admission: { fence: FENCE },
          events: input.events,
          completion,
          abort: async () => closed.resolve(),
          forceDispose: async () => closed.resolve(),
          tell: async (tell) => {
            submissions.push(tell);
            return { kind: "accepted", fence: FENCE };
          },
          ...(input.receipts === undefined ? {} : { receipts: input.receipts }),
        };
      }),
  };
  return { adapter, submissions, aborts: () => aborts };
}

type TurnFixture = Readonly<{
  paths: Awaited<ReturnType<typeof bornDirectAkuma>>["paths"];
  world: Awaited<ReturnType<typeof World.at>>;
  soul: Soul;
  bodySequence: number;
  snapshot: HeartSnapshot;
  control(): Promise<BodySupervisor>;
}>;

/** One real World, Heart, held leash, and admitted Body; each control owner the test opens is closed. */
async function turnFixture(context: TestContext, prefix: string): Promise<TurnFixture> {
  const root = temporaryDirectory(context, prefix);
  const world = await World.at(root);
  const born = await bornDirectAkuma({ root, akumaName: "claude", draw: "f8930001", createdAt: AT });
  const body = await born.leash.recordBody(born.paths, { leashTakenAt: AT });
  await recordTell(born.paths, { kind: "tell", id: "opening", body: "wait on a permission", recordedAt: AT });
  return {
    paths: born.paths,
    world,
    soul: born.soul,
    bodySequence: body.sequence,
    snapshot: await readHeart(born.paths),
    control: async () => await BodySupervisor.open(born.paths, body.sequence, born.leash),
  };
}

function driveInput(fixture: TurnFixture, adapter: ProviderAdapter, supervisor: BodySupervisor): DriveTurnInput {
  return {
    paths: fixture.paths,
    soul: fixture.soul,
    adapter,
    bodySequence: fixture.bodySequence,
    launchTells: fixture.snapshot.pending,
    supervisor,
    world: fixture.world,
    turnStarted: { emit: async () => undefined },
    now: () => AT,
  };
}

/**
 * A deterministic control owner with the BodySupervisor contract: `current` is level-triggered and
 * every observation publishes one fresh snapshot identity. It stops the Turn by aborting the leash
 * signal at a fixed observation budget, so a six-figure observation count costs no wall-clock poll.
 */
function budgetedControl(snapshot: HeartSnapshot, budget: number) {
  const controller = new AbortController();
  let observation = snapshot;
  let observed = 0;
  const supervisor = {
    signal: controller.signal,
    current: () => observation,
    next: async () => {
      observed += 1;
      if (observed >= budget) controller.abort(new Error("control observation budget reached"));
      observation = { ...observation };
      return observation;
    },
    cancel: (reason: "control" | "heart-gone") => controller.abort(new Error(reason)),
    recordHung: async () => undefined,
  };
  return { supervisor: supervisor as unknown as BodySupervisor, observed: () => observed };
}

/** The Turn wait is real only once the provider pull is registered; later fixtures act on that fact. */
async function armedWait(pull: PendingProviderPull): Promise<void> {
  await waitForCondition("the Turn wait to register its provider pull", () => pull.registrations === 1, {
    budgetMs: 5_000,
  });
}

/**
 * Controlled Heart observations through the real BodySupervisor, one at a time. The periodic timer
 * yield matters: a tight synchronous refresh loop only spins the microtask queue, and the driving
 * Turn's own Heart writes then never reach their timer-backed contention retry.
 */
async function observe(supervisor: BodySupervisor, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await supervisor.refresh();
    if (index % 5 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function highestSequence(paths: TurnFixture["paths"]): Promise<number | null> {
  return (await activitySlice(paths)).highest;
}

/** One stalled Turn driven by exactly `observations` controlled Heart observations, then stopped. */
async function stalledRun(
  context: TestContext,
  prefix: string,
  observations: number,
): Promise<Readonly<{ observations: number; registrations: number }>> {
  const fixture = await turnFixture(context, prefix);
  const pull = new PendingProviderPull();
  const provider = turnProvider({ events: stalledEvents(pull) });
  const control = budgetedControl(fixture.snapshot, observations);
  assert.deepEqual(await driveTurn(driveInput(fixture, provider.adapter, control.supervisor)), {
    kind: "stopped",
  });
  assert.ok(
    control.observed() >= observations,
    `the Turn wait observed ${control.observed()} of ${observations} controlled observations`,
  );
  return { observations, registrations: pull.registrations };
}

test("a stalled Turn keeps exactly one provider registration as control observations grow", async (context) => {
  const few = await stalledRun(context, "kei-turn-wait-few-", 20_000);
  const many = await stalledRun(context, "kei-turn-wait-many-", 200_000);
  const report = `provider registrations after ${few.observations} and ${many.observations} control observations: ${few.registrations} and ${many.registrations}`;
  assert.equal(few.registrations, 1, report);
  assert.equal(many.registrations, 1, report);
});

test("a Tell admitted mid-stall is submitted live once and recorded with its binding", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-tell-");
  const supervisor = await fixture.control();
  const pull = new PendingProviderPull();
  const provider = turnProvider({ events: stalledEvents(pull) });
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor));
  try {
    await armedWait(pull);
    await recordTell(fixture.paths, { kind: "tell", id: "tell-live", body: "keep going", recordedAt: AT });
    await supervisor.refresh();
    await waitForCondition(
      "the live Tell delivery",
      async () => (await readTell(fixture.paths, "tell-live"))?.deliveries.length === 1,
    );
    const tell = await readTell(fixture.paths, "tell-live");
    assert.deepEqual(provider.submissions, [{ id: "tell-live", text: "keep going" }]);
    assert.deepEqual(
      tell?.deliveries.map((delivery) => delivery.route),
      ["live"],
    );
    assert.equal(tell?.state, "told");
    assert.ok(tell?.binding !== undefined && tell.binding.turnSequence > 0);
    supervisor.cancel("control");
    assert.deepEqual(await settlement, { kind: "stopped" });
    assert.equal(provider.submissions.length, 1);
  } finally {
    await supervisor.close();
  }
});

test("provider events are serialized in order and the answer waits for physical closure", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-order-");
  const supervisor = await fixture.control();
  const closure = deferred<void>();
  const events: readonly AgentEvent[] = [
    { type: "session", coordinate: { sessionId: "first-session" } },
    { type: "assistant", text: "first" },
    { type: "note", text: "second" },
    { type: "session", coordinate: { sessionId: "last-session" } },
  ];
  const provider = turnProvider({
    events: narratedEvents(events),
    completion: Promise.resolve({ kind: "answered", answer: "done" }),
    closure: closure.promise,
  });
  let answered = false;
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor)).then((outcome) => {
    answered = true;
    return outcome;
  });
  try {
    await waitForCondition("the last provider event to persist", async () => {
      const activity = (await activitySlice(fixture.paths)).rows.filter((fact) => fact.kind === "activity");
      return activity.length === events.length;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(answered, false, "event exhaustion and completion do not prove closure");
    closure.resolve();
    assert.deepEqual(await settlement, {
      kind: "answered",
      answer: "done",
      turnSequence: 2,
      session: { sessionId: "last-session" },
    });
    assert.deepEqual((await readHeart(fixture.paths)).latestSession?.coordinate, { sessionId: "last-session" });
    const activity = (await activitySlice(fixture.paths)).rows.filter((fact) => fact.kind === "activity");
    assert.deepEqual(
      activity.map((fact) => fact.event),
      events,
    );
  } finally {
    closure.resolve();
    supervisor.cancel("control");
    await supervisor.close();
  }
});

test("provider completion failure preserves its diagnostic and retires the stalled attempt", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-failure-");
  const supervisor = await fixture.control();
  const completion = deferred<TurnResult>();
  const pull = new PendingProviderPull();
  const provider = turnProvider({ events: stalledEvents(pull), completion: completion.promise });
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor));
  try {
    await armedWait(pull);
    completion.reject(new Error("provider completion failed"));
    assert.deepEqual(await settlement, { kind: "failed", diagnostic: "provider completion failed", turnSequence: 2 });
    assert.equal(provider.aborts(), 1);
    assert.equal(pull.registrations, 1);
  } finally {
    await supervisor.close();
  }
});

test("control during retirement does not erase an already observed provider failure", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-failure-control-");
  const supervisor = await fixture.control();
  const completion = deferred<TurnResult>();
  const closure = deferred<void>();
  const pull = new PendingProviderPull();
  const provider = turnProvider({
    events: stalledEvents(pull),
    completion: completion.promise,
    closure: closure.promise,
  });
  let settled = false;
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor)).finally(() => {
    settled = true;
  });
  try {
    await armedWait(pull);
    const diagnostic = "provider failed before control";
    completion.reject(new Error(diagnostic));
    await waitForCondition("retirement to begin before control", () => provider.aborts() === 1);
    assert.equal(supervisor.signal.aborted, false);
    assert.equal((await requestStop(fixture.paths, AT)).kind, "requested");
    await waitForCondition("BodySupervisor to observe the stop", () => supervisor.signal.aborted);
    assert.equal(settled, false, "abort acknowledgement is not closure proof");
    closure.resolve();
    assert.deepEqual(await settlement, { kind: "failed", diagnostic, turnSequence: 2 });
  } finally {
    closure.resolve();
    supervisor.cancel("control");
    await supervisor.close();
  }
});

test("a failed Heart read fails the stalled Turn and retires its provider", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-observation-failure-");
  const supervisor = await fixture.control();
  const lastGood = supervisor.current();
  const pull = new PendingProviderPull();
  const provider = turnProvider({ events: stalledEvents(pull) });
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor));
  try {
    await armedWait(pull);
    // Keep the Heart present. Its real background reader must reject, not see disappearance.
    const database = new DatabaseSync(fixture.paths.heart);
    try {
      database.exec("PRAGMA ignore_check_constraints=ON; UPDATE akuma_schema SET version = -1");
    } finally {
      database.close();
    }
    const failure = await readHeart(fixture.paths).catch((error: unknown) => error);
    assert.ok(failure instanceof Error, "corrupt Heart must fail a direct read");
    const diagnostic = failure.message;
    await waitForCondition("the failed observation to retire the provider", () => provider.aborts() === 1, {
      budgetMs: 5_000,
    });
    assert.deepEqual(await settlement, { kind: "failed", diagnostic, turnSequence: 2 });
    assert.equal(supervisor.signal.aborted, false);
    assert.equal(pull.registrations, 1);
    assert.throws(() => supervisor.current(), { message: diagnostic });
    await assert.rejects(supervisor.next(lastGood), { message: diagnostic });
  } finally {
    supervisor.cancel("control");
    await supervisor.close();
  }
});

test("stop is responsive and later control observations write nothing", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-stop-");
  const supervisor = await fixture.control();
  const pull = new PendingProviderPull();
  const provider = turnProvider({ events: stalledEvents(pull) });
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor));
  try {
    await armedWait(pull);
    const before = await highestSequence(fixture.paths);
    const startedAt = performance.now();
    supervisor.cancel("control");
    assert.deepEqual(await settlement, { kind: "stopped" });
    assert.ok(performance.now() - startedAt < CONTROL_RESPONSE_MS + 1_000, "stop did not settle promptly");
    await observe(supervisor, 25);
    assert.equal(await highestSequence(fixture.paths), before);
    assert.deepEqual(provider.submissions, []);
    assert.equal(pull.registrations, 1);
  } finally {
    await supervisor.close();
  }
});

test("Heart loss ends the stalled wait, retires custody, and leaves no later evidence", async (context) => {
  const fixture = await turnFixture(context, "kei-turn-wait-heart-");
  const supervisor = await fixture.control();
  const late = deferred<IteratorResult<AgentEvent>>();
  const pull = new PendingProviderPull((resolve) => resolve(late.promise));
  const provider = turnProvider({ events: stalledEvents(pull) });
  const settlement = driveTurn(driveInput(fixture, provider.adapter, supervisor));
  try {
    await armedWait(pull);
    rmSync(fixture.paths.heart, { force: true });
    assert.deepEqual(await settlement, { kind: "stopped" });
    late.resolve({ done: false, value: { type: "note", text: "late provider event" } });
    await late.promise;
    await supervisor.refresh();
    assert.equal(await heartExists(fixture.paths), false);
    assert.equal(provider.aborts(), 1);
    assert.equal(pull.registrations, 1);
  } finally {
    await supervisor.close();
  }
});
