import { present } from "./support/library-verbs.js";
import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo } from "../src/index.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { singletonRequirement } from "../src/verification/declaration.js";
import { gate, type ContractId } from "../src/core/facts/types.js";
import { admitDecidedOffer, mintAttempt } from "../src/protocol/attempt.js";
import { admitIntent } from "../src/protocol/intent.js";
import { observeContractsAt } from "../src/git/observe.js";
import { withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";

import { withGitDecodeChannel } from "../src/git/read-observation.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  observeContract,
  snapshotGitRepository,
  type TestGitRepository,
  withGitShim,
} from "./support/git.js";
import {
  acceptedDelivery,
  managedCandidate,
  repositoryWithMain,
  TARGET_PLACEMENT_FILES,
} from "./support/library-verbs.js";

const caseInsensitiveCheckout = (() => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-case-probe-"));
  try {
    writeFileSync(join(directory, "probe"), "x");
    return lstatSync(join(directory, "PROBE")).isFile();
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

type ManagedCandidateTemplate = Readonly<{
  repository: TestGitRepository;
  id: ContractId;
  candidateHead: string;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

const TEMPLATE_CANDIDATE_REF = "refs/heads/keiyaku-test-template-candidate";
const ordinaryCandidateTemplates = new Map<string, Promise<ManagedCandidateTemplate>>();
let claimedUnfollowedCandidateTemplate: Promise<ManagedCandidateTemplate> | undefined;

function captureManagedCandidateTemplate(
  repository: TestGitRepository,
  candidate: Awaited<ReturnType<typeof managedCandidate>>,
): ManagedCandidateTemplate {
  const candidateHead = repository.run(["-C", candidate.path, "rev-parse", "HEAD"]).trim();
  const generatedFiles = captureWorktreeFiles(candidate.path, [".keiyaku/.gitignore", ".keiyaku/KEIYAKU.md"]);
  repository.run(["update-ref", TEMPLATE_CANDIDATE_REF, candidateHead]);
  repository.run(["worktree", "remove", "--force", candidate.path]);
  return { repository, id: candidate.id, candidateHead, generatedFiles };
}

async function buildOrdinaryCandidateTemplate(gates: readonly string[]): Promise<ManagedCandidateTemplate> {
  const repository = repositoryWithMain({ files: TARGET_PLACEMENT_FILES });
  const candidate = await managedCandidate(repository, gates);
  return captureManagedCandidateTemplate(repository, candidate);
}

function ordinaryCandidateTemplateKey(gates: readonly string[]): string {
  if (gates.length === 0) return "default";
  if (gates.length === 1 && gates[0] === "reviewed") return "reviewed";
  throw new Error(`unexpected ordinary candidate gates: ${JSON.stringify(gates)}`);
}

function ordinaryCandidateTemplate(gates: readonly string[] = []): Promise<ManagedCandidateTemplate> {
  const key = ordinaryCandidateTemplateKey(gates);
  const existing = ordinaryCandidateTemplates.get(key);
  if (existing !== undefined) return existing;
  const template = buildOrdinaryCandidateTemplate(gates);
  ordinaryCandidateTemplates.set(key, template);
  return template;
}

async function buildClaimedUnfollowedCandidateTemplate(): Promise<ManagedCandidateTemplate> {
  const candidate = await candidateFixture(await ordinaryCandidateTemplate(["reviewed"]));
  await admitClaimWithoutFollow(candidate.repository, candidate.contract);
  return captureManagedCandidateTemplate(candidate.repository, candidate);
}

async function candidateFixture(template: ManagedCandidateTemplate) {
  const repository = snapshotGitRepository(template.repository);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), template.id);
  repository.run(["worktree", "add", "--quiet", "--detach", worktree, template.candidateHead]);
  restoreWorktreeFiles(worktree, template.generatedFiles);
  repository.run(["update-ref", "-d", TEMPLATE_CANDIDATE_REF]);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keis.of(repo).kei({ id: template.id });
  return { repository, contract, id: template.id, path: worktree };
}

async function ordinaryCandidateFixture(gates: readonly string[] = []) {
  return await candidateFixture(await ordinaryCandidateTemplate(gates));
}

async function claimedUnfollowedCandidateFixture() {
  return await candidateFixture(
    await (claimedUnfollowedCandidateTemplate ??= buildClaimedUnfollowedCandidateTemplate()),
  );
}

async function admitClaimWithoutFollow(
  repository: TestGitRepository,
  contract: Awaited<ReturnType<typeof managedCandidate>>["contract"],
): Promise<void> {
  await contract.deliver({ includeDirty: true });
  await contract.review({ verdict: "unsatisfied", summary: "Checkout review found an issue" });
  const git = await cachedRepositoryAt(repository.path);
  const contractId = present(await contract.state()).id;
  const state = (await observeContract(git, contractId)).state;
  const subject = state?.attestations.at(-1)?.data.subject;
  assert.ok(subject);
  await withGitDecodeChannel(git, async (channel) => {
    const attested = await admitIntent(
      channel,
      git,
      {
        contractId,
        at: new Date().toISOString(),
        preparation: {
          kind: "prepared" as const,
          data: {
            gate: gate("reviewed"),
            requirement: singletonRequirement(gate("reviewed")),
            subject,
            verdict: "satisfied" as const,
          },
        },
      },
      decideAttestation<never>,
      { attempt: mintAttempt() },
    );
    assert.equal(attested.kind, "accepted");

    const admitted = (
      await withPrivateStatePublicationSeat(git, async (seat) => {
        const observation = await observeContractsAt(git, channel, [contractId]);
        const attempt = mintAttempt(2);
        const decision = decidePlacement({
          input: { contractId, at: new Date().toISOString() },
          attempt,
          observation: observation.decision,
        });
        assert.equal(decision.kind, "offer");
        if (decision.kind !== "offer") assert.fail("expected placement offer");
        return await admitDecidedOffer({
          scope: git,
          channel,
          contractId,
          seat,
          observation,
          attempt,
          offer: decision.offer,
        });
      })
    ).value;
    assert.equal(admitted.kind, "accepted");
  });
}

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("target-checkout-reconcile isolated repositories", { concurrency: 4 }, () => {
  test("claimed target observation is current at integration and drifts after rewind", async () => {
    const { repository, contract } = await ordinaryCandidateFixture();
    await contract.deliver();
    const delivery = present(await contract.state()).delivery?.data;
    if (delivery === undefined) throw new Error("delivery was not recorded");
    const repo = await cachedRepoAt(repository.path);
    const contractId = present(await contract.state()).id;
    const placed = await Keis.of(repo).observe({ id: contractId });
    assert.equal(placed.kind, "contract");
    assert.equal(placed.targetObservation, undefined);

    repository.run(["reset", "--hard", delivery.integration.predecessor]);
    const rewound = await Keis.of(repo).observe({ id: contractId });
    assert.equal(rewound.kind, "contract");
    assert.deepEqual(rewound.targetObservation, {
      kind: "moved",
      before: delivery.integration.snapshot,
      after: delivery.integration.predecessor,
    });
    const retry = await Keis.of(repo).reconcile({ contract: contractId });
    assert.equal(retry.kind, "contract");
    assert.ok(!retry.effects?.some((effect) => effect.kind === "target-checkout"));
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivery.integration.predecessor);
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");
  });

  test("an operational follow failure leaves checkout bytes and a foreign index lock untouched", async () => {
    const { repository, contract } = await ordinaryCandidateFixture();
    const index = readFileSync(resolve(repository.path, ".git", "index"));
    const lock = resolve(repository.path, ".git", "index.lock");
    writeFileSync(lock, "foreign writer\n");
    try {
      const delivered = acceptedDelivery(await contract.deliver());
      assert.equal(delivered.placement?.kind, "placed");
      assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
      assert.deepEqual(
        (delivered.issues ?? [])
          .filter((issue) => issue.kind === "target-checkout-retained")
          .map(({ path, target }) => ({ path, target })),
        [{ path: repository.path, target: "refs/heads/main" }],
      );
      assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");
      assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);
      assert.equal(readFileSync(lock, "utf8"), "foreign writer\n");
      const observed = await observeContract(
        await cachedRepositoryAt(repository.path),
        present(await contract.state()).id,
      );
      assert.equal(observed.state?.terminal?.kind, "claimed");
    } finally {
      rmSync(lock);
    }
  });

  test("reconcile completes an ordinary follow interrupted after atomic publication", async () => {
    const candidate = await claimedUnfollowedCandidateFixture();
    const { repository } = candidate;
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");

    const contracts = Keis.of(await Repo.at({ path: repository.path }));
    const reconciled = await contracts.reconcile({ contract: candidate.id });
    assert.ok(reconciled.kind === "contract");
    assert.equal((reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"), false);
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
    assert.equal(repository.run(["status", "--porcelain"]), "");
    assert.deepEqual(reconciled.effects?.filter((effect) => effect.kind === "target-checkout"), [
      { kind: "target-checkout", path: repository.path, target: "refs/heads/main" },
    ]);

    const index = readFileSync(resolve(repository.path, ".git", "index"));
    const retry = await contracts.reconcile({ contract: candidate.id });
    assert.ok(retry.kind === "contract");
    assert.ok(!retry.effects?.some((effect) => effect.kind === "target-checkout"));
    assert.ok(!retry.issues?.some((issue) => issue.kind === "target-checkout-retained"));
    assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);
  });

  test("a relevant staged change after classification fails into lag without overwriting it", async () => {
    const candidate = await claimedUnfollowedCandidateFixture();
    const { repository } = candidate;
    const delivery = (await observeContract(await cachedRepositoryAt(repository.path), candidate.id)).state?.delivery
      ?.data;
    assert.ok(delivery);
    const marker = resolve(repository.path, ".git", "recovery-relevant-stage.marker");
    const stagedBytes = "relevant concurrent stage\n";
    const expectedBlob = repository.run(["hash-object", "-w", "--stdin"], stagedBytes).trim();
    const reconciled = await withGitShim(
      [
        'if [ "$1" = "-C" ]; then',
        "  shift",
        '  cd "$1" || exit $?',
        "  shift",
        "fi",
        'if [ "$1 $2 $3" = "read-tree -m -u" ] && [ "$4" != "--dry-run" ] && [ ! -e "$KEIYAKU_RECOVERY_RELEVANT_STAGE" ]; then',
        '  printf "%s" "$KEIYAKU_STAGED_BYTES" > "$KEIYAKU_RELEVANT_PATH"',
        '  "$KEIYAKU_REAL_GIT" add -- "$KEIYAKU_RELEVANT_PATH" || exit $?',
        '  touch "$KEIYAKU_RECOVERY_RELEVANT_STAGE"',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {
        KEIYAKU_RECOVERY_RELEVANT_STAGE: marker,
        KEIYAKU_RELEVANT_PATH: resolve(repository.path, "delivered.txt"),
        KEIYAKU_STAGED_BYTES: stagedBytes,
      },
      async (gitPath) =>
        Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({
          contract: candidate.id,
        }),
    );
    assert.ok(reconciled.kind === "contract");

    const stage = repository.run(["ls-files", "--stage", "--", "delivered.txt"]).trim().split(/\s+/u);
    assert.ok((reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.ok(!(reconciled.effects ?? []).some((effect) => effect.kind === "target-checkout"));
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), stagedBytes);
    assert.equal(stage[1], expectedBlob);
    assert.equal(
      repository.run(["status", "--porcelain", "--untracked-files=no", "--", "delivered.txt"]),
      "M  delivered.txt\n",
    );
  });

  test("disjoint untracked content does not retain an otherwise exact predecessor", async () => {
    const { repository, contract, id } = await ordinaryCandidateFixture();
    const predecessor = repository.run(["rev-parse", "refs/heads/main"]).trim();
    writeFileSync(resolve(repository.path, "notes.txt"), "unrelated untracked\n");

    const preview = await contract.previewDelivery();
    assert.equal(preview.kind, "ready");
    assert.equal(preview.target?.kind, "placeable");
    assert.equal(preview.target.checkouts, undefined);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), predecessor);

    const delivered = acceptedDelivery(await contract.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.ok(!(delivered.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
    assert.equal(repository.run(["show", ":delivered.txt"]), "candidate\n");
    assert.equal(readFileSync(resolve(repository.path, "notes.txt"), "utf8"), "unrelated untracked\n");
    assert.equal(repository.run(["status", "--porcelain"]), "?? notes.txt\n");

    const reconciled = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: id });
    assert.ok(reconciled.kind === "contract");
    assert.ok(!(reconciled.effects ?? []).some((effect) => effect.kind === "target-checkout"));
    assert.ok(!(reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.equal(readFileSync(resolve(repository.path, "notes.txt"), "utf8"), "unrelated untracked\n");
  });

  test("a native untracked collision keeps the whole predecessor until reconciliation follows", async () => {
    const repository = repositoryWithMain({ files: TARGET_PLACEMENT_FILES });
    const { contract, id, path: candidatePath } = await managedCandidate(repository, []);
    writeFileSync(resolve(candidatePath, "incoming.txt"), "candidate\n");
    repository.run(["-C", candidatePath, "add", "incoming.txt"]);
    repository.run(["-C", candidatePath, "commit", "--quiet", "-m", "add incoming"]);
    const index = readFileSync(resolve(repository.path, ".git", "index"));
    writeFileSync(resolve(repository.path, "incoming.txt"), "local untracked\n");

    const preview = await contract.previewDelivery();
    assert.equal(preview.kind, "ready");
    assert.equal(preview.target?.kind, "placeable");
    const diagnostic = preview.target.checkouts?.find((checkout) => checkout.path === repository.path)?.diagnostic;
    assert.match(diagnostic ?? "", /incoming\.txt/u);

    const delivered = acceptedDelivery(await contract.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(delivered.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic, diagnostic);
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");
    assert.equal(repository.run(["show", ":delivered.txt"]), "base\n");
    assert.equal(readFileSync(resolve(repository.path, "incoming.txt"), "utf8"), "local untracked\n");
    assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);

    rmSync(resolve(repository.path, "incoming.txt"));
    const reconciled = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: id });
    assert.ok(reconciled.kind === "contract");
    assert.ok(!(reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.deepEqual(
      (reconciled.effects ?? []).filter((effect) => effect.kind === "target-checkout"),
      [{ kind: "target-checkout", path: repository.path, target: "refs/heads/main" }],
    );
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
    assert.equal(readFileSync(resolve(repository.path, "incoming.txt"), "utf8"), "candidate\n");
    assert.equal(repository.run(["status", "--porcelain"]), "");
  });

  test("disjoint staged and unstaged tracked edits survive following untouched", async () => {
    const repository = repositoryWithMain({
      files: { ...TARGET_PLACEMENT_FILES, "staged.txt": "base\n", "unstaged.txt": "base\n" },
    });
    const { contract, id } = await managedCandidate(repository, []);
    writeFileSync(resolve(repository.path, "staged.txt"), "staged local\n");
    repository.run(["add", "staged.txt"]);
    writeFileSync(resolve(repository.path, "unstaged.txt"), "unstaged local\n");

    const preview = await contract.previewDelivery();
    assert.equal(preview.kind, "ready");
    assert.equal(preview.target?.kind, "placeable");
    assert.equal(preview.target.checkouts, undefined);

    const delivered = acceptedDelivery(await contract.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.ok(!(delivered.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.equal(repository.run(["show", ":delivered.txt"]), "candidate\n");
    assert.equal(repository.run(["show", ":staged.txt"]), "staged local\n");
    assert.equal(repository.run(["show", ":unstaged.txt"]), "base\n");
    assert.equal(readFileSync(resolve(repository.path, "staged.txt"), "utf8"), "staged local\n");
    assert.equal(readFileSync(resolve(repository.path, "unstaged.txt"), "utf8"), "unstaged local\n");
    assert.equal(repository.run(["status", "--porcelain"]), "M  staged.txt\n M unstaged.txt\n");

    const reconciled = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: id });
    assert.ok(reconciled.kind === "contract");
    assert.ok(!(reconciled.effects ?? []).some((effect) => effect.kind === "target-checkout"));
    assert.ok(!(reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
  });

  test("mixed changed paths are retained whole instead of partially repaired", async () => {
    const repository = repositoryWithMain({ files: { ...TARGET_PLACEMENT_FILES, "second.txt": "base\n" } });
    const candidate = await managedCandidate(repository, ["reviewed"]);
    writeFileSync(resolve(candidate.path, "second.txt"), "candidate\n");
    repository.run(["-C", candidate.path, "add", "second.txt"]);
    repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "change second"]);
    await admitClaimWithoutFollow(repository, candidate.contract);
    const index = readFileSync(resolve(repository.path, ".git", "index"));
    writeFileSync(resolve(repository.path, "delivered.txt"), "candidate\n");

    const reconciled = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: candidate.id });
    assert.ok(reconciled.kind === "contract");
    assert.ok((reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.ok(!(reconciled.effects ?? []).some((effect) => effect.kind === "target-checkout"));
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
    assert.equal(readFileSync(resolve(repository.path, "second.txt"), "utf8"), "base\n");
    assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);
  });

  test(
    "a case-insensitive untracked alias collision is retained by native movement",
    {
      skip: !caseInsensitiveCheckout && "fixture needs a case-insensitive filesystem",
    },
    async () => {
      const repository = repositoryWithMain({ files: TARGET_PLACEMENT_FILES });
      const candidate = await managedCandidate(repository, []);
      writeFileSync(resolve(candidate.path, "Incoming.txt"), "candidate\n");
      repository.run(["-C", candidate.path, "add", "Incoming.txt"]);
      repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "add incoming"]);
      const untracked = "aliased untracked\n";
      writeFileSync(resolve(repository.path, "incoming.txt"), untracked);

      const preview = await candidate.contract.previewDelivery();
      assert.equal(preview.kind, "ready");
      assert.equal(preview.target?.kind, "placeable");
      const diagnostic = preview.target.checkouts?.find((checkout) => checkout.path === repository.path)?.diagnostic;
      assert.match(diagnostic ?? "", /Incoming\.txt/u);

      const delivered = acceptedDelivery(await candidate.contract.deliver());
      assert.equal(delivered.placement?.kind, "placed");
      assert.equal(
        delivered.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic,
        diagnostic,
      );
      assert.equal(readFileSync(resolve(repository.path, "incoming.txt"), "utf8"), untracked);
      assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");
    },
  );
});
