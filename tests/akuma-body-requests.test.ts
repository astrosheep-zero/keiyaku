import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
  requestBodyDeliver,
  requestBodyKill,
  requestBodyTell,
  requestBodyWait,
  type UpstreamExecutionPort,
} from "../src/akuma/requests.js";
import { executeTellAkuma, executeWaitAkuma, waitAkuma } from "../src/library/fleet.js";
import { hookMarkerPath } from "../src/git/hooks.js";
import { repositoryAt, worktreeGitDirectory } from "../src/git/repository.js";
import { Delivery, Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { World, type WorldRoot } from "../src/world.js";
import { appointedWorktreePath, makeGitRepository } from "./support/git.js";

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

function noDeliver(): Pick<UpstreamExecutionPort, "deliver"> {
  return {
    deliver: async () => { throw new Error("unexpected deliver"); },
  };
}

test("deliver claims execute once and Heart retains only the Contract fact reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-reference-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const contractId = "kei/forwarded-delivery";
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async (input) => {
      calls += 1;
      assert.equal(input.requester, parent.id);
      assert.deepEqual(
        { contractId: input.contractId, message: input.message, includeDirty: input.includeDirty },
        { contractId, message: "ship it", includeDirty: true },
      );
      return {
        result: { kind: "accepted", result: { marker: "delivery-result" } },
        deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      };
    },
  });
  try {
    const id = randomUUID();
    const outcomes = await Promise.all([1, 2].map(async () => await requestBodyDeliver({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId,
      message: "ship it",
      includeDirty: true,
    })));
    assert.deepEqual(outcomes, [
      { kind: "returned", result: { kind: "accepted", result: { marker: "delivery-result" } } },
      { kind: "returned", result: { kind: "accepted", result: { marker: "delivery-result" } } },
    ]);
    assert.equal(calls, 1);
    const claim = JSON.parse(await readFile(join(pump.directory, `${id}.request.json`), "utf8")) as {
      payload: unknown;
    };
    assert.deepEqual(claim.payload, { repoRoot: root, contractId, message: "ship it", includeDirty: true });
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "service" in fact ? fact.service : null, {
      action: "contract.deliver",
      repoRoot: root,
      contractId,
      deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
    });
    assert.doesNotMatch(JSON.stringify(fact), /delivery-result|marker|tenderSnapshot/u);

    await pump.close();
    const replayPump = await openPump(parent, {
      wait: async () => { throw new Error("unexpected wait"); },
      tell: async () => { throw new Error("unexpected tell"); },
      kill: async () => { throw new Error("unexpected kill"); },
      deliver: async () => { calls += 1; throw new Error("delivery must not replay"); },
    });
    try {
      assert.deepEqual(await requestBodyDeliver({
        directory: replayPump.directory,
        id,
        repoRoot: root,
        contractId,
        message: "ship it",
        includeDirty: true,
      }), {
        kind: "accepted-reference",
        repoRoot: root,
        contractId,
        deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      });
      assert.equal(calls, 1);
    } finally { await replayPump.close(); }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI forwarded deliver preserves its selected Repo and uses parent Settings and execution", async () => {
  const parentRepository = makeGitRepository();
  const contractRepository = makeGitRepository();
  for (const repository of [parentRepository, contractRepository]) {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
    repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  const root = await World.at(parentRepository.path);
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const inert = await born(root, "inert", "22222222", []);
  const parentHome = mkdtempSync(join(tmpdir(), "keiyaku-forwarded-parent-settings-"));
  const childHome = mkdtempSync(join(tmpdir(), "keiyaku-forwarded-child-settings-"));
  const hookLog = join(parentHome, "parent-create-hook.log");
  await writeFile(join(parentHome, "settings.json"), JSON.stringify({
    git: { requireBranchesToBeUpToDate: true },
    worktree: {
      create: [{
        argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(hookLog)}, "created\\n")`],
        timeoutMs: 5_000,
      }],
      destroy: [],
    },
  }));
  await writeFile(join(childHome, "settings.json"), JSON.stringify({
    git: { requireBranchesToBeUpToDate: false },
    worktree: { create: [], destroy: [] },
  }));
  const repo = await Repo.at({ path: contractRepository.path });
  const bound = await Keiyaku.bind({
    repo,
    markdown: [
      "# Forwarded delivery",
      "",
      "## Context",
      "context",
      "",
      "## Objective",
      "objective",
      "",
      "## Design",
      "design",
      "",
      "## Region",
      "~~~",
      "src/**",
      "~~~",
      "",
      "## Criteria",
      "### C1",
      "criterion",
      "",
    ].join("\n"),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const id = (await bound.keiyaku.state()).id;
  const worktree = await appointedWorktreePath(await repositoryAt(contractRepository.path), id);
  unlinkSync(hookMarkerPath(await worktreeGitDirectory(await repositoryAt(contractRepository.path), worktree)));
  await writeFile(join(worktree, "candidate.txt"), "candidate\n");
  contractRepository.run(["-C", worktree, "add", "candidate.txt"]);
  contractRepository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const previousArgv = [...process.argv];
  process.argv.splice(2, process.argv.length - 2, Buffer.from(JSON.stringify({ paths: inert.paths })).toString("base64url"));
  let compositionUpstreamFor: typeof import("../src/akuma-body.js").upstreamFor;
  try { ({ upstreamFor: compositionUpstreamFor } = await import("../src/akuma-body.js")); }
  finally { process.argv.splice(0, process.argv.length, ...previousArgv); }
  const pump = await openPump(parent, compositionUpstreamFor({ paths: parent.paths }, { home: parentHome }));
  const previous = process.env[AKUMA_REQUESTS_ENV];
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const result = await invoke(parseArgv([
      "--repo", contractRepository.path, "deliver", id, "--actor", "child-supplied-actor",
    ]), {
      cwd: parentRepository.path,
      environment: { KEIYAKU_HOME: childHome },
    });
    const state = await bound.keiyaku.state();
    assert.equal(result.kind, "accepted");
    assert.equal((await bound.keiyaku.delivery()) instanceof Delivery, true);
    assert.equal(state.delivery?.actor, parent.id);
    assert.equal(state.delivery?.data.policy.requireBranchesToBeUpToDate, true);
    assert.equal(await readFile(hookLog, "utf8"), "created\n");
  } finally {
    if (previous === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previous;
    await pump.close();
    rmSync(parentHome, { recursive: true, force: true });
    rmSync(childHome, { recursive: true, force: true });
    rmSync(parentRepository.path, { recursive: true, force: true });
    rmSync(contractRepository.path, { recursive: true, force: true });
  }
});

test("deliver refusal and retry remain live receipts while Heart records voided", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-voided-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const results = [
    { kind: "refused", refusal: { kind: "contract-missing" } },
    { kind: "retry", reason: { kind: "exhausted" } },
  ];
  let index = 0;
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => ({ result: results[index++] }),
  });
  try {
    for (const result of results) {
      const id = randomUUID();
      assert.deepEqual(await requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId: "kei/not-accepted",
        includeDirty: false,
      }), { kind: "returned", result });
      assert.equal((await readRequest(parent.paths, id))?.state, "voided");
    }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("upstream receipts keep action results out of Heart service facts", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-results-")));
  const parent = await born(root, "parent", "11111111");
  const first = "aku/worker/22222222" as AkuId;
  const second = "aku/worker/33333333" as AkuId;
  let killCalls = 0;
  const pump = await openPump(parent, {
    ...noDeliver(),
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
    ...noDeliver(),
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
    await assert.rejects(requestBodyDeliver({
      directory: pump.directory,
      id: randomUUID(),
      repoRoot: root,
      contractId: "kei/blocked",
      includeDirty: false,
    }), (error: unknown) => error instanceof AkumaBodyRequestError
      && error.diagnostic === "not-allowed: contract.deliver");
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
    ...noDeliver(),
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
    ...noDeliver(),
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
    ...noDeliver(),
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
