import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRequest } from "../src/akuma/heart/index.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { requestBodyCommand } from "../src/akuma/request-rendezvous.js";
import { contractHead, contractId, entryUlid, snapshotId } from "../src/core/facts/types.js";
import type { VerifyOutcome } from "../src/library/contract-outcomes.js";
import {
  contractRequestCommands,
  contractRequestProtocol,
  requestForwardedContractLive,
  type ContractRequestPort,
} from "../src/library/contract-operations.js";
import { KeiyakuError } from "../src/library/outcome.js";
import { World, type WorldRoot } from "../src/world.js";
import { bodyRequestExecutionContext } from "../src/akuma/requests.js";
import { createKeiyakuHandle, Keiyaku } from "../src/library/keiyaku.js";
import { Repo, scopeForRepo } from "../src/library/repo.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { accepted, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";

const unusedPort: Omit<ContractRequestPort, "verify"> = {
  previewDelivery: async () => {
    throw new Error("unexpected preview");
  },
  deliver: async () => {
    throw new Error("unexpected deliver");
  },
  review: async () => {
    throw new Error("unexpected review");
  },
};
const contract = contractId("kei/verification-forwarding");
const snapshot = snapshotId("captured-integration");
const entry = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA3");

async function fixture(verify: ContractRequestPort["verify"], worldRoot?: WorldRoot) {
  const root = worldRoot ?? (await World.at(mkdtempSync(join(tmpdir(), "keiyaku-verify-forwarding-"))));
  const parent = await bornDirectAkuma({
    root,
    archetype: "parent",
    draw: "11111111",
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  parent.leash.release();
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    bodySequence: 1,
    now: () => "2026-09-05T00:00:01.000Z",
    commands: contractRequestCommands({ ...unusedPort, verify }),
    signal: new AbortController().signal,
  });
  return {
    root,
    parent,
    pump,
    request: { action: "contract.verify" as const, repoRoot: root, contractId: contract, index: 2, includeDirty: true },
    async close() {
      await pump.close();
      if (worldRoot === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}

function acceptedVerify(checks: Extract<VerifyOutcome, { kind: "accepted" }>["value"]["checks"]): VerifyOutcome {
  return {
    operation: "verify",
    kind: "accepted",
    contract,
    head: contractHead("observed-head"),
    facts: [],
    effects: [],
    pending: [],
    value: { snapshot, checks, continuation: { claimed: [], stopped: [] } },
  };
}

test("forwarded verify preserves live continuation and retains references without replaying reused execution", async () => {
  const owner = acceptedVerify([
    {
      kind: "terminal",
      index: 2,
      requirement: "requirement-2",
      snapshot,
      verdict: "satisfied",
      admission: { kind: "reused", entry },
    },
  ]);
  let calls = 0;
  const observations: string[] = [];
  const value = await fixture(async (input) => {
    calls += 1;
    assert.equal(input.index, 2);
    assert.equal(input.includeDirty, true);
    assert.equal(input.signal.aborted, false);
    assert.equal(input.requester, value.parent.id);
    input.observe?.({ kind: "stage", contractId: contract, stage: "placement", state: "started" });
    return owner;
  });
  const id = randomUUID();
  const invoke = () =>
    requestBodyCommand({
      directory: value.pump.directory,
      id,
      command: contractRequestProtocol("contract.verify"),
      value: value.request,
      onProgress: (event) => observations.push((event as { kind: string }).kind),
    });
  try {
    const result = await invoke();
    assert.equal(result.kind, "returned");
    if (result.kind !== "returned") throw new Error("missing live result");
    assert.deepEqual(result.result, owner);
    assert.deepEqual(observations, ["stage"]);
    const stored = await readRequest(value.parent.paths, id);
    assert.ok(stored?.state === "served" && "serviceJson" in stored);
    const evidence = {
      kind: "verification-completed",
      repoRoot: value.root,
      contractId: contract,
      snapshot,
      checks: [{ index: 2, requirement: "requirement-2", kind: "reused", entry }],
    };
    assert.deepEqual(JSON.parse(stored.serviceJson), evidence);
    const replay = await invoke();
    assert.equal(replay.kind, "reference");
    if (replay.kind !== "reference") throw new Error("expected bounded service reference");
    assert.deepEqual(replay.reference, evidence);
    assert.equal(calls, 1);
  } finally {
    await value.close();
  }
});

test("Git-less native verify preserves selected execution and repeated admission reuse", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const root = await World.at(repository.path);
  const markdown = `${document("printf first")}\n~~~bash timeout=5m\nprintf second\n~~~\n`;
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown, gates: ["verified"] }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  commitCandidate(repository, bound.value.workspace.path);
  let owner: VerifyOutcome | undefined;
  let calls = 0;
  const value = await fixture(async (input) => {
    calls += 1;
    assert.equal(input.index, 2);
    owner = await Keiyaku.with({ actor: input.requester })
      .select({ repo, id: input.contractId })
      .verify(
        {
          ...(input.index === undefined ? {} : { index: input.index }),
          includeDirty: input.includeDirty,
          signal: input.signal,
        },
        input.observe === undefined ? undefined : { observe: input.observe },
      );
    return owner;
  }, root);
  try {
    const forwarded = createKeiyakuHandle(
      bound.contract,
      {
        ...scopeForRepo(repo),
        get gitPath(): string {
          throw new Error("child has no Git custody");
        },
      },
      bodyRequestExecutionContext(value.pump.directory),
      captureLocalContractComposition(),
    );
    const first = accepted(await forwarded.verify({ index: 2 }));
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(owner)));
    assert.equal(first.value.checks.length, 1);
    const check = first.value.checks[0]!;
    assert.equal(check.index, 2);
    assert.equal(check.kind, "terminal");
    if (check.kind !== "terminal") throw new Error("expected terminal check");
    assert.equal(check.verdict, "satisfied");
    assert.equal(check.admission.kind, "admitted");
    let repeatedOutput = "";
    const second = accepted(
      await forwarded.verify(
        { index: 2 },
        {
          observe: (event) => {
            if (event.kind === "verification" && event.observation.kind === "output")
              repeatedOutput += event.observation.text;
          },
        },
      ),
    );
    assert.match(repeatedOutput, /second/u);
    assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(owner)));
    assert.equal(second.value.snapshot, first.value.snapshot);
    const repeated = second.value.checks[0]!;
    if (repeated.kind !== "terminal") throw new Error("expected repeated terminal check");
    assert.equal(repeated.admission.kind, "reused");
    assert.deepEqual(second.facts, []);
    assert.equal(calls, 2);
    assert.equal((await bound.value.keiyaku.state())?.delivery, null);
  } finally {
    await value.close();
  }
});

test("a completed operational stop is served without inventing an attestation", async () => {
  const owner = acceptedVerify([
    {
      kind: "stopped",
      index: 2,
      requirement: "requirement-2",
      snapshot,
      stop: { failure: "spawn-error", diagnostic: "shell unavailable" },
    },
  ]);
  const value = await fixture(async () => owner);
  const id = randomUUID();
  try {
    const response = await requestBodyCommand({
      directory: value.pump.directory,
      id,
      command: contractRequestProtocol("contract.verify"),
      value: value.request,
    });
    assert.equal(response.kind, "returned");
    if (response.kind !== "returned") throw new Error("missing live result");
    assert.deepEqual(response.result, owner);
    const stored = await readRequest(value.parent.paths, id);
    assert.ok(stored?.state === "served" && "serviceJson" in stored);
    assert.deepEqual(JSON.parse(stored.serviceJson), {
      kind: "verification-completed",
      repoRoot: value.root,
      contractId: contract,
      snapshot,
      checks: [
        {
          index: 2,
          requirement: "requirement-2",
          kind: "stopped",
          stage: "execution",
          stop: { failure: "spawn-error", diagnostic: "shell unavailable" },
        },
      ],
    });
  } finally {
    await value.close();
  }
});

test("verify refusal proves no committed effect while owner failure remains unproven", async () => {
  let fail = false;
  const refusal: VerifyOutcome = {
    operation: "verify",
    kind: "refused",
    contract,
    facts: [],
    effects: [],
    pending: [],
    refusal: { kind: "contract-missing", contractId: contract },
  };
  const value = await fixture(async () => {
    if (fail) throw new KeiyakuError("internal", "unknown owner effect", { cause: new TypeError("owner failure") });
    return refusal;
  });
  try {
    const refusedId = randomUUID();
    const response = await requestBodyCommand({
      directory: value.pump.directory,
      id: refusedId,
      command: contractRequestProtocol("contract.verify"),
      value: value.request,
    });
    assert.equal(response.kind, "returned");
    if (response.kind !== "returned") throw new Error("missing refusal");
    assert.deepEqual(response.result, refusal);
    assert.equal((await readRequest(value.parent.paths, refusedId))?.state, "voided");
    fail = true;
    await assert.rejects(
      requestForwardedContractLive({
        directory: value.pump.directory,
        action: "contract.verify",
        request: value.request,
      }),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "internal");
        assert.ok(error.cause instanceof TypeError);
        assert.equal((error as Error & { requestOutcome?: string }).requestOutcome, "unproven");
        return true;
      },
    );
  } finally {
    await value.close();
  }
});
