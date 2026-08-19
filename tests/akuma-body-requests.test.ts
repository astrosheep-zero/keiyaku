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
  admitRequest,
  initializeHeart,
  readHeart,
  readRequest,
  type Soul,
} from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, type AkuId } from "../src/akuma/identity.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import {
  AkumaBodyRequestError,
  requestBodyCall,
  requestBodyDeliver,
  requestBodyReview,
  requestBodyKill,
  requestBodyTell,
  requestBodyTask,
  requestBodyWait,
} from "../src/akuma/requests.js";
import { BodyRequestPump, settleBodyRequests, type UpstreamExecutionPort } from "../src/akuma/request-serve.js";
import { executeTellAkuma, executeWaitAkuma, waitAkuma } from "../src/library/fleet.js";
import { hookMarkerPath } from "../src/git/hooks.js";
import { repositoryAt, worktreeGitDirectory } from "../src/git/repository.js";
import { Delivery, Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { World, type WorldRoot } from "../src/world.js";
import { Tasks } from "../src/task/index.js";
import { executeTaskMutation } from "../src/task/mutation.js";
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

test("call allocation crossing the admission fence settles voided without spawning", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-admission-fence-")));
  const parent = await born(root, "parent", "11111111");
  let pump!: BodyRequestPump;
  let fenceScheduled = false;
  let spawnCalls = 0;
  pump = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => {
      if (!fenceScheduled) {
        fenceScheduled = true;
        setImmediate(() => pump.stopAdmission());
      }
      return "2026-08-18T00:00:01.000Z";
    },
    spawn: async () => {
      spawnCalls += 1;
    },
    signal: new AbortController().signal,
  });
  const id = randomUUID();
  try {
    await assert.rejects(requestBodyCall({
      directory: pump.directory,
      id,
      world: root,
      archetype: "worker",
      body: "fenced child",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        allowed: ALLOWED_ACTIONS,
      },
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided");
    assert.equal(spawnCalls, 0);
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("review claims execute once and Heart retains only the attestation fact reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-review-reference-")));
  const parent = await born(root, "parent", "11111111", ["contract.review"]);
  const contractId = "kei/forwarded-review";
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => { throw new Error("unexpected deliver"); },
    review: async (input) => {
      calls += 1;
      assert.equal(input.requester, parent.id);
      assert.deepEqual(
        { contractId: input.contractId, verdict: input.verdict, summary: input.summary },
        { contractId, verdict: "satisfied", summary: "ready" },
      );
      return {
        result: { kind: "accepted", result: { marker: "review-result" } },
        reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
      };
    },
  });
  try {
    const id = randomUUID();
    const outcomes = await Promise.all([1, 2].map(async () => await requestBodyReview({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId,
      verdict: "satisfied",
      summary: "ready",
    })));
    assert.deepEqual(outcomes, [
      { kind: "returned", result: { kind: "accepted", result: { marker: "review-result" } } },
      { kind: "returned", result: { kind: "accepted", result: { marker: "review-result" } } },
    ]);
    assert.equal(calls, 1);
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "service" in fact ? fact.service : null, {
      action: "contract.review",
      repoRoot: root,
      contractId,
      reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
    });
    assert.doesNotMatch(JSON.stringify(fact), /review-result|marker/u);

    await pump.close();
    const replayPump = await openPump(parent, {
      wait: async () => { throw new Error("unexpected wait"); },
      tell: async () => { throw new Error("unexpected tell"); },
      kill: async () => { throw new Error("unexpected kill"); },
      deliver: async () => { throw new Error("unexpected deliver"); },
      review: async () => { calls += 1; throw new Error("review must not replay"); },
    });
    try {
      assert.deepEqual(await requestBodyReview({
        directory: replayPump.directory,
        id,
        repoRoot: root,
        contractId,
        verdict: "satisfied",
        summary: "ready",
      }), {
        kind: "accepted-reference",
        repoRoot: root,
        contractId,
        reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
      });
      assert.equal(calls, 1);
    } finally { await replayPump.close(); }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract review and delivery retain separate request permissions", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-review-permission-")));
  const reviewParent = await born(root, "reviewer", "11111111", ["contract.review"]);
  const reviewPump = await openPump(reviewParent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => { throw new Error("delivery must not execute"); },
    review: async () => ({
      result: { kind: "refused", refusal: { kind: "contract-missing" } },
      reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
    }),
  });
  try {
    assert.deepEqual(await requestBodyReview({
      directory: reviewPump.directory,
      id: randomUUID(),
      repoRoot: root,
      contractId: "kei/missing",
      verdict: "unsatisfied",
    }), { kind: "returned", result: { kind: "refused", refusal: { kind: "contract-missing" } } });
    await assert.rejects(requestBodyDeliver({
      directory: reviewPump.directory,
      id: randomUUID(),
      repoRoot: root,
      contractId: "kei/missing",
      includeDirty: false,
    }), (error: unknown) => error instanceof AkumaBodyRequestError
      && error.diagnostic === "not-allowed: contract.deliver");
  } finally { await reviewPump.close(); }

  const deliverParent = await born(root, "deliverer", "22222222", ["contract.deliver"]);
  const deliverPump = await openPump(deliverParent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => ({ result: { kind: "refused", refusal: { kind: "contract-missing" } } }),
    review: async () => { throw new Error("review must not execute"); },
  });
  try {
    await assert.rejects(requestBodyReview({
      directory: deliverPump.directory,
      id: randomUUID(),
      repoRoot: root,
      contractId: "kei/missing",
      verdict: "unsatisfied",
    }), (error: unknown) => error instanceof AkumaBodyRequestError
      && error.diagnostic === "not-allowed: contract.review");
  } finally {
    await deliverPump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("all Task mutations preserve selected World and inputs while Heart keeps only service markers", async () => {
  const parentRoot = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-forward-parent-")));
  const selectedWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-forward-selected-")));
  const parent = await born(parentRoot, "parent", "22222222", [
    "task.add", "task.addDocument", "task.compose", "task.update", "task.start", "task.stop", "task.hold", "task.resume", "task.done", "task.drop",
  ]);
  const calls: { action: string; world: string; requester: string; request: unknown }[] = [];
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => { throw new Error("unexpected deliver"); },
    task: async (input) => {
      calls.push({ action: input.request.action, world: input.world, requester: input.requester, request: input.request });
      if (input.request.action === "task.add" || input.request.action === "task.addDocument") {
        return { kind: "accepted", value: { id: "task/created", body: "exact\nmarkdown", documentDiff: "must not persist" } };
      }
      if (input.request.action === "task.compose") {
        return { kind: "accepted", documentChanges: [{ kind: "created", taskId: "task/composed", documentDiff: "must not persist" }] };
      }
      return { kind: "accepted", value: { task: { id: "task/target" }, documentDiff: "must not persist" } };
    },
  });
  const requests = [
    { action: "task.add" as const, input: { title: "Add", body: "exact\nbody" } },
    { action: "task.addDocument" as const, input: { markdown: "# Exact\n\nbody\n" } },
    { action: "task.compose" as const, markdown: "+ Compose\n" },
    { action: "task.update" as const, id: "task/target" as const, input: { appendBody: "\nexact" } },
    { action: "task.start" as const, id: "task/target" as const },
    { action: "task.stop" as const, id: "task/target" as const },
    { action: "task.hold" as const, ids: ["task/target"] as const },
    { action: "task.resume" as const, id: "task/target" as const },
    { action: "task.done" as const, ids: ["task/target"] as const, note: "exact note" },
    { action: "task.drop" as const, ids: ["task/target"] as const, note: "exact note" },
  ];
  try {
    for (const [index, request] of requests.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
      if (index === 0) {
        await Promise.all([1, 2].map(async () => await requestBodyTask({ directory: pump.directory, id, world: selectedWorld, request })));
      } else {
        await requestBodyTask({ directory: pump.directory, id, world: selectedWorld, request });
      }
      const fact = await readRequest(parent.paths, id);
      assert.equal(fact?.state, "served");
      if (fact?.state === "served" && "service" in fact) {
        assert.deepEqual(fact.service, { action: request.action });
        assert.equal(JSON.stringify(fact.service).includes(selectedWorld), false);
        assert.equal(JSON.stringify(fact.service).includes("task/target"), false);
      }
    }
    assert.equal(calls.length, requests.length);
    assert.deepEqual(calls.map((call) => call.action), requests.map((request) => request.action));
    assert.equal(calls.every((call) => call.world === selectedWorld && call.requester === parent.id), true);
    assert.equal((calls[0]?.request as { input: { body: string } }).input.body, "exact\nbody");
    assert.equal((calls[1]?.request as { input: { markdown: string } }).input.markdown, "# Exact\n\nbody\n");
    assert.equal((calls[8]?.request as { note: string }).note, "exact note");

    await pump.close();
    const replayPump = await openPump(parent, {
      wait: async () => { throw new Error("unexpected wait"); },
      tell: async () => { throw new Error("unexpected tell"); },
      kill: async () => { throw new Error("unexpected kill"); },
      deliver: async () => { throw new Error("unexpected deliver"); },
      task: async () => { throw new Error("Task must not replay"); },
    });
    try {
      assert.deepEqual(await requestBodyTask({
        directory: replayPump.directory,
        id: "00000000-0000-4000-8000-000000000100",
        world: selectedWorld,
        request: requests[0]!,
      }), { kind: "served-reference", action: "task.add" });
      assert.equal(calls.length, requests.length);
    } finally { await replayPump.close(); }
  } finally {
    await pump.close();
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(selectedWorld, { recursive: true, force: true });
  }
});

test("every native Task return is served unchanged without result classification", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-forward-results-")));
  const parent = await born(root, "parent", "23232323", ["task.start", "task.stop", "task.compose", "task.done"]);
  const results = [
    { kind: "refused", refusal: { kind: "task-missing", taskId: "task/missing" } },
    { kind: "retry", reason: "busy" },
    {
      kind: "incomplete",
      documentChanges: [],
      stopped: { kind: "retry", reason: "concurrent-modification" },
      draft: "+ Remaining\n",
    },
    {
      kind: "accepted",
      value: {
        results: [
          { taskId: "task/one", kind: "accepted" },
          { taskId: "task/two", kind: "refused", refusal: { kind: "task-missing", taskId: "task/two" } },
        ],
      },
    },
  ] as const;
  let call = 0;
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => { throw new Error("unexpected deliver"); },
    task: async () => results[call++]!,
  });
  const requests = [
    { action: "task.start" as const, id: "task/missing" as const },
    { action: "task.stop" as const, id: "task/target" as const },
    { action: "task.compose" as const, markdown: "+ Remaining\n" },
    { action: "task.done" as const, ids: ["task/one", "task/two"] as const },
  ];
  try {
    for (const [index, request] of requests.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 400).padStart(12, "0")}`;
      assert.deepEqual(await requestBodyTask({ directory: pump.directory, id, world: root, request }), results[index]);
      const fact = await readRequest(parent.paths, id);
      assert.equal(fact?.state, "served");
      if (fact?.state === "served" && "service" in fact) {
        assert.deepEqual(fact.service, { action: request.action });
        assert.doesNotMatch(JSON.stringify(fact.service), /task\/missing|concurrent-modification|Remaining/u);
      }
    }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI forwards Task mutations through the parent and renders the native Task result", async () => {
  const parentRoot = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-cli-parent-")));
  const selectedWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-cli-selected-")));
  const parent = await born(parentRoot, "parent", "33333333", ["task.add"]);
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => { throw new Error("unexpected deliver"); },
    task: async (input) => await executeTaskMutation({
      world: input.world as WorldRoot,
      request: input.request,
      requester: input.requester,
      signal: input.signal,
    }),
  });
  const previous = process.env[AKUMA_REQUESTS_ENV];
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const result = await invoke(parseArgv(["-C", selectedWorld, "task", "add", "CLI forwarded", "--body", "exact\nbody"]));
    assert.equal((result as { kind: string }).kind, "accepted");
    const created = await Tasks.of(selectedWorld).task({ id: "task/cli-forwarded" }).read();
    assert.equal(created?.task.body, "exact\nbody");
    assert.equal(created?.task.createdBy, parent.id);
  } finally {
    if (previous === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previous;
    await pump.close();
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(selectedWorld, { recursive: true, force: true });
  }
});

test("Task request recovery voids an unserved claim without replaying Task authority", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-recovery-")));
  const parent = await born(root, "parent", "44444444", ["task.add"]);
  const id = "00000000-0000-4000-8000-000000000301";
  try {
    await admitRequest(parent.paths, {
      id,
      action: "task.add",
      world: root,
      request: { action: "task.add", input: { title: "Never replayed" } },
      admittedAt: "2026-08-18T00:00:01.000Z",
    });
    assert.equal(await settleBodyRequests(parent.paths, parent.soul, () => "2026-08-18T00:00:02.000Z"), "settled");
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
    const board = await Tasks.of(root).list({ selection: "all", scope: "world" });
    assert.equal(board.kind, "accepted");
    if (board.kind === "accepted") assert.equal(board.value.total, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  const parent = await born(root, "parent", "11111111", ["contract.deliver", "contract.review"]);
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
  await writeFile(join(childHome, "settings.json"), "{");
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

    const reviewed = await invoke(parseArgv([
      "--repo", contractRepository.path, "review", id, "--unsatisfied", "--summary", "needs work", "--actor", "child-supplied-actor",
    ]), {
      cwd: parentRepository.path,
      environment: { KEIYAKU_HOME: childHome },
    });
    assert.equal(reviewed.kind, "accepted");
    const reviewedState = await bound.keiyaku.state();
    assert.equal(reviewedState.attestations.at(-1)?.actor, parent.id);
    assert.equal(reviewedState.attestations.at(-1)?.data.summary, "needs work");
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

test("deliver returns without a durable reference and settles Heart voided", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-voided-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => ({ result: { kind: "refused", refusal: { kind: "contract-missing" } } }),
  });
  try {
    const id = randomUUID();
    await assert.rejects(requestBodyDeliver({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId: "kei/not-accepted",
      includeDirty: false,
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided");
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion fences admission but drains a returned delivery reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-drain-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  let started!: () => void;
  let release!: (value: Readonly<{ result: unknown; deliveryFactId: string }>) => void;
  const executorStarted = new Promise<void>((resolve) => { started = resolve; });
  const executorReleased = new Promise<Readonly<{ result: unknown; deliveryFactId: string }>>((resolve) => {
    release = resolve;
  });
  const id = randomUUID();
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => {
      started();
      return await executorReleased;
    },
  });
  try {
    const request = requestBodyDeliver({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId: "kei/drained",
      includeDirty: false,
    });
    await executorStarted;
    pump.stopAdmission();
    const closing = pump.close();
    release({ result: { kind: "accepted" }, deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" });
    await closing;
    await assert.rejects(request, (error: unknown) => error instanceof AkumaBodyRequestError
      && error.outcome === "voided");
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "service" in fact ? fact.service : null, {
      action: "contract.deliver",
      repoRoot: root,
      contractId: "kei/drained",
      deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    });
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal duplicate is reprojected when its replay fences admission", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-terminal-replay-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const id = randomUUID();
  let calls = 0;
  const first = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => {
      calls += 1;
      return { result: { kind: "accepted" }, deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FD0" };
    },
  });
  try {
    await requestBodyDeliver({
      directory: first.directory,
      id,
      repoRoot: root,
      contractId: "kei/terminal-replay",
      includeDirty: false,
    });
  } finally {
    await first.close();
  }

  let replay!: BodyRequestPump;
  let fenced = false;
  replay = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => {
      if (!fenced) {
        fenced = true;
        replay.stopAdmission();
      }
      return "2026-08-18T00:00:01.000Z";
    },
    spawn: async () => { throw new Error("call is outside this test"); },
    signal: new AbortController().signal,
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => {
      calls += 1;
      throw new Error("terminal replay must not execute");
    },
  });
  try {
    assert.deepEqual(await requestBodyDeliver({
      directory: replay.directory,
      id,
      repoRoot: root,
      contractId: "kei/terminal-replay",
      includeDirty: false,
    }), {
      kind: "accepted-reference",
      repoRoot: root,
      contractId: "kei/terminal-replay",
      deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
    });
    assert.equal(calls, 1);
    assert.equal((await readRequest(parent.paths, id))?.state, "served");
  } finally {
    await replay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a served wait is not voided when its duplicate replay fences admission", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-wait-replay-")));
  const parent = await born(root, "parent", "11111111");
  const id = randomUUID();
  const target = "aku/worker/22222222" as AkuId;
  let calls = 0;
  const first = await openPump(parent, {
    wait: async () => {
      calls += 1;
      return { observed: true };
    },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    ...noDeliver(),
  });
  try {
    assert.deepEqual(await requestBodyWait({
      directory: first.directory,
      id,
      targets: [target],
      completion: "all",
    }), { kind: "returned", result: { observed: true } });
  } finally {
    await first.close();
  }

  let replay!: BodyRequestPump;
  let fenced = false;
  replay = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => {
      if (!fenced) {
        fenced = true;
        replay.stopAdmission();
      }
      return "2026-08-18T00:00:01.000Z";
    },
    spawn: async () => { throw new Error("call is outside this test"); },
    signal: new AbortController().signal,
    wait: async () => {
      calls += 1;
      throw new Error("terminal replay must not execute");
    },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    ...noDeliver(),
  });
  try {
    assert.deepEqual(await requestBodyWait({
      directory: replay.directory,
      id,
      targets: [target],
      completion: "all",
    }), {
      kind: "failed",
      failure: {
        kind: "failed",
        diagnostic: "served request receipt is no longer available",
      },
    });
    assert.equal(calls, 1);
    assert.equal((await readRequest(parent.paths, id))?.state, "served");
  } finally {
    await replay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vanished live receipt does not fail durable request settlement", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-receipt-loss-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  let started!: () => void;
  let release!: () => void;
  const executorStarted = new Promise<void>((resolve) => { started = resolve; });
  const executorReleased = new Promise<void>((resolve) => { release = resolve; });
  const id = randomUUID();
  const pump = await openPump(parent, {
    wait: async () => { throw new Error("unexpected wait"); },
    tell: async () => { throw new Error("unexpected tell"); },
    kill: async () => { throw new Error("unexpected kill"); },
    deliver: async () => {
      started();
      await executorReleased;
      return { result: { kind: "accepted" }, deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" };
    },
  });
  try {
    const request = requestBodyDeliver({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId: "kei/missing-receipt",
      includeDirty: false,
    });
    await executorStarted;
    rmSync(pump.directory, { recursive: true, force: true });
    release();
    await assert.rejects(request, (error: unknown) => error instanceof AkumaBodyRequestError
      && error.outcome === "voided");
    await pump.close();
    assert.equal((await readRequest(parent.paths, id))?.state, "served");
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
