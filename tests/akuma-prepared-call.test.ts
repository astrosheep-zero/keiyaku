import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { HeldAkumaLeash, projectTell, readSoul, type Soul, type TellFact } from "../src/akuma/heart/index.js";
import { akumaRunRoot, type AkuId } from "../src/akuma/identity.js";
import type { CallInitialTellAdmission, TellResult } from "../src/akuma/call-initial-tell.js";
import {
  executePreparedCall,
  type PreparedCallInitialTellAdmission,
  type PreparedCallRecipe,
  type PreparedCallSpawn,
} from "../src/akuma/publication.js";
import { World } from "../src/world.js";
import { temporaryDirectory } from "./support/process.js";

const AT = "2026-08-09T00:00:00.000Z";

function rawRecipe(overrides: Partial<PreparedCallRecipe> = {}): PreparedCallRecipe {
  return {
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    allowed: ALLOWED_ACTIONS,
    ...overrides,
  };
}

/** Birth one already-allocated child through its own leash, the way a real spawn body would. */
async function birth(launch: PreparedCallSpawn, createdAt = AT): Promise<void> {
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

function parentSoul(allowed: Soul["allowed"]): Soul {
  return {
    id: "aku/parent/1234abcd" as AkuId,
    archetype: "parent",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    cwd: "/tmp",
    origin: { kind: "direct" },
    allowed,
    createdAt: AT,
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

const rejectedTell = async (input: PreparedCallInitialTellAdmission): Promise<CallInitialTellAdmission> => {
  throw new Error(`unexpected initial Tell ${input.initialTell.tellId}`);
};

test("the prepared executor admits local provider options itself and refuses unsupported ones before birth", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-refuse-"));
  await assert.rejects(
    executePreparedCall({
      archetype: "worker",
      cwd: root,
      custody: {
        kind: "local",
        world: root,
        recipe: rawRecipe({ options: { network: "enabled" } }),
        spawn: async (launch) => await birth(launch),
        admitInitialTell: rejectedTell,
      },
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
    custody: {
      kind: "local",
      world: root,
      recipe,
      spawn: async (launch) => await birth(launch),
      admitInitialTell: rejectedTell,
    },
  });
  assert.equal(result.failure, undefined);
  const soul = await readSoul(result.child.paths);
  assert.equal(soul?.id, result.child.id);
  assert.equal(soul?.cwd, root);
  assert.deepEqual(soul?.allowed, ALLOWED_ACTIONS);
  assert.deepEqual(soul?.options, { model: "claude-sonnet-4-5" });
  assert.equal(Object.isFrozen(soul?.options), true);
  assert.deepEqual(soul?.origin, { kind: "direct" });
});

test("request custody resolves, reserves before spawn, clips to the parent, and stamps the request origin", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-request-"));
  const order: string[] = [];
  const parent = parentSoul(["akuma.tell"]);
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    custody: {
      kind: "request",
      world: root,
      coordinate: root,
      recipe: rawRecipe(),
      parent,
      requestId: "request-1",
      admissionOpen: () => true,
      reserve: async (child) => {
        order.push(`reserve:${child}`);
      },
      refuse: async (diagnostic) => {
        order.push(`refuse:${diagnostic}`);
      },
      spawn: async (launch) => {
        order.push("spawn");
        await birth(launch);
      },
      admitInitialTell: rejectedTell,
    },
  });
  assert.deepEqual(order, [`reserve:${result.child.id}`, "spawn"]);
  const soul = await readSoul(result.child.paths);
  assert.deepEqual(soul?.allowed, ["akuma.tell"]);
  assert.deepEqual(soul?.origin, { kind: "request", parent: parent.id, requestId: "request-1" });
  assert.equal(result.failure, undefined);
});

test("request custody refuses a mismatched world before any reservation or birth", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-world-"));
  const other = await World.at(temporaryDirectory(context, "keiyaku-prepared-other-"));
  let refused: string | undefined;
  let spawned = false;
  await assert.rejects(
    executePreparedCall({
      archetype: "worker",
      cwd: root,
      custody: {
        kind: "request",
        world: root,
        coordinate: other,
        recipe: rawRecipe(),
        parent: parentSoul(ALLOWED_ACTIONS),
        requestId: "request-mismatch",
        admissionOpen: () => true,
        reserve: async () => {},
        refuse: async (diagnostic) => {
          refused = diagnostic;
        },
        spawn: async (launch) => {
          spawned = true;
          await birth(launch);
        },
        admitInitialTell: rejectedTell,
      },
    }),
    /does not match/u,
  );
  assert.match(refused ?? "", /does not match/u);
  assert.equal(spawned, false);
  assert.deepEqual(await childRuns(root), []);
});

test("a durably born child survives a later launch failure and returns the native failure", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-prepared-born-"));
  const failure = new Error("post-birth launch failure");
  const result = await executePreparedCall({
    archetype: "worker",
    cwd: root,
    custody: {
      kind: "local",
      world: root,
      recipe: rawRecipe(),
      spawn: async (launch) => {
        await birth(launch);
        throw failure;
      },
      admitInitialTell: rejectedTell,
    },
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
    custody: {
      kind: "local",
      world: root,
      recipe: rawRecipe(),
      spawn: async (launch) => {
        await birth(launch);
        controller.abort(reason);
      },
      admitInitialTell: rejectedTell,
    },
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
    custody: {
      kind: "local",
      world: root,
      recipe: rawRecipe(),
      spawn: async (launch) => await birth(launch),
      admitInitialTell: async (input) => {
        seen.push(input.initialTell.tellId);
        return admittedTell(input.initialTell.tellId);
      },
    },
  });
  assert.deepEqual(seen, [tellId]);
  assert.deepEqual(result.tell, tellResult(tellId));

  const missingRoot = await World.at(temporaryDirectory(context, "keiyaku-prepared-notborn-"));
  const missing = await executePreparedCall({
    archetype: "worker",
    cwd: missingRoot,
    initialTell: { tellId, body: "begin" },
    custody: {
      kind: "local",
      world: missingRoot,
      recipe: rawRecipe(),
      spawn: async (launch) => await birth(launch),
      admitInitialTell: async () => ({ kind: "not-born" }),
    },
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
    custody: {
      kind: "local",
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
    },
  });
  assert.equal(result.child.id, (await readSoul(result.child.paths))?.id);
  assert.equal(result.failure, failure);
});
