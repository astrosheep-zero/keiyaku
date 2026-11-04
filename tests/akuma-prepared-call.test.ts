import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLauncher, ChildBodyLaunch } from "../src/akuma/body-launch.js";
import { Schema } from "../src/akuma/schema.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { settings } from "../src/settings.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { answering } from "./support/akuma-tell.js";
import { Square, DeliveryLedger, harnessOwner } from "@astrosheep/square";
import test from "node:test";
import { HeldAkumaLeash, projectTell, readSoul, readTell, type TellFact } from "../src/akuma/heart/index.js";
import { akumaRunRoot, pathsForAkuId } from "../src/akuma/identity.js";
import type {
  CallInitialTellAdmission,
  InitialTellAdmissionInput,
  TellResult,
} from "../src/akuma/call-initial-tell.js";
import { executePreparedCall, type PreparedCallRecipe } from "../src/akuma/publication.js";
import { World } from "../src/world.js";
import { restoreEnvironmentValues, temporaryDirectory } from "./support/process.js";

const AT = "2026-08-09T00:00:00.000Z";

function rawRecipe(overrides: Partial<PreparedCallRecipe> = {}): PreparedCallRecipe {
  return {
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    ...overrides,
  };
}

/** Birth one already-allocated child through its own leash, the way a real spawn body would. */
async function birth(launch: ChildBodyLaunch, createdAt = AT): Promise<void> {
  const leash = await HeldAkumaLeash.try(launch.paths);
  if (leash === null) throw new Error("expected a free child leash");
  try {
    await leash.birth(launch.paths, { ...launch.seed, createdAt });
  } finally {
    leash.release();
  }
}

function tellResult(tellId: string): TellResult {
  const fact: TellFact = {
    kind: "tell",
    sequence: 1,
    id: tellId,
    body: "",
    recordedAt: AT,
    state: "told",
    deliveries: [],
  };
  return { admission: { fact: "recorded", tellId }, row: projectTell(fact), wake: { kind: "told" } };
}

function admittedTell(tellId: string): CallInitialTellAdmission {
  const result = tellResult(tellId);
  return {
    kind: "admitted",
    tell: {
      kind: "tell",
      sequence: 1,
      id: tellId,
      body: "",
      recordedAt: AT,
      state: "pending",
      deliveries: [],
    },
    wake: Promise.resolve(result),
  };
}

/** The child run directory entries, or an empty list when no child was ever allocated. */
async function childRuns(root: string): Promise<readonly string[]> {
  try {
    return await readdir(akumaRunRoot(root));
  } catch {
    return [];
  }
}

test("bounded call protects its exact first Tell before admission can finish", { timeout: 15_000 }, async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-call-scope-"));
  const variables = [
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
    "PASEO_AGENT_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "SQUARE_PARTICIPANT_NAME",
    "SQUARE_DELIVERY",
    "SQUARE_INDEX",
  ];
  const prior = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  variables.forEach((key) => {
    delete process.env[key];
  });
  process.env.PI_SESSION_ID = "bounded-call";
  process.env.SQUARE_PARTICIPANT_NAME = "Requester";
  process.env.SQUARE_DELIVERY = join(world, "delivery.sqlite");
  process.env.SQUARE_INDEX = join(world, "square-index");
  t.after(() => restoreEnvironmentValues(prior));
  mkdirSync(join(world, ".square"), { recursive: true });
  const square = await Square.build({ path: join(world, ".square", "KEIYAKU.square"), markdown: "" });
  const owner = harnessOwner({ channel: "pi", session: "bounded-call" });
  await square.join("Requester", { owner });
  const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
  t.after(async () => {
    await square.close();
    await ledger.close();
  });
  const cards = async () => {
    const session = await ledger.session(owner);
    assert.ok(session);
    return await ledger.pending(owner, { generation: session.generation });
  };
  const output = join(world, "call-trace.jsonl");
  const trace = (): unknown[][] =>
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  mkdirSync(join(world, "plugins"), { recursive: true });
  writeFileSync(
    join(world, "plugins", "call.mjs"),
    `
      import { appendFileSync } from "node:fs";
      import squarePlugin from ${JSON.stringify(new URL("../plugins/square/index.js", import.meta.url).href)};
      export default { manifest: { ...squarePlugin.manifest, id: "call" }, async activate(context) {
        const actual = await squarePlugin.activate(context);
        const record = value => appendFileSync(${JSON.stringify(output)}, JSON.stringify(value) + "\\n");
        return {
          async waitDeferral(input, signal) {
            const resource = await actual.waitDeferral(input, signal);
            record(["acquire", input]);
            return { async close(signal) { await resource?.close(signal); record(["close"]); } };
          },
          signals: {
            "akuma.turn-outcome": async signal => {
              await actual.signals["akuma.turn-outcome"](signal);
              record(["produced", signal.akumaId, signal.turnSequence, signal.tellIds]);
            },
            "akuma.outcome-observed": async signal => {
              await actual.signals["akuma.outcome-observed"](signal);
              record(["observe", signal.akumaId, signal.historyId]);
            }
          }
        };
      } };
    `,
  );
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: fixture\n---\nWork.\n");
  writeFileSync(
    join(world, ".keiyaku", "settings.json"),
    JSON.stringify({
      providers: { fixture: { kind: "claude-agent-sdk" } },
      plugins: {
        square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
        call: { package: "./plugins/call.mjs" },
      },
    }),
  );
  const selected = await settings({ root: world, home: join(world, "empty-home") });
  let bounded = true;
  const spawn: BodyLauncher = async (launch) => {
    if (bounded) {
      const first = trace()[0];
      assert.equal(first?.[0], "acquire", "scope exists even before child birth");
      assert.deepEqual((first?.[1] as { akumaIds: string[] }).akumaIds, []);
      assert.equal(
        trace().some((row) => row[0] === "close"),
        false,
      );
    }
    // Complete provider work before returning launch/admission to expose the fast-first-Tell gap.
    await driveAkumaBody(launch, answering('{"ok":true}'), {
      spawn: noBodyLaunch,
      now: () => AT,
    });
    return { completed: Promise.resolve({ diagnostic: "fixture finished" }), cancel: async () => {}, release() {} };
  };
  const api = akumasWithLauncher(world, spawn);
  const schema = Schema.json({ type: "object" }, (value) => {
    assert.deepEqual(trace().slice(-1)[0]?.slice(0, 1), ["observe"], "ACK attempt precedes decode and close");
    return value;
  });
  const result = await api.call({
    archetype: "worker",
    body: "work",
    mode: "wait",
    settings: selected,
    schema,
    initiator: "Requester",
    signal: t.signal,
    observe: {
      admitted: async () => {
        assert.equal(
          trace().some((row) => row[0] === "produced"),
          true,
          "the first Tell finished before call admission returned",
        );
        assert.deepEqual(await cards(), [], "UUID lease protected the producer before the requester knew its child ID");
      },
    },
  });
  assert.equal(result.observation.kind, "observed");
  if (result.observation.kind === "observed")
    assert.deepEqual(result.observation.observation, { reason: "answered", answer: { ok: true } });
  const input = trace()[0]?.[1] as { akumaIds: string[]; initialTellId: string };
  assert.match(input.initialTellId, /^[0-9a-f-]{36}$/u);
  const tell = await readTell(pathsForAkuId(world, result.akuma), input.initialTellId);
  assert.ok(tell?.binding);
  assert.deepEqual(trace(), [
    ["acquire", input],
    ["produced", result.akuma, tell.binding.turnSequence, [input.initialTellId]],
    ["observe", result.akuma, `turn/${tell.binding.turnSequence}`],
    ["close"],
  ]);
  assert.deepEqual(await cards(), [], "exact observation consumed the held notice before releasing the UUID lease");
  bounded = false;
  writeFileSync(output, "");
  await api.call({ archetype: "worker", settings: selected, signal: t.signal });
  await api.call({ archetype: "worker", body: "detached", settings: selected, signal: t.signal });
  assert.equal(
    trace().some((row) => row[0] === "acquire" || row[0] === "close" || row[0] === "observe"),
    false,
    "prompt-free and detached calls acquire no answer scope",
  );
});

const rejectedTell = async (input: InitialTellAdmissionInput): Promise<CallInitialTellAdmission> => {
  throw new Error(`unexpected initial Tell ${input.initialTell.tellId}`);
};

test("the prepared executor admits local provider options itself and refuses unsupported ones before birth", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-refuse-"));
  await assert.rejects(
    executePreparedCall({
      archetype: "worker",
      cwd: root,
      world: root,
      recipe: rawRecipe({ options: { network: "enabled" } }),
      spawn: async (launch) => await birth(launch),
      admitInitialTell: rejectedTell,
    }),
    /Claude provider does not support the network option/u,
  );
  assert.deepEqual(await childRuns(root), []);
});

test("local custody carries a raw recipe the executor admits once and births with", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-local-"));
  const recipe = rawRecipe({ description: "Worker", options: { model: "claude-sonnet-4-5" } });
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    world: root,
    recipe,
    spawn: async (launch) => await birth(launch),
    admitInitialTell: rejectedTell,
  });
  assert.equal(result.failure, undefined);
  const soul = await readSoul(result.child.paths);
  assert.equal(soul?.id, result.child.id);
  assert.equal(soul?.cwd, root);
  assert.deepEqual(soul?.options, { model: "claude-sonnet-4-5" });
  assert.equal(Object.isFrozen(soul?.options), true);
  assert.deepEqual(soul?.origin, { kind: "direct" });
});

test("a durably born child survives a later launch failure and returns the native failure", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-born-"));
  const failure = new Error("post-birth launch failure");
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    world: root,
    recipe: rawRecipe(),
    spawn: async (launch) => {
      await birth(launch);
      throw failure;
    },
    admitInitialTell: rejectedTell,
  });
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, failure);
  assert.equal(result.tell, undefined);
});

test("an abort after confirmed birth keeps the child and its native reason", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-abort-"));
  const controller = new AbortController();
  const reason = new Error("stop after birth");
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    signal: controller.signal,
    world: root,
    recipe: rawRecipe(),
    spawn: async (launch) => {
      await birth(launch);
      controller.abort(reason);
    },
    admitInitialTell: rejectedTell,
  });
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, reason);
});

test("the exact admitted initial Tell is preserved and a missing admission never invents one", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-tell-"));
  const tellId = "2f1c4b6a-0000-4000-8000-000000000001";
  const seen: string[] = [];
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    initialTell: { tellId, body: "begin" },
    world: root,
    recipe: rawRecipe(),
    spawn: async (launch) => await birth(launch),
    admitInitialTell: async (input) => {
      seen.push(input.initialTell.tellId);
      return admittedTell(input.initialTell.tellId);
    },
  });
  assert.deepEqual(seen, [tellId]);
  assert.deepEqual(result.tell, tellResult(tellId));

  const missingRoot = await World.at(temporaryDirectory(context, "keiyaku-prepared-notborn-"));
  const missing = await executePreparedCall({
    archetype: "worker",
    cwd: missingRoot,
    initialTell: { tellId, body: "begin" },
    world: missingRoot,
    recipe: rawRecipe(),
    spawn: async (launch) => await birth(launch),
    admitInitialTell: async () => ({ kind: "not-born" }),
  });
  assert.equal(missing.tell, undefined);
  assert.match(String(missing.failure), /was not born for its initial Tell/u);
});

test("a failed initial Tell wake keeps the born child and the native failure", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-wake-"));
  const failure = new Error("tell wake failed");
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    initialTell: { tellId: "2f1c4b6a-0000-4000-8000-000000000002", body: "begin" },
    world: root,
    recipe: rawRecipe(),
    spawn: async (launch) => await birth(launch),
    admitInitialTell: async (input) => ({
      kind: "admitted",
      tell: {
        kind: "tell",
        sequence: 1,
        id: input.initialTell.tellId,
        body: "",
        recordedAt: AT,
        state: "pending",
        deliveries: [],
      },
      wake: Promise.reject(failure),
    }),
  });
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, failure);
});
