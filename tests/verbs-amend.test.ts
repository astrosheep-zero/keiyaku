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
  type AmendData,
  type AmendEntry,
  type BindEntry,
  type ContractBody,
  type ContractId,
  type ContractState,
  type JournalEntry,
  type Phase,
} from "../src/core/facts/types.js";
import { decideAmend, type AmendInput } from "../src/core/verbs/amend.js";
import { readRef, repositoryAt } from "../src/core/facts/repository.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Amend contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [{ executor: "bash", script: "npm test" }],
    extensions: [{ title: "Notes", content: "Initial notes" }],
  };
}

function amendData(): AmendData {
  return {
    revisions: [
      { target: "context", op: "append", body: "Updated context" },
      { target: { extension: "Notes" }, op: "append", body: "Updated notes" },
    ],
    region: ["src/changed"],
    criteriaDelta: { replace: ["replacement criterion"] },
    verificationDelta: { replace: [{ executor: "zsh", script: "npm run test:typecheck" }] },
  };
}

function amendInput(id: ContractId, data: AmendData = amendData()): AmendInput {
  return { contractId: id, actor: "tester", at: AT, data };
}

function bind(id: ContractId, value: string): BindEntry {
  return {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "seed",
    data: body(),
  };
}

function seal(id: ContractId, value: string): JournalEntry {
  return { v: 1, kind: "seal", contract: id, entry: entryUlid(value), at: AT, actor: "seed", data: {} };
}

function open(id: ContractId, value: string): JournalEntry {
  return { v: 1, kind: "open", contract: id, entry: entryUlid(value), at: AT, actor: "seed", data: { target: "refs/heads/main", base: commitOid("a".repeat(40)) } };
}

function claimPetition(id: ContractId, value: string): JournalEntry {
  return {
    v: 1,
    kind: "petition",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "seed",
    data: {
      expectedPredecessor: commitOid("a".repeat(40)),
      deliveryHead: commitOid("a".repeat(40)),
      candidate: commitOid("b".repeat(40)),
    },
  };
}

function approvedReview(id: ContractId, value: string): JournalEntry {
  return {
    v: 1,
    kind: "review",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "reviewer",
    data: { verdict: "approved", reviewedHead: commitOid("a".repeat(40)), digest: "digest", summary: "approved", evidence: [] },
  };
}

function claim(id: ContractId, petition: string, value: string): JournalEntry {
  return {
    v: 1,
    kind: "claim",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "seed",
    data: { petition: entryUlid(petition) },
  };
}

function forfeit(id: ContractId, value: string): JournalEntry {
  return {
    v: 1,
    kind: "forfeit",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "seed",
    data: { reason: "manual" },
  };
}

function journalFor(id: ContractId, phase: Phase): readonly JournalEntry[] {
  const bound = bind(id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  if (phase === "active") return [bound];
  const opened = open(id, "01ARZ3NDEKTSV4RRFFQ69G5FB0");
  const sealed = seal(id, "01ARZ3NDEKTSV4RRFFQ69G5FAW");
  if (phase === "sealed") return [bound, opened, sealed];
  if (phase === "forfeited") return [bound, forfeit(id, "01ARZ3NDEKTSV4RRFFQ69G5FAX")];
  if (phase === "awaiting-verdict") return [bound, opened, sealed, claimPetition(id, "01ARZ3NDEKTSV4RRFFQ69G5FAX")];
  const petition = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  return [bound, opened, sealed, claimPetition(id, petition), approvedReview(id, "01ARZ3NDEKTSV4RRFFQ69G5FAY"), claim(id, petition, "01ARZ3NDEKTSV4RRFFQ69G5FAZ")];
}

function seed(
  repository: ReturnType<typeof repositoryAt>,
  id: ContractId,
  phase: Phase,
  withApproval = false,
): void {
  const journal = journalFor(id, phase);
  const entries = withApproval
    ? [...journal, approvedReview(id, "01ARZ3NDEKTSV4RRFFQ69G5FAY")]
    : journal;
  const result = admit(repository, { facts: [{ contractId: id, expectedHead: null, entries }] });
  assert.equal(result.kind, "accepted");
}

function amendedBody(): ContractBody {
  return {
    ...body(),
    context: "Context\n\nUpdated context",
    region: ["src/changed"],
    criteria: ["replacement criterion"],
    verification: [{ executor: "zsh", script: "npm run test:typecheck" }],
    extensions: [{ title: "Notes", content: "Initial notes\n\nUpdated notes" }],
  };
}

test("amend has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/amend.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("amend updates the effective body and returns permitted phases to active", () => {
  for (const [phase, withApproval] of [
    ["active", false],
    ["awaiting-verdict", false],
    ["awaiting-verdict", true],
  ] as const) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    const id = contractId(`kei/amend-${phase}${withApproval ? "-approved" : ""}`);
    seed(repo, id, phase, withApproval);
    const before = observeContract(repo, id).state;
    assert.equal(before?.phase, phase);
    assert.equal(before?.approval === null, !withApproval);

    const result = runProtocol({
      input: amendInput(id),
      repository: repo,
      contracts: [id],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB1")],
      decide: decideAmend,
    });

    assert.equal(result.kind, "handoff");
    if (result.kind !== "handoff") continue;
    assert.equal(result.handoff.admission?.kind, "accepted");
    const observed = observeContract(repo, id);
    assert.equal(observed.state?.phase, "active");
    assert.equal(observed.state?.approval, null);
    assert.equal(observed.state?.petition, null);
    assert.deepEqual(observed.state?.body, amendedBody());
  }
});

test("amend refuses missing and non-amendable contracts without publishing", () => {
  const missingRepository = makeGitRepository();
  const missingRepo = repositoryAt(missingRepository.path);
  const missing = contractId("kei/amend-missing");
  const missingResult = runProtocol({
    input: amendInput(missing),
    repository: missingRepo,
    contracts: [missing],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB1")],
    decide: decideAmend,
  });
  assert.deepEqual(missingResult, { kind: "refused", refusal: { kind: "contract-missing", contractId: missing } });
  assert.equal(readRef(missingRepo, "refs/heads/keiyaku-state"), null);

  for (const phase of ["sealed", "claimed", "forfeited"] as const) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    const id = contractId(`kei/amend-${phase}`);
    seed(repo, id, phase);
    const before = readRef(repo, "refs/heads/keiyaku-state");

    const result = runProtocol({
      input: amendInput(id),
      repository: repo,
      contracts: [id],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB2")],
      decide: decideAmend,
    });

    assert.deepEqual(result, {
      kind: "refused",
      refusal: { kind: "phase-not-amendable", contractId: id, phase },
    });
    assert.equal(readRef(repo, "refs/heads/keiyaku-state"), before);
  }
});

test("amend decision is deterministic, isolates caller data, and requires one ULID", () => {
  const id = contractId("kei/amend-pure");
  const mutableData = {
    revisions: [{ target: { extension: "Notes" }, op: "append" as const, body: "Updated notes" }],
    region: ["src/changed"],
    criteriaDelta: { add: ["added criterion"] },
    verificationDelta: { replace: [{ executor: "zsh" as const, script: "npm run test:typecheck" }] },
  };
  const state: ContractState = {
    id,
    head: contractHead("a".repeat(40)),
    phase: "active",
    body: body(),
    delivery: null,
    approval: null,
    petition: null,
    evidence: [],
    terminal: null,
  };
  const decisionInput: DecideInput<AmendInput> = {
    input: amendInput(id, mutableData),
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB3"),
    observation: { carrierCommit: null, contracts: new Map([[id, { id, entries: [], state }]]) },
  };

  const first = decideAmend(decisionInput);
  const second = decideAmend(decisionInput);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "offer");
  if (first.kind !== "offer") return;
  mutableData.revisions[0]!.target.extension = "Changed";
  mutableData.region.push("tests");
  mutableData.criteriaDelta.add.push("another criterion");
  mutableData.verificationDelta.replace[0]!.script = "changed";
  const offered = first.offer.facts[0]!.entries[0]!;
  assert.equal(offered.kind, "amend");
  if (offered.kind !== "amend") return;
  assert.deepEqual(offered.data, {
    revisions: [{ target: { extension: "Notes" }, op: "append", body: "Updated notes" }],
    region: ["src/changed"],
    criteriaDelta: { add: ["added criterion"] },
    verificationDelta: { replace: [{ executor: "zsh", script: "npm run test:typecheck" }] },
  });

  assert.throws(
    () => decideAmend({ ...decisionInput, attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB4"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB5")] } }),
    /exactly one fresh entry ULID/,
  );
});

test("a competing append causes amend to redecide against the new journal head", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/amend-race");
  seed(repo, id, "active");
  const attempts = [
    attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB6"),
    attempt(1, "01ARZ3NDEKTSV4RRFFQ69G5FB7"),
  ];
  const seen: Array<{ ulid: string; expectedHead: string }> = [];
  let competingHead: string | undefined;
  const result = runProtocol({
    input: amendInput(id, { criteriaDelta: { add: ["requested"] } }),
    repository: repo,
    contracts: [id],
    attempts,
    decide: (input) => {
      const decision = decideAmend(input);
      assert.equal(decision.kind, "offer");
      if (decision.kind !== "offer") return decision;
      const append = decision.offer.facts[0]!;
      if (append.expectedHead === undefined || append.expectedHead === null) {
        throw new Error("amend offer must carry an observed journal head");
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
  assert.equal(observed.entries.length, 3);
  assert.deepEqual(observed.state?.body?.criteria, ["criterion", "competing", "requested"]);
});
