import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { Square, type Participant, type Body } from "@astrosheep/square";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { squareSeat } from "../src/cli/square-identity.js";
import type { WorldRoot } from "../src/world.js";
import { runCli } from "./support/cli-fixtures.js";
import { restoreEnvironmentValues, temporaryDirectory } from "./support/process.js";

/** Every ambient coordinate a fixture must own before it can observe a session. */
const SESSION_VARIABLES = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "PASEO_AGENT_ID",
  "SQUARE_PARTICIPANT_NAME",
] as const;

type SeatWorld = Readonly<{
  root: string;
  world: WorldRoot;
  home: string;
  squareFile: string;
  environment: (session?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}>;

/**
 * One established World with its own home and Square directory. The host ledger is
 * the shared user-level registry, so the fixture points it inside the temporary
 * root instead of the developer's live ledger.
 */
function seatWorld(t: TestContext): SeatWorld {
  const root = temporaryDirectory(t, "keiyaku-assigned-");
  const home = join(root, "home");
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  mkdirSync(join(root, ".square"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const prior = {
    ...Object.fromEntries(SESSION_VARIABLES.map((name) => [name, process.env[name]])),
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SQUARE_INDEX: process.env.SQUARE_INDEX,
  };
  for (const name of SESSION_VARIABLES) delete process.env[name];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SQUARE_INDEX = join(root, "index.ndjsonl");
  t.after(() => restoreEnvironmentValues(prior));
  return {
    root,
    world: root as WorldRoot,
    home,
    squareFile: join(root, ".square", "KEIYAKU.square"),
    environment: (session = {}) => ({ ...process.env, KEIYAKU_HOME: home, ...session }),
  };
}

/** Install session coordinates for the process too: the shipped observer reads process.env. */
function installSession(t: TestContext, session: NodeJS.ProcessEnv): void {
  const prior = Object.fromEntries(Object.keys(session).map((name) => [name, process.env[name]]));
  Object.assign(process.env, session);
  t.after(() => restoreEnvironmentValues(prior));
}

/** Open the fixture Square, building it once exactly as the shipped observer would. */
function bodyFor(environment: NodeJS.ProcessEnv): Body {
  for (const [variable, channel] of [["PI_SESSION_ID", "pi"], ["CODEX_THREAD_ID", "codex"],
    ["CLAUDE_CODE_SESSION_ID", "claude-code"], ["OPENCODE_SESSION_ID", "opencode"], ["PASEO_AGENT_ID", "paseo"]]) {
    const session = environment[variable!];
    if (session) return { channel: channel!, session };
  }
  return { channel: "fixture", session: "read-only" };
}

async function openSquareFile(world: SeatWorld, session: NodeJS.ProcessEnv): Promise<Square> {
  const env = world.environment(session);
  const identity = { env, body: bodyFor(env) };
  try {
    return await Square.at({ path: world.squareFile, ...identity });
  } catch {
    try {
      return await Square.build({ path: world.squareFile, markdown: "", ...identity });
    } catch {
      return await Square.at({ path: world.squareFile, ...identity });
    }
  }
}

/** Join one participant as the fixture's own session, exactly as native hooks do. */
async function withJoined<T>(
  world: SeatWorld,
  session: NodeJS.ProcessEnv,
  name: string,
  operation: (participant: Participant) => Promise<T>,
): Promise<T> {
  const square = await openSquareFile(world, session);
  try {
    const joined = await square.implicitJoin(name);
    assert.ok(joined.participant, `fixture joined ${name}`);
    return await operation(joined.participant);
  } finally {
    await square.close();
  }
}

async function recognize(world: SeatWorld, session: NodeJS.ProcessEnv): Promise<string | undefined> {
  const square = await openSquareFile(world, session);
  try {
    const recognized = await square.recognize();
    return recognized.length === 1 ? recognized[0]!.name : undefined;
  } finally {
    await square.close();
  }
}

test("a fresh supported session derives one keiyaku-assigned name and no provider prefix", async (t) => {
  const world = seatWorld(t);
  const first = await squareSeat({ path: world.world, environment: world.environment({ PI_SESSION_ID: "one" }) });
  assert.match(first ?? "", /^keiyaku-assigned-[0-9a-f]{12}$/u);
  assert.doesNotMatch(first ?? "", /auto|^(?:pi|codex|claude|opencode)-/u);
  assert.equal(
    await squareSeat({ path: world.world, environment: world.environment({ PI_SESSION_ID: "one" }) }),
    first,
    "the same session derives the same seat across invocations",
  );
  const other = await squareSeat({ path: world.world, environment: world.environment({ PI_SESSION_ID: "two" }) });
  assert.notEqual(other, first, "another session does not share the seat");
  const crossProvider = await squareSeat({
    path: world.world,
    environment: world.environment({ CODEX_THREAD_ID: "one" }),
  });
  assert.notEqual(crossProvider, first, "the same raw token under another provider is another coordinate");
  assert.equal(
    await squareSeat({
      path: world.world,
      environment: world.environment({ PI_SESSION_ID: "one", CODEX_THREAD_ID: "two" }),
    }),
    undefined,
    "an ambiguous native identity selects nothing",
  );
  assert.equal(
    await squareSeat({ path: world.world, environment: world.environment() }),
    undefined,
    "no native identity selects nothing",
  );
});

test("a managed session reuses its established voice without inventing a fresh name", async (t) => {
  const world = seatWorld(t);
  const session = { PASEO_AGENT_ID: "managed-only" };
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(session) }), undefined);
  await withJoined(world, session, "Managed", async () => undefined);
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(session) }), "Managed");
});

test("an explicit Square name is authoritative and an unusable one selects nothing", async (t) => {
  const world = seatWorld(t);
  await withJoined(world, { PI_SESSION_ID: "one" }, "pi-legacy", async () => undefined);
  assert.equal(
    await squareSeat({
      path: world.world,
      environment: world.environment({ PI_SESSION_ID: "one", SQUARE_PARTICIPANT_NAME: "Custom" }),
    }),
    "Custom",
    "an explicit name outranks the established binding",
  );
  assert.equal(
    await squareSeat({
      path: world.world,
      environment: world.environment({ PI_SESSION_ID: "one", SQUARE_PARTICIPANT_NAME: "not a name" }),
    }),
    undefined,
    "Square owns the name grammar; an unusable explicit name selects nothing",
  );
});

test("an established legacy participant is reused and a prepared seat becomes recognizable", async (t) => {
  const world = seatWorld(t);
  const legacy = { PI_SESSION_ID: "legacy" };
  await withJoined(world, legacy, "pi-legacy", async () => undefined);
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(legacy) }), "pi-legacy");
  assert.equal(await recognize(world, legacy), "pi-legacy");

  const fresh = { PI_SESSION_ID: "fresh" };
  const seat = await squareSeat({ path: world.world, environment: world.environment(fresh) });
  assert.match(seat ?? "", /^keiyaku-assigned-[0-9a-f]{12}$/u);
  assert.equal(await recognize(world, fresh), undefined, "nothing is recognizable before preparation");
  await withJoined(world, fresh, seat!, async () => undefined);
  assert.equal(await recognize(world, fresh), seat, "the prepared seat is one real recognizable participant");
});

test("an existing old-prefix participant is reused and never replaced after finishing", async (t) => {
  const world = seatWorld(t);
  const session = { PI_SESSION_ID: "old-prefix" };
  const assigned = await squareSeat({ path: world.world, environment: world.environment(session) });
  assert.ok(assigned);
  const previous = assigned.replace("keiyaku-assigned-", "keiyaku-seat-");
  await withJoined(world, session, previous, async () => undefined);
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(session) }), previous);
  await withJoined(world, session, previous, async (participant) => await participant.done());
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(session) }), undefined);
});

test("a finished seat is not proposed again or implicitly rejoined", async (t) => {
  const world = seatWorld(t);
  const session = { PI_SESSION_ID: "finished" };
  const seat = await squareSeat({ path: world.world, environment: world.environment(session) });
  await withJoined(world, session, seat!, async (participant) => await participant.done());
  assert.equal(
    await squareSeat({ path: world.world, environment: world.environment(session) }),
    undefined,
    "a finished seat selects no fresh candidate",
  );
  const square = await openSquareFile(world, session);
  try {
    assert.equal((await square.implicitJoin(seat!)).state, "done", "standing stays Square's decision");
    assert.deepEqual(await square.recognize(), []);
  } finally {
    await square.close();
  }
});

test("recognition ambiguity is artifact-owned even when the discovery index is absent", async (t) => {
  const world = seatWorld(t);
  const session = { PI_SESSION_ID: "crowded" };
  await withJoined(world, session, "Alpha", async () => undefined);
  await withJoined(world, session, "Beta", async () => undefined);
  writeFileSync(process.env.SQUARE_INDEX!, "");
  assert.equal(await recognize(world, session), undefined);
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(session) }), undefined);
});

test("a finished legacy participant is not replaced by a new seat", async (t) => {
  const world = seatWorld(t);
  const session = { PI_SESSION_ID: "legacy-done" };
  const former = `pi-${createHash("sha256").update(session.PI_SESSION_ID).digest("hex").slice(0, 12)}`;
  assert.match(former ?? "", /^pi-/u);
  await withJoined(world, session, former!, async (participant) => await participant.done());

  assert.equal(
    await squareSeat({ path: world.world, environment: world.environment(session) }),
    undefined,
    "done standing selects no replacement identity",
  );

  const trace = join(world.root, "trace.txt");
  writeTracePlugin(world.root, trace);
  const result = await runCli(["call", "ghost", "hi"], {
    cwd: world.root,
    environment: world.environment(session),
  });
  assert.equal(result.exit, 1, `only the missing archetype refuses: ${result.stderr}`);
  assert.deepEqual(traced(trace), [], "nothing is prepared for a finished identity");
});

test("two live bindings for one session select nothing", async (t) => {
  const world = seatWorld(t);
  const session = { PI_SESSION_ID: "twice" };
  await withJoined(world, session, "alpha", async () => undefined);
  await withJoined(world, session, "beta", async () => undefined);
  assert.equal(await recognize(world, session), undefined, "Square refuses to name an ambiguous session");
  assert.equal(await squareSeat({ path: world.world, environment: world.environment(session) }), undefined);
});

/** A selected observer that records the initiator each submitting edge prepares. */
function writeTracePlugin(root: string, trace: string): void {
  mkdirSync(join(root, "plugins"), { recursive: true });
  writeFileSync(
    join(root, "plugins", "alpha.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "export default {",
      '  manifest: { id: "alpha", apiVersion: 1 },',
      "  activate(context) {",
      "    return {",
      '      signals: { "akuma.initiating": (signal) => appendFileSync(context.config.trace, `signal:${signal.initiator}\\n`) },',
      "    };",
      "  },",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { alpha: { package: "./plugins/alpha.mjs", config: { trace } } } }),
  );
}

function traced(trace: string): readonly string[] {
  return existsSync(trace)
    ? readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
    : [];
}

test("call, tell, ask, and fork prepare one seat before forwarding", async (t) => {
  const world = seatWorld(t);
  const trace = join(world.root, "trace.txt");
  writeTracePlugin(world.root, trace);
  const environment = world.environment({ PI_SESSION_ID: "submitting" });
  const seat = await squareSeat({ path: world.world, environment });
  assert.match(seat ?? "", /^keiyaku-assigned-[0-9a-f]{12}$/u);
  const address = "aku/ghost/00000001";
  for (const argv of [
    ["call", "ghost", "hi"],
    ["tell", address, "hi"],
    ["ask", address, "hi"],
    ["fork", address, "--at", "turn/1"],
  ]) {
    const result = await runCli(argv, { cwd: world.root, environment });
    assert.equal(result.exit, 1, `${argv[0]} refuses the missing Akuma: ${result.stderr}`);
  }
  assert.deepEqual(traced(trace), [`signal:${seat}`, `signal:${seat}`, `signal:${seat}`, `signal:${seat}`]);
  const declared = await runCli(["tell", address, "hi"], {
    cwd: world.root,
    environment: { ...environment, KEIYAKU_INITIATOR: "Integration" },
  });
  assert.equal(declared.exit, 1);
  assert.equal(
    traced(trace).at(-1),
    "signal:Integration",
    "a generic integration initiator outranks the Square selection",
  );
});

test("the shipped Square observer prepares the seat this session is then recognized as", async (t) => {
  const world = seatWorld(t);
  installSession(t, { PI_SESSION_ID: "shipped" });
  const environment = world.environment();
  const seat = await squareSeat({ path: world.world, environment });
  const result = await runCli(["call", "ghost", "hi"], { cwd: world.root, environment });
  assert.equal(result.exit, 1, `call refuses the missing archetype: ${result.stderr}`);
  const square = await openSquareFile(world, {});
  try {
    const active = (await square.participants()).participants.filter(({ state }) => state === "active");
    assert.deepEqual(
      active.map(({ name }) => name),
      [seat],
      "preparation created exactly the selected participant",
    );
    assert.deepEqual((await square.recognize()).map(({ name }) => name), [seat], "native resolution finds that one binding");
  } finally {
    await square.close();
  }
});

test("concurrent same-session preparations converge on one standing participant", async (t) => {
  const world = seatWorld(t);
  const session = { PI_SESSION_ID: "concurrent" };
  const seat = await squareSeat({ path: world.world, environment: world.environment(session) });
  await Promise.all([
    withJoined(world, session, seat!, async () => undefined),
    withJoined(world, session, seat!, async () => undefined),
  ]);
  assert.equal(await recognize(world, session), seat);
  const square = await openSquareFile(world, session);
  try {
    assert.deepEqual((await square.recognize()).map(({ name }) => name), [seat]);
    assert.equal((await square.history({ from: [seat!], limit: null })).activities.filter(({ kind }) => kind === "join").length, 1);
  } finally { await square.close(); }
});

test("a genuinely absent Square selects the deterministic candidate", async (t) => {
  const world = seatWorld(t);
  assert.equal(existsSync(world.squareFile), false, "the fixture has not created a Square yet");
  const seat = await squareSeat({ path: world.world, environment: world.environment({ PI_SESSION_ID: "absent" }) });
  assert.match(seat ?? "", /^keiyaku-assigned-[0-9a-f]{12}$/u);
  assert.equal(existsSync(world.squareFile), false, "selecting a candidate creates no Square");
});

test("an existing but unusable Square selects no fresh identity", async (t) => {
  const world = seatWorld(t);
  writeFileSync(world.squareFile, "corrupt bytes where an artifact belongs");
  const environment = world.environment({ PI_SESSION_ID: "review-session" });
  await assert.rejects(Square.at({ path: world.squareFile, env: environment }), /Invalid square artifact/u);
  assert.equal(await squareSeat({ path: world.world, environment }), undefined);
  assert.equal(readFileSync(world.squareFile, "utf8"), "corrupt bytes where an artifact belongs", "nothing was rewritten");
});

test("the captured environment decides which registry is read, not this process's own", async (t) => {
  const world = seatWorld(t);
  const elsewhere = join(world.root, "submitted-ledger");
  const environment = { ...world.environment({ PI_SESSION_ID: "captured-session" }), SQUARE_INDEX: elsewhere };
  const square = await openSquareFile(world, {
    PI_SESSION_ID: "captured-session",
    SQUARE_INDEX: elsewhere,
  });
  try {
    await square.implicitJoin("ExistingCustom");
  } finally {
    await square.close();
  }
  assert.equal(
    await squareSeat({ path: world.world, environment }),
    "ExistingCustom",
    "recognition and the registry are read from the submitted environment",
  );
});

test("a name another session already holds is never replaced by a seat", async (t) => {
  const world = seatWorld(t);
  installSession(t, { PI_SESSION_ID: "holder" });
  const holder = await openSquareFile(world, {});
  try {
    await holder.implicitJoin("Held");
  } finally {
    await holder.close();
  }
  process.env.PI_SESSION_ID = "claimant";
  const environment = world.environment({ SQUARE_PARTICIPANT_NAME: "Held" });
  const result = await runCli(["call", "ghost", "hi"], { cwd: world.root, environment });
  assert.equal(result.exit, 1, `only the missing archetype refuses: ${result.stderr}`);
  const square = await openSquareFile(world, {});
  try {
    assert.deepEqual(
      (await square.participants()).participants.map(({ name }) => name),
      ["Held"],
      "the edge neither takes the name over nor invents a replacement identity",
    );
  } finally {
    await square.close();
  }
});

test("a child Akuma environment never carries the parent seat as its identity", () => {
  const child = akumaExecutionEnvironment(
    {
      PI_SESSION_ID: "parent-session",
      SQUARE_PARTICIPANT_NAME: "keiyaku-assigned-0123456789ab",
      KEIYAKU_INITIATOR: "Parent",
      KEIYAKU_EXTERNAL_CALLER: "paseo:parent",
      PATH: "/usr/bin",
    },
    {},
  );
  assert.equal(child.SQUARE_PARTICIPANT_NAME, undefined);
  assert.equal(child.PI_SESSION_ID, undefined);
  assert.equal(child.KEIYAKU_INITIATOR, undefined, "a nested submission cannot inherit the parent's initiator");
  assert.equal(child.KEIYAKU_EXTERNAL_CALLER, undefined);
  assert.equal(child.PATH, "/usr/bin");
});

test("identity observation settles within its budget when Square does not cooperate", async (t) => {
  const world = seatWorld(t);
  const environment = world.environment({ PI_SESSION_ID: "delayed" });
  t.mock.method(Square, "at", () => new Promise<never>(() => undefined));
  const started = performance.now();
  assert.equal(await squareSeat({ path: world.world, environment }, { budgetMs: 50 }), undefined);
  assert.ok(performance.now() - started < 2_000, "a stalled Square read does not hold the submission");
});

test("identity observation settles when the caller cancels it", async (t) => {
  const world = seatWorld(t);
  const environment = world.environment({ PI_SESSION_ID: "cancelled" });
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await squareSeat({ path: world.world, environment }, { signal: controller.signal }),
    undefined,
    "cancellation selects nothing and raises nothing",
  );
});

test("a session with no coordinate reads no Square at all", async (t) => {
  const world = seatWorld(t);
  const at = t.mock.method(Square, "at", async () => {
    throw new Error("a sessionless submission must not read Square");
  });
  assert.equal(await squareSeat({ path: world.world, environment: world.environment() }), undefined);
  assert.equal(at.mock.callCount(), 0);
});
