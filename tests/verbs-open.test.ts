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
  type BindEntry,
  type ContractBody,
  type ContractId,
  type ContractState,
  type OpenEntry,
} from "../src/core/facts/types.js";
import { observeContract } from "../src/core/protocol/observe.js";
import { runProtocol, type AttemptContext, type DecideInput } from "../src/core/protocol/run.js";
import { decideOpen, type OpenInput } from "../src/core/verbs/open.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";
const TARGET = "refs/heads/main";
const BASE = commitOid("a".repeat(40));

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Open contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [{ executor: "bash", script: "npm test" }],
    extensions: [],
  };
}

function bind(id: ContractId, value = "01ARZ3NDEKTSV4RRFFQ69G5FAV"): BindEntry {
  return { v: 1, kind: "bind", contract: id, entry: entryUlid(value), at: AT, actor: "seed", data: body() };
}

function open(id: ContractId, value = "01ARZ3NDEKTSV4RRFFQ69G5FAW"): OpenEntry {
  return {
    v: 1,
    kind: "open",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "seed",
    data: { target: TARGET, base: BASE },
  };
}

function openInput(id: ContractId): OpenInput {
  return { contractId: id, actor: "tester", at: AT, target: TARGET, base: BASE };
}

function seed(repository: ReturnType<typeof repositoryAt>, id: ContractId, entries: readonly (BindEntry | OpenEntry)[]): void {
  const result = admit(repository, { facts: [{ contractId: id, expectedHead: null, entries }] });
  assert.equal(result.kind, "accepted");
}

test("open has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/open.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("open installs the first delivery through the real protocol", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/open-accepted");
  seed(repo, id, [bind(id)]);

  const result = runProtocol({
    input: openInput(id),
    repository: repo,
    contracts: [id],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAX")],
    decide: decideOpen,
  });

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.deepEqual(result.handoff.acceptedEntries, [{
    v: 1,
    kind: "open",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    at: AT,
    actor: "tester",
    data: { target: TARGET, base: BASE },
  }]);
  assert.deepEqual(observeContract(repo, id).state?.delivery, { target: TARGET, base: BASE, head: BASE });
});

test("open refuses a missing, non-active, or already-delivered contract without publishing", () => {
  const missingRepository = makeGitRepository();
  const missingRepo = repositoryAt(missingRepository.path);
  const missing = contractId("kei/open-missing");
  const missingResult = runProtocol({
    input: openInput(missing),
    repository: missingRepo,
    contracts: [missing],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAY")],
    decide: decideOpen,
  });
  assert.deepEqual(missingResult, { kind: "refused", refusal: { kind: "contract-missing", contractId: missing } });
  assert.equal(readRef(missingRepo, "refs/heads/keiyaku-state"), null);

  const sealedRepository = makeGitRepository();
  const sealedRepo = repositoryAt(sealedRepository.path);
  const sealed = contractId("kei/open-sealed");
  seed(sealedRepo, sealed, [bind(sealed), open(sealed)]);
  const sealedFact = admit(sealedRepo, {
    facts: [{
      contractId: sealed,
      expectedHead: observeContract(sealedRepo, sealed).state?.head ?? null,
      entries: [{
        v: 1,
        kind: "seal",
        contract: sealed,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
        at: AT,
        actor: "seed",
        data: {},
      }],
    }],
  });
  assert.equal(sealedFact.kind, "accepted");
  const sealedHead = readRef(sealedRepo, "refs/heads/keiyaku-state");
  assert.deepEqual(
    runProtocol({
      input: openInput(sealed),
      repository: sealedRepo,
      contracts: [sealed],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB0")],
      decide: decideOpen,
    }),
    { kind: "refused", refusal: { kind: "phase-not-active", contractId: sealed, phase: "sealed" } },
  );
  assert.equal(readRef(sealedRepo, "refs/heads/keiyaku-state"), sealedHead);

  const deliveredRepository = makeGitRepository();
  const deliveredRepo = repositoryAt(deliveredRepository.path);
  const delivered = contractId("kei/open-delivered");
  seed(deliveredRepo, delivered, [bind(delivered), open(delivered)]);
  const deliveredHead = readRef(deliveredRepo, "refs/heads/keiyaku-state");
  assert.deepEqual(
    runProtocol({
      input: openInput(delivered),
      repository: deliveredRepo,
      contracts: [delivered],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB1")],
      decide: decideOpen,
    }),
    { kind: "refused", refusal: { kind: "delivery-already-installed", contractId: delivered } },
  );
  assert.equal(readRef(deliveredRepo, "refs/heads/keiyaku-state"), deliveredHead);
});

test("open decision is deterministic, offers no ref operation, and requires one ULID", () => {
  const id = contractId("kei/open-pure");
  const state: ContractState = {
    id,
    head: contractHead("b".repeat(40)),
    phase: "active",
    body: body(),
    delivery: null,
    approval: null,
    petition: null,
    evidence: [],
    terminal: null,
  };
  const decisionInput: DecideInput<OpenInput> = {
    input: openInput(id),
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    observation: { carrierCommit: null, contracts: new Map([[id, { id, entries: [], state }]]) },
  };

  const first = decideOpen(decisionInput);
  const second = decideOpen(decisionInput);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    kind: "offer",
    offer: {
      facts: [{
        contractId: id,
        expectedHead: contractHead("b".repeat(40)),
        entries: [{
          v: 1,
          kind: "open",
          contract: id,
          entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
          at: AT,
          actor: "tester",
          data: { target: TARGET, base: BASE },
        }],
      }],
    },
    handoff: null,
  });
  assert.equal(first.kind, "offer");
  if (first.kind !== "offer") return;
  assert.equal(first.offer.refs, undefined);

  for (const entryUlids of [
    [],
    [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB2")],
  ]) {
    assert.throws(
      () => decideOpen({ ...decisionInput, attempt: { ordinal: 0, entryUlids } }),
      /exactly one fresh entry ULID/,
    );
  }
});
