import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { decodeContractDocument, verificationDefinition } from "../src/body/decode.js";
import { repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { contractId, entryUlid, gate } from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import { verifyDelivery } from "../src/protocol/intent.js";
import { auditOperation } from "../src/protocol/audit.js";
import { admitDeliveryOperation } from "../src/protocol/deliver.js";
import { scopeOperation } from "../src/protocol/operations.js";
import { observeContractAt } from "../src/git/observe.js";
import { prepareVerificationDeclaration } from "../src/verification/declaration.js";
import { appointedWorktreePath, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";

function verificationBody(script: string | null = "exit 1"): string {
  return contractMarkdown("Audit", {
    Context: "Exercise the audit reader.",
    Objective: "Keep reports derived and compact.",
    Design: "Run the stored Verification.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: [
      "### Audit",
      "The report follows the journal.",
      ...(script === null ? [] : ["", "## Verification", "~~~bash timeout=5m", script, "~~~"]),
      "",
    ].join("\n"),
  });
}

async function failedStoredVerification(): Promise<
  Readonly<{
    repository: TestGitRepository;
    contract: Keiyaku;
    state: Awaited<ReturnType<Keiyaku["state"]>>;
  }>
> {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(),
    workspace: "worktree",
    gates: ["verified"],
  });
  const boundState = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), boundState.id);
  writeFileSync(`${worktree}/candidate.txt`, "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await bound.keiyaku.deliver();
  const state = await bound.keiyaku.state();
  assert.equal(state.attestations.at(-1)?.data.verdict, "unsatisfied");
  assert.equal(state.attestations.at(-1)?.data.summary, "[1 bash exit 1]");
  return { repository, contract: bound.keiyaku, state };
}

test("a stale document derivation is refused inside its E-decision", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(null),
    workspace: "worktree",
  });
  const state = await bound.keiyaku.state();
  const decoded = decodeContractDocument(state.terms.document.bytes);
  const derivation = {
    document: decoded.document.key,
    bytes: state.terms.document.bytes,
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
    assert.deepEqual(
      await admitDeliveryOperation({
        scope,
        channel,
        contractId: state.id,
        deriveDocument: () => derivation,
        requireBranchesToBeUpToDate: false,
        includeDirty: false,
        materializeConflict: false,
      }),
      { kind: "refused", refusal },
    );
    assert.deepEqual(
      await auditOperation({
        scope,
        channel,
        contractId: state.id,
        deriveDocument: () => derivation,
      }),
      { kind: "refused", refusal },
    );
  });
});

test("audit without Verification still returns an accepted ready candidate", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(null),
    workspace: "worktree",
  });

  const scope = await scopeOperation({ coordinate: repository.path });
  const contractId = (await bound.keiyaku.state()).id;
  const observed = await withGitDecodeChannel(scope, (channel) => observeContractAt(scope, channel, contractId));
  const decoded = decodeContractDocument(observed.state!.terms.document.bytes);
  const result = await withGitDecodeChannel(scope, (channel) =>
    auditOperation({
      scope,
      channel,
      contractId,
      deriveDocument: () => ({
        document: decoded.document.key,
        bytes: decoded.document.bytes,
        title: decoded.title,
        verification: prepareVerificationDeclaration({
          gates: observed.state!.terms.gates,
          definition: verificationDefinition(decoded),
          contractId,
        }),
      }),
    }),
  );
  assert.ok(result.kind === "accepted", "expected result.kind = \"accepted\"");
  assert.deepEqual(result.facts, []);
  assert.equal(result.head, observed.state!.head);
  assert.ok(result.value.candidate.kind === "ready", "expected result.value.candidate.kind = \"ready\"");
  assert.equal(result.value.candidate.identity.method, "squash");
  assert.equal("diff" in result.value.candidate, false);
  assert.equal(result.value.verification.kind, "not-run");
  assert.equal(result.value.target.kind, "not-observed");
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
  const git = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(git, (channel) =>
    verifyDelivery({
      channel,
      repository: git,
      contractId: state.id,
      at: "2026-08-06T00:00:03.000Z",
      state: { ...state, attestations: [...state.attestations, unrelated] },
      verification: definition,
    }),
  );
  assert.ok(result !== null);
  if (!("kind" in result.step)) throw new Error("verification did not return a protocol result");
  assert.equal(result.step.kind, "accepted");
});

// Test declaration admission at its owner, without binding two complete worktrees.
test("verified terms require a declaration at both unbound and identified boundaries", () => {
  for (const id of [undefined, contractId("verify-boundary")]) {
    assert.deepEqual(prepareVerificationDeclaration({ gates: [gate("verified")], definition: null, ...(id === undefined ? {} : { contractId: id }) }), {
      kind: "refused",
      refusal: { kind: "verification-declaration-invalid", ...(id === undefined ? {} : { contractId: id }) },
    });
    assert.deepEqual(prepareVerificationDeclaration({ gates: [gate("reviewed")], definition: null, ...(id === undefined ? {} : { contractId: id }) }), {
      kind: "prepared", data: null,
    });
  }
});
