import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import {
  HeldAkumaLeash,
  initializeHeart,
  readHeart,
  readRequest,
  type Soul,
} from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, type AkuId } from "../src/akuma/identity.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import {
  AkumaBodyRequestError,
  BodyRequestPump,
  requestBodyKill,
  requestBodyTell,
  requestBodyWait,
  type UpstreamExecutionPort,
} from "../src/akuma/requests.js";
import { executeTellAkuma, executeWaitAkuma, waitAkuma } from "../src/library/fleet.js";
import { World, type WorldRoot } from "../src/world.js";

async function born(
  root: WorldRoot,
  archetype: string,
  draw: string,
  allowed: Soul["allowed"] = ALLOWED_ACTIONS,
) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype, draw: () => draw });
  await initializeHeart(allocated.paths);
  const soul: Soul = {
    id: allocated.id,
    archetype,
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "declared", writableRoots: [root] },
    allowed,
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, soul);
  leash.release();
  return { ...allocated, soul };
}

async function openPump(
  parent: Awaited<ReturnType<typeof born>>,
  upstream: UpstreamExecutionPort,
): Promise<BodyRequestPump> {
  return await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    spawn: async () => { throw new Error("call is outside this test"); },
    upstream,
    signal: new AbortController().signal,
  });
}

test("upstream receipts keep action results out of Heart service facts", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-results-")));
  const parent = await born(root, "parent", "11111111");
  const first = "aku/worker/22222222" as AkuId;
  const second = "aku/worker/33333333" as AkuId;
  let killCalls = 0;
  const pump = await openPump(parent, {
    wait: async (input) => ({ completion: input.completion, marker: "wait-result" }),
    tell: async (input) => ({ tellId: input.tellId, marker: "tell-result" }),
    kill: async (input) => {
      killCalls += 1;
      const service = input.targets.map((id) => ({ id, evidence: "already-stopped" as const }));
      return { result: { marker: "kill-result" }, service };
    },
  });
  try {
    const waitId = randomUUID();
    const tellId = randomUUID();
    const killId = randomUUID();
    assert.deepEqual(await requestBodyWait({
      directory: pump.directory,
      id: waitId,
      targets: [first, second],
      completion: "all",
      timeoutMs: 0,
    }), { kind: "returned", result: { completion: "all", marker: "wait-result" } });
    assert.deepEqual(await requestBodyTell({
      directory: pump.directory,
      id: tellId,
      target: first,
      body: "continue",
    }), { kind: "returned", result: { tellId, marker: "tell-result" } });
    const duplicateKills = await Promise.all([1, 2].map(async () => await requestBodyKill({
      directory: pump.directory,
      id: killId,
      targets: [first, second],
    })));
    assert.deepEqual(duplicateKills, [
      { kind: "returned", result: { marker: "kill-result" } },
      { kind: "returned", result: { marker: "kill-result" } },
    ]);
    assert.equal(killCalls, 1);

    const waitFact = await readRequest(parent.paths, waitId);
    const tellFact = await readRequest(parent.paths, tellId);
    const killFact = await readRequest(parent.paths, killId);
    assert.deepEqual(
      waitFact?.state === "served" && "service" in waitFact ? waitFact.service : null,
      { action: "akuma.wait" },
    );
    assert.deepEqual(tellFact?.state === "served" && "service" in tellFact ? tellFact.service : null, {
      action: "akuma.tell",
      target: first,
      tellId,
    });
    assert.deepEqual(killFact?.state === "served" && "service" in killFact ? killFact.service : null, {
      action: "akuma.kill",
      results: [
        { id: first, evidence: "already-stopped" },
        { id: second, evidence: "already-stopped" },
      ],
    });
    assert.doesNotMatch(JSON.stringify(waitFact), /wait-result|observations|timeout result/u);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Heart leaves wait unkeyed and refuses disabled mutations before their executors", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-policy-")));
  const parent = await born(root, "parent", "11111111", []);
  const target = "aku/worker/22222222" as AkuId;
  const calls: string[] = [];
  const pump = await openPump(parent, {
    wait: async () => { calls.push("wait"); return { observed: true }; },
    tell: async () => { calls.push("tell"); return {}; },
    kill: async () => { calls.push("kill"); return { result: {}, service: [] }; },
  });
  try {
    assert.deepEqual(await requestBodyWait({
      directory: pump.directory,
      id: randomUUID(),
      targets: [target],
      completion: "all",
    }), { kind: "returned", result: { observed: true } });
    await assert.rejects(requestBodyTell({
      directory: pump.directory,
      id: randomUUID(),
      target,
      body: "blocked",
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.diagnostic === "not-allowed: akuma.tell");
    await assert.rejects(requestBodyKill({
      directory: pump.directory,
      id: randomUUID(),
      targets: [target],
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.diagnostic === "not-allowed: akuma.kill");
    assert.deepEqual(calls, ["wait"]);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transport rejects malformed target sets and foreign World coordinates before Heart", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-malformed-")));
  const parent = await born(root, "parent", "11111111");
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => { calls += 1; return {}; },
    tell: async () => { calls += 1; return {}; },
    kill: async () => { calls += 1; return { result: {}, service: [] }; },
  });
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const claims = [
      { id: ids[0], action: "akuma.wait", payload: { targets: [], completion: "all" } },
      {
        id: ids[1],
        action: "akuma.kill",
        payload: { targets: ["aku/worker/22222222", "aku/worker/22222222"] },
      },
      {
        id: ids[2],
        action: "akuma.tell",
        payload: { target: "aku/worker/22222222", body: "x", world: "/foreign" },
      },
    ];
    await Promise.all(claims.map(async (claim) => await writeFile(
      join(pump.directory, `${claim.id}.request.json`),
      `${JSON.stringify(claim)}\n`,
    )));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 0);
    assert.deepEqual(await Promise.all(ids.map(async (id) => await readRequest(parent.paths, id))), [null, null, null]);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fleet resolves Alias glob and duplicate selectors before publishing a wait claim", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-address-")));
  const parent = await born(root, "parent", "11111111");
  const target = await born(root, "worker", "22222222");
  await moveAlias({ world: root, alias: "@target", akuId: target.id });
  let received: readonly AkuId[] = [];
  const pump = await openPump(parent, {
    wait: async (input) => {
      received = input.targets;
      return await executeWaitAkuma({
        path: root,
        ids: input.targets,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: input.signal,
      });
    },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
  });
  const previous = process.env[AKUMA_REQUESTS_ENV];
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const result = await waitAkuma({
      path: root,
      akuma: ["@target", "aku/worker/*", target.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.deepEqual(received, [target.id]);
    assert.deepEqual(result.observations.map((observation) => observation.status.id), [target.id]);
  } finally {
    if (previous === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previous;
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate tell claims enter the existing tell executor once with request id as TellId", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-tell-")));
  const parent = await born(root, "parent", "11111111", ["akuma.tell"]);
  const target = await born(root, "worker", "22222222");
  const targetLeash = (await HeldAkumaLeash.try(target.paths))!;
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async (input) => {
      calls += 1;
      return await executeTellAkuma({
        path: root,
        id: input.target,
        body: input.body,
        tellId: input.tellId,
        recordedAt: input.recordedAt,
        signal: input.signal,
      });
    },
    kill: async () => { throw new Error("unexpected kill"); },
  });
  try {
    const id = randomUUID();
    const outcomes = await Promise.all([1, 2].map(async () => await requestBodyTell({
      directory: pump.directory,
      id,
      target: target.id,
      body: "continue",
    })));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.equal(calls, 1);
    assert.deepEqual((await readHeart(target.paths)).pending.map((tell) => ({ id: tell.id, body: tell.body })), [
      { id, body: "continue" },
    ]);
    const request = await readRequest(parent.paths, id);
    assert.deepEqual(request?.state === "served" && "service" in request ? request.service : null, {
      action: "akuma.tell",
      target: target.id,
      tellId: id,
    });
  } finally {
    targetLeash.release();
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});
