import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo, type KeiyakuRefusal } from "../src/index.js";
import { decodeContractDocument, verificationDefinition } from "../src/body/decode.js";
import { repositoryAt } from "../src/git/repository.js";
import { entryUlid, gate } from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import { verifyDelivery } from "../src/protocol/intent.js";
import { auditOperation, deliverOperation, scopeOperation, type AuditReport } from "../src/protocol/operations.js";
import { readAudit } from "../src/protocol/read/audit.js";
import { produceVerification, type VerificationOutcome } from "../src/verification/producer.js";
import { prepareVerificationDeclaration } from "../src/verification/declaration.js";
import { makeGitRepository, type TestGitRepository } from "./support/git.js";

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function refused(expected: KeiyakuRefusal): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof KeiyakuRefused);
    assert.deepEqual(error.refusal, expected);
    return true;
  };
}

function verificationBody(script: string | null = "exit 1"): string {
  return [
    "# Audit",
    "",
    "## Context",
    "Exercise the audit reader.",
    "",
    "## Objective",
    "Keep reports derived and compact.",
    "",
    "## Design",
    "Run the stored Verification.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Audit",
    "The report follows the journal.",
    ...(script === null ? [] : ["", "## Verification", "~~~bash", script, "~~~"]),
    "",
  ].join("\n");
}

function failureOutcome(failure: NonNullable<AuditReport["attempt"]>["failure"]): VerificationOutcome {
  return failure === "spawn-error"
    ? { kind: failure, diagnostic: "spawn failed" }
    : { kind: failure };
}

async function failedStoredVerification(): Promise<Readonly<{
  repository: TestGitRepository;
  contract: Keiyaku;
  state: Awaited<ReturnType<Keiyaku["state"]>>;
}>> {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: verificationBody(), workspace: "here", gates: ["verified"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const delivered = await bound.keiyaku.deliver();
  const state = await bound.keiyaku.state();
  assert.equal(state.attestations.at(-1)?.data.verdict, "unsatisfied");
  assert.equal(state.attestations.at(-1)?.data.summary, "[1 bash exit 1]");
  return { repository, contract: bound.keiyaku, state };
}

test("a verified placement gate without a Verification declaration is refused at bind", async () => {
  const repository = repositoryWithMain();
  await assert.rejects(
    Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
      markdown: verificationBody(null),
      workspace: "here",
      gates: ["verified"],
    }),
    refused({ kind: "verification-declaration-invalid" }),
  );
});

test("an active amend cannot admit verified terms without a Verification declaration", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: verificationBody(null), workspace: "here" });
  const before = await bound.keiyaku.state();

  await assert.rejects(
    bound.keiyaku.amend({
      markdown: "## Replace: Objective\nKeep declaration admission at the document edge.\n\n",
      gates: ["verified"],
    }),
    refused({ kind: "verification-declaration-invalid", contractId: before.id }),
  );

  const after = await bound.keiyaku.state();
  assert.equal(after.head, before.head);
  assert.deepEqual(after.terms, before.terms);
});

test("terminal amend refusal outranks a missing Verification declaration", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: verificationBody(null), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  await bound.keiyaku.abandon();

  await assert.rejects(
    bound.keiyaku.amend({
      markdown: "## Replace: Objective\nNo longer actionable.\n\n",
      gates: ["verified"],
    }),
    refused({ kind: "terminal", contractId: id }),
  );
});

test("amend between document derivation and attempt returns document-moved", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: verificationBody(null), workspace: "here" });
  const state = await bound.keiyaku.state();
  const decoded = decodeContractDocument(state.terms.document.bytes);
  const derivation = {
    document: decoded.document.key,
    title: decoded.title,
    verification: prepareVerificationDeclaration({
      gates: [gate("verified")],
      definition: verificationDefinition(decoded),
      contractId: state.id,
    }),
  };
  const amended = await bound.keiyaku.amend({ markdown: "## Replace: Objective\nA newer document.\n\n" });
  const scope = scopeOperation({ coordinate: repository.path });
  const refusal = { kind: "document-moved", contractId: state.id };

  assert.deepEqual(await deliverOperation({ scope, contractId: state.id, derivation }), { kind: "refused", refusal });
  assert.deepEqual(await auditOperation({ scope, contractId: state.id, derivation }), { kind: "refused", refusal });
});

test("read-only audit returns its initial observation when verification is skipped", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: verificationBody(null),
    workspace: "here",
  });

  const scope = scopeOperation({ coordinate: repository.path });
  const contractId = (await bound.keiyaku.state()).id;
  const initial = readAudit(scope, contractId, gate("reviewed"));
  const decoded = decodeContractDocument(initial.state!.terms.document.bytes);
  const pending = auditOperation({
    scope,
    contractId,
    derivation: {
      document: decoded.document.key,
      title: decoded.title,
      verification: prepareVerificationDeclaration({
        gates: initial.state!.terms.gates,
        definition: verificationDefinition(decoded),
        contractId,
      }),
    },
  });
  const amendment = new Promise<void>((resolve, reject) => {
    process.nextTick(() => {
      void bound.keiyaku.amend({ markdown: [
        "## Replace: Objective",
        "Keep the original audit observation.",
        "",
      ].join("\n") }).then((result) => {
        try {
          resolve();
        } catch (error) {
          reject(error);
        }
      }, reject);
    });
  });

  const result = await pending;
  await amendment;
  assert.deepEqual(result.value, initial.report);
  assert.deepEqual(result.facts, []);
  assert.equal(result.head, initial.state.head);
  assert.notDeepEqual(readAudit(scope, contractId, gate("reviewed")).report, initial.report);
});

test("stored Verification maps every nonterminal producer outcome to an audit attempt without admission", async () => {
  for (const failure of ["timeout", "spawn-error", "unknown-exit"] as const) {
    const { repository, contract, state } = await failedStoredVerification();
    const before = state.attestations.length;
    const result = await verifyDelivery({
      repository: repositoryAt(repository.path),
      contractId: state.id,
      at: "2026-08-06T00:00:00.000Z",
      state,
      verification: verificationDefinition(decodeContractDocument(state.terms.document.bytes))!,
      environment: {},
      produce: async () => failureOutcome(failure),
    });
    const step = failure === "spawn-error"
      ? { failure, diagnostic: "spawn failed" }
      : { failure };
    assert.deepEqual(result, { step });
    assert.equal((await contract.state()).attestations.length, before);
  }
});

test("audit accepts an attestation refusal as a typed attempt without facts", async () => {
  const { contract } = await failedStoredVerification();
  const amended = await contract.amend({ markdown: [
    "## Replace: Verification",
    "~~~bash",
    "sleep 0.2",
    "~~~",
    "",
  ].join("\n") });

  const pending = contract.audit();
  const abandoned = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void contract.abandon().then((result) => {
        try {
          resolve();
        } catch (error) {
          reject(error);
        }
      }, reject);
    }, 20);
  });
  const result = await pending;
  await abandoned;
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.value.attempt, {
    refusal: { kind: "terminal", contractId: (await contract.state()).id },
  });
});

test("audit admits Verification testimony for its captured old subject", async () => {
  const { contract } = await failedStoredVerification();
  const delayed = await contract.amend({ markdown: [
    "## Replace: Verification",
    "~~~bash",
    "sleep 0.2",
    "~~~",
    "",
  ].join("\n") });
  const state = await contract.state();
  const definition = verificationDefinition(decodeContractDocument(state.terms.document.bytes));
  if (state.delivery === null || definition === null) throw new Error("audit inputs are absent");

  const pending = contract.audit();
  const amended = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void contract.amend({ markdown: [
        "## Replace: Verification",
        "~~~bash",
        "exit 0",
        "~~~",
        "",
      ].join("\n") }).then((result) => {
        try {
          resolve();
        } catch (error) {
          reject(error);
        }
      }, reject);
    }, 20);
  });
  const audited = await pending;
  await amended;
  assert.deepEqual(audited.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal((await contract.state()).attestations.at(-1)?.data.subject, dependencyKeySet([
    { kind: "snapshot", value: state.delivery.data.integration.snapshot },
    { kind: "segment", value: definition.segment },
  ]));
});

test("stored Verification records a result captured before its declaration changes", async () => {
  const { repository, contract, state } = await failedStoredVerification();
  const before = state.attestations.length;
  const result = await verifyDelivery({
    repository: repositoryAt(repository.path),
    contractId: state.id,
    at: "2026-08-06T00:00:00.000Z",
    state,
    verification: verificationDefinition(decodeContractDocument(state.terms.document.bytes))!,
    environment: {},
    produce: async (input) => {
      const amended = await contract.amend({ markdown: [
        "## Replace: Verification",
        "~~~bash",
        "exit 0",
        "~~~",
        "",
      ].join("\n") });
      return produceVerification(input);
    },
  });
  assert.equal(result?.step.kind, "accepted");
  assert.equal((await contract.state()).attestations.length, before + 1);
});

test("Verification runs a valid declaration even after prior testimony", async () => {
  const { repository, contract, state } = await failedStoredVerification();
  const definition = verificationDefinition(decodeContractDocument(state.terms.document.bytes))!;
  const before = state.attestations.length;
  let executions = 0;
  const produce = async () => {
    executions += 1;
    return { kind: "terminal", verdict: "satisfied" } as const;
  };

  const result = await verifyDelivery({
    repository: repositoryAt(repository.path),
    contractId: state.id,
    at: "2026-08-06T00:00:00.000Z",
    state,
    environment: {},
    produce,
    verification: definition,
  });
  assert.equal(executions, 1);
  assert.equal(result?.step.kind, "accepted");
  assert.equal((await contract.state()).attestations.length, before + 1);
  assert.equal((await contract.state()).attestations.at(-1)?.data.subject, dependencyKeySet([
    { kind: "snapshot", value: state.delivery!.data.integration.snapshot },
    { kind: "segment", value: definition.segment },
  ]));
});

test("Verification reuse requires its exact producer subject", async () => {
  const { repository, state } = await failedStoredVerification();
  const definition = verificationDefinition(decodeContractDocument(state.terms.document.bytes))!;
  const unrelated = {
    ...state.attestations.at(-1)!,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAE"),
    data: {
      gate: gate("verified"),
      subject: dependencyKeySet([{ kind: "document", value: state.terms.document.key }]),
      verdict: "satisfied" as const,
    },
  };
  let executions = 0;

  const result = await verifyDelivery({
    repository: repositoryAt(repository.path),
    contractId: state.id,
    at: "2026-08-06T00:00:03.000Z",
    state: { ...state, attestations: [...state.attestations, unrelated] },
    verification: definition,
    environment: {},
    produce: async () => {
      executions += 1;
      return { kind: "timeout" };
    },
  });

  assert.equal(executions, 1);
  assert.deepEqual(result, { step: { failure: "timeout" } });
});
