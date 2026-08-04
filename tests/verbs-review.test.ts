import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { admit } from "../src/core/facts/admission.js";
import { FactsCodecError } from "../src/core/facts/codec.js";
import { readRef, repositoryAt } from "../src/core/facts/repository.js";
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
  type PetitionEntry,
} from "../src/core/facts/types.js";
import { observeContract } from "../src/core/protocol/observe.js";
import { runProtocol, type AttemptContext, type DecideInput } from "../src/core/protocol/run.js";
import {
  decideReviewChangesRequested,
  type ReviewChangesRequestedInput,
} from "../src/core/verbs/review.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Review contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [],
    extensions: [],
  };
}

function reviewInput(
  id: ContractId,
  data: ReviewChangesRequestedInput["data"] = { digest: "review-digest", summary: "Changes are needed" },
): ReviewChangesRequestedInput {
  return { contractId: id, actor: "reviewer", at: AT, data };
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

function open(id: ContractId): JournalEntry {
  return {
    v: 1,
    kind: "open",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    at: AT,
    actor: "seed",
    data: { target: "refs/heads/main", base: commitOid("a".repeat(40)) },
  };
}

function petition(id: ContractId): PetitionEntry {
  return {
    v: 1,
    kind: "petition",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    at: AT,
    actor: "seed",
    data: {
      expectedPredecessor: commitOid("a".repeat(40)),
      deliveryHead: commitOid("a".repeat(40)),
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
    actor: "seed",
    data: { verdict: "approved", reviewedHead: commitOid("a".repeat(40)), digest: "digest", summary: "approved", evidence: [] },
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
  const opened = open(id);
  if (phase === "sealed") return [bound, opened, seal(id)];
  if (phase === "awaiting-verdict") return [bound, opened, seal(id), petition(id)];
  if (phase === "claimed") return [bound, opened, seal(id), petition(id), approvedReview(id), claim(id)];
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

test("review changes requested has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/review.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("review changes requested reopens a claim petition to active", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/review-claim");
  const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
  seed(repo, id, [bind(id), open(id), seal(id), petition(id)]);
  assert.equal(observeContract(repo, id).state?.phase, "awaiting-verdict");

  const result = runProtocol({
    input: reviewInput(id),
    repository: repo,
    contracts: [id],
    attempts: [attempt(0, ulid)],
    decide: decideReviewChangesRequested,
  });

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.equal(result.handoff.handoff, null);
  assert.deepEqual(result.handoff.acceptedEntries, [{
    v: 1,
    kind: "review",
    contract: id,
    entry: entryUlid(ulid),
    at: AT,
    actor: "reviewer",
    data: {
      verdict: "changes-requested",
      digest: "review-digest",
      summary: "Changes are needed",
      evidence: [],
    },
  }]);
  const observed = observeContract(repo, id);
  assert.equal(observed.state?.phase, "active");
  assert.equal(observed.state?.petition, null);
  assert.equal(observed.state?.evidence.at(-1)?.kind, "review");
});

test("review changes requested refuses missing and every non-awaiting phase without publishing", () => {
  const missingRepository = makeGitRepository();
  const missingRepo = repositoryAt(missingRepository.path);
  const missing = contractId("kei/review-missing");
  const missingResult = runProtocol({
    input: reviewInput(missing),
    repository: missingRepo,
    contracts: [missing],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB2")],
    decide: decideReviewChangesRequested,
  });
  assert.deepEqual(missingResult, {
    kind: "refused",
    refusal: { kind: "contract-missing", contractId: missing },
  });
  assert.equal(readRef(missingRepo, "refs/heads/keiyaku-state"), null);

  for (const phase of ["active", "sealed", "claimed", "forfeited"] as const) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    const id = contractId(`kei/review-${phase}`);
    seed(repo, id, journalFor(id, phase));
    const before = readRef(repo, "refs/heads/keiyaku-state");

    const result = runProtocol({
      input: reviewInput(id),
      repository: repo,
      contracts: [id],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB3")],
      decide: decideReviewChangesRequested,
    });

    assert.deepEqual(result, {
      kind: "refused",
      refusal: { kind: "phase-not-awaiting-verdict", contractId: id, phase },
    });
    assert.equal(readRef(repo, "refs/heads/keiyaku-state"), before);
  }
});

test("malformed review input surfaces codec errors without publishing", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/review-malformed");
  seed(repo, id, journalFor(id, "awaiting-verdict"));
  const seededHead = readRef(repo, "refs/heads/keiyaku-state");
  const malformed = [
    {
      input: reviewInput(id, { digest: "", summary: "Changes are needed" }),
      path: "data.review.digest",
    },
    {
      input: reviewInput(id, { digest: "review-digest", summary: "" }),
      path: "data.review.summary",
    },
    {
      input: { ...reviewInput(id), at: "not-a-timestamp" },
      path: "entry.at",
    },
  ] satisfies ReadonlyArray<{ input: ReviewChangesRequestedInput; path: string }>;

  for (const candidate of malformed) {
    assert.throws(
      () => runProtocol({
        input: candidate.input,
        repository: repo,
        contracts: [id],
        attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB5")],
        decide: decideReviewChangesRequested,
      }),
      (error: unknown) => error instanceof FactsCodecError
        && error.code === "INVALID_FACTS_CODEC"
        && error.message.includes(candidate.path),
    );
    assert.equal(readRef(repo, "refs/heads/keiyaku-state"), seededHead);
  }
});

test("review changes requested is deterministic, clones input data, and offers only one journal fact", () => {
  const id = contractId("kei/review-pure");
  const mutableData = { digest: "initial digest", summary: "Initial summary" };
  const state: ContractState = {
    id,
    head: contractHead("a".repeat(40)),
    phase: "awaiting-verdict",
    body: body(),
    delivery: null,
    approval: null,
    petition: petition(id),
    evidence: [],
    terminal: null,
  };
  const decisionInput: DecideInput<ReviewChangesRequestedInput> = {
    input: reviewInput(id, mutableData),
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB4"),
    observation: { carrierCommit: null, contracts: new Map([[id, { id, entries: [], state }]]) },
  };

  const first = decideReviewChangesRequested(decisionInput);
  const second = decideReviewChangesRequested(decisionInput);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    kind: "offer",
    offer: {
      facts: [{
        contractId: id,
        expectedHead: contractHead("a".repeat(40)),
        entries: [{
          v: 1,
          kind: "review",
          contract: id,
          entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB4"),
          at: AT,
          actor: "reviewer",
          data: {
            verdict: "changes-requested",
            digest: "initial digest",
            summary: "Initial summary",
            evidence: [],
          },
        }],
      }],
    },
    handoff: null,
  });
  assert.equal(first.kind, "offer");
  if (first.kind !== "offer") return;
  mutableData.digest = "changed digest";
  mutableData.summary = "Changed summary";
  const offered = first.offer.facts[0]!.entries[0]!;
  assert.equal(offered.kind, "review");
  if (offered.kind !== "review") return;
  assert.deepEqual(offered.data, {
    verdict: "changes-requested",
    digest: "initial digest",
    summary: "Initial summary",
    evidence: [],
  });
  assert.equal(first.offer.evidence, undefined);
  assert.equal(first.offer.refs, undefined);

  for (const entryUlids of [
    [],
    [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB5"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB6")],
  ]) {
    assert.throws(
      () => decideReviewChangesRequested({ ...decisionInput, attempt: { ordinal: 0, entryUlids } }),
      /exactly one fresh entry ULID/,
    );
  }
});

test("a competing changes-requested review redecides with a fresh ULID", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/review-race");
  seed(repo, id, journalFor(id, "awaiting-verdict"));
  const attempts = [
    attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB7"),
    attempt(1, "01ARZ3NDEKTSV4RRFFQ69G5FB8"),
  ];
  const seen: Array<{ ordinal: number; ulid: string }> = [];
  let competingHead: string | undefined;
  const result = runProtocol({
    input: reviewInput(id),
    repository: repo,
    contracts: [id],
    attempts,
    decide: (input) => {
      seen.push({ ordinal: input.attempt.ordinal, ulid: input.attempt.entryUlids[0]! });
      const decision = decideReviewChangesRequested(input);
      if (input.attempt.ordinal !== 0) return decision;
      assert.equal(decision.kind, "offer");
      if (decision.kind !== "offer") return decision;
      const append = decision.offer.facts[0]!;
      if (append.expectedHead === undefined || append.expectedHead === null) {
        throw new Error("review offer must carry an observed journal head");
      }
      const competitor = admit(repo, {
        facts: [{
          contractId: id,
          expectedHead: append.expectedHead,
          entries: [{
            v: 1,
            kind: "review",
            contract: id,
            entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB9"),
            at: AT,
            actor: "competing-reviewer",
            data: {
              verdict: "changes-requested",
              digest: "competing-digest",
              summary: "Competing changes requested",
              evidence: [],
            },
          }],
        }],
      });
      assert.equal(competitor.kind, "accepted");
      if (competitor.kind === "accepted") competingHead = competitor.heads[id];
      return decision;
    },
  });

  assert.deepEqual(seen, [
    { ordinal: 0, ulid: attempts[0]!.entryUlids[0]! },
    { ordinal: 1, ulid: attempts[1]!.entryUlids[0]! },
  ]);
  assert.deepEqual(result, {
    kind: "refused",
    refusal: { kind: "phase-not-awaiting-verdict", contractId: id, phase: "active" },
  });
  const observed = observeContract(repo, id);
  assert.equal(observed.state?.head, competingHead);
  assert.deepEqual(observed.entries.map((entry) => entry.entry), [
    entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB9"),
  ]);
});
