import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { akumaCallRequestCommands, requestForwardedAkumaCall as requestBodyCall } from "../src/akuma/call-request.js";
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
import { AkumaBodyRequestError, bodyRequestExecutionContext, requestBodyCommand } from "../src/akuma/requests.js";
import { BodyRequestPump, receiptFor, settleBodyRequests } from "../src/akuma/request-serve.js";
import { BodyRequestPump as LifecycleBodyRequestPump } from "../src/akuma/request-lifecycle.js";
import {
  executeTellAkuma,
  executeWaitAkuma,
  fleetRequestCommand,
  fleetRequestCommands,
  waitAkuma,
} from "../src/library/fleet.js";
import { contractRequestCommand, contractRequestCommands } from "../src/library/contract-operations.js";
import { KeiyakuRefused, KeiyakuRetry } from "../src/library/refusal.js";
import { repositoryAt } from "../src/git/repository.js";
import { Delivery, Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { World, type WorldRoot } from "../src/world.js";
import { Tasks } from "../src/task/index.js";
import {
  executeTaskMutation,
  requestForwardedTask,
  taskMutationRequestCommand,
  taskMutationRequestCommands,
} from "../src/task/mutation.js";
import { appointedWorktreePath, gitExecutablePath, makeGitRepository } from "./support/git.js";

async function born(root: WorldRoot, archetype: string, draw: string, allowed: Soul["allowed"] = ALLOWED_ACTIONS) {
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

async function openPump(parent: Awaited<ReturnType<typeof born>>, upstream: unknown): Promise<BodyRequestPump> {
  return await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    spawn: async () => {
      throw new Error("call is outside this test");
    },
    upstream,
    commands: {
      ...akumaCallRequestCommands(),
      ...fleetRequestCommands(),
      ...contractRequestCommands(),
      ...taskMutationRequestCommands(),
    },
    signal: new AbortController().signal,
  });
}

async function requestBodyTask(
  input: Readonly<{
    directory: string;
    id?: string;
    world: WorldRoot;
    request: import("../src/task/mutation.js").TaskMutationRequest;
    signal?: AbortSignal;
  }>,
) {
  return await requestForwardedTask(input);
}

async function requestBodyDeliver(
  input: Readonly<{
    directory: string;
    id?: string;
    repoRoot: string;
    contractId: string;
    message?: string;
    includeDirty: boolean;
    materializeConflict: boolean;
    signal?: AbortSignal;
  }>,
) {
  const { directory, id, signal, ...request } = input;
  const response = await requestBodyCommand({
    directory,
    ...(id === undefined ? {} : { id }),
    command: contractRequestCommand("contract.deliver"),
    value: { action: "contract.deliver", ...request },
    ...(signal === undefined ? {} : { signal }),
  });
  return response.kind === "reference" ? response.reference : response.result;
}

async function requestBodyReview(
  input: Readonly<{
    directory: string;
    id?: string;
    repoRoot: string;
    contractId: string;
    verdict: "satisfied" | "unsatisfied";
    summary?: string;
    signal?: AbortSignal;
  }>,
) {
  const { directory, id, signal, ...request } = input;
  const response = await requestBodyCommand({
    directory,
    ...(id === undefined ? {} : { id }),
    command: contractRequestCommand("contract.review"),
    value: { action: "contract.review", ...request },
    ...(signal === undefined ? {} : { signal }),
  });
  return response.kind === "reference" ? response.reference : response.result;
}

async function requestBodyAudit(
  input: Readonly<{
    directory: string;
    id?: string;
    repoRoot: string;
    contractId: string;
    includeDirty: boolean;
    showDiff: boolean;
    signal?: AbortSignal;
  }>,
) {
  const { directory, id, signal, ...request } = input;
  const response = await requestBodyCommand({
    directory,
    ...(id === undefined ? {} : { id }),
    command: contractRequestCommand("contract.audit"),
    value: { action: "contract.audit", ...request },
    ...(signal === undefined ? {} : { signal }),
  });
  return response.kind === "reference" ? response.reference : response.result;
}

async function requestBodyWait(
  input: Readonly<{
    directory: string;
    id?: string;
    targets: readonly AkuId[];
    completion: "any" | "all";
    timeoutMs?: number;
  }>,
) {
  const command = fleetRequestCommand("akuma.wait");
  return await requestBodyCommand({
    ...input,
    command: { ...command, decodeResult: (result) => result },
    value: {
      action: "akuma.wait",
      targets: input.targets,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
  });
}

async function requestBodyTell(input: Readonly<{ directory: string; id?: string; target: AkuId; body: string }>) {
  const command = fleetRequestCommand("akuma.tell");
  return await requestBodyCommand({
    ...input,
    command: { ...command, decodeResult: (result) => result },
    value: { action: "akuma.tell", target: input.target, body: input.body },
  });
}

async function requestBodyKill(input: Readonly<{ directory: string; id?: string; targets: readonly AkuId[] }>) {
  const command = fleetRequestCommand("akuma.kill");
  return await requestBodyCommand({
    ...input,
    command: { ...command, decodeResult: (result) => result },
    value: { action: "akuma.kill", targets: input.targets },
  });
}

async function readTransportClaim(directory: string, id: string): Promise<Readonly<{ payload: unknown }>> {
  for (const name of (await readdir(directory)).filter((value) => value.endsWith(".request.json"))) {
    const claim = JSON.parse(await readFile(join(directory, name), "utf8")) as Readonly<{
      id?: unknown;
      payload?: unknown;
    }>;
    if (claim.id === id) return { payload: claim.payload };
  }
  throw new Error(`transport claim ${id} was not found`);
}

function sortByKind<T extends Readonly<{ kind: string }>>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.kind.localeCompare(right.kind));
}

function acceptedContract(marker: string, action: "deliver" | "review") {
  return {
    facts: [],
    head: "head",
    value:
      action === "deliver"
        ? {
            tenderSnapshot: "tender",
            integration: { predecessor: "predecessor", snapshot: "snapshot", changeId: "change" },
            method: "squash",
            policy: { requireBranchesToBeUpToDate: false },
            verificationSummary: marker,
          }
        : { verificationSummary: marker },
    lags: [],
    settlementLags: [],
  };
}

function acceptedTaskView(id: string, body = ""): Readonly<Record<string, unknown>> {
  return {
    id,
    title: "Task result",
    state: "open",
    priority: 2,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    note: "",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    body,
    namespace: id.split("/").slice(1, -1),
  };
}

function noDeliver(): Readonly<{ deliver(): Promise<never> }> {
  return {
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
  };
}

test("Contract owns strict direct live-result decoding", () => {
  assert.throws(
    () => contractRequestCommand("contract.deliver").decodeResult({ kind: "accepted", result: {} }),
    /transport integrity: Contract contract\.deliver returned an invalid live result/u,
  );
  assert.throws(
    () => contractRequestCommand("contract.review").decodeResult({ kind: "retry", reason: {} }),
    /transport integrity: Contract contract\.review returned an invalid live result/u,
  );
});

test("Contract owns strict live domain-failure decoding", () => {
  const command = contractRequestCommand("contract.deliver");
  const refusal = new KeiyakuRefused({ kind: "contract-missing", contractId: "kei/missing" });
  const encoded = command.encodeFailure?.(refusal);
  const decoded = encoded === undefined ? null : command.decodeFailure?.(encoded);
  assert.ok(decoded instanceof KeiyakuRefused);
  assert.deepEqual(decoded.refusal, refusal.refusal);
  assert.equal(command.encodeFailure?.(new Error("executor unavailable")), null);
  assert.equal(command.decodeFailure?.({ kind: "refused", refusal: { kind: "contract-missing" } }), null);
});

test("Fleet decoder rejects noncanonical identities and incomplete terminal evidence", () => {
  assert.equal(fleetRequestCommand("akuma.tell").decodeRequest({ target: "not-an-aku", body: "hello" }), null);
  assert.throws(
    () =>
      fleetRequestCommand("akuma.tell").decodeService({
        action: "akuma.tell",
        target: "aku/worker/nothex",
        tellId: "tell",
      }),
    /malformed stored Fleet service evidence/u,
  );
  assert.throws(
    () =>
      fleetRequestCommand("akuma.tell").decodeService({
        action: "akuma.tell",
        target: "aku/worker/11111111",
        tellId: "tell",
        unexpected: true,
      }),
    /malformed stored Fleet service evidence/u,
  );
  assert.throws(
    () => fleetRequestCommand("akuma.wait").decodeResult({ completion: "all", observations: [], unobserved: [{}] }),
    /invalid live result for akuma\.wait/u,
  );
});

test("an unregistered action reaches a terminal refusal without external cancellation", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-unconfigured-command-")));
  const parent = await born(root, "parent", "25252525", []);
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    spawn: async () => undefined,
    commands: {},
    signal: new AbortController().signal,
  });
  try {
    const requestId = randomUUID();
    await assert.rejects(
      requestBodyCommand({
        directory: pump.directory,
        id: requestId,
        command: fleetRequestCommand("akuma.wait"),
        value: { action: "akuma.wait", targets: [parent.id], completion: "all" },
      }),
      (error: unknown) =>
        error instanceof AkumaBodyRequestError &&
        error.outcome === "refused" &&
        error.diagnostic === "request action akuma.wait is not registered",
    );
    assert.equal(await readRequest(parent.paths, requestId), null);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract decoder rejects corrupt stored service evidence during terminal replay", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-corrupt-service-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  try {
    assert.throws(
      () => contractRequestCommand("contract.deliver").decodeService({ malformed: true }),
      /malformed stored Contract service evidence for contract\.deliver/u,
    );
    assert.throws(
      () =>
        contractRequestCommand("contract.deliver").decodeService({
          action: "contract.deliver",
          repoRoot: root,
          contractId: "kei/forwarded-delivery",
          deliveryFactId: "fact",
          unexpected: true,
        }),
      /malformed stored Contract service evidence for contract\.deliver/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Heart authority failure keeps its error identity, closes the channel, and recovers admission", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-authority-failure-")));
  const parent = await born(root, "parent", "11111111");
  const id = randomUUID();
  const authorityFailure = new Error("simulated Heart authority failure");
  let serving!: () => void;
  const served = new Promise<void>((resolve) => {
    serving = resolve;
  });
  const pump = await LifecycleBodyRequestPump.openWithService(
    {
      paths: parent.paths,
      parent: parent.soul,
      bodySequence: 1,
      now: () => "2026-08-18T00:00:01.000Z",
      spawn: async () => {
        throw new Error("call is outside this test");
      },
      signal: new AbortController().signal,
    },
    async (input) => {
      await admitRequest(input.paths, {
        id: input.claim.id,
        action: input.claim.action,
        payloadJson: JSON.stringify({}),
        admittedAt: input.now(),
        permitted: true,
      });
      serving();
      throw authorityFailure;
    },
  );
  let closed = false;
  try {
    const request = requestBodyWait({
      directory: pump.directory,
      id,
      targets: ["aku/worker/22222222" as AkuId],
      completion: "all",
    });
    const failed = assert.rejects(pump.failure, (error: unknown) => error === authorityFailure);
    await served;
    await failed;
    assert.deepEqual(
      (await readdir(pump.directory)).filter((name) => name.endsWith(".receipt.json")),
      [],
    );
    await assert.rejects(pump.close(), (error: unknown) => error === authorityFailure);
    closed = true;
    await assert.rejects(
      request,
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
    assert.equal(existsSync(pump.directory), false);
    assert.equal((await readRequest(parent.paths, id))?.state, "admitted");
    assert.equal(await settleBodyRequests(parent.paths, parent.soul, () => "2026-08-18T00:00:02.000Z"), "settled");
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
  } finally {
    if (!closed) await pump.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-id different-payload conflict is refused without changing the admitted request", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-input-conflict-")));
  const parent = await born(root, "parent", "11111111");
  const id = randomUUID();
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => {
      calls += 1;
      return { observed: true };
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    ...noDeliver(),
  });
  try {
    const first = {
      directory: pump.directory,
      id,
      targets: ["aku/worker/22222222" as AkuId],
      completion: "all" as const,
    };
    assert.deepEqual(await requestBodyWait(first), { kind: "returned", result: { observed: true } });
    const fact = await readRequest(parent.paths, id);
    await assert.rejects(
      requestBodyWait({ ...first, targets: ["aku/worker/33333333" as AkuId] }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "refused",
    );
    assert.deepEqual(await readRequest(parent.paths, id), fact);
    assert.equal(calls, 1);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    upstream: { launchWorld: () => root },
    spawn: async () => {
      spawnCalls += 1;
    },
    commands: akumaCallRequestCommands(),
    signal: new AbortController().signal,
  });
  const id = randomUUID();
  try {
    await assert.rejects(
      requestBodyCall({
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
      }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
    assert.equal(spawnCalls, 0);
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routed call proves its transported World before child allocation", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-world-proof-")));
  const parent = await born(root, "parent", "11111111");
  let spawns = 0;
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    upstream: { launchWorld: () => root },
    spawn: async () => {
      spawns += 1;
    },
    commands: akumaCallRequestCommands(),
    signal: new AbortController().signal,
  });
  const id = randomUUID();
  try {
    const request = requestBodyCall({
      directory: pump.directory,
      id,
      world: `${root}/.`,
      archetype: "worker",
      body: "must not allocate",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        allowed: ALLOWED_ACTIONS,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spawns, 0);
    assert.equal(await readRequest(parent.paths, id), null);
    await pump.close();
    await assert.rejects(
      request,
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantically invalid call recipes create no Heart fact or child", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-invalid-recipe-")));
  const parent = await born(root, "parent", "11111111");
  let spawnCalls = 0;
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    upstream: { launchWorld: () => root },
    spawn: async () => {
      spawnCalls += 1;
      throw new Error("invalid recipe must not spawn");
    },
    commands: akumaCallRequestCommands(),
    signal: new AbortController().signal,
  });
  try {
    const id = randomUUID();
    const request = requestBodyCall({
      directory: pump.directory,
      id,
      world: root,
      archetype: "worker",
      body: "invalid recipe",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { readonly: true },
        allowed: ALLOWED_ACTIONS,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const fact = await readRequest(parent.paths, id);
    assert.equal(fact, null);
    assert.equal(spawnCalls, 0);
    await pump.close();
    await assert.rejects(
      request,
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal Akuma call duplicate projects its stored child without spawning again", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-terminal-replay-")));
  const parent = await born(root, "parent", "11111111");
  const id = randomUUID();
  const request = {
    id,
    world: root,
    archetype: "worker",
    body: "terminal child",
    recipe: {
      provider: { name: "claude", kind: "claude-agent-sdk" } as const,
      options: {},
      allowed: ALLOWED_ACTIONS,
    },
  };
  let spawns = 0;
  const first = await BodyRequestPump.open({
    paths: parent.paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    upstream: { launchWorld: () => root },
    commands: akumaCallRequestCommands(),
    signal: new AbortController().signal,
    async spawn(launch) {
      spawns += 1;
      const leash = (await HeldAkumaLeash.try(launch.paths))!;
      await leash.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-18T00:00:02.000Z" });
      leash.release();
    },
  });
  try {
    const child = await requestBodyCall({ directory: first.directory, ...request });
    await first.close();
    const replay = await BodyRequestPump.open({
      paths: parent.paths,
      parent: parent.soul,
      bodySequence: 2,
      now: () => "2026-08-18T00:00:03.000Z",
      upstream: { launchWorld: () => root },
      commands: akumaCallRequestCommands(),
      signal: new AbortController().signal,
      async spawn() {
        throw new Error("terminal call must not spawn again");
      },
    });
    try {
      assert.equal(await requestBodyCall({ directory: replay.directory, ...request }), child);
      assert.equal(spawns, 1);
    } finally {
      await replay.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Body composition carries its minted launch World through forwarded call execution", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-composed-world-")));
  const parent = await born(root, "parent", "11111111");
  const inert = await born(root, "inert", "22222222", []);
  const previousArgv = [...process.argv];
  process.argv.splice(
    2,
    process.argv.length - 2,
    Buffer.from(JSON.stringify({ paths: inert.paths })).toString("base64url"),
  );
  let compositionUpstreamFor: typeof import("../src/akuma-body.js").upstreamFor;
  try {
    ({ upstreamFor: compositionUpstreamFor } = await import("../src/akuma-body.js"));
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
  }
  const alias = (path: string) => `${root}/.${path.slice(root.length)}`;
  const paths = {
    directory: alias(parent.paths.directory),
    heart: alias(parent.paths.heart),
    leash: alias(parent.paths.leash),
    log: alias(parent.paths.log),
    requests: alias(parent.paths.requests),
  };
  let spawns = 0;
  const pump = await BodyRequestPump.open({
    paths,
    parent: parent.soul,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    upstream: await compositionUpstreamFor({ paths: parent.paths }, {}),
    commands: akumaCallRequestCommands(),
    signal: new AbortController().signal,
    async spawn(launch) {
      spawns += 1;
      const leash = (await HeldAkumaLeash.try(launch.paths))!;
      await leash.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-18T00:00:02.000Z" });
      leash.release();
    },
  });
  try {
    const id = randomUUID();
    const child = await requestBodyCall({
      directory: pump.directory,
      id,
      world: root,
      archetype: "worker",
      body: "carried launch World",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        allowed: ALLOWED_ACTIONS,
      },
    });
    assert.equal(spawns, 1);
    assert.equal((await readRequest(parent.paths, id))?.child, child);
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
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async (input) => {
      calls += 1;
      assert.equal(input.requester, parent.id);
      assert.deepEqual(
        {
          contractId: input.contractId,
          message: input.message,
          includeDirty: input.includeDirty,
          materializeConflict: input.materializeConflict,
        },
        { contractId, message: "ship it", includeDirty: true, materializeConflict: false },
      );
      return {
        result: acceptedContract("delivery-result", "deliver"),
        deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      };
    },
  });
  try {
    const id = randomUUID();
    assert.deepEqual(
      await requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId,
        message: "ship it",
        includeDirty: true,
        materializeConflict: false,
      }),
      acceptedContract("delivery-result", "deliver"),
    );
    assert.equal(calls, 1);
    const claim = await readTransportClaim(pump.directory, id);
    assert.deepEqual(claim.payload, {
      repoRoot: root,
      contractId,
      message: "ship it",
      includeDirty: true,
      materializeConflict: false,
    });
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "accepted-reference",
      repoRoot: root,
      contractId,
      deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
    });
    assert.doesNotMatch(JSON.stringify(fact), /delivery-result|marker|tenderSnapshot/u);

    await pump.close();
    const replayPump = await openPump(parent, {
      wait: async () => {
        throw new Error("unexpected wait");
      },
      tell: async () => {
        throw new Error("unexpected tell");
      },
      kill: async () => {
        throw new Error("unexpected kill");
      },
      deliver: async () => {
        calls += 1;
        throw new Error("delivery must not replay");
      },
    });
    try {
      assert.deepEqual(
        await requestBodyDeliver({
          directory: replayPump.directory,
          id,
          repoRoot: root,
          contractId,
          message: "ship it",
          includeDirty: true,
          materializeConflict: false,
        }),
        {
          kind: "accepted-reference",
          repoRoot: root,
          contractId,
          deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
        },
      );
      assert.equal(calls, 1);
    } finally {
      await replayPump.close();
    }
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
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
    review: async (input) => {
      calls += 1;
      assert.equal(input.requester, parent.id);
      assert.deepEqual(
        { contractId: input.contractId, verdict: input.verdict, summary: input.summary },
        { contractId, verdict: "satisfied", summary: "ready" },
      );
      return {
        result: acceptedContract("review-result", "review"),
        reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
      };
    },
  });
  try {
    const id = randomUUID();
    assert.deepEqual(
      await requestBodyReview({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId,
        verdict: "satisfied",
        summary: "ready",
      }),
      acceptedContract("review-result", "review"),
    );
    assert.equal(calls, 1);
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "accepted-reference",
      repoRoot: root,
      contractId,
      reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
    });
    assert.doesNotMatch(JSON.stringify(fact), /review-result|marker/u);

    await pump.close();
    const replayPump = await openPump(parent, {
      wait: async () => {
        throw new Error("unexpected wait");
      },
      tell: async () => {
        throw new Error("unexpected tell");
      },
      kill: async () => {
        throw new Error("unexpected kill");
      },
      deliver: async () => {
        throw new Error("unexpected deliver");
      },
      review: async () => {
        calls += 1;
        throw new Error("review must not replay");
      },
    });
    try {
      assert.deepEqual(
        await requestBodyReview({
          directory: replayPump.directory,
          id,
          repoRoot: root,
          contractId,
          verdict: "satisfied",
          summary: "ready",
        }),
        {
          kind: "accepted-reference",
          repoRoot: root,
          contractId,
          reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
        },
      );
      assert.equal(calls, 1);
    } finally {
      await replayPump.close();
    }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit claims use the default permission, retain owner report evidence, and never replay", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-audit-report-")));
  const parent = await born(root, "parent", "11111111");
  const contractId = "kei/forwarded-audit";
  const report = {
    candidate: { kind: "blocked" as const, refusal: { kind: "target-missing", contractId } },
    verification: { kind: "not-run" as const },
    target: { kind: "not-observed" as const },
  };
  let calls = 0;
  const pump = await openPump(parent, {
    audit: async (input) => {
      calls += 1;
      assert.equal(input.requester, parent.id);
      assert.deepEqual(
        {
          contractId: input.contractId,
          includeDirty: input.includeDirty,
          showDiff: input.showDiff,
        },
        { contractId, includeDirty: true, showDiff: true },
      );
      return { result: { facts: [], head: "head", value: report, lags: [], settlementLags: [] }, auditReport: report };
    },
  });
  try {
    const id = randomUUID();
    assert.deepEqual(
      await requestBodyAudit({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId,
        includeDirty: true,
        showDiff: true,
      }),
      { facts: [], head: "head", value: report, lags: [], settlementLags: [] },
    );
    assert.equal(calls, 1);
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "audit-report",
      repoRoot: root,
      contractId,
      report,
    });

    await pump.close();
    const replayPump = await openPump(parent, {
      audit: async () => {
        calls += 1;
        throw new Error("audit must not replay");
      },
    });
    try {
      assert.deepEqual(
        await requestBodyAudit({
          directory: replayPump.directory,
          id,
          repoRoot: root,
          contractId,
          includeDirty: true,
          showDiff: true,
        }),
        { kind: "audit-report", repoRoot: root, contractId, report },
      );
      assert.equal(calls, 1);
    } finally {
      await replayPump.close();
    }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract review and delivery retain separate request permissions", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-review-permission-")));
  const reviewParent = await born(root, "reviewer", "11111111", ["contract.review"]);
  const reviewPump = await openPump(reviewParent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("delivery must not execute");
    },
    review: async () => ({
      result: acceptedContract("permission", "review"),
      reviewFactId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
    }),
  });
  try {
    assert.deepEqual(
      await requestBodyReview({
        directory: reviewPump.directory,
        id: randomUUID(),
        repoRoot: root,
        contractId: "kei/missing",
        verdict: "unsatisfied",
      }),
      acceptedContract("permission", "review"),
    );
    await assert.rejects(
      requestBodyDeliver({
        directory: reviewPump.directory,
        id: randomUUID(),
        repoRoot: root,
        contractId: "kei/missing",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) =>
        error instanceof AkumaBodyRequestError &&
        error.outcome === "refused" &&
        error.diagnostic === "not-allowed: contract.deliver" &&
        error.message === "contract.deliver refused: not-allowed: contract.deliver",
    );
  } finally {
    await reviewPump.close();
  }

  const deliverParent = await born(root, "deliverer", "22222222", ["contract.deliver"]);
  const deliverPump = await openPump(deliverParent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => ({ result: acceptedContract("permission", "deliver") }),
    review: async () => {
      throw new Error("review must not execute");
    },
  });
  try {
    await assert.rejects(
      requestBodyReview({
        directory: deliverPump.directory,
        id: randomUUID(),
        repoRoot: root,
        contractId: "kei/missing",
        verdict: "unsatisfied",
      }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.diagnostic === "not-allowed: contract.review",
    );
  } finally {
    await deliverPump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-id task.add and all Task mutations preserve selected World and inputs while Heart keeps only service markers", async () => {
  const parentRoot = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-forward-parent-")));
  const selectedWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-forward-selected-")));
  const parent = await born(parentRoot, "parent", "22222222", [
    "task.add",
    "task.addDocument",
    "task.compose",
    "task.update",
    "task.start",
    "task.stop",
    "task.hold",
    "task.resume",
    "task.done",
    "task.drop",
  ]);
  const calls: { action: string; world: string; requester: string; request: unknown }[] = [];
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
    task: async (input) => {
      calls.push({
        action: input.request.action,
        world: input.world,
        requester: input.requester,
        request: input.request,
      });
      if ("ids" in input.request) {
        return {
          items: input.request.ids.map((id) => ({
            id,
            outcome: { kind: "accepted", value: acceptedTaskView(id) },
          })),
        };
      }
      if (input.request.action === "task.add" || input.request.action === "task.addDocument") {
        return {
          kind: "accepted",
          value: acceptedTaskView("task/created", "exact\nmarkdown"),
        };
      }
      if (input.request.action === "task.compose") {
        return {
          kind: "accepted",
          aliases: [],
          admissionOrder: [],
          documentChanges: [{ kind: "created", taskId: "task/composed", documentDiff: "must not persist" }],
        };
      }
      if (input.request.action === "task.update") {
        return { kind: "accepted", value: { task: acceptedTaskView("task/target"), documentDiff: "must not persist" } };
      }
      return { kind: "accepted", value: acceptedTaskView("task/target") };
    },
  });
  const requests = [
    { action: "task.add" as const, input: { title: "Add", body: "exact\nbody", namespace: ["caller"] } },
    { action: "task.addDocument" as const, input: { markdown: "# Exact\n\nbody\n", namespace: ["caller"] } },
    { action: "task.compose" as const, markdown: "+ Compose\n", namespace: ["caller"] },
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
        const outcomes = await Promise.all(
          [1, 2].map(
            async () =>
              await requestBodyTask({
                directory: pump.directory,
                id,
                world: selectedWorld,
                request,
              }),
          ),
        );
        assert.deepEqual(sortByKind(outcomes as Array<Readonly<{ kind: string }>>), [
          {
            kind: "accepted",
            value: acceptedTaskView("task/created", "exact\nmarkdown"),
          },
          { kind: "served-reference", action: "task.add" },
        ]);
      } else {
        await requestBodyTask({ directory: pump.directory, id, world: selectedWorld, request });
      }
      const fact = await readRequest(parent.paths, id);
      assert.equal(fact?.state, "served");
      if (fact?.state === "served" && "service" in fact) {
        assert.deepEqual(JSON.parse(fact.serviceJson), { action: request.action });
        assert.equal(fact.serviceJson.includes(selectedWorld), false);
        assert.equal(fact.serviceJson.includes("task/target"), false);
      }
    }
    assert.equal(calls.length, requests.length);
    assert.deepEqual(
      calls.map((call) => call.action),
      requests.map((request) => request.action),
    );
    assert.equal(
      calls.every((call) => call.world === selectedWorld && call.requester === parent.id),
      true,
    );
    assert.equal((calls[0]?.request as { input: { body: string } }).input.body, "exact\nbody");
    assert.equal((calls[1]?.request as { input: { markdown: string } }).input.markdown, "# Exact\n\nbody\n");
    assert.equal((calls[8]?.request as { note: string }).note, "exact note");

    await pump.close();
    const replayPump = await openPump(parent, {
      wait: async () => {
        throw new Error("unexpected wait");
      },
      tell: async () => {
        throw new Error("unexpected tell");
      },
      kill: async () => {
        throw new Error("unexpected kill");
      },
      deliver: async () => {
        throw new Error("unexpected deliver");
      },
      task: async () => {
        throw new Error("Task must not replay");
      },
    });
    try {
      assert.deepEqual(
        await requestBodyTask({
          directory: replayPump.directory,
          id: "00000000-0000-4000-8000-000000000100",
          world: selectedWorld,
          request: requests[0]!,
        }),
        { kind: "served-reference", action: "task.add" },
      );
      assert.equal(calls.length, requests.length);
    } finally {
      await replayPump.close();
    }
  } finally {
    await pump.close();
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(selectedWorld, { recursive: true, force: true });
  }
});

test("every complete native Task result is served unchanged", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-forward-results-")));
  const parent = await born(root, "parent", "23232323", ["task.start", "task.stop", "task.compose", "task.done"]);
  const results = [
    { kind: "refused", refusal: { kind: "task-missing", taskId: "task/missing" } },
    { kind: "retry", reason: "busy" },
    {
      kind: "incomplete",
      aliases: [],
      admissionOrder: [],
      documentChanges: [],
      stopped: { kind: "retry", reason: "concurrent-modification" },
      draft: "+ Remaining\n",
    },
    {
      items: [
        {
          id: "task/one",
          outcome: { kind: "accepted", value: acceptedTaskView("task/one") },
        },
        {
          id: "task/two",
          outcome: { kind: "refused", refusal: { kind: "task-missing", taskId: "task/two" } },
        },
      ],
    },
  ] as const;
  let call = 0;
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
    task: async () => results[call++]!,
  });
  const requests = [
    { action: "task.start" as const, id: "task/missing" as const },
    { action: "task.stop" as const, id: "task/target" as const },
    { action: "task.compose" as const, markdown: "+ Remaining\n", namespace: ["caller"] },
    { action: "task.done" as const, ids: ["task/one", "task/two"] as const },
  ];
  try {
    for (const [index, request] of requests.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 400).padStart(12, "0")}`;
      assert.deepEqual(await requestBodyTask({ directory: pump.directory, id, world: root, request }), results[index]);
      const fact = await readRequest(parent.paths, id);
      assert.equal(fact?.state, "served");
      if (fact?.state === "served" && "service" in fact) {
        assert.deepEqual(JSON.parse(fact.serviceJson), { action: request.action });
        assert.doesNotMatch(fact.serviceJson, /task\/missing|concurrent-modification|Remaining/u);
      }
    }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task owns malformed live-result and durable-reference decoders", async () => {
  const command = taskMutationRequestCommand("task.start");
  assert.throws(
    () => command.decodeResult({ kind: "accepted" }),
    /transport integrity: Task task\.start returned an invalid live result/u,
  );
  assert.throws(
    () => command.decodeResult({ kind: "accepted", value: { id: "task/target" } }),
    /transport integrity: Task task\.start returned an invalid live result/u,
  );
  assert.equal(command.decodeRequest({ id: "task/target", unexpected: true }), null);
  assert.throws(
    () => command.decodeResult({ kind: "accepted", value: { ...acceptedTaskView("task/target"), unexpected: true } }),
    /transport integrity: Task task\.start returned an invalid live result/u,
  );
  assert.throws(
    () => command.decodeService({ action: "task.stop" }),
    /malformed stored Task service evidence for task\.start/u,
  );
  assert.throws(
    () => command.decodeReference({ kind: "served-reference", action: "task.stop" }),
    /malformed Task service reference for task\.start/u,
  );

  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-malformed-result-")));
  const parent = await born(root, "parent", "24242424", ["task.start"]);
  const id = randomUUID();
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
    task: async () => ({ kind: "accepted" }),
  });
  try {
    await assert.rejects(
      requestBodyTask({
        directory: pump.directory,
        id,
        world: root,
        request: { action: "task.start", id: "task/target" },
      }),
      new RegExp(`transport integrity: request ${id} action task\\.start returned an invalid live result`, "u"),
    );
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task raw Body execution mints its World before Task dispatch", async () => {
  const command = taskMutationRequestCommand("task.add");
  const request = command.decodeRequest({
    world: "/definitely-not-a-keiyaku-world",
    request: { input: { title: "unreachable", namespace: [] } },
  });
  assert.notEqual(request, null);
  if (request === null) return;

  let dispatched = false;
  await assert.rejects(
    command.execute(request, {
      requester: "aku/worker/11111111",
      signal: new AbortController().signal,
      upstream: {
        task: async () => {
          dispatched = true;
          throw new Error("Task port must not receive an unminted World");
        },
      },
    }),
    /world path is not an existing directory: \/definitely-not-a-keiyaku-world/u,
  );
  assert.equal(dispatched, false);
});

test("CLI forwards Task mutations through the parent and renders the native Task result", async () => {
  const parentRoot = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-cli-parent-")));
  const selectedWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-task-cli-selected-")));
  const parent = await born(parentRoot, "parent", "33333333", ["task.add"]);
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
    task: async (input) =>
      await executeTaskMutation({
        world: input.world,
        request: input.request,
        requester: input.requester,
        signal: input.signal,
      }),
  });
  const previous = process.env[AKUMA_REQUESTS_ENV];
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const result = await invoke(
      parseArgv(["-C", selectedWorld, "task", "add", "CLI forwarded", "--body", "exact\nbody"]),
    );
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
      payloadJson: JSON.stringify({ request: { input: { title: "Never replayed" } }, world: root }),
      admittedAt: "2026-08-18T00:00:01.000Z",
      permitted: true,
    });
    assert.equal(await settleBodyRequests(parent.paths, parent.soul, () => "2026-08-18T00:00:02.000Z"), "settled");
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
    const board = await Tasks.of(root).list({ selection: "all", scope: "world" });
    assert.equal(board.kind, "accepted");
    if (board.kind === "accepted") assert.equal(board.value.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CLI forwarded deliver preserves its selected Repo and uses parent Settings and execution", async () => {
  const gitPath = gitExecutablePath();
  const parentRepository = makeGitRepository();
  const contractRepository = makeGitRepository();
  for (const repository of [parentRepository, contractRepository]) {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  const root = await World.at(parentRepository.path);
  const parent = await born(root, "parent", "11111111", ["contract.deliver", "contract.review"]);
  const inert = await born(root, "inert", "22222222", []);
  const parentHome = mkdtempSync(join(tmpdir(), "keiyaku-forwarded-parent-settings-"));
  const childHome = mkdtempSync(join(tmpdir(), "keiyaku-forwarded-child-settings-"));
  const hookLog = join(parentHome, "parent-create-hook.log");
  await writeFile(
    join(parentHome, "settings.json"),
    JSON.stringify({
      git: { requireBranchesToBeUpToDate: true },
      worktree: {
        create: [
          {
            name: "parent-create",
            argv: [
              process.execPath,
              "-e",
              `require("node:fs").appendFileSync(${JSON.stringify(hookLog)}, "created\\n")`,
            ],
            timeoutMs: 5_000,
          },
        ],
        destroy: [],
      },
    }),
  );
  await writeFile(join(childHome, "settings.json"), "{");
  const repo = await Repo.at({ path: contractRepository.path, gitPath });
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
  await writeFile(join(worktree, "candidate.txt"), "candidate\n");
  contractRepository.run(["-C", worktree, "add", "candidate.txt"]);
  contractRepository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const previousArgv = [...process.argv];
  process.argv.splice(
    2,
    process.argv.length - 2,
    Buffer.from(JSON.stringify({ paths: inert.paths })).toString("base64url"),
  );
  let compositionUpstreamFor: typeof import("../src/akuma-body.js").upstreamFor;
  try {
    ({ upstreamFor: compositionUpstreamFor } = await import("../src/akuma-body.js"));
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
  }
  let pump = await openPump(
    parent,
    await compositionUpstreamFor({ paths: parent.paths }, { home: parentHome, gitPath }),
  );
  const noncanonical = requestBodyDeliver({
    directory: pump.directory,
    id: randomUUID(),
    repoRoot: `${contractRepository.path}/.`,
    contractId: id,
    includeDirty: true,
    materializeConflict: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await pump.close();
  await assert.rejects(
    noncanonical,
    (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
  );
  pump = await openPump(parent, await compositionUpstreamFor({ paths: parent.paths }, { home: parentHome, gitPath }));
  const previous = process.env[AKUMA_REQUESTS_ENV];
  const previousPath = process.env.PATH;
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    process.env.PATH = "";
    const result = await invoke(
      parseArgv(["--repo", contractRepository.path, "deliver", id]),
      {
        cwd: parentRepository.path,
        environment: {
          KEIYAKU_HOME: childHome,
          KEIYAKU_GIT_PATH: gitPath,
          PATH: "",
          [AKUMA_REQUESTS_ENV]: pump.directory,
        },
      },
    );
    const state = await bound.keiyaku.state();
    assert.equal(result.kind, "accepted");
    assert.equal((await bound.keiyaku.delivery()) instanceof Delivery, true);
    assert.equal(state.delivery?.actor, parent.id);
    assert.equal(state.delivery?.data.policy.requireBranchesToBeUpToDate, true);
    assert.equal(existsSync(hookLog), false);

    const reviewed = await invoke(
      parseArgv([
        "--repo",
        contractRepository.path,
        "review",
        id,
        "--unsatisfied",
        "--summary",
        "needs work",
      ]),
      {
        cwd: parentRepository.path,
        environment: {
          KEIYAKU_HOME: childHome,
          KEIYAKU_GIT_PATH: gitPath,
          PATH: "",
          [AKUMA_REQUESTS_ENV]: pump.directory,
        },
      },
    );
    assert.equal(reviewed.kind, "accepted");
    const reviewedState = await bound.keiyaku.state();
    assert.equal(reviewedState.attestations.at(-1)?.actor, parent.id);
    assert.equal(reviewedState.attestations.at(-1)?.data.summary, "needs work");
  } finally {
    if (previous === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
  const id = randomUUID();
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new KeiyakuRefused({ kind: "contract-missing", contractId: "kei/not-accepted" });
    },
  });
  try {
    await assert.rejects(
      requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId: "kei/not-accepted",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) =>
        error instanceof KeiyakuRefused &&
        assert.deepEqual(error.refusal, { kind: "contract-missing", contractId: "kei/not-accepted" }) === undefined,
    );
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
  } finally {
    await pump.close();
  }

  const replay = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      throw new Error("voided deliver must not replay");
    },
  });
  try {
    await assert.rejects(
      requestBodyDeliver({
        directory: replay.directory,
        id,
        repoRoot: root,
        contractId: "kei/not-accepted",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
  } finally {
    await replay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract forwarding preserves typed live failures for deliver, review, and audit", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-contract-live-failures-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver", "contract.review", "contract.audit"]);
  const pump = await openPump(parent, {
    deliver: async () => {
      throw new KeiyakuRefused({ kind: "contract-missing", contractId: "kei/missing-deliver" });
    },
    review: async () => {
      throw new KeiyakuRetry({ kind: "collision" });
    },
    audit: async () => {
      throw new KeiyakuRefused({ kind: "terminal", contractId: "kei/missing-audit" });
    },
  });
  try {
    const deliverId = randomUUID();
    await assert.rejects(
      requestBodyDeliver({
        directory: pump.directory,
        id: deliverId,
        repoRoot: root,
        contractId: "kei/missing-deliver",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) =>
        error instanceof KeiyakuRefused &&
        assert.deepEqual(error.refusal, { kind: "contract-missing", contractId: "kei/missing-deliver" }) === undefined,
    );
    const reviewId = randomUUID();
    await assert.rejects(
      requestBodyReview({
        directory: pump.directory,
        id: reviewId,
        repoRoot: root,
        contractId: "kei/missing-review",
        verdict: "unsatisfied",
      }),
      (error: unknown) => error instanceof KeiyakuRetry && error.reason.kind === "collision",
    );
    const auditId = randomUUID();
    await assert.rejects(
      requestBodyAudit({
        directory: pump.directory,
        id: auditId,
        repoRoot: root,
        contractId: "kei/missing-audit",
        includeDirty: false,
        showDiff: false,
      }),
      (error: unknown) =>
        error instanceof KeiyakuRefused &&
        assert.deepEqual(error.refusal, { kind: "terminal", contractId: "kei/missing-audit" }) === undefined,
    );
    for (const id of [deliverId, reviewId, auditId]) {
      const fact = await readRequest(parent.paths, id);
      assert.equal(fact?.state, "voided");
      assert.equal(fact !== null && fact !== undefined && "serviceJson" in fact, false);
    }
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an executor throw settles its admitted request voided", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-executor-voided-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const id = randomUUID();
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      calls += 1;
      throw new Error("executor unavailable");
    },
  });
  try {
    await assert.rejects(
      requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId: "kei/executor-voided",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) =>
        error instanceof AkumaBodyRequestError &&
        error.outcome === "voided" &&
        error.diagnostic === "executor unavailable" &&
        error.message === "contract.deliver failed: executor unavailable",
    );
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
    await assert.rejects(
      requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId: "kei/executor-voided",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) =>
        error instanceof AkumaBodyRequestError &&
        error.outcome === "voided" &&
        error.diagnostic === "executor unavailable" &&
        error.message === "contract.deliver failed: executor unavailable",
    );
    assert.equal(calls, 1);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("forwarded materialization is a live result and stores no Heart delivery reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-materialized-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const materialized = {
    kind: "integration-conflict-materialized" as const,
    targetHead: "target-head",
    conflictPaths: ["shared.txt"],
    workspace: { kind: "worktree" as const, path: "/tmp/wt" },
  };
  let calls = 0;
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async (input) => {
      calls += 1;
      assert.equal(input.materializeConflict, true);
      return { result: materialized };
    },
  });
  try {
    const id = randomUUID();
    await assert.rejects(
      requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId: "kei/conflicted",
        includeDirty: false,
        materializeConflict: true,
      }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
    assert.equal(calls, 1);
    const claim = await readTransportClaim(pump.directory, id);
    assert.deepEqual(claim.payload, {
      repoRoot: root,
      contractId: "kei/conflicted",
      includeDirty: false,
      materializeConflict: true,
    });
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
  const executorStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const executorReleased = new Promise<Readonly<{ result: unknown; deliveryFactId: string }>>((resolve) => {
    release = resolve;
  });
  const id = randomUUID();
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
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
      materializeConflict: false,
    });
    await executorStarted;
    pump.stopAdmission();
    const closing = pump.close();
    release({ result: acceptedContract("drained", "deliver"), deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" });
    await closing;
    await assert.rejects(
      request,
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "accepted-reference",
      repoRoot: root,
      contractId: "kei/drained",
      deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    });
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an identical retry converges on its existing terminal request when replay fences admission", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-terminal-replay-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const id = randomUUID();
  let calls = 0;
  const first = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      calls += 1;
      return { result: acceptedContract("terminal-replay", "deliver"), deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FD0" };
    },
  });
  try {
    await requestBodyDeliver({
      directory: first.directory,
      id,
      repoRoot: root,
      contractId: "kei/terminal-replay",
      includeDirty: false,
      materializeConflict: false,
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
    spawn: async () => {
      throw new Error("call is outside this test");
    },
    signal: new AbortController().signal,
    commands: { ...fleetRequestCommands(), ...contractRequestCommands() },
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      calls += 1;
      throw new Error("terminal replay must not execute");
    },
  });
  try {
    assert.deepEqual(
      await requestBodyDeliver({
        directory: replay.directory,
        id,
        repoRoot: root,
        contractId: "kei/terminal-replay",
        includeDirty: false,
        materializeConflict: false,
      }),
      {
        kind: "accepted-reference",
        repoRoot: root,
        contractId: "kei/terminal-replay",
        deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
      },
    );
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
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    ...noDeliver(),
  });
  try {
    assert.deepEqual(
      await requestBodyWait({
        directory: first.directory,
        id,
        targets: [target],
        completion: "all",
      }),
      { kind: "returned", result: { observed: true } },
    );
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
    spawn: async () => {
      throw new Error("call is outside this test");
    },
    signal: new AbortController().signal,
    commands: fleetRequestCommands(),
    wait: async () => {
      calls += 1;
      throw new Error("terminal replay must not execute");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    ...noDeliver(),
  });
  try {
    assert.deepEqual(
      await requestBodyWait({
        directory: replay.directory,
        id,
        targets: [target],
        completion: "all",
      }),
      { kind: "reference", reference: { action: "akuma.wait" } },
    );
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
  const executorStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const executorReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = randomUUID();
  const pump = await openPump(parent, {
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
    deliver: async () => {
      started();
      await executorReleased;
      return { result: acceptedContract("missing-receipt", "deliver"), deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" };
    },
  });
  try {
    const request = requestBodyDeliver({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId: "kei/missing-receipt",
      includeDirty: false,
      materializeConflict: false,
    });
    await executorStarted;
    rmSync(pump.directory, { recursive: true, force: true });
    release();
    await assert.rejects(
      request,
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
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
    assert.deepEqual(
      await requestBodyWait({
        directory: pump.directory,
        id: waitId,
        targets: [first, second],
        completion: "all",
        timeoutMs: 0,
      }),
      { kind: "returned", result: { completion: "all", marker: "wait-result" } },
    );
    assert.deepEqual(
      await requestBodyTell({
        directory: pump.directory,
        id: tellId,
        target: first,
        body: "continue",
      }),
      { kind: "returned", result: { tellId, marker: "tell-result" } },
    );
    const duplicateKills = await Promise.all(
      [1, 2].map(
        async () =>
          await requestBodyKill({
            directory: pump.directory,
            id: killId,
            targets: [first, second],
          }),
      ),
    );
    assert.deepEqual(sortByKind(duplicateKills), [
      {
        kind: "reference",
        reference: {
          action: "akuma.kill",
          results: [
            { id: first, evidence: "already-stopped" },
            { id: second, evidence: "already-stopped" },
          ],
        },
      },
      { kind: "returned", result: { marker: "kill-result" } },
    ]);
    assert.equal(killCalls, 1);

    const waitFact = await readRequest(parent.paths, waitId);
    const tellFact = await readRequest(parent.paths, tellId);
    const killFact = await readRequest(parent.paths, killId);
    assert.deepEqual(
      waitFact?.state === "served" && "serviceJson" in waitFact ? JSON.parse(waitFact.serviceJson) : null,
      {
        action: "akuma.wait",
      },
    );
    assert.deepEqual(
      tellFact?.state === "served" && "serviceJson" in tellFact ? JSON.parse(tellFact.serviceJson) : null,
      {
        action: "akuma.tell",
        target: first,
        tellId,
      },
    );
    assert.deepEqual(
      killFact?.state === "served" && "serviceJson" in killFact ? JSON.parse(killFact.serviceJson) : null,
      {
        action: "akuma.kill",
        results: [
          { id: first, evidence: "already-stopped" },
          { id: second, evidence: "already-stopped" },
        ],
      },
    );
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
    wait: async () => {
      calls.push("wait");
      return { observed: true };
    },
    tell: async () => {
      calls.push("tell");
      return {};
    },
    kill: async () => {
      calls.push("kill");
      return { result: {}, service: [] };
    },
  });
  try {
    assert.deepEqual(
      await requestBodyWait({
        directory: pump.directory,
        id: randomUUID(),
        targets: [target],
        completion: "all",
      }),
      { kind: "returned", result: { observed: true } },
    );
    await assert.rejects(
      requestBodyTell({
        directory: pump.directory,
        id: randomUUID(),
        target,
        body: "blocked",
      }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.diagnostic === "not-allowed: akuma.tell",
    );
    await assert.rejects(
      requestBodyKill({
        directory: pump.directory,
        id: randomUUID(),
        targets: [target],
      }),
      (error: unknown) => error instanceof AkumaBodyRequestError && error.diagnostic === "not-allowed: akuma.kill",
    );
    await assert.rejects(
      requestBodyDeliver({
        directory: pump.directory,
        id: randomUUID(),
        repoRoot: root,
        contractId: "kei/blocked",
        includeDirty: false,
        materializeConflict: false,
      }),
      (error: unknown) =>
        error instanceof AkumaBodyRequestError && error.diagnostic === "not-allowed: contract.deliver",
    );
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
    wait: async () => {
      calls += 1;
      return {};
    },
    tell: async () => {
      calls += 1;
      return {};
    },
    kill: async () => {
      calls += 1;
      return { result: {}, service: [] };
    },
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
    await Promise.all(
      claims.map(
        async (claim) =>
          await writeFile(join(pump.directory, `${claim.id}.request.json`), `${JSON.stringify(claim)}\n`),
      ),
    );
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
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
  });
  const previous = process.env[AKUMA_REQUESTS_ENV];
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const result = await waitAkuma(
      {
        path: root,
        akuma: ["@target", "aku/worker/*", target.id],
        completion: "all",
        timeoutMs: 0,
      },
      bodyRequestExecutionContext(pump.directory),
    );
    assert.deepEqual(received, [target.id]);
    assert.deepEqual(
      result.observations.map((observation) => observation.status.id),
      [target.id],
    );
  } finally {
    if (previous === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previous;
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forwarded Tell writes its transport and the direct parent enters the tell executor once", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-tell-")));
  const parent = await born(root, "parent", "11111111", ["akuma.tell"]);
  const target = await born(root, "worker", "22222222");
  const targetLeash = (await HeldAkumaLeash.try(target.paths))!;
  await targetLeash.recordBody(target.paths, { leashTakenAt: "2026-08-18T00:00:01.000Z" });
  let calls = 0;
  const pump = await openPump(parent, {
    ...noDeliver(),
    wait: async () => {
      throw new Error("unexpected wait");
    },
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
    kill: async () => {
      throw new Error("unexpected kill");
    },
  });
  try {
    const id = randomUUID();
    const outcomes = await Promise.all(
      [1, 2].map(
        async () =>
          await requestBodyTell({
            directory: pump.directory,
            id,
            target: target.id,
            body: "continue",
          }),
      ),
    );
    assert.equal(outcomes.filter((value) => (value as { kind: string }).kind === "returned").length, 1);
    assert.deepEqual(
      outcomes.find((value) => (value as { kind: string }).kind === "reference"),
      {
        kind: "reference",
        reference: { action: "akuma.tell", target: target.id, tellId: id },
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      (await readHeart(target.paths)).pending.map((tell) => ({ id: tell.id, body: tell.body })),
      [{ id, body: "continue" }],
    );
    const request = await readRequest(parent.paths, id);
    assert.deepEqual(request?.state === "served" && "serviceJson" in request ? JSON.parse(request.serviceJson) : null, {
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
