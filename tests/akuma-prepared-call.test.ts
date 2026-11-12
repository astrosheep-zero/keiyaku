import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLauncher, ChildBodyLaunch } from "../src/akuma/body-launch.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { KeiyakuError, type SpawnResult } from "../src/index.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { Settings } from "../src/settings.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { answering } from "./support/akuma-tell.js";
import { DeliveryLedger, harnessOwner } from "@astrosheep/square";
import test from "node:test";
import { HeldAkumaLeash, readSeal, readSoul, readTell } from "../src/akuma/heart/index.js";
import { akumaRunRoot, pathsForAkumaId, type AkumaId } from "../src/akuma/identity.js";
import type {
  CallInitialTellAdmission,
  InitialTellAdmissionInput,
  TellResult,
} from "../src/akuma/call-initial-tell.js";
import { prepareCall, publishPreparedCall, type PreparedCallRecipe } from "../src/akuma/publication.js";
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
  return {
    admission: { tellId },
    row: { sequence: 1, at: AT, text: "" },
    wake: { kind: "told" },
  };
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
    return (await readdir(akumaRunRoot(root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

test(
  "bounded call suppresses its allocated child before birth and its fast first outcome",
  { timeout: 15_000 },
  async (t) => {
    const world = await World.at(temporaryDirectory(t, "keiyaku-call-scope-"));
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
    process.env.PI_SESSION_ID = "bounded-call";
    process.env.SQUARE_DELIVERY = join(world, "delivery.sqlite");
    t.after(() => restoreEnvironmentValues(prior));
    const owner = harnessOwner({ channel: "pi", session: "bounded-call" });
    const ledger = await DeliveryLedger.open({ location: process.env.SQUARE_DELIVERY });
    assert.ok(await ledger.attach({ owner, expectedGeneration: null, routes: [] }));
    t.after(async () => {
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
              record(["produced", signal.akumaId, signal.turnSequence]);
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
    const selected = await Settings.load({ cwd: world, home: join(world, "empty-home") });
    let bounded = true;
    const spawn: BodyLauncher = async (launch) => {
      if (bounded) {
        const first = trace()[0];
        assert.equal(first?.[0], "acquire", "scope exists even before child birth");
        const allocatedId = launch.seed?.id ?? (await readSoul(launch.paths))?.id;
        assert.deepEqual((first?.[1] as { akumaIds: string[] }).akumaIds, [allocatedId]);
        if (launch.seed !== undefined)
          assert.equal(await readSoul(launch.paths), null, "suppression preceded Soul publication");
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

    const result = await api.spawn({
      akumaName: "worker",
      body: "work",
      mode: "wait",
      settings: selected,
      initiator: owner,
      signal: t.signal,
      observe: {
        admitted: async () => {
          assert.equal(
            trace().some((row) => row[0] === "produced"),
            true,
            "the first Tell finished before call admission returned",
          );
          assert.deepEqual(await cards(), [], "allocated-child prefix protects even the fastest initial outcome");
        },
      },
    });
    assert.equal(result.input?.kind, "answered");
    assert.deepEqual(result.input, { kind: "answered", answer: '{"ok":true}' });
    const input = trace()[0]?.[1] as { akumaIds: string[] };
    assert.deepEqual(input.akumaIds, [result.akumaId]);
    const tell = await readTell(pathsForAkumaId(world, result.akumaId), result.tellId!);
    assert.ok(tell?.binding);
    assert.deepEqual(trace(), [
      ["acquire", input],
      ["produced", result.akumaId, tell.binding.turnSequence],
      ["observe", result.akumaId, `turn/${tell.binding.turnSequence}`],
      ["close"],
    ]);
    assert.deepEqual(await cards(), [], "exact observation survives release of its temporary prefix");
    bounded = false;
    writeFileSync(output, "");
    await api.spawn({ akumaName: "worker", settings: selected, signal: t.signal });
    await api.spawn({ akumaName: "worker", body: "detached", settings: selected, signal: t.signal });
    assert.equal(
      trace().some((row) => row[0] === "acquire" || row[0] === "close" || row[0] === "observe"),
      false,
      "prompt-free and detached calls acquire no answer scope",
    );
  },
);

const rejectedTell = async (input: InitialTellAdmissionInput): Promise<CallInitialTellAdmission> => {
  throw new Error(`unexpected initial Tell ${input.initialTell.tellId}`);
};

test("the prepared executor admits local provider options itself and refuses unsupported ones before birth", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-refuse-"));
  await assert.rejects(
    prepareCall({
      akumaName: "worker",
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
  const prepared = await prepareCall({
    akumaName: "worker",
    cwd: root,
    world: root,
    recipe,
    spawn: async (launch) => await birth(launch),
    admitInitialTell: rejectedTell,
  });
  const result = await publishPreparedCall(prepared);
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
  const prepared = await prepareCall({
    akumaName: "worker",
    cwd: root,
    world: root,
    recipe: rawRecipe(),
    spawn: async (launch) => {
      await birth(launch);
      throw failure;
    },
    admitInitialTell: rejectedTell,
  });
  const result = await publishPreparedCall(prepared);
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, failure);
  assert.equal(result.tell, undefined);
});

test("native spawn failure after Soul durability retains TypeError cause and direct birth evidence", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-native-born-failure-"));
  mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({
    providers: { claude: { kind: "claude-agent-sdk" } }, plugins: {},
  }));
  const selected = await Settings.load({ cwd: world, home: join(world, "empty-home") });
  const cause = new Error("original launcher cause");
  const failure = Object.freeze(new TypeError("launcher failed after durable Soul", { cause }));
  const api = akumasWithLauncher(world, async (launch) => {
    assert.ok(launch.seed);
    await birth({ paths: launch.paths, seed: launch.seed });
    throw failure;
  });
  let confirmed: SpawnResult | undefined;
  await assert.rejects(api.spawn({ akumaName: "worker", cwd: world, settings: selected }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.cause, failure);
    assert.equal(failure.cause, cause);
    const receipt = error.spawn;
    assert.ok(receipt);
    confirmed = receipt;
    assert.equal(receipt.tellId, undefined);
    assert.equal(error.category, "internal");
    assert.equal(error.cause.name, "TypeError");
    assert.ok(Object.isFrozen(receipt));
    assert.throws(() => Object.assign(error, { spawn: undefined }), TypeError);
    const completion = { kind: "threw" as const, error };
    const input = { akumaName: "worker", workdir: world };
    assert.equal(classifyVerb("spawn", input, completion), "failed");
    const text = renderVerb("spawn", input, completion, { columns: 120, color: false });
    assert.ok(text.includes(receipt.akumaId) && text.includes(world) && text.includes(failure.message));
    return true;
  });
  const confirmedBirth = confirmed;
  if (confirmedBirth === undefined) throw new Error("expected a confirmed birth receipt");
  assert.equal(
    (await readSoul(pathsForAkumaId(world, confirmedBirth.akumaId)))?.cwd,
    world,
    "the confirmed birth keeps its frozen execution directory",
  );
  const [directory] = await childRuns(world);
  assert.ok(directory);
  assert.ok((await api.list()).rows?.some(row => row.id === confirmedBirth.akumaId && row.life !== "unborn" && row.life !== "stillborn"));
});

test("an abort after confirmed birth keeps the child and its native reason", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-abort-"));
  const controller = new AbortController();
  const reason = new Error("stop after birth");
  const prepared = await prepareCall({
    akumaName: "worker",
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
  const result = await publishPreparedCall(prepared);
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, reason);
});

test("the exact admitted initial Tell is preserved and a missing admission never invents one", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-tell-"));
  const tellId = "2f1c4b6a-0000-4000-8000-000000000001";
  const seen: string[] = [];
  const prepared = await prepareCall({
    akumaName: "worker",
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
  const result = await publishPreparedCall(prepared);
  assert.deepEqual(seen, [tellId]);
  assert.deepEqual(result.tell, tellResult(tellId));

  const missingRoot = await World.at(temporaryDirectory(context, "keiyaku-prepared-notborn-"));
  const missingPrepared = await prepareCall({
    akumaName: "worker",
    cwd: missingRoot,
    initialTell: { tellId, body: "begin" },
    world: missingRoot,
    recipe: rawRecipe(),
    spawn: async (launch) => await birth(launch),
    admitInitialTell: async () => ({ kind: "not-born" }),
  });
  const missing = await publishPreparedCall(missingPrepared);
  assert.equal(missing.tell, undefined);
  assert.match(String(missing.failure), /was not born for its initial Tell/u);
});

test("a failed initial Tell wake keeps the born child and the native failure", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-wake-"));
  const failure = new Error("tell wake failed");
  const prepared = await prepareCall({
    akumaName: "worker",
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
  const result = await publishPreparedCall(prepared);
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, failure);
  assert.equal(result.failureStage, "wake");
  assert.equal(result.tell?.admission.tellId, prepared.input.initialTell?.tellId);
  assert.equal(result.tell?.row.sequence, 1);
});

for (const corruptInitialization of [false, true]) {
  test(`prebirth cancellation retains its native reason with ${corruptInitialization ? "failed" : "successful"} seal cleanup`, async (t) => {
    const world = await World.at(temporaryDirectory(t, "keiyaku-prebirth-cancel-"));
    const prior = { KEIYAKU_INITIATOR: process.env.KEIYAKU_INITIATOR, SQUARE_DELIVERY: process.env.SQUARE_DELIVERY };
    process.env.KEIYAKU_INITIATOR = "isolated-observer";
    process.env.SQUARE_DELIVERY = join(world, "delivery.sqlite");
    t.after(() => restoreEnvironmentValues(prior));
    mkdirSync(join(world, ".keiyaku", "akumas"), { recursive: true });
    writeFileSync(join(world, ".keiyaku", "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
    writeFileSync(
      join(world, ".keiyaku", "settings.json"),
      JSON.stringify({
        providers: { claude: { kind: "claude-agent-sdk" } },
        plugins: { square: { package: "@astrosheep/keiyaku-plugin-square" } },
      }),
    );
    const controller = new AbortController();
    const reason = new Error("original prebirth cancellation");
    const suppress = DeliveryLedger.prototype.suppress;
    let child: AkumaId | undefined;
    t.mock.method(
      DeliveryLedger.prototype,
      "suppress",
      async function (this: DeliveryLedger, input: Parameters<DeliveryLedger["suppress"]>[0]) {
        const result = await suppress.call(this, input);
        child = input.key.slice("keiyaku/".length, -"/turn/".length) as AkumaId;
        if (corruptInitialization) mkdirSync(pathsForAkumaId(world, child).heart);
        controller.abort(reason);
        return result;
      },
    );
    const selected = await Settings.load({ cwd: world, home: join(world, "empty-home") });
    const api = akumasWithLauncher(world, async () => assert.fail("canceled observation cannot launch a Body"));
    await assert.rejects(
      api.spawn({ akumaName: "worker", body: "begin", mode: "wait", settings: selected, signal: controller.signal }),
      (error) => error === reason,
    );
    assert.ok(child);
    assert.equal((await childRuns(world)).length, 1, "the allocated coordinate remains owned and is never reused");
    if (!corruptInitialization) {
      assert.equal(await readSoul(pathsForAkumaId(world, child)), null);
      assert.equal((await readSeal(pathsForAkumaId(world, child)))?.evidence, reason.message);
    }
  });
}
