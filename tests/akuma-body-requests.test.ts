import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { waitForCondition as waitFor, settlementProbe } from "./support/process.js";
import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import fsPromises, { readdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { akumaCallRequestCommands, requestForwardedAkumaCall as requestBodyCall } from "../src/akuma/call-request.js";
import {
  HeldAkumaLeash,
  admitRequest,
  readHeart,
  readRequest,
  stopRequested,
  type Soul,
} from "../src/akuma/heart/index.js";
import { type AkuId } from "../src/akuma/identity.js";
import { AkumaBodyRequestError, bodyRequestExecutionContext, requestBodyCommand } from "../src/akuma/requests.js";
import { AkumaNotBornError, AkumaObservationError } from "../src/akuma/akuma-errors.js";
import { selectionRequestPort } from "../src/akuma/selection-owner-port.js";
import { BodyRequestPump, settleBodyRequests } from "../src/akuma/request-serve.js";
import {
  atomicJson,
  composeRequestCommands,
  eraseRequestCommand,
  type ExecutionFacts,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../src/akuma/request-wire.js";
import { REQUEST_PROGRESS_WINDOW } from "../src/akuma/request-observation.js";
import { executeTellAkuma } from "../src/akuma/selection-execution.js";
import { type ProviderAdapter } from "../src/akuma/provider.js";
import { fixtureAdapter, fixtureRuntime, installTellRuntime, settleFixtureBodies } from "./support/akuma-tell.js";
import { waitAkuma, tellAkuma } from "../src/library/selection.js";
import { invokeAkuma } from "../src/cli/commands/akuma-invoke.js";
import { akumaRawAnswer } from "../src/cli/render/akuma.js";
import { parseArgv } from "../src/cli/parse.js";
import {
  selectionRequestCommand,
  selectionRequestProtocol,
  selectionRequestCommands,
  type SelectionRequestPort,
} from "../src/akuma/selection-request.js";
import { isTellResult, isAskResult, type AkumaTellResult } from "../src/akuma/selection-observation.js";
import {
  contractRequestCommand,
  contractRequestProtocol,
  contractRequestCommands,
  type ContractRequestPort,
} from "../src/library/contract-operations.js";
import { KeiyakuError } from "../src/library/outcome.js";
import { requestForwardedContractLive, mapForwardedContractFailure } from "../src/library/contract-operations.js";
import {
  changeId,
  contractHead,
  contractId as makeContractId,
  entryUlid,
  gate,
  snapshotId,
  type DependencyKeySet,
} from "../src/core/facts/types.js";
import { World, type WorldRoot } from "../src/world.js";
import { Keiyaku, Repo, bodyRequestExecution } from "../src/index.js";
// File-scope: git fixture teardown binds to this file, and both repository tests share its template.
import { accepted, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";
import { Tasks } from "../src/task/index.js";
import {
  taskMutationRequestCommand,
  taskMutationRequestProtocol,
  type TaskMutationRequestPort,
} from "../src/task/mutation.js";

function callTell(body = ""): Readonly<{ tellId: string; body: string }> {
  return { tellId: randomUUID(), body };
}

async function born(root: WorldRoot, archetype: string, draw: string, allowed: Soul["allowed"] = ALLOWED_ACTIONS) {
  const { leash, ...value } = await bornDirectAkuma({
    root,
    archetype,
    draw,
    allowed,
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  leash.release();
  return value;
}

async function openSelectionPump(
  parent: Awaited<ReturnType<typeof born>>,
  port: SelectionRequestPort,
): Promise<BodyRequestPump> {
  return await openPump(parent, selectionRequestCommands(port));
}

async function openContractPump(
  parent: Awaited<ReturnType<typeof born>>,
  port: Partial<ContractRequestPort>,
): Promise<BodyRequestPump> {
  return await openPump(parent, contractRequestCommands({ ...unusedContractPort, ...port }));
}

async function openSelectionAndContractPump(
  parent: Awaited<ReturnType<typeof born>>,
  selection: SelectionRequestPort,
  contract: ContractRequestPort,
): Promise<BodyRequestPump> {
  return await openPump(
    parent,
    composeRequestCommands(selectionRequestCommands(selection), contractRequestCommands(contract)),
  );
}

const unusedSelectionPort: SelectionRequestPort = {
  wait: async () => {
    throw new Error("unexpected Selection request");
  },
  tell: async () => {
    throw new Error("unexpected Selection request");
  },
  kill: async () => {
    throw new Error("unexpected Selection request");
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
  add: async () => {
    throw new Error("unexpected Task request");
  },
  addDocument: async () => {
    throw new Error("unexpected Task request");
  },
  compose: async () => {
    throw new Error("unexpected Task request");
  },
  update: async () => {
    throw new Error("unexpected Task request");
  },
  lifecycle: async () => {
    throw new Error("unexpected Task request");
  },
  batch: async () => {
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
    value: { action: "contract.deliver", ...request, contractId: makeContractId(request.contractId) },
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
    signal?: AbortSignal;
  }>,
) {
  const { directory, id, signal, ...request } = input;
  const response = await requestBodyCommand({
    directory,
    ...(id === undefined ? {} : { id }),
    command: contractRequestProtocol("contract.review"),
    value: { action: "contract.review", ...request, contractId: makeContractId(request.contractId) },
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
    signal?: AbortSignal;
  }>,
) {
  const command = selectionRequestProtocol("akuma.wait");
  return await requestBodyCommand({
    ...input,
    command,
    value: {
      action: "akuma.wait",
      targets: input.targets,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function requestBodyTell(input: Readonly<{ directory: string; id?: string; target: AkuId; body: string }>) {
  const command = selectionRequestProtocol("akuma.tell");
  return await requestBodyCommand({
    ...input,
    command,
    value: { action: "akuma.tell", target: input.target, body: input.body },
  });
}

async function requestBodyAsk(
  input: Readonly<{ directory: string; id?: string; target: AkuId; body: string; timeoutMs: number }>,
) {
  return await requestBodyCommand({
    ...input,
    command: selectionRequestProtocol("akuma.ask"),
    value: {
      action: "akuma.ask",
      target: input.target,
      body: input.body,
      timeoutMs: input.timeoutMs,
    },
  });
}

async function requestBodyKill(input: Readonly<{ directory: string; id?: string; targets: readonly AkuId[] }>) {
  const command = selectionRequestProtocol("akuma.kill");
  return await requestBodyCommand({
    ...input,
    command,
    value: { action: "akuma.kill", targets: input.targets },
  });
}

const emptyWaitResult = { mode: "all" as const, reason: "completed" as const, observations: [], unobserved: [] };

const progressProtocol = (supportsCancellation = false): RequestProtocol<string, string, string> => ({
  action: "test.progress",
  ...(supportsCancellation ? { supportsCancellation: true } : {}),
  encodeRequest: (value) => value,
  decodeRequest: (value) => (typeof value === "string" ? value : null),
  encodeResult: (value) => value,
  decodeResult: (value) => {
    if (typeof value !== "string") throw new Error("invalid test progress result");
    return value;
  },
  decodeReference: (value) => {
    if (typeof value !== "string") throw new Error("invalid test progress reference");
    return value;
  },
  isPermitted: () => true,
});

function progressCommand(
  execute: (
    value: string,
    facts: ExecutionFacts,
  ) => Promise<Readonly<{ kind: "served"; result: string; service: string }>>,
  supportsCancellation = false,
) {
  const command: ServiceRequestCommand<string, string, string, string> = {
    completion: "service",
    protocol: progressProtocol(supportsCancellation),
    encodeService: (value) => value,
    decodeService: (value) => {
      if (typeof value !== "string") throw new Error("invalid test progress service");
      return value;
    },
    projectService: (value) => value,
    execute,
  };
  return eraseRequestCommand(command);
}

async function openProgressPump(
  parent: Awaited<ReturnType<typeof born>>,
  command: ReturnType<typeof progressCommand>,
): Promise<BodyRequestPump> {
  return await BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-09-09T00:00:01.000Z",
    commands: { "test.progress": command },
    signal: new AbortController().signal,
  });
}

test("forwarded ordinary and schema Tells retain the submitting initiator at the service port", async () => {
  const received: Array<string | undefined> = [];
  const port: SelectionRequestPort = {
    ...unusedSelectionPort,
    tell: async (input) => {
      received.push(input.initiator);
      return {} as never;
    },
    ask: async (input) => {
      received.push(input.initiator);
      return {} as never;
    },
  };
  const facts: ExecutionFacts = {
    id: "request-initiator",
    admittedAt: "2026-09-09T00:00:01.000Z",
    requester: "aku/parent/11111111",
    signal: new AbortController().signal,
    admissionOpen: () => true,
  };
  for (const action of ["akuma.tell", "akuma.ask"] as const) {
    const command = selectionRequestCommand(action, port);
    const request = command.protocol.decodeRequest({
      target: "aku/worker/22222222",
      body: "continue",
      initiator: "Bob",
      ...(action === "akuma.ask" ? { schemaJson: "{}" } : {}),
    });
    assert.ok(request);
    await command.execute(request, facts);
  }
  assert.deepEqual(received, ["Bob", "Bob"]);
});

test("selection request permissions stay separated by action", () => {
  assert.equal(selectionRequestProtocol("akuma.wait").isPermitted([]), true);
  assert.equal(selectionRequestProtocol("akuma.tell").isPermitted(["akuma.tell"]), true);
  assert.equal(selectionRequestProtocol("akuma.ask").isPermitted(["akuma.tell"]), true);
  assert.equal(selectionRequestProtocol("akuma.kill").isPermitted(["akuma.kill"]), true);
  assert.equal(selectionRequestProtocol("akuma.kill").isPermitted([]), false);
  assert.equal(selectionRequestProtocol("akuma.kill").isPermitted(["akuma.tell"]), false);
});

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

type FixtureDeliveryResult = Awaited<ReturnType<ContractRequestPort["deliver"]>>;
type FixtureReviewResult = Awaited<ReturnType<ContractRequestPort["review"]>>;

function acceptedContract(marker: string, action: "deliver", contract: string): FixtureDeliveryResult;
function acceptedContract(marker: string, action: "review", contract: string): FixtureReviewResult;
function acceptedContract(
  marker: string,
  action: "deliver" | "review",
  contract: string,
): FixtureDeliveryResult | FixtureReviewResult {
  const result = {
    operation: action,
    kind: "accepted" as const,
    contract: makeContractId(contract),
    facts: [],
    effects: [],
    pending: [],
    head: contractHead("head"),
    value:
      action === "deliver"
        ? {
            tenderSnapshot: snapshotId("tender"),
            integration: {
              predecessor: snapshotId("predecessor"),
              snapshot: snapshotId("snapshot"),
              changeId: changeId("change"),
            },
            method: "squash" as const,
            policy: { requireBranchesToBeUpToDate: false },
            leading: { kind: "already-admitted" as const, fact: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA3") },
            verificationSummary: marker,
          }
        : { verificationSummary: marker },
  };
  return result as FixtureDeliveryResult | FixtureReviewResult;
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
  const handoff = {
    kind: "materialized-handoff",
    repoRoot: "/tmp/repo",
    contractId: "kei/conflicted",
    targetHead: "target-head",
    handoffBase: "handoff-base",
    recovery: {
      materialize: "deliver --materialize-conflict --include-dirty",
      deliver: "deliver --include-dirty",
      staging: "not-required",
    },
    conflictPaths: ["shared.txt"],
    workspace: { kind: "worktree", path: "/tmp/wt" },
  };
  assert.deepEqual(command.decodeService(handoff), handoff);
  const legacyRecovery = {
    materialize: handoff.recovery.materialize,
    continue: handoff.recovery.deliver,
    staging: handoff.recovery.staging,
  };
  assert.throws(
    () => command.decodeService({ ...handoff, recovery: legacyRecovery }),
    /malformed stored Contract service evidence for contract\.deliver/u,
  );
  assert.throws(
    () => command.decodeService({ ...handoff, recovery: { ...handoff.recovery, continue: handoff.recovery.deliver } }),
    /malformed stored Contract service evidence for contract\.deliver/u,
  );
});

test("Selection owner codecs reject malformed live and service payloads", () => {
  const forwarded = {
    mode: "all" as const,
    reason: "completed" as const,
    observations: [
      {
        status: {
          id: "aku/worker/1234abcd",
          life: "asleep" as const,
          allowed: ["akuma.call"],
          timeline: { kind: "idle" as const, entries: [], omitted: 0, reportedChanges: [], reportedChangesOmitted: 0 },
        },
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
    ],
    unobserved: [],
  };
  assert.deepEqual(selectionRequestProtocol("akuma.wait").decodeResult(forwarded), forwarded);
  assert.throws(
    () =>
      selectionRequestProtocol("akuma.wait").decodeResult({
        mode: "all",
        reason: "completed",
        observations: [],
        unobserved: [{}],
      }),
    /invalid live result for akuma\.wait/u,
  );
  assert.throws(
    () =>
      selectionRequestCommand("akuma.tell", unusedSelectionPort).decodeService({
        action: "akuma.tell",
        target: "aku/worker/nothex",
        tellId: "tell",
      }),
    /malformed stored Selection service evidence/u,
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
    () =>
      composeRequestCommands(
        selectionRequestCommands(unusedSelectionPort),
        selectionRequestCommands(unusedSelectionPort),
      ),
    /duplicate request command action: akuma\.wait/u,
  );
});

test("request progress includes the final snapshot published between progress and receipt reads", async (t) => {
  for (const failed of [false, true]) {
    await t.test(failed ? "failed receipt" : "successful receipt", async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "keiyaku-request-final-progress-"));
      const id = randomUUID();
      const command = progressProtocol();
      const originalRead = fsPromises.readFile;
      let published = false;
      const seen: unknown[] = [];
      const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
        const path = String(args[0]);
        if (!path.startsWith(directory)) return originalRead(...args);
        if (path.endsWith(".receipt.json")) {
          published = true;
          return JSON.stringify({
            id,
            action: command.action,
            state: "served",
            outcome: failed
              ? { kind: "failed", failure: { kind: "failed", diagnostic: "service failed" } }
              : { kind: "returned", result: "complete" },
          });
        }
        if (path.endsWith(".progress.json")) {
          if (!published) throw Object.assign(new Error("not yet published"), { code: "ENOENT" });
          return JSON.stringify({
            id,
            action: command.action,
            nextSequence: 2,
            events: [{ sequence: 1, value: "final output" }],
          });
        }
        return originalRead(...args);
      });
      syncBuiltinESMExports();
      try {
        const request = requestBodyCommand({
          directory,
          id,
          command,
          value: "run",
          onProgress: (value) => seen.push(value),
        });
        if (failed) await assert.rejects(request, /service failed/u);
        else assert.equal((await request).kind, "returned");
        assert.deepEqual(seen, ["final output"]);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("request pump discards an enumerated request only when its read reports ENOENT", async (t) => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-enumeration-race-")));
  const parent = await born(root, "parent", "24681357");
  const pump = await openSelectionPump(parent, unusedSelectionPort);
  const requestPath = join(pump.directory, `${randomUUID()}.request.json`);
  const originalRead = fsPromises.readFile;
  const { promise: readStarted, resolve: started } = promiseBarrier<void>();
  const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
    const path = String(args[0]);
    if (path === requestPath) {
      await fsPromises.rm(path, { force: true });
      started();
      throw Object.assign(new Error("request disappeared"), { code: "ENOENT" });
    }
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  let closed = false;
  try {
    await writeFile(requestPath, "not read\n");
    await readStarted;
    assert.equal(existsSync(requestPath), false);
    await pump.close();
    closed = true;
  } finally {
    if (!closed) await pump.close().catch(() => undefined);
    mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("request pump propagates permission errors while reading an enumerated request", async (t) => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-read-error-")));
  const parent = await born(root, "parent", "13572468");
  const pump = await openSelectionPump(parent, unusedSelectionPort);
  const requestPath = join(pump.directory, `${randomUUID()}.request.json`);
  const originalRead = fsPromises.readFile;
  const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
    if (String(args[0]) === requestPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  let closed = false;
  try {
    const failed = assert.rejects(pump.failure, (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES");
    await writeFile(requestPath, "not read\n");
    await failed;
    await assert.rejects(pump.close(), (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES");
    closed = true;
  } finally {
    if (!closed) await pump.close().catch(() => undefined);
    mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("request progress consumers receive the sequence-derived retained-window gap", async (t) => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-progress-gap-")));
  const parent = await born(root, "parent", "65432109");
  const { promise: published, resolve: started } = promiseBarrier<void>();
  const { promise: gate, resolve: release } = promiseBarrier<void>();
  const pump = await openProgressPump(
    parent,
    progressCommand(async (_value, facts) => {
      for (let value = 1; value <= REQUEST_PROGRESS_WINDOW + 3; value += 1) facts.progress?.(value);
      started();
      await gate;
      return { kind: "served", result: "complete", service: "complete" };
    }),
  );
  // The service publishes its burst asynchronously, so a consumer read that lands
  // mid-write would observe a partial window, advance its observed sequence, and
  // erase the gap. Hold consumer snapshot reads until the full window is durable so
  // the success arm depends on the sequence, never on write scheduling.
  const { promise: windowDurable, resolve: windowComplete } = promiseBarrier<void>();
  const originalRead = fsPromises.readFile;
  const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
    if (String(args[0]).endsWith(".progress.json")) await windowDurable;
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  const gaps: number[] = [];
  try {
    const request = requestBodyCommand({
      directory: pump.directory,
      command: progressProtocol(),
      value: "run",
      onProgressGap: (count) => gaps.push(count),
    });
    // The failure path releases the gate before the pump settles, so a request that
    // never observes its gap cannot leave an unhandled rejection behind.
    void request.catch(() => undefined);
    await published;
    await waitFor("the durable full retained-window snapshot", async () => {
      for (const name of await readdir(pump.directory)) {
        if (!name.endsWith(".progress.json")) continue;
        try {
          const snapshot = JSON.parse(await originalRead(join(pump.directory, name), "utf8")) as {
            events?: readonly { value?: unknown }[];
          };
          if (snapshot.events?.at(-1)?.value === REQUEST_PROGRESS_WINDOW + 3) return true;
        } catch {
          // A snapshot is only durable once its rename completes.
        }
      }
      return false;
    });
    windowComplete();
    await waitFor("the retained-window progress gap", () => gaps.length === 1, {
      terminalState: settlementProbe(request, (settled) => `outcome ${settled.kind}`),
    });
    assert.deepEqual(gaps, [3]);
    release();
    assert.equal((await request).kind, "returned");
  } finally {
    // A missing gap must fail by name without stranding the service behind the gate.
    windowComplete();
    release();
    mock.mock.restore();
    syncBuiltinESMExports();
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress observation failures and absent observers do not hold service completion", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-progress-observer-")));
  const parent = await born(root, "parent", "87654321");
  const pump = await openProgressPump(
    parent,
    progressCommand(async (_value, facts) => {
      facts.progress?.("first");
      facts.progress?.("second");
      return { kind: "served", result: "complete", service: "complete" };
    }),
  );
  try {
    const ignored = await requestBodyCommand({ directory: pump.directory, command: progressProtocol(), value: "run" });
    assert.equal(ignored.kind, "returned");
    const observed = await requestBodyCommand({
      directory: pump.directory,
      command: progressProtocol(),
      value: "run-again",
      onProgress: async () => {
        throw new Error("observer failure");
      },
    });
    assert.equal(observed.kind, "returned");
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial request publication loss is unknown with its request identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-request-publication-loss-"));
  rmSync(directory, { recursive: true, force: true });
  const id = randomUUID();
  await assert.rejects(
    requestBodyWait({
      directory,
      id,
      targets: ["aku/worker/22222222" as AkuId],
      completion: "all",
    }),
    (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "unknown" && error.requestId === id,
  );
});

test("cancellation before request publication retains the caller cancellation", async (context) => {
  const directory = temporaryDirectory(context, "keiyaku-request-cancel-before-publication-");
  const controller = new AbortController();
  const reason = new Error("cancel before publication");
  controller.abort(reason);
  await assert.rejects(
    requestBodyWait({
      directory,
      id: randomUUID(),
      targets: ["aku/worker/22222222" as AkuId],
      completion: "all",
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".request.json")),
    [],
  );
});

test("cancellation during request publication retains the caller cancellation before rename", async (context) => {
  const directory = temporaryDirectory(context, "keiyaku-request-cancel-during-publication-");
  const controller = new AbortController();
  const reason = new Error("cancel during publication");
  let entered!: () => void;
  let paused!: () => void;
  const publicationEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const publicationPaused = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const publication = atomicJson(
    join(directory, "request.json"),
    { id: randomUUID(), action: "akuma.wait" },
    controller.signal,
    async () => {
      entered();
      await publicationPaused;
    },
  );
  await publicationEntered;
  controller.abort(reason);
  paused();
  await assert.rejects(publication, (error: unknown) => error === reason);
  assert.equal(existsSync(join(directory, "request.json")), false);
});

test("cancellation after publication aborts the served operation and frees the serial request slot", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-cancel-after-publication-")));
  const parent = await born(root, "parent", "11111111");
  const { promise: executionStarted, resolve: started } = promiseBarrier<void>();
  const { promise: executionCancelled, resolve: cancelled } = promiseBarrier<void>();
  let calls = 0;
  const pump = await openSelectionPump(parent, {
    wait: async (input) => {
      calls += 1;
      if (calls > 1) return emptyWaitResult;
      started();
      return await new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(input.signal.reason);
          },
          { once: true },
        );
      });
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
  });
  const id = randomUUID();
  const controller = new AbortController();
  try {
    const request = requestBodyWait({
      directory: pump.directory,
      id,
      targets: ["aku/worker/22222222" as AkuId],
      completion: "all",
      signal: controller.signal,
    });
    await executionStarted;
    assert.equal((await readRequest(parent.paths, id))?.state, "begun");
    controller.abort(new Error("cancel after publication"));
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof AkumaBodyRequestError &&
        error.outcome === "unproven" &&
        error.requestId === id &&
        error.action === "akuma.wait",
    );
    await executionCancelled;
    assert.deepEqual(
      await requestBodyWait({
        directory: pump.directory,
        id: randomUUID(),
        targets: ["aku/worker/22222222" as AkuId],
        completion: "all",
      }),
      { kind: "returned", result: emptyWaitResult },
    );
    assert.equal(calls, 2);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-id different-payload conflict is refused without changing the admitted request", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-request-input-conflict-")));
  const parent = await born(root, "parent", "11111111");
  const id = randomUUID();
  let calls = 0;
  const pump = await openSelectionPump(parent, {
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
      admitInitialTell: async () => ({ kind: "not-born" as const }),
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
        initialTell: callTell("fenced child"),
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

test("a noncanonical routed call fails the pump before child allocation", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-call-world-proof-"));
  const parent = await born(root, "parent", "11111111");
  let spawns = 0;
  const pump = await openPump(
    parent,
    akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: parent.soul,
      admitInitialTell: async () => ({ kind: "not-born" as const }),
      spawn: async () => {
        spawns += 1;
      },
    }),
  );
  const id = randomUUID();
  const request = requestBodyCall({
    directory: pump.directory,
    id,
    world: `${root}/.`,
    archetype: "worker",
    initialTell: callTell("must not allocate"),
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
    (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "unknown",
  );
});

test("a semantically invalid call recipe fails the pump before Heart admission", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-call-invalid-recipe-"));
  const parent = await born(root, "parent", "11111111");
  let spawnCalls = 0;
  const pump = await openPump(
    parent,
    akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: parent.soul,
      admitInitialTell: async () => ({ kind: "not-born" as const }),
      spawn: async () => {
        spawnCalls += 1;
        throw new Error("invalid recipe must not spawn");
      },
    }),
  );
  const id = randomUUID();
  const request = requestBodyCall({
    directory: pump.directory,
    id,
    world: root,
    archetype: "worker",
    initialTell: callTell("invalid recipe"),
    recipe: {
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: null as never,
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
    (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "unknown",
  );
});

test("deliver claims execute once and Heart retains only the Contract fact reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-reference-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const contractId = "kei/forwarded-delivery";
  let calls = 0;
  const pump = await openContractPump(parent, {
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
      return acceptedContract("delivery-result", "deliver", contractId);
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
      acceptedContract("delivery-result", "deliver", contractId),
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

function reviewedAttestation(contract: string, entry: string, gateWord: "reviewed" | "verified") {
  return {
    v: 1 as const,
    kind: "attestation" as const,
    contract: makeContractId(contract),
    entry: entryUlid(entry),
    at: "2026-08-18T00:00:00.000Z",
    data: { gate: gate(gateWord), subject: "[]" as DependencyKeySet, verdict: "satisfied" as const },
  };
}

test("review derives its service reference from the invocation's addressed reviewed attestation", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-review-reference-")));
  const parent = await born(root, "parent", "11111111", ["contract.review"]);
  const contractId = "kei/forwarded-review";
  const reviewed = reviewedAttestation(contractId, "01ARZ3NDEKTSV4RRFFQ69G5FAX", "reviewed");
  const incidental = [
    reviewedAttestation(contractId, "01ARZ3NDEKTSV4RRFFQ69G5FAY", "verified"),
    reviewedAttestation("kei/other-contract", "01ARZ3NDEKTSV4RRFFQ69G5FAZ", "reviewed"),
  ];
  const native = { ...acceptedContract("review-result", "review", contractId), facts: [...incidental, reviewed] };
  let calls = 0;
  const pump = await openContractPump(parent, {
    review: async (input) => {
      calls += 1;
      assert.equal(input.requester, parent.id);
      assert.equal(input.contractId, contractId);
      return native;
    },
  });
  try {
    const id = randomUUID();
    assert.deepEqual(
      await requestBodyReview({ directory: pump.directory, id, repoRoot: root, contractId, verdict: "satisfied" }),
      native,
    );
    assert.equal(calls, 1);
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "accepted-reference",
      repoRoot: root,
      contractId,
      reviewFactId: reviewed.entry,
    });
    assert.doesNotMatch(JSON.stringify(fact), /review-result/u);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("review with no addressed reviewed attestation settles unproven rather than serving a reference", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-review-missing-")));
  const parent = await born(root, "parent", "22222222", ["contract.review"]);
  const contractId = "kei/forwarded-review-missing";
  const native = {
    ...acceptedContract("review-result", "review", contractId),
    facts: [reviewedAttestation("kei/other-contract", "01ARZ3NDEKTSV4RRFFQ69G5FAW", "reviewed")],
  };
  const pump = await openContractPump(parent, { review: async () => native });
  try {
    const id = randomUUID();
    await assert.rejects(
      requestBodyReview({ directory: pump.directory, id, repoRoot: root, contractId, verdict: "satisfied" }),
    );
    const fact = await readRequest(parent.paths, id);
    assert.equal(fact?.state, "unproven");
    assert.equal(fact !== null && "serviceJson" in fact ? fact.serviceJson : null, null);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task request recovery voids an unserved claim without replaying Task authority", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-task-recovery-"));
  const parent = await born(root, "parent", "44444444", ["task.add"]);
  const id = "00000000-0000-4000-8000-000000000301";
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
});

test("deliver returns without a durable reference and settles Heart voided", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-voided-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const id = randomUUID();
  let calls = 0;
  const pump = await openContractPump(parent, {
    deliver: async () => {
      calls += 1;
      return {
        operation: "deliver",
        kind: "refused",
        facts: [],
        effects: [],
        pending: [],
        refusal: { kind: "contract-missing", contractId: makeContractId("kei/not-accepted") },
      } as FixtureDeliveryResult;
    },
  });
  try {
    const refused = await requestBodyDeliver({
      directory: pump.directory,
      id,
      repoRoot: root,
      contractId: "kei/not-accepted",
      includeDirty: false,
      materializeConflict: false,
    });
    assert.equal(refused.kind, "refused");
    if (refused.kind === "refused")
      assert.deepEqual(refused.refusal, { kind: "contract-missing", contractId: makeContractId("kei/not-accepted") });
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
  } finally {
    await pump.close();
  }

  const replay = await openContractPump(parent, {
    deliver: async () => {
      throw new Error("expired voided delivery must not replay");
    },
  });
  try {
    for (const name of await readdir(pump.directory)) {
      if (name.endsWith(".receipt.json") || name.endsWith(".request.json"))
        rmSync(join(pump.directory, name), { force: true });
    }
    const request = {
      action: "contract.deliver" as const,
      repoRoot: root,
      contractId: makeContractId("kei/not-accepted"),
      includeDirty: false,
      materializeConflict: false,
    };
    let raw: AkumaBodyRequestError | undefined;
    await assert.rejects(
      requestBodyCommand({
        directory: replay.directory,
        id,
        command: contractRequestProtocol(request.action),
        value: request,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AkumaBodyRequestError);
        assert.equal(error.outcome, "voided");
        assert.equal(error.requestId, id);
        raw = error;
        return true;
      },
    );
    assert.ok(raw);
    const mapped = mapForwardedContractFailure(raw, request);
    const expired = mapped.result;
    assert.equal(expired.kind, "retry");
    if (expired.kind === "retry") {
      assert.deepEqual(expired.reason, { kind: "owner-reason-unavailable", diagnostic: raw.diagnostic });
      assert.deepEqual(expired.effects, []);
      assert.deepEqual(expired.facts, []);
      assert.deepEqual(expired.pending, []);
      assert.equal(Object.keys(expired.reason).includes("refusal"), false);
    }
    assert.equal(calls, 1);
    const durable = await readRequest(parent.paths, id);
    assert.ok(durable?.state === "voided");
    assert.equal(raw.diagnostic, durable.evidence);
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
        error.requestId === id &&
        error.diagnostic === "executor unavailable" &&
        error.cause instanceof KeiyakuError &&
        error.cause.category === "internal" &&
        error.cause.cause instanceof Error &&
        error.cause.cause.message === "executor unavailable",
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
        error.requestId === id &&
        error.diagnostic === "executor unavailable" &&
        error.cause === undefined,
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
  let release!: (value: FixtureDeliveryResult) => void;
  const executorStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const executorReleased = new Promise<FixtureDeliveryResult>((resolve) => {
    release = resolve;
  });
  const id = randomUUID();
  const pump = await openContractPump(parent, {
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
    release(acceptedContract("drained", "deliver", "kei/drained"));
    await closing;
    // The receipt may reach the caller before transport disposal; only the durable
    // served reference is guaranteed after close drains the in-flight operation.
    await request.catch((error: unknown) => {
      assert.ok(error instanceof AkumaBodyRequestError && error.outcome === "unknown");
    });
    const fact = await readRequest(parent.paths, id);
    assert.deepEqual(fact?.state === "served" && "serviceJson" in fact ? JSON.parse(fact.serviceJson) : null, {
      kind: "accepted-reference",
      repoRoot: root,
      contractId: "kei/drained",
      // The durable reference now comes from the returned invocation's own leading fact.
      deliveryFactId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
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
    deliver: async () => {
      started();
      await executorReleased;
      return acceptedContract("missing-receipt", "deliver", "kei/missing-receipt");
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
      (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "unknown",
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
  const selection: SelectionRequestPort = {
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
  const pump = await openSelectionAndContractPump(parent, selection, contract);
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

test("a forwarded wait omits its mode and reaches the parent as any", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-wait-")));
  const parent = await born(root, "parent", "42424242");
  const completions: ("any" | "all")[] = [];
  const pump = await openSelectionPump(parent, {
    wait: async (input) => {
      completions.push(input.completion);
      return { mode: input.completion, reason: "completed", observations: [], unobserved: [] };
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async () => {
      throw new Error("unexpected kill");
    },
  });
  try {
    const result = await waitAkuma(
      { path: root, akuma: ["aku/worker/00000001" as AkuId, "aku/worker/00000002" as AkuId] },
      bodyRequestExecutionContext(pump.directory),
    );
    assert.deepEqual(completions, ["any"]);
    assert.equal(result.mode, "any");
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plural forwarded kill refuses before it requests any member's kill", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-partial-effect-")));
  const parent = await born(root, "parent", "46464646");
  const target = await born(root, "worker", "abcd0046");
  // A killable member: without its Body a kill would record nothing anyway, so
  // this is what makes the test able to catch an operation that ran too early.
  const targetLeash = (await HeldAkumaLeash.try(target.paths))!;
  await targetLeash.recordBody(target.paths, { leashTakenAt: "2026-08-18T00:00:01.000Z" });
  const absent = "aku/intern/33dd4670" as AkuId;
  const pump = await openSelectionPump(parent, selectionRequestPort(root));
  const id = randomUUID();
  try {
    await assert.rejects(
      requestBodyKill({ directory: pump.directory, id, targets: [target.id, absent] }),
      (error: unknown) => error instanceof AkumaNotBornError && error.id === absent,
    );
    // The whole operation refused, so the request truthfully claims no effect
    // and the killable member was never asked to stop.
    assert.equal((await readRequest(parent.paths, id))?.state, "voided");
    assert.equal(await stopRequested(target.paths), false);
  } finally {
    targetLeash.release();
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forwarded operation answers from the parent World without reading the child's Hearts", async () => {
  const parentWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-parent-")));
  const childWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-child-")));
  const parent = await born(parentWorld, "parent", "43434343");
  const target = await born(parentWorld, "worker", "abcd0043");
  const local = await born(childWorld, "worker", "abcd0043");
  await writeFile(local.paths.heart, "this is not a database\n");
  const pump = await openSelectionPump(parent, selectionRequestPort(parentWorld));
  try {
    // The child's own Heart is unreadable here: a local probe would fail this.
    const result = await waitAkuma(
      { path: childWorld, akuma: [target.id], timeoutMs: 0 },
      bodyRequestExecutionContext(pump.directory),
    );
    assert.deepEqual(
      result.observations.map((observation) => observation.status.id),
      [target.id],
    );
  } finally {
    await pump.close();
    rmSync(parentWorld, { recursive: true, force: true });
    rmSync(childWorld, { recursive: true, force: true });
  }
});

test("a forwarded refusal keeps the parent's answer over the child's local birth", async () => {
  const parentWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-refusal-parent-")));
  const childWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-refusal-child-")));
  const parent = await born(parentWorld, "parent", "44434343");
  const local = await born(childWorld, "intern", "33dd4670");
  const pump = await openSelectionPump(parent, selectionRequestPort(parentWorld));
  try {
    // The target is born only in the child's World, so a locally proved
    // operation would succeed instead of answering as the parent does.
    await assert.rejects(
      waitAkuma({ path: childWorld, akuma: [local.id] }, bodyRequestExecutionContext(pump.directory)),
      (error: unknown) => error instanceof AkumaNotBornError && error.id === local.id,
    );
  } finally {
    await pump.close();
    rmSync(parentWorld, { recursive: true, force: true });
    rmSync(childWorld, { recursive: true, force: true });
  }
});

test("a forwarded observation failure keeps the parent's reason", async () => {
  const parentWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-unreadable-parent-")));
  const childWorld = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-unreadable-child-")));
  const parent = await born(parentWorld, "parent", "45454545");
  const target = await born(childWorld, "worker", "abcd0045");
  const mirrored = await born(parentWorld, "worker", "abcd0045");
  await writeFile(mirrored.paths.heart, "this is not a database\n");
  const pump = await openSelectionPump(parent, selectionRequestPort(parentWorld));
  try {
    await assert.rejects(
      tellAkuma({ path: childWorld, akuma: target.id, body: "hello" }, bodyRequestExecutionContext(pump.directory)),
      (error: unknown) => {
        assert.ok(error instanceof AkumaObservationError);
        assert.equal(error.id, target.id);
        assert.notEqual(error.diagnostic, "");
        return true;
      },
    );
  } finally {
    await pump.close();
    rmSync(parentWorld, { recursive: true, force: true });
    rmSync(childWorld, { recursive: true, force: true });
  }
});

test("transport rejects malformed target sets and foreign World coordinates before Heart", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-malformed-")));
  const parent = await born(root, "parent", "11111111");
  let calls = 0;
  const pump = await openSelectionPump(parent, {
    ...noDeliver(),
    wait: async () => {
      calls += 1;
      throw new Error("unexpected wait");
    },
    tell: async () => {
      calls += 1;
      throw new Error("unexpected tell");
    },
    kill: async () => {
      calls += 1;
      throw new Error("unexpected kill");
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
    const rejectedPayload = assert.rejects(pump.failure, /registered request action akuma\.(?:wait|kill|tell) rejected its payload/u);
    await Promise.all(
      claims.map(
        async (claim) =>
          await writeFile(join(pump.directory, `${claim.id}.request.json`), `${JSON.stringify(claim)}\n`),
      ),
    );
    await rejectedPayload;
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

test("bounded forwarded Tell admits once under the request identity", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-ask-")));
  const parent = await born(root, "parent", "11111111", ["akuma.tell"]);
  const target = "aku/worker/22222222" as AkuId;
  let calls = 0;
  const pump = await openSelectionPump(parent, {
    ...unusedSelectionPort,
    ask: async (input) => {
      calls += 1;
      return {
        akuma: input.target,
        tell: {
          admission: { fact: "recorded", tellId: input.tellId },
          row: {
            kind: "tell",
            sequence: 1,
            at: input.recordedAt,
            tellId: input.tellId,
            text: input.body,
            state: "pending",
            deliveries: [],
          },
          wake: { kind: "held" },
        },
        observation: { reason: "deadline" },
      };
    },
  });
  try {
    const id = randomUUID();
    const outcomes = await Promise.all(
      [1, 2].map(
        async () => await requestBodyAsk({ directory: pump.directory, id, target, body: "continue", timeoutMs: 0 }),
      ),
    );
    const returned = outcomes.find((value) => value.kind === "returned");
    assert.equal(returned?.kind, "returned");
    if (returned?.kind === "returned") {
      assert.equal(isAskResult(returned.result), true);
      if (!isAskResult(returned.result)) throw new Error("expected a waited Tell result");
      assert.equal(returned.result.tell.admission.tellId, id);
      assert.deepEqual(returned.result.observation, { reason: "deadline" });
    }
    assert.equal(calls, 1);
    assert.deepEqual(
      outcomes.find((value) => value.kind === "reference"),
      { kind: "reference", reference: { action: "akuma.ask", target, tellId: id } },
    );
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real delayed direct-parent waited Tell observes its exact answer", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-ask-real-")));
  const parent = await born(root, "parent", "11111111", ["akuma.tell"]);
  const target = await born(root, "worker", "33333333");
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const started = promiseBarrier<void>();
  const finish = promiseBarrier<Readonly<{ kind: "answered"; answer: string; historyId: string }>>();
  fixtures.set(target.paths.directory, {
    adapter: fixtureAdapter(async () => ({
      admission: { fence: "delayed-direct-parent" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "delayed-direct-parent" } };
          started.resolve();
        },
      },
      completion: finish.promise,
      async abort() {},
    })),
    now: "2026-08-18T00:00:02.000Z",
  });
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  const pump = await openSelectionPump(parent, selectionRequestPort(root));
  try {
    const pending = requestBodyAsk({
      directory: pump.directory,
      target: target.id,
      body: "delayed direct",
      timeoutMs: 10_000,
    });
    await started.promise;
    finish.resolve({ kind: "answered", answer: "delayed direct answer", historyId: "delayed-direct-history" });
    const outcome = await pending;
    assert.equal(outcome.kind, "returned");
    if (outcome.kind !== "returned") throw new Error("expected a returned waited Tell result");
    assert.equal(isAskResult(outcome.result), true);
    if (!isAskResult(outcome.result)) throw new Error("expected a waited Tell result");
    assert.deepEqual(outcome.result.observation, { reason: "answered", answer: "delayed direct answer" });
    assert.equal((await readHeart(target.paths)).pending.length, 0);
  } finally {
    restoreTellRuntime();
    await pump.close();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the waited-Tell facade forwards to a serving parent when the caller World lacks the target", async () => {
  const parentRoot = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-ask-facade-")));
  const callerRoot = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-ask-caller-")));
  const parent = await born(parentRoot, "parent", "11111111", ["akuma.tell"]);
  const target = await born(parentRoot, "worker", "44444444");
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const started = promiseBarrier<void>();
  const finish = promiseBarrier<Readonly<{ kind: "answered"; answer: string; historyId: string }>>();
  fixtures.set(target.paths.directory, {
    adapter: fixtureAdapter(async () => ({
      admission: { fence: "facade-direct-parent" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "facade-direct-parent" } };
          started.resolve();
        },
      },
      completion: finish.promise,
      async abort() {},
    })),
    now: "2026-08-18T00:00:03.000Z",
  });
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  const pump = await openSelectionPump(parent, selectionRequestPort(parentRoot));
  try {
    const parsed = parseArgv(["ask", target.id, "--wait", "10s", "facade delayed"]);
    if (!("command" in parsed) || parsed.command.command !== "ask") throw new Error("expected an Ask command");
    const pending = invokeAkuma(parsed.command, {
      path: callerRoot,
      environment: {},
      readStdin: async () => "",
      execution: bodyRequestExecutionContext(pump.directory),
    });
    await started.promise;
    finish.resolve({ kind: "answered", answer: "facade delayed answer", historyId: "facade-direct-history" });
    const result = await pending;
    if (result.action !== "ask") throw new Error("expected an Ask result");
    assert.deepEqual(result.result.observation, { reason: "answered", answer: "facade delayed answer" });
    assert.equal(result.result.tell.row.text, "facade delayed");
    assert.equal(akumaRawAnswer(result), "facade delayed answer", "forwarded CLI preserves exact stdout bytes");
    assert.equal((await readHeart(target.paths)).pending.length, 0);
  } finally {
    restoreTellRuntime();
    await pump.close();
    await settleFixtureBodies(bodies);
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(callerRoot, { recursive: true, force: true });
  }
});

test("a forwarded Tell writes its transport and the direct parent enters the tell executor once", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-tell-")));
  const parent = await born(root, "parent", "11111111", ["akuma.tell"]);
  const target = await born(root, "worker", "22222222");
  const targetLeash = (await HeldAkumaLeash.try(target.paths))!;
  await targetLeash.recordBody(target.paths, { leashTakenAt: "2026-08-18T00:00:01.000Z" });
  let calls = 0;
  const pump = await openSelectionPump(parent, {
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
      (value): value is Extract<(typeof outcomes)[number], { kind: "returned" }> & { result: AkumaTellResult } =>
        (value as { kind: string }).kind === "returned" &&
        isTellResult((value as Extract<(typeof outcomes)[number], { kind: "returned" }>).result),
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

test("an allowed forwarded kill reaches its direct parent owner once", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-kill-")));
  const parent = await born(root, "parent", "11111111", ["akuma.kill"]);
  const target = "aku/worker/22222222" as AkuId;
  const result = { results: [{ id: target, evidence: "already-stopped" as const }] };
  let calls = 0;
  const pump = await openSelectionPump(parent, {
    ...noDeliver(),
    wait: async () => {
      throw new Error("unexpected wait");
    },
    tell: async () => {
      throw new Error("unexpected tell");
    },
    kill: async (input) => {
      calls += 1;
      assert.deepEqual(input.targets, [target]);
      return result;
    },
  });
  try {
    assert.deepEqual(await requestBodyKill({ directory: pump.directory, id: randomUUID(), targets: [target] }), {
      kind: "returned",
      result,
    });
    assert.equal(calls, 1);
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("forwarded materialization retains and replays its handoff evidence", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-upstream-deliver-materialized-")));
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  const materializedValue = {
    kind: "integration-conflict-materialized" as const,
    targetHead: snapshotId("target-head"),
    conflictPaths: ["shared.txt"],
    workspace: { kind: "worktree" as const, path: "/tmp/wt" },
    handoffBase: snapshotId("handoff-base"),
    recovery: {
      materialize: "deliver --materialize-conflict --include-dirty" as const,
      deliver: "deliver --include-dirty" as const,
      staging: "not-required" as const,
    },
  };
  let calls = 0;
  const pump = await openContractPump(parent, {
    deliver: async (input) => {
      calls += 1;
      assert.equal(input.materializeConflict, true);
      return {
        operation: "deliver",
        kind: "handoff",
        contract: makeContractId("kei/conflicted"),
        facts: [],
        effects: [],
        pending: [],
        value: materializedValue,
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
        contractId: "kei/conflicted",
        includeDirty: false,
        materializeConflict: true,
      }),
      {
        operation: "deliver",
        kind: "handoff",
        contract: makeContractId("kei/conflicted"),
        facts: [],
        effects: [],
        pending: [],
        value: materializedValue,
      },
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
      handoffBase: "handoff-base",
      recovery: {
        materialize: "deliver --materialize-conflict --include-dirty",
        deliver: "deliver --include-dirty",
        staging: "not-required",
      },
      conflictPaths: ["shared.txt"],
      workspace: { kind: "worktree", path: "/tmp/wt" },
    });

    await pump.close();
    const replayPump = await openContractPump(parent, {
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
        materializedValue,
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

// A partial owner receipt does not turn Heart's unproven service into a voided request.
test("forwarded fatal receipts survive unproven transport without claiming no product effect", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-forwarded-fatal-")));
  const parent = await born(root, "parent", "11111111", ["contract.review"]);
  const contract = makeContractId("kei/partial");
  const receipt = {
    operation: "review" as const,
    contract,
    head: contractHead("accepted-head"),
    facts: [
      {
        v: 1 as const,
        kind: "arc" as const,
        contract,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        at: "2026-09-05T00:00:00.000Z",
        data: { seq: 1, title: "test", body: "test" },
      },
    ],
    effects: [],
    pending: [],
  };
  let requestId: string | undefined;
  const pump = await openContractPump(parent, {
    ...unusedContractPort,
    review: async () => {
      throw new KeiyakuError("internal", "failed after admission", {
        cause: new TypeError("failed after admission"),
        outcome: receipt,
      });
    },
  });
  try {
    await assert.rejects(
      requestForwardedContractLive({
        directory: pump.directory,
        action: "contract.review",
        request: { action: "contract.review", repoRoot: root, contractId: contract, verdict: "satisfied" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.ok(error.cause instanceof TypeError);
        assert.deepEqual(error.outcome, receipt);
        assert.equal(Object.keys(error).includes("requestOutcome"), false);
        assert.equal(Object.keys(error).includes("requestId"), false);
        assert.equal((error as unknown as Error & { requestOutcome: string }).requestOutcome, "unproven");
        requestId = (error as unknown as Error & { requestId: string }).requestId;
        return true;
      },
    );
    assert.ok(requestId);
    assert.equal((await readRequest(parent.paths, requestId))?.state, "unproven");
  } finally {
    await pump.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Carrier defaults for this file; every pump still gets a fresh cancellation signal. */
function openPump(
  parent: Pick<Awaited<ReturnType<typeof born>>, "paths" | "soul">,
  commands: Parameters<typeof BodyRequestPump.open>[0]["commands"],
): Promise<BodyRequestPump> {
  return BodyRequestPump.open({
    paths: parent.paths,
    allowed: parent.soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-18T00:00:01.000Z",
    commands,
    signal: new AbortController().signal,
  });
}

test("forwarded native delivery preserves full JSON result and revives the diff ability", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const root = await World.at(repository.path);
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), gates: ["reviewed"] }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  commitCandidate(repository, bound.value.workspace.path);
  const parent = await born(root, "parent", "11111111", ["contract.deliver"]);
  let owner: FixtureDeliveryResult | undefined;
  let calls = 0;
  const pump = await openContractPump(parent, {
    deliver: async (input) => {
      calls += 1;
      // The serving parent composes the native owner operation directly; no
      // forwarding wrapper reconstructs its result.
      const served = await Keiyaku.with({ actor: input.requester })
        .select({ repo, id: input.contractId })
        .deliver(
          {
            includeDirty: input.includeDirty,
            materializeConflict: input.materializeConflict,
            ...(input.message === undefined ? {} : { message: input.message }),
            signal: input.signal,
          },
          input.observe === undefined ? undefined : { observe: input.observe },
        );
      owner = served;
      return served;
    },
  });
  try {
    const observations: string[] = [];
    const forwarded = Keiyaku.with({ execution: bodyRequestExecution({ directory: pump.directory }) }).select({
      repo,
      id: bound.contract,
    });
    const result = accepted(
      await forwarded.deliver(
        {},
        {
          observe: (event) => {
            observations.push(event.kind);
          },
        },
      ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(owner)));
    assert.ok((await result.value.diff())?.includes("candidate.txt"));
    assert.ok(observations.includes("admitted"));
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(result.value)), "readDiff"), false);
    const claims = (await readdir(pump.directory)).filter((name) => name.endsWith(".request.json"));
    assert.equal(claims.length, 1);
    const claim = JSON.parse(await readFile(join(pump.directory, claims[0]!), "utf8")) as { id: string };
    assert.equal((await readRequest(parent.paths, claim.id))?.state, "served");
  } finally {
    await pump.close();
  }
});

test("forwarded native review preserves the owner outcome and stores the addressed reviewed attestation", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const root = await World.at(repository.path);
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), gates: ["reviewed"] }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  commitCandidate(repository, bound.value.workspace.path);
  accepted(await Keiyaku.with().select({ repo, id: bound.contract }).deliver());
  const parent = await born(root, "parent", "11111111", ["contract.review"]);
  let owner: FixtureReviewResult | undefined;
  let calls = 0;
  const pump = await openContractPump(parent, {
    review: async (input) => {
      calls += 1;
      // The serving parent composes the native owner operation directly; no
      // forwarding wrapper reconstructs its result.
      const served = await Keiyaku.with({ actor: input.requester })
        .select({ repo, id: input.contractId })
        .review(
          { verdict: input.verdict, signal: input.signal },
          input.observe === undefined ? undefined : { observe: input.observe },
        );
      owner = served;
      return served;
    },
  });
  try {
    const observations: string[] = [];
    const forwarded = Keiyaku.with({ execution: bodyRequestExecution({ directory: pump.directory }) }).select({
      repo,
      id: bound.contract,
    });
    const result = accepted(
      await forwarded.review(
        { verdict: "satisfied" },
        {
          observe: (event) => {
            observations.push(event.kind);
          },
        },
      ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(owner)));
    assert.ok(observations.includes("admitted"));
    const reviewed = result.facts.filter(
      (fact) => fact.contract === bound.contract && fact.kind === "attestation" && fact.data.gate === "reviewed",
    );
    assert.equal(reviewed.length, 1);
    const claims = (await readdir(pump.directory)).filter((name) => name.endsWith(".request.json"));
    assert.equal(claims.length, 1);
    const claim = JSON.parse(await readFile(join(pump.directory, claims[0]!), "utf8")) as { id: string };
    const stored = await readRequest(parent.paths, claim.id);
    assert.deepEqual(stored?.state === "served" && "serviceJson" in stored ? JSON.parse(stored.serviceJson) : null, {
      kind: "accepted-reference",
      repoRoot: repository.path,
      contractId: bound.contract,
      reviewFactId: reviewed[0]!.entry,
    });
  } finally {
    await pump.close();
  }
});
