import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { admit } from "../src/core/facts/admission.js";
import { readRef, repositoryAt } from "../src/core/facts/repository.js";
import {
  commitOid,
  contractHead,
  contractId,
  entryUlid,
  type ContractBody,
  type ContractId,
  type ForfeitData,
  type JournalEntry,
  type Phase,
} from "../src/core/facts/types.js";
import { observeContract } from "../src/core/protocol/observe.js";
import { runProtocol, type AttemptContext, type DecideInput } from "../src/core/protocol/run.js";
import { decideForfeit, type ForfeitInput } from "../src/core/verbs/forfeit.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Forfeit contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [],
    extensions: [],
  };
}

function forfeitInput(id: ContractId, data: ForfeitData = { reason: "manual", note: "stop" }): ForfeitInput {
  return { contractId: id, actor: "tester", at: AT, data };
}

function bind(id: ContractId): JournalEntry {
  return {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: AT,
    actor: "seed",
    data: body(),
  };
}

function seal(id: ContractId): JournalEntry {
  return {
    v: 1,
    kind: "seal",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    at: AT,
    actor: "seed",
    data: {},
  };
}

function petition(id: ContractId, intent: "claim" | "forfeit"): JournalEntry {
  return intent === "forfeit"
    ? {
      v: 1,
      kind: "petition",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      at: AT,
      actor: "seed",
      data: { intent, seat: 1 },
    }
    : {
      v: 1,
      kind: "petition",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      at: AT,
      actor: "seed",
      data: {
        intent,
        oath: "Ready to claim",
        expectedPredecessor: commitOid("a".repeat(40)),
        seat: 1,
        candidate: commitOid("b".repeat(40)),
      },
    };
}

function approvedReview(id: ContractId): JournalEntry {
  return {
    v: 1,
    kind: "review",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    at: AT,
    actor: "reviewer",
    data: { verdict: "approved", digest: "digest", summary: "approved", evidence: [] },
  };
}

function claim(id: ContractId): JournalEntry {
  return {
    v: 1,
    kind: "claim",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
    at: AT,
    actor: "seed",
    data: { petition: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX") },
  };
}

function journalFor(id: ContractId, phase: Phase): readonly JournalEntry[] {
  const bound = bind(id);
  if (phase === "active") return [bound];
  if (phase === "sealed") return [bound, seal(id)];
  if (phase === "awaiting-verdict") return [bound, seal(id), petition(id, "forfeit")];
  if (phase === "approved") return [bound, seal(id), petition(id, "forfeit"), approvedReview(id)];
  if (phase === "claimed") return [bound, seal(id), petition(id, "claim"), approvedReview(id), claim(id)];
  return [bound, {
    v: 1,
    kind: "forfeit",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    at: AT,
    actor: "seed",
    data: { reason: "manual" },
  }];
}

function seed(repository: ReturnType<typeof repositoryAt>, id: ContractId, entries: readonly JournalEntry[]): void {
  const result = admit(repository, { facts: [{ contractId: id, expectedHead: null, entries }] });
  assert.equal(result.kind, "accepted");
}

test("forfeit has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/forfeit.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("forfeit publishes one terminal fact from every fold-legal phase", () => {
  for (const [phase, ulid] of [
    ["active", "01ARZ3NDEKTSV4RRFFQ69G5FB0"],
    ["sealed", "01ARZ3NDEKTSV4RRFFQ69G5FB1"],
    ["approved", "01ARZ3NDEKTSV4RRFFQ69G5FB2"],
  ] as const) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    const id = contractId(`kei/forfeit-${phase}`);
    seed(repo, id, journalFor(id, phase));

    const result = runProtocol({
      input: forfeitInput(id),
      repository: repo,
      contracts: [id],
      attempts: [attempt(0, ulid)],
      decide: decideForfeit,
    });

    assert.equal(result.kind, "handoff");
    if (result.kind !== "handoff") continue;
    assert.equal(result.handoff.admission?.kind, "accepted");
    assert.equal(result.handoff.handoff, null);
    assert.deepEqual(result.handoff.acceptedEntries, [{
      v: 1,
      kind: "forfeit",
      contract: id,
      entry: entryUlid(ulid),
      at: AT,
      actor: "tester",
      data: { reason: "manual", note: "stop" },
    }]);
    const observed = observeContract(repo, id);
    assert.equal(observed.state?.phase, "forfeited");
    assert.equal(observed.state?.terminal?.kind, "forfeit");
    assert.equal(observed.state?.petition, null);
  }
});

test("forfeit refuses missing, illegal, and claim-petition states without publishing", () => {
  const missingRepository = makeGitRepository();
  const missingRepo = repositoryAt(missingRepository.path);
  const missing = contractId("kei/forfeit-missing");
  const missingResult = runProtocol({
    input: forfeitInput(missing),
    repository: missingRepo,
    contracts: [missing],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB3")],
    decide: decideForfeit,
  });
  assert.deepEqual(missingResult, { kind: "refused", refusal: { kind: "contract-missing", contractId: missing } });
  assert.equal(readRef(missingRepo, "refs/heads/keiyaku-state"), null);

  for (const phase of ["awaiting-verdict", "claimed", "forfeited"] as const) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    const id = contractId(`kei/forfeit-${phase}`);
    seed(repo, id, journalFor(id, phase));
    const before = readRef(repo, "refs/heads/keiyaku-state");

    const result = runProtocol({
      input: forfeitInput(id),
      repository: repo,
      contracts: [id],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB4")],
      decide: decideForfeit,
    });
    assert.deepEqual(result, {
      kind: "refused",
      refusal: { kind: "phase-not-forfeitable", contractId: id, phase },
    });
    assert.equal(readRef(repo, "refs/heads/keiyaku-state"), before);
  }

  const claimRepository = makeGitRepository();
  const claimRepo = repositoryAt(claimRepository.path);
  const claimId = contractId("kei/forfeit-claim-petition");
  seed(claimRepo, claimId, [bind(claimId), seal(claimId), petition(claimId, "claim"), approvedReview(claimId)]);
  const claimBefore = readRef(claimRepo, "refs/heads/keiyaku-state");
  const claimResult = runProtocol({
    input: forfeitInput(claimId),
    repository: claimRepo,
    contracts: [claimId],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB5")],
    decide: decideForfeit,
  });
  assert.deepEqual(claimResult, {
    kind: "refused",
    refusal: { kind: "phase-not-forfeitable", contractId: claimId, phase: "approved" },
  });
  assert.equal(readRef(claimRepo, "refs/heads/keiyaku-state"), claimBefore);
});

test("forfeit decision is deterministic, clones input data, and requires one ULID", () => {
  const id = contractId("kei/forfeit-pure");
  const mutableData: { reason: "manual"; note: string } = { reason: "manual", note: "initial" };
  const decisionInput: DecideInput<ForfeitInput> = {
    input: forfeitInput(id, mutableData),
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB6"),
    observation: {
      carrierCommit: null,
      contracts: new Map([[id, {
        id,
        entries: [],
        state: {
          id,
          head: contractHead("a".repeat(40)),
          phase: "active",
          body: body(),
          delivery: null,
          petition: null,
          evidence: [],
          terminal: null,
        },
      }]]),
    },
  };

  const first = decideForfeit(decisionInput);
  const second = decideForfeit(decisionInput);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "offer");
  if (first.kind !== "offer") return;
  mutableData.note = "changed";
  const offered = first.offer.facts[0]!.entries[0]!;
  assert.equal(offered.kind, "forfeit");
  if (offered.kind !== "forfeit") return;
  assert.deepEqual(offered.data, { reason: "manual", note: "initial" });
  assert.deepEqual(first.offer, {
    facts: [{ contractId: id, expectedHead: "a".repeat(40), entries: [offered] }],
  });
  assert.throws(
    () => decideForfeit({
      ...decisionInput,
      attempt: {
        ordinal: 0,
        entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB7"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB8")],
      },
    }),
    /exactly one fresh entry ULID/,
  );
});

test("a competing seal causes forfeit to redecide with the next fresh ULID", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/forfeit-race");
  seed(repo, id, journalFor(id, "active"));
  const attempts = [
    attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB9"),
    attempt(1, "01ARZ3NDEKTSV4RRFFQ69G5FBA"),
  ];
  const seen: Array<{ ulid: string; expectedHead: string }> = [];
  let competingHead: string | undefined;
  const result = runProtocol({
    input: forfeitInput(id, { reason: "bind-failed" }),
    repository: repo,
    contracts: [id],
    attempts,
    decide: (input) => {
      const decision = decideForfeit(input);
      assert.equal(decision.kind, "offer");
      if (decision.kind !== "offer") return decision;
      const append = decision.offer.facts[0]!;
      if (append.expectedHead === undefined || append.expectedHead === null) {
        throw new Error("forfeit offer must carry an observed journal head");
      }
      seen.push({ ulid: input.attempt.entryUlids[0]!, expectedHead: append.expectedHead });
      if (input.attempt.ordinal === 0) {
        const competitor = admit(repo, {
          facts: [{
            contractId: id,
            expectedHead: append.expectedHead,
            entries: [seal(id)],
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
  assert.deepEqual(observed.entries.map((entry) => entry.kind), ["bind", "seal", "forfeit"]);
  assert.equal(observed.state?.phase, "forfeited");
});
