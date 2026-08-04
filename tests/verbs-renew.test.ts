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
  type RenewEntry,
  type SealEntry,
} from "../src/core/facts/types.js";
import { observeContract } from "../src/core/protocol/observe.js";
import { runProtocol, type AttemptContext, type DecideInput } from "../src/core/protocol/run.js";
import { decideRenew, type RenewInput } from "../src/core/verbs/renew.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";
const TARGET = "refs/heads/main";
const BASE = commitOid("a".repeat(40));
const OLD_HEAD = commitOid("b".repeat(40));
const NEW_BASE = commitOid("c".repeat(40));
const NEW_HEAD = commitOid("d".repeat(40));

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Renew contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [{ executor: "bash", script: "npm test" }],
    extensions: [],
  };
}

function bind(id: ContractId): BindEntry {
  return { v: 1, kind: "bind", contract: id, entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"), at: AT, actor: "seed", data: body() };
}

function open(id: ContractId): OpenEntry {
  return {
    v: 1,
    kind: "open",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    at: AT,
    actor: "seed",
    data: { target: TARGET, base: BASE },
  };
}

function seal(id: ContractId): SealEntry {
  return { v: 1, kind: "seal", contract: id, entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"), at: AT, actor: "seed", data: {} };
}

function renewInput(id: ContractId, oldHead = BASE): RenewInput {
  return { contractId: id, actor: "tester", at: AT, newBase: NEW_BASE, oldHead, newHead: NEW_HEAD };
}

function seed(repository: ReturnType<typeof repositoryAt>, id: ContractId, entries: readonly (BindEntry | OpenEntry | SealEntry)[]): void {
  const result = admit(repository, { facts: [{ contractId: id, expectedHead: null, entries }] });
  assert.equal(result.kind, "accepted");
}

test("renew has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/renew.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("renew from sealed preserves target and records new base and head", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/renew-accepted");
  seed(repo, id, [bind(id), open(id), seal(id)]);

  const result = runProtocol({
    input: renewInput(id),
    repository: repo,
    contracts: [id],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAY")],
    decide: decideRenew,
  });

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.deepEqual(result.handoff.acceptedEntries, [{
    v: 1,
    kind: "renew",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    at: AT,
    actor: "tester",
    data: { newBase: NEW_BASE, oldHead: BASE, newHead: NEW_HEAD },
  }]);
  const state = observeContract(repo, id).state;
  assert.equal(state?.phase, "active");
  assert.deepEqual(state?.delivery, { target: TARGET, base: NEW_BASE, head: NEW_HEAD });
});

test("renew refuses missing, non-sealed, and stale delivery heads without publishing", () => {
  const missingRepository = makeGitRepository();
  const missingRepo = repositoryAt(missingRepository.path);
  const missing = contractId("kei/renew-missing");
  assert.deepEqual(
    runProtocol({
      input: renewInput(missing),
      repository: missingRepo,
      contracts: [missing],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAZ")],
      decide: decideRenew,
    }),
    { kind: "refused", refusal: { kind: "contract-missing", contractId: missing } },
  );
  assert.equal(readRef(missingRepo, "refs/heads/keiyaku-state"), null);

  const activeRepository = makeGitRepository();
  const activeRepo = repositoryAt(activeRepository.path);
  const active = contractId("kei/renew-active");
  seed(activeRepo, active, [bind(active), open(active)]);
  const activeHead = readRef(activeRepo, "refs/heads/keiyaku-state");
  assert.deepEqual(
    runProtocol({
      input: renewInput(active),
      repository: activeRepo,
      contracts: [active],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB0")],
      decide: decideRenew,
    }),
    { kind: "refused", refusal: { kind: "phase-not-sealed", contractId: active, phase: "active" } },
  );
  assert.equal(readRef(activeRepo, "refs/heads/keiyaku-state"), activeHead);

  const staleRepository = makeGitRepository();
  const staleRepo = repositoryAt(staleRepository.path);
  const stale = contractId("kei/renew-stale");
  seed(staleRepo, stale, [bind(stale), open(stale), seal(stale)]);
  const staleHead = readRef(staleRepo, "refs/heads/keiyaku-state");
  const wrongOldHead = commitOid("e".repeat(40));
  assert.deepEqual(
    runProtocol({
      input: renewInput(stale, wrongOldHead),
      repository: staleRepo,
      contracts: [stale],
      attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB2")],
      decide: decideRenew,
    }),
    {
      kind: "refused",
      refusal: { kind: "delivery-head-mismatch", contractId: stale, oldHead: wrongOldHead, observedHead: BASE },
    },
  );
  assert.equal(readRef(staleRepo, "refs/heads/keiyaku-state"), staleHead);
});

test("renew decision is deterministic, offers no ref operation, and requires one ULID", () => {
  const id = contractId("kei/renew-pure");
  const state: ContractState = {
    id,
    head: contractHead("f".repeat(40)),
    phase: "sealed",
    body: body(),
    delivery: { target: TARGET, base: BASE, head: OLD_HEAD },
    approval: null,
    petition: null,
    evidence: [],
    terminal: null,
  };
  const decisionInput: DecideInput<RenewInput> = {
    input: renewInput(id, OLD_HEAD),
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB3"),
    observation: { carrierCommit: null, contracts: new Map([[id, { id, entries: [], state }]]) },
  };

  const first = decideRenew(decisionInput);
  const second = decideRenew(decisionInput);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    kind: "offer",
    offer: {
      facts: [{
        contractId: id,
        expectedHead: contractHead("f".repeat(40)),
        entries: [{
          v: 1,
          kind: "renew",
          contract: id,
          entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB3"),
          at: AT,
          actor: "tester",
          data: { newBase: NEW_BASE, oldHead: OLD_HEAD, newHead: NEW_HEAD },
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
    [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB4"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB5")],
  ]) {
    assert.throws(
      () => decideRenew({ ...decisionInput, attempt: { ordinal: 0, entryUlids } }),
      /exactly one fresh entry ULID/,
    );
  }
});
