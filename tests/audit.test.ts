import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo, type KeiyakuRefusal } from "../src/index.js";
import { decodeContractDocument, verificationDefinition } from "../src/body/decode.js";
import { repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { entryUlid, gate } from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import { verifyDelivery } from "../src/protocol/intent.js";
import { auditOperation, deliverOperation, scopeOperation } from "../src/protocol/operations.js";
import { observeContractAt } from "../src/git/observe.js";
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


async function failedStoredVerification(): Promise<Readonly<{
  repository: TestGitRepository;
  contract: Keiyaku;
  state: Awaited<ReturnType<Keiyaku["state"]>>;
}>> {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: verificationBody(), workspace: "here", gates: ["verified"] });
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
    Keiyaku.bind({ repo: await Repo.at({ path: repository.path }),
      markdown: verificationBody(null),
      workspace: "here",
      gates: ["verified"],
    }),
    refused({ kind: "verification-declaration-invalid" }),
  );
});

test("an active amend cannot admit verified terms without a Verification declaration", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: verificationBody(null), workspace: "here" });
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
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: verificationBody(null), workspace: "here" });
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

test("a stale document derivation is refused inside its E-decision", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: verificationBody(null), workspace: "here" });
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
  await bound.keiyaku.amend({ markdown: "## Replace: Objective\nA newer document.\n\n" });
  const scope = await scopeOperation({ coordinate: repository.path });
  const refusal = { kind: "document-moved", contractId: state.id };

  await withGitDecodeChannel(scope, async (channel) => {
    assert.deepEqual(await deliverOperation({
      scope,
      channel,
      contractId: state.id,
      deriveDocument: () => derivation,
      requireBranchesToBeUpToDate: false,
    }), { kind: "refused", refusal });
    assert.deepEqual(await auditOperation({
      scope,
      channel,
      contractId: state.id,
      deriveDocument: () => derivation,
    }), { kind: "refused", refusal });
  });
});

test("audit without Verification still returns an accepted ready candidate", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(null),
    workspace: "here",
  });

  const scope = await scopeOperation({ coordinate: repository.path });
  const contractId = (await bound.keiyaku.state()).id;
  const observed = await withGitDecodeChannel(scope, (channel) => observeContractAt(scope, channel, contractId));
  const decoded = decodeContractDocument(observed.state!.terms.document.bytes);
  const result = await withGitDecodeChannel(scope, (channel) => auditOperation({
    scope,
    channel,
    contractId,
    deriveDocument: () => ({
      document: decoded.document.key,
      title: decoded.title,
      verification: prepareVerificationDeclaration({
        gates: observed.state!.terms.gates,
        definition: verificationDefinition(decoded),
        contractId,
      }),
    }),
  }));
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts, []);
  assert.equal(result.head, observed.state!.head);
  assert.equal(result.value.candidate.kind, "ready");
  if (result.value.candidate.kind !== "ready") return;
  assert.equal(result.value.candidate.identity.method, "squash");
  assert.equal("diff" in result.value.candidate, false);
  assert.equal(result.value.verification.kind, "not-run");
  assert.equal(result.value.target.kind, "not-observed");
});

test("audit accepts an attestation refusal as a stopped answer without facts", async () => {
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
  assert.equal(result.value.candidate.kind, "ready");
  assert.deepEqual(result.value.verification, {
    kind: "stopped",
    stop: { refusal: { kind: "terminal", contractId: (await contract.state()).id } },
  });
  assert.equal(result.value.target.kind, "not-observed");
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

  const git = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(git, (channel) => verifyDelivery({
    channel,
    repository: git,
    contractId: state.id,
    at: "2026-08-06T00:00:03.000Z",
    state: { ...state, attestations: [...state.attestations, unrelated] },
    verification: definition,
    environment: {},
  }));
  assert.equal(result?.step.kind, "accepted");
});
