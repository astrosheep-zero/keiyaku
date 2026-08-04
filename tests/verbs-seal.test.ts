import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { admit } from "../src/core/facts/admission.js";
import { observeContract } from "../src/core/protocol/observe.js";
import { runProtocol, type AttemptContext, type DecideInput } from "../src/core/protocol/run.js";
import {
  commitOid,
  contractHead,
  contractId,
  entryUlid,
  type ContractBody,
  type ContractId,
  type ContractState,
  type JournalEntry,
  type Phase,
} from "../src/core/facts/types.js";
import { decideSeal, type SealInput } from "../src/core/verbs/seal.js";
import { readRef, repositoryAt } from "../src/core/facts/repository.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Seal contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [],
    extensions: [],
  };
}

function sealInput(id: ContractId): SealInput {
  return { contractId: id, actor: "tester", at: AT };
}

function journalFor(id: ContractId, phase: Phase): readonly JournalEntry[] {
  const bound: JournalEntry = {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: AT,
    actor: "seed",
    data: body(),
  };
  if (phase === "active") return [bound];
  if (phase === "forfeited") {
    return [bound, {
      v: 1,
      kind: "forfeit",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      at: AT,
      actor: "seed",
      data: { reason: "manual" },
    }];
  }
  const sealed: JournalEntry = {
    v: 1,
    kind: "seal",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    at: AT,
    actor: "seed",
    data: {},
  };
  if (phase === "sealed") return [bound, sealed];
  const petition: JournalEntry = phase === "claimed"
    ? {
      v: 1,
      kind: "petition",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      at: AT,
      actor: "seed",
      data: {
        intent: "claim",
        oath: "Ready to claim",
        expectedPredecessor: commitOid("a".repeat(40)),
        seat: 1,
        candidate: commitOid("b".repeat(40)),
      },
    }
    : {
      v: 1,
      kind: "petition",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      at: AT,
      actor: "seed",
      data: { intent: "forfeit", seat: 1 },
    };
  if (phase === "awaiting-verdict") return [bound, sealed, petition];
  const review: JournalEntry = {
    v: 1,
    kind: "review",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    at: AT,
    actor: "reviewer",
    data: { verdict: "approved", digest: "digest", summary: "approved", evidence: [] },
  };
  if (phase === "approved") return [bound, sealed, petition, review];
  return [bound, sealed, petition, review, {
    v: 1,
    kind: "claim",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
    at: AT,
    actor: "seed",
    data: { petition: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX") },
  }];
}

function seed(repository: ReturnType<typeof repositoryAt>, id: ContractId, phase: Phase): void {
  const result = admit(repository, { facts: [{ contractId: id, expectedHead: null, entries: journalFor(id, phase) }] });
  assert.equal(result.kind, "accepted");
}

test("seal has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/seal.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("seal accepts an active contract through the real protocol", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("seal-active");
  seed(repo, id, "active");

  const result = runProtocol({
    input: sealInput(id),
    repository: repo,
    contracts: [id],
    watchedRefs: [],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB0")],
    decide: decideSeal,
  });

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.deepEqual(result.handoff.acceptedEntries, [{
    v: 1,
    kind: "seal",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    at: AT,
    actor: "tester",
    data: {},
  }]);
  assert.equal(observeContract(repo, id).state?.phase, "sealed");
});

test("seal refuses missing and every non-active phase without publishing", () => {
  const missingRepository = makeGitRepository();
  const missingRepo = repositoryAt(missingRepository.path);
  const missing = contractId("seal-missing");
  const missingResult = runProtocol({
    input: sealInput(missing),
    repository: missingRepo,
    contracts: [missing],
    watchedRefs: [],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB1")],
    decide: decideSeal,
  });
  assert.deepEqual(missingResult, { kind: "refused", refusal: { kind: "contract-missing", contractId: missing } });
  assert.equal(readRef(missingRepo, "refs/heads/keiyaku-state"), null);

  for (const phase of ["sealed", "awaiting-verdict", "approved", "claimed", "forfeited"] as const) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    const id = contractId(`seal-${phase}`);
    seed(repo, id, phase);
    const before = readRef(repo, "refs/heads/keiyaku-state");

    const result = runProtocol({
      input: sealInput(id),
      repository: repo,
      contracts: [id],
      watchedRefs: [],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB2")],
      decide: decideSeal,
    });

    assert.deepEqual(result, {
      kind: "refused",
      refusal: { kind: "phase-not-active", contractId: id, phase },
    });
    assert.equal(readRef(repo, "refs/heads/keiyaku-state"), before);
  }
});

test("seal decision is deterministic and requires one ULID", () => {
  const id = contractId("seal-pure");
  const state: ContractState = {
    id,
    head: contractHead("a".repeat(40)),
    phase: "active",
    body: body(),
    delivery: null,
    petition: null,
    evidence: [],
    terminal: null,
  };
  const decisionInput: DecideInput<SealInput> = {
    input: sealInput(id),
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB3"),
    observation: { carrierCommit: null, contracts: new Map([[id, { id, entries: [], state }]]) },
    watchedRefs: [],
  };

  const first = decideSeal(decisionInput);
  const second = decideSeal(decisionInput);
  assert.deepEqual(first, second);
  assert.throws(
    () => decideSeal({ ...decisionInput, attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB4"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB5")] } }),
    /exactly one fresh entry ULID/,
  );
});

test("a competing amend causes seal to redecide against the new journal head", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("seal-race");
  seed(repo, id, "active");
  const attempts = [
    attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB6"),
    attempt(1, "01ARZ3NDEKTSV4RRFFQ69G5FB7"),
  ];
  const seen: Array<{ ulid: string; expectedHead: string }> = [];
  let competingHead: string | undefined;
  const result = runProtocol({
    input: sealInput(id),
    repository: repo,
    contracts: [id],
    watchedRefs: [],
    attempts,
    decide: (input) => {
      const decision = decideSeal(input);
      assert.equal(decision.kind, "offer");
      if (decision.kind !== "offer") return decision;
      const append = decision.offer.facts[0]!;
      if (append.expectedHead === undefined || append.expectedHead === null) {
        throw new Error("seal offer must carry an observed journal head");
      }
      const expectedHead = append.expectedHead;
      seen.push({ ulid: input.attempt.entryUlids[0]!, expectedHead });
      if (input.attempt.ordinal === 0) {
        const competitor = admit(repo, {
          facts: [{
            contractId: id,
            expectedHead,
            entries: [{
              v: 1,
              kind: "amend",
              contract: id,
              entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB8"),
              at: AT,
              actor: "competitor",
              data: { criteriaDelta: { add: ["competing"] } },
            }],
          }],
        });
        assert.equal(competitor.kind, "accepted");
        if (competitor.kind === "accepted") competingHead = competitor.heads[id];
      }
      return decision;
    },
  });

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.deepEqual(seen.map((item) => item.ulid), attempts.map((candidate) => candidate.entryUlids[0]!));
  assert.equal(seen[1]?.expectedHead, competingHead);
  const observed = observeContract(repo, id);
  assert.equal(observed.state?.phase, "sealed");
  assert.deepEqual(observed.state?.body?.criteria, ["criterion", "competing"]);
  assert.deepEqual(observed.entries.map((entry) => entry.kind), ["bind", "amend", "seal"]);
});
