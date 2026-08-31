import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { AkumaBodyRequestError, requestBodyCommand } from "../src/akuma/requests.js";
import { BodyRequestPump, settleBodyRequests } from "../src/akuma/request-serve.js";
import { BodyRequestPump as LifecycleBodyRequestPump } from "../src/akuma/request-lifecycle.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import {
  executeTellAkuma,
  fleetRequestCommand,
  fleetRequestProtocol,
  fleetRequestCommands,
  type FleetRequestPort,
} from "../src/library/fleet.js";
import {
  contractRequestCommand,
  contractRequestProtocol,
  contractRequestCommands,
  type ContractRequestPort,
} from "../src/library/contract-operations.js";
import { KeiyakuRefused } from "../src/library/refusal.js";
import { repositoryAt } from "../src/git/repository.js";
import { Delivery, Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { World, type WorldRoot } from "../src/world.js";
import { Tasks } from "../src/task/index.js";
import {
  taskMutationRequestCommand,
  taskMutationRequestProtocol,
  type TaskMutationRequestPort,
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

async function openFleetPump(
  parent: Awaited<ReturnType<typeof born>>,
  port: FleetRequestPort,
): Promise<BodyRequestPump> {
  return await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: fleetRequestCommands(port),
    signal: new AbortController().signal,
  });
}

async function openContractPump(
  parent: Awaited<ReturnType<typeof born>>,
  port: ContractRequestPort,
): Promise<BodyRequestPump> {
  return await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: contractRequestCommands(port),
    signal: new AbortController().signal,
  });
}

async function openFleetAndContractPump(
  parent: Awaited<ReturnType<typeof born>>,
  fleet: FleetRequestPort,
  contract: ContractRequestPort,
): Promise<BodyRequestPump> {
  return await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: composeRequestCommands(fleetRequestCommands(fleet), contractRequestCommands(contract)),
    signal: new AbortController().signal,
  });
}

const unusedFleetPort: FleetRequestPort = {
  wait: async () => {
    throw new Error("unexpected Fleet request");
  },
  tell: async () => {
    throw new Error("unexpected Fleet request");
  },
  kill: async () => {
    throw new Error("unexpected Fleet request");
  },
};

const unusedContractPort: ContractRequestPort = {
  audit: async () => {
    throw new Error("unexpected Contract request");
  },
  deliver: async () => {
    throw new Error("unexpected Contract request");
  },
  review: async () => {
    throw new Error("unexpected Contract request");
  },
};

const unusedTaskPort: TaskMutationRequestPort = {
  task: async () => {
    throw new Error("unexpected Task request");
  },
};

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
    command: contractRequestProtocol("contract.deliver"),
    value: { action: "contract.deliver", ...request },
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
  const command = fleetRequestProtocol("akuma.wait");
  return await requestBodyCommand({
    ...input,
    command,
    value: {
      action: "akuma.wait",
      targets: input.targets,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
  });
}

async function requestBodyTell(input: Readonly<{ directory: string; id?: string; target: AkuId; body: string }>) {
  const command = fleetRequestProtocol("akuma.tell");
  return await requestBodyCommand({
    ...input,
    command,
    value: { action: "akuma.tell", target: input.target, body: input.body },
  });
}

async function requestBodyKill(input: Readonly<{ directory: string; id?: string; targets: readonly AkuId[] }>) {
  const command = fleetRequestProtocol("akuma.kill");
  return await requestBodyCommand({
    ...input,
    command,
    value: { action: "akuma.kill", targets: input.targets },
  });
}

const emptyWaitResult = { completion: "all" as const, observations: [], unobserved: [] };

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

function noDeliver(): Readonly<{ deliver(): Promise<never> }> {
  return {
    deliver: async () => {
      throw new Error("unexpected deliver");
    },
  };
}

test("Contract owner codecs reject malformed live, failure, and service payloads", () => {
  const protocol = contractRequestProtocol("contract.deliver");
  const command = contractRequestCommand("contract.deliver", unusedContractPort);
  assert.throws(
    () => protocol.decodeResult({ kind: "accepted", result: {} }),
    /transport integrity: Contract contract\.deliver returned an invalid live result/u,
  );
  assert.equal(protocol.decodeFailure?.({ kind: "refused", refusal: { kind: "contract-missing" } }), null);
  assert.throws(
    () => command.decodeService({ malformed: true }),
    /malformed stored Contract service evidence for contract\.deliver/u,
  );
});

test("Fleet owner codecs reject malformed live and service payloads", () => {
  assert.throws(
    () => fleetRequestProtocol("akuma.wait").decodeResult({ completion: "all", observations: [], unobserved: [{}] }),
    /invalid live result for akuma\.wait/u,
  );
  assert.throws(
    () =>
      fleetRequestCommand("akuma.tell", unusedFleetPort).decodeService({
        action: "akuma.tell",
        target: "aku/worker/nothex",
        tellId: "tell",
      }),
    /malformed stored Fleet service evidence/u,
  );
});

test("Task owner codecs reject malformed live and service/reference payloads", () => {
  const protocol = taskMutationRequestProtocol("task.start");
  const command = taskMutationRequestCommand("task.start", unusedTaskPort);
  assert.throws(
    () => protocol.decodeResult({ kind: "accepted" }),
    /transport integrity: Task task\.start returned an invalid live result/u,
  );
  assert.throws(
    () => command.decodeService({ action: "task.stop" }),
    /malformed stored Task service evidence for task\.start/u,
  );
  assert.throws(
    () => protocol.decodeReference({ kind: "served-reference", action: "task.stop" }),
    /malformed Task service reference for task\.start/u,
  );
});

test("request command composition rejects a duplicate action", () => {
  assert.throws(
    () => composeRequestCommands(fleetRequestCommands(unusedFleetPort), fleetRequestCommands(unusedFleetPort)),
    /duplicate request command action: akuma\.wait/u,
  );
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
      allowed: parent.soul.allowed,
      bodySequence: 1,
      now: () => "2026-08-18T00:00:01.000Z",
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
  const pump = await openFleetPump(parent, {
    wait: async () => {
      calls += 1;
      return emptyWaitResult;
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
    assert.deepEqual(await requestBodyWait(first), { kind: "returned", result: emptyWaitResult });
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
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => {
      if (!fenceScheduled) {
        fenceScheduled = true;
        setImmediate(() => pump.stopAdmission());
      }
      return "2026-08-18T00:00:01.000Z";
    },
    commands: akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: parent.soul,
      spawn: async () => {
        spawnCalls += 1;
      },
    }),
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

test("a noncanonical routed call fails the pump before child allocation", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-world-proof-")));
  const parent = await born(root, "parent", "11111111");
  let spawns = 0;
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: parent.soul,
      spawn: async () => {
        spawns += 1;
      },
    }),
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
    await assert.rejects(pump.failure, /registered request action akuma\.call rejected its payload/u);
    assert.equal(spawns, 0);
    assert.equal(await readRequest(parent.paths, id), null);
    await assert.rejects(pump.close(), /registered request action akuma\.call rejected its payload/u);
    await assert.rejects(
      request,
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a semantically invalid call recipe fails the pump before Heart admission", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-call-invalid-recipe-")));
  const parent = await born(root, "parent", "11111111");
  let spawnCalls = 0;
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: parent.soul,
      spawn: async () => {
        spawnCalls += 1;
        throw new Error("invalid recipe must not spawn");
      },
    }),
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
    await assert.rejects(pump.failure, /registered request action akuma\.call rejected its payload/u);
    const fact = await readRequest(parent.paths, id);
    assert.equal(fact, null);
    assert.equal(spawnCalls, 0);
    await assert.rejects(pump.close(), /registered request action akuma\.call rejected its payload/u);
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
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: parent.soul,
      spawn: async (launch) => {
        spawns += 1;
        const leash = (await HeldAkumaLeash.try(launch.paths))!;
        await leash.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-18T00:00:02.000Z" });
        leash.release();
      },
    }),
    signal: new AbortController().signal,
  });
  try {
    const child = await requestBodyCall({ directory: first.directory, ...request });
    await first.close();
    const replay = await BodyRequestPump.open({
      paths: parent.paths,
      allowed: parent.soul.allowed,
      bodySequence: 2,
      now: () => "2026-08-18T00:00:03.000Z",
      commands: akumaCallRequestCommands({
        world: root,
        paths: parent.paths,
        parent: parent.soul,
        spawn: async () => {
          throw new Error("terminal call must not spawn again");
        },
      }),
      signal: new AbortController().signal,
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

test("deliver claims execute once and Heart retains only the Contract fact reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-reference-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const contractId = "kei/forwarded-delivery";
  let calls = 0;
  const pump = await openContractPump(parent, {
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
    const replayPump = await openContractPump(parent, {
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
    if (board.kind === "accepted") {
      assert.deepEqual(board.value.rows, []);
      assert.equal(board.value.hasMore, false);
    }
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
  let externalRequestCommandsFor: typeof import("../src/akuma-body.js").externalRequestCommandsFor;
  try {
    ({ externalRequestCommandsFor } = await import("../src/akuma-body.js"));
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
  }
  let composition = await externalRequestCommandsFor({ paths: parent.paths }, { home: parentHome, gitPath });
  let pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: composition.commands,
    signal: new AbortController().signal,
  });
  const noncanonical = requestBodyDeliver({
    directory: pump.directory,
    id: randomUUID(),
    repoRoot: `${contractRepository.path}/.`,
    contractId: id,
    includeDirty: true,
    materializeConflict: false,
  });
  await assert.rejects(pump.failure, /registered request action contract\.deliver rejected its payload/u);
  await assert.rejects(pump.close(), /registered request action contract\.deliver rejected its payload/u);
  await assert.rejects(
    noncanonical,
    (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "voided",
  );
  composition = await externalRequestCommandsFor({ paths: parent.paths }, { home: parentHome, gitPath });
  pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands: composition.commands,
    signal: new AbortController().signal,
  });
  const previous = process.env[AKUMA_REQUESTS_ENV];
  const previousPath = process.env.PATH;
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    process.env.PATH = "";
    const result = await invoke(parseArgv(["--repo", contractRepository.path, "deliver", id]), {
      cwd: parentRepository.path,
      environment: {
        KEIYAKU_HOME: childHome,
        KEIYAKU_GIT_PATH: gitPath,
        PATH: "",
        [AKUMA_REQUESTS_ENV]: pump.directory,
      },
    });
    const state = await bound.keiyaku.state();
    assert.equal(result.kind, "accepted");
    assert.equal((await bound.keiyaku.delivery()) instanceof Delivery, true);
    assert.equal(state.delivery?.actor, parent.id);
    assert.equal(state.delivery?.data.policy.requireBranchesToBeUpToDate, true);
    assert.equal(existsSync(hookLog), false);

    const reviewed = await invoke(
      parseArgv(["--repo", contractRepository.path, "review", id, "--unsatisfied", "--summary", "needs work"]),
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
  const pump = await openContractPump(parent, {
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

  const replay = await openContractPump(parent, {
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

test("an executor throw settles its begun request unproven", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-executor-voided-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const id = randomUUID();
  let calls = 0;
  const pump = await openContractPump(parent, {
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
      assert.equal((await readRequest(parent.paths, id))?.state, "begun");
      assert.equal(input.signal.aborted, false);
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
        error.outcome === "unproven" &&
        error.diagnostic === "executor unavailable" &&
        error.message === "contract.deliver unproven: executor unavailable",
    );
    assert.equal((await readRequest(parent.paths, id))?.state, "unproven");
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
        error.outcome === "unproven" &&
        error.diagnostic === "executor unavailable" &&
        error.message === "contract.deliver unproven: executor unavailable",
    );
    assert.equal(calls, 1);
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
  const pump = await openContractPump(parent, {
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
      started();
      const result = await executorReleased;
      assert.equal(input.signal.aborted, true);
      return result;
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
  const pump = await openContractPump(parent, {
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

test("Heart leaves wait unkeyed and refuses disabled mutations before their executors", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-policy-")));
  const parent = await born(root, "parent", "11111111", []);
  const target = "aku/worker/22222222" as AkuId;
  const calls: string[] = [];
  const fleet: FleetRequestPort = {
    wait: async () => {
      calls.push("wait");
      return emptyWaitResult;
    },
    tell: async () => {
      calls.push("tell");
      return {} as never;
    },
    kill: async () => {
      calls.push("kill");
      return {} as never;
    },
  };
  const contract: ContractRequestPort = {
    audit: async () => {
      calls.push("audit");
      return {} as never;
    },
    deliver: async () => {
      calls.push("deliver");
      return {} as never;
    },
    review: async () => {
      calls.push("review");
      return {} as never;
    },
  };
  const pump = await openFleetAndContractPump(parent, fleet, contract);
  try {
    assert.deepEqual(
      await requestBodyWait({
        directory: pump.directory,
        id: randomUUID(),
        targets: [target],
        completion: "all",
      }),
      { kind: "returned", result: emptyWaitResult },
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
  const pump = await openFleetPump(parent, {
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
  let closed = false;
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
    await assert.rejects(pump.failure, /registered request action akuma\.(?:wait|kill|tell) rejected its payload/u);
    const receipts = (await readdir(pump.directory)).filter((name) => name.endsWith(".receipt.json"));
    await assert.rejects(pump.close(), /registered request action akuma\.(?:wait|kill|tell) rejected its payload/u);
    closed = true;
    assert.equal(calls, 0);
    assert.deepEqual(await Promise.all(ids.map(async (id) => await readRequest(parent.paths, id))), [null, null, null]);
    assert.deepEqual(receipts, []);
  } finally {
    if (!closed) await pump.close().catch(() => undefined);
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
  const pump = await openFleetPump(parent, {
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
    const returned = outcomes.find(
      (value): value is Extract<(typeof outcomes)[number], { kind: "returned" }> =>
        (value as { kind: string }).kind === "returned",
    );
    assert.equal(returned?.result.tell.admission.tellId, id);
    assert.deepEqual(returned?.result.tell.row, {
      kind: "tell",
      sequence: returned?.result.tell.row.sequence,
      at: returned?.result.tell.row.at,
      tellId: id,
      text: "continue",
      state: "pending",
      deliveries: [],
    });
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
test("forwarded materialization retains and replays its handoff evidence", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-materialized-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const materialized = {
    kind: "integration-conflict-materialized" as const,
    targetHead: "target-head",
    conflictPaths: ["shared.txt"],
    workspace: { kind: "worktree" as const, path: "/tmp/wt" },
  };
  let calls = 0;
  const pump = await openContractPump(parent, {
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
    assert.deepEqual(
      await requestBodyDeliver({
        directory: pump.directory,
        id,
        repoRoot: root,
        contractId: "kei/conflicted",
        includeDirty: false,
        materializeConflict: true,
      }),
      materialized,
    );
    assert.equal(calls, 1);
    const claim = await readTransportClaim(pump.directory, id);
    assert.deepEqual(claim.payload, {
      repoRoot: root,
      contractId: "kei/conflicted",
      includeDirty: false,
      materializeConflict: true,
    });
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "materialized-handoff",
      repoRoot: root,
      contractId: "kei/conflicted",
      targetHead: "target-head",
      conflictPaths: ["shared.txt"],
      workspace: { kind: "worktree", path: "/tmp/wt" },
    });

    await pump.close();
    const replayPump = await openContractPump(parent, {
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
        throw new Error("materialization must not replay");
      },
    });
    try {
      assert.deepEqual(
        await requestBodyDeliver({
          directory: replayPump.directory,
          id,
          repoRoot: root,
          contractId: "kei/conflicted",
          includeDirty: false,
          materializeConflict: true,
        }),
        materialized,
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
