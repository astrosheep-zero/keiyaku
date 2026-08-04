import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { admit } from "../src/core/facts/admission.js";
import { observeContract } from "../src/core/protocol/observe.js";
import { runProtocol, type AttemptContext, type DecideInput } from "../src/core/protocol/run.js";
import { contractId, entryUlid, type BindEntry, type ContractBody, type ContractId } from "../src/core/facts/types.js";
import { decideBind, type BindInput } from "../src/core/verbs/bind.js";
import { makeGitRepository } from "./support/git.js";
import { readRef, repositoryAt } from "../src/core/facts/repository.js";

const AT = "2026-08-04T00:00:00Z";

function attempt(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function body(): ContractBody {
  return {
    title: "Bind contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [{ executor: "bash", script: "npm test" }],
    extensions: [{ title: "Notes", content: "Initial notes" }],
  };
}

function bindInput(id: ContractId, contractBody: ContractBody = body()): BindInput {
  return { contractId: id, actor: "tester", at: AT, body: contractBody };
}

function competitorBind(id: ContractId, value: string): BindEntry {
  return {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid(value),
    at: AT,
    actor: "competitor",
    data: body(),
  };
}

test("bind has only type-only facts and protocol dependencies", () => {
  const path = fileURLToPath(new URL("../src/core/verbs/bind.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const imports = source.statements.filter(ts.isImportDeclaration);

  assert.deepEqual(
    imports.map((declaration) => declaration.moduleSpecifier.getText(source)),
    ["\"../facts/types.js\"", "\"../protocol/run.js\""],
  );
  assert.ok(imports.every((declaration) => declaration.importClause?.isTypeOnly));
});

test("bind accepts an absent contract through the real protocol and folds it active", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("bind-accepted");
  const input = bindInput(id);
  const result = runProtocol({
    input,
    repository: repo,
    contracts: [id],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    decide: decideBind,
  });

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.deepEqual(result.handoff.acceptedEntries.map((entry) => entry.kind), ["bind"]);
  const observed = observeContract(repo, id);
  assert.equal(observed.state?.phase, "active");
  assert.deepEqual(observed.state?.body, input.body);
});

test("bind refuses an existing contract without publishing", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("bind-existing");
  const existing = admit(repo, {
    facts: [{ contractId: id, expectedHead: null, entries: [competitorBind(id, "01ARZ3NDEKTSV4RRFFQ69G5FAW")] }],
  });
  assert.equal(existing.kind, "accepted");
  const before = readRef(repo, "refs/heads/keiyaku-state");

  const result = runProtocol({
    input: bindInput(id),
    repository: repo,
    contracts: [id],
    attempts: [attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAX")],
    decide: decideBind,
  });

  assert.deepEqual(result, {
    kind: "refused",
    refusal: { kind: "contract-already-exists", contractId: id },
  });
  assert.equal(readRef(repo, "refs/heads/keiyaku-state"), before);
});

test("bind decision is deterministic, isolates caller body containers, and requires one ULID", () => {
  const id = contractId("bind-pure");
  const mutableBody = {
    title: "Bind contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/core"],
    criteria: ["criterion"],
    verification: [{ executor: "bash" as const, script: "npm test" }],
    extensions: [{ title: "Notes", content: "Initial notes" }],
  };
  const input = bindInput(id, mutableBody);
  const decisionInput: DecideInput<BindInput> = {
    input,
    attempt: attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    observation: { carrierCommit: null, contracts: new Map([[id, { id, entries: [], state: null }]]) },
  };

  const first = decideBind(decisionInput);
  const second = decideBind(decisionInput);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "offer");
  if (first.kind !== "offer") return;
  mutableBody.region.push("tests");
  mutableBody.criteria.push("another criterion");
  mutableBody.verification[0]!.script = "changed";
  mutableBody.extensions[0]!.content = "changed";
  const offeredBody = first.offer.facts[0]!.entries[0]!.data;
  assert.deepEqual(offeredBody, body());

  assert.throws(
    () => decideBind({ ...decisionInput, attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0")] } }),
    /exactly one fresh entry ULID/,
  );
});

test("a competing bind causes the next protocol attempt to redecide and refuse", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("bind-race");
  const attempts = [
    attempt(0, "01ARZ3NDEKTSV4RRFFQ69G5FB1"),
    attempt(1, "01ARZ3NDEKTSV4RRFFQ69G5FB2"),
  ];
  const seenAttempts: string[] = [];
  const result = runProtocol({
    input: bindInput(id),
    repository: repo,
    contracts: [id],
    attempts,
    decide: (input) => {
      seenAttempts.push(input.attempt.entryUlids[0]!);
      const decision = decideBind(input);
      if (input.attempt.ordinal === 0) {
        const competitor = admit(repo, {
          facts: [{ contractId: id, expectedHead: null, entries: [competitorBind(id, "01ARZ3NDEKTSV4RRFFQ69G5FB3")] }],
        });
        assert.equal(competitor.kind, "accepted");
      }
      return decision;
    },
  });

  assert.deepEqual(seenAttempts, attempts.map((candidate) => candidate.entryUlids[0]!));
  assert.deepEqual(result, {
    kind: "refused",
    refusal: { kind: "contract-already-exists", contractId: id },
  });
  const observed = observeContract(repo, id);
  assert.equal(observed.entries.length, 1);
  assert.equal(observed.entries[0]?.entry, entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB3"));
});
