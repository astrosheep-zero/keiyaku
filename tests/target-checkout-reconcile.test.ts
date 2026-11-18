import { present } from "./support/library-verbs.js";
import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo } from "../src/index.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { singletonRequirement } from "../src/verification/declaration.js";
import { gate, type ContractId } from "../src/core/facts/types.js";
import { admitDecidedOffer, mintAttempts } from "../src/protocol/attempt.js";
import { admitIntent } from "../src/protocol/intent.js";
import { observeContractsAt } from "../src/git/observe.js";
import { withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";

import { mintSnapshotId } from "../src/git/identity.js";
import { observeTargetCheckoutShape } from "../src/git/target-placement.js";
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
    );
    assert.equal(attested.kind, "accepted");

    const admitted = (
      await withPrivateStatePublicationSeat(git, async (seat) => {
        const observation = await observeContractsAt(git, channel, [contractId]);
        const attempt = mintAttempts({ entryCount: 2 })[0]!;
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
    assert.ok(placed.kind === "present", 'expected placed.kind = "present"');
    assert.equal(placed.row.targetObservation, undefined);

    repository.run(["reset", "--hard", delivery.integration.predecessor]);
    const rewound = await Keis.of(repo).observe({ id: contractId });
    assert.ok(rewound.kind === "present", 'expected rewound.kind = "present"');
    assert.deepEqual(rewound.row.targetObservation, {
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

  test("a staged candidate-changed path leaves the checkout behind instead of refusing placement", async () => {
    const { repository, contract } = await ordinaryCandidateFixture();
    writeFileSync(resolve(repository.path, "delivered.txt"), "staged conflict\n");
    repository.run(["add", "delivered.txt"]);

    const delivered = acceptedDelivery(await contract.deliver());

    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    const retained = (delivered.issues ?? []).filter((issue) => issue.kind === "target-checkout-retained");
    assert.ok(retained.length > 0);
    assert.equal(new Set(retained.map((issue) => issue.diagnostic)).size, retained.length);
    for (const issue of retained) {
      assert.equal(issue.path, repository.path);
      assert.equal(issue.target, "refs/heads/main");
    }
    assert.equal(repository.run(["show", ":delivered.txt"]), "staged conflict\n");
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "staged conflict\n");
  });

  test("an unmerged candidate-changed path leaves the checkout behind instead of refusing placement", async () => {
    const { repository, contract } = await ordinaryCandidateFixture();
    const base = repository.run(["rev-parse", "HEAD:delivered.txt"]).trim();
    const ours = repository.run(["hash-object", "-w", "--stdin"], "ours\n").trim();
    const theirs = repository.run(["hash-object", "-w", "--stdin"], "theirs\n").trim();
    repository.run(
      ["update-index", "--index-info"],
      `100644 ${base} 1\tdelivered.txt\n100644 ${ours} 2\tdelivered.txt\n100644 ${theirs} 3\tdelivered.txt\n`,
    );
    writeFileSync(resolve(repository.path, "delivered.txt"), "unresolved\n");
    assert.equal(repository.run(["ls-files", "-u", "--", "delivered.txt"]).split("\n").filter(Boolean).length, 3);

    const delivered = acceptedDelivery(await contract.deliver());

    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    const retained = (delivered.issues ?? []).filter((issue) => issue.kind === "target-checkout-retained");
    assert.ok(retained.length > 0);
    assert.equal(new Set(retained.map((issue) => issue.diagnostic)).size, retained.length);
    for (const issue of retained) {
      assert.equal(issue.path, repository.path);
      assert.equal(issue.target, "refs/heads/main");
    }
    assert.equal(repository.run(["ls-files", "-u", "--", "delivered.txt"]).split("\n").filter(Boolean).length, 3);
    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "unresolved\n");
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

  test("reconcile preserves ignored directory contents until target recovery can follow safely", async () => {
    const repository = repositoryWithMain({
      files: {
        ...TARGET_PLACEMENT_FILES,
        ".gitignore": "artifact/local-secret\n",
        "artifact/tracked.txt": "tracked\n",
      },
    });
    const candidate = await managedCandidate(repository, []);
    repository.run(["-C", candidate.path, "rm", "-r", "artifact"]);
    writeFileSync(resolve(candidate.path, "artifact"), "candidate file\n");
    repository.run(["-C", candidate.path, "add", "artifact"]);
    repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "replace directory"]);
    const repo = await Repo.at({ path: repository.path });
    const git = await cachedRepositoryAt(repository.path);
    const index = readFileSync(resolve(repository.path, ".git", "index"));
    const secret = Buffer.from([0, 255, 10, 115, 101, 99, 114, 101, 116]);
    const secretPath = resolve(repository.path, "artifact", "local-secret");
    writeFileSync(secretPath, secret);

    const preview = await candidate.contract.previewDelivery();
    assert.equal(preview.kind, "ready");
    assert.equal(preview.target?.kind, "placeable");
    const diagnostic = preview.target.checkouts?.find((checkout) => checkout.path === repository.path)?.diagnostic;
    assert.match(diagnostic ?? "", /ignored.*artifact\/local-secret/u);
    const delivered = acceptedDelivery(await candidate.contract.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(delivered.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic, diagnostic);
    assert.deepEqual(readFileSync(secretPath), secret);
    assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);
    const integration = delivered.integration;
    const journal = repository.run(["rev-parse", "refs/heads/keiyaku-state"]);
    const retained = await Keis.of(repo).reconcile({ contract: candidate.id });
    assert.ok(retained.kind === "contract");

    assert.deepEqual(readFileSync(secretPath), secret);
    assert.equal(readFileSync(resolve(repository.path, "artifact", "tracked.txt"), "utf8"), "tracked\n");
    assert.deepEqual(readFileSync(resolve(repository.path, ".git", "index")), index);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), integration);
    assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]), journal);
    assert.equal((await observeContract(git, candidate.id)).state?.terminal?.kind, "claimed");
    const lag = (retained.issues ?? []).find((issue) => issue.kind === "target-checkout-retained");
    assert.ok(lag?.kind === "target-checkout-retained");
    assert.equal(lag.path, repository.path);
    assert.equal(lag.target, "refs/heads/main");
    assert.match(lag.diagnostic, /ignored.*artifact/);
    assert.ok(!(retained.effects ?? []).some((effect) => effect.kind === "target-checkout"));

    rmSync(secretPath);
    const recovered = await Keis.of(repo).reconcile({ contract: candidate.id });
    assert.ok(recovered.kind === "contract");

    assert.equal((recovered.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"), false);
    assert.equal(readFileSync(resolve(repository.path, "artifact"), "utf8"), "candidate file\n");
    assert.equal(repository.run(["status", "--porcelain"]), "");
    assert.ok((recovered.effects ?? []).some((effect) => effect.kind === "target-checkout"));
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), integration);
    assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]), journal);
  });

  test("mixed candidate bytes are inert until the entire predecessor is restored", async () => {
    const { repository, id, contract } = await claimedUnfollowedCandidateFixture();
    const integration = present(await contract.state()).currentIntegration!;
    const indexPath = resolve(repository.path, ".git", "index");
    const index = readFileSync(indexPath);
    const file = resolve(repository.path, "delivered.txt");
    writeFileSync(file, "candidate\n");
    const contracts = Keis.of(await Repo.at({ path: repository.path }));

    const retained = await contracts.reconcile({ contract: id });
    assert.ok(retained.kind === "contract");
    assert.ok(retained.issues?.some((issue) => issue.kind === "target-checkout-retained"));
    assert.ok(!retained.effects?.some((effect) => effect.kind === "target-checkout"));
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), integration.snapshot);
    assert.equal(readFileSync(file, "utf8"), "candidate\n");
    assert.deepEqual(readFileSync(indexPath), index);

    repository.run(["checkout-index", "--force", "--", "delivered.txt"]);
    repository.run(["update-index", "--refresh", "-q"]);
    const recovered = await contracts.reconcile({ contract: id });
    assert.ok(recovered.kind === "contract");
    assert.ok(!recovered.issues?.some((issue) => issue.kind === "target-checkout-retained"), JSON.stringify(recovered));
    assert.deepEqual(recovered.effects?.filter((effect) => effect.kind === "target-checkout"), [
      { kind: "target-checkout", path: repository.path, target: "refs/heads/main" },
    ]);
    assert.equal(readFileSync(file, "utf8"), "candidate\n");
    assert.equal(repository.run(["show", ":delivered.txt"]), "candidate\n");
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

  test("reconcile does not guess after the user changes an interrupted target checkout", async () => {
    const candidate = await claimedUnfollowedCandidateFixture();
    const { repository } = candidate;
    writeFileSync(resolve(repository.path, "delivered.txt"), "changed after publication\n");

    const reconciled = await Keis.of(await Repo.at({ path: repository.path })).reconcile({
      contract: candidate.id,
    });
    assert.ok(reconciled.kind === "contract");

    assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "changed after publication\n");
    assert.ok((reconciled.issues ?? []).some((issue) => issue.kind === "target-checkout-retained"));
    assert.ok(!(reconciled.effects ?? []).some((effect) => effect.kind === "target-checkout"));
  });

  test("the ignored guard uses literal filenames, not pathspec expressions", async () => {
    const names = process.platform === "win32" ? ["[a].txt"] : ["[a].txt", "*.txt", ":(exclude)literal.txt"];
    for (const name of names) {
      const repository = repositoryWithMain({ files: { ".gitignore": "*.txt\n" } });
      const predecessor = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
      writeFileSync(resolve(repository.path, name), "candidate\n");
      repository.run(["--literal-pathspecs", "add", "-f", "--", name]);
      repository.run(["commit", "--quiet", "-m", "literal candidate"]);
      const candidate = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
      const capability = await cachedRepositoryAt(repository.path);
      const shape = () => observeTargetCheckoutShape(capability, { target: "refs/heads/main", predecessor, candidate });

      repository.run(["reset", "--hard", predecessor]);
      writeFileSync(resolve(repository.path, "a.txt"), "unrelated ignored bytes\n");
      assert.equal(await shape(), "followable", `${name}: a glob must not match the ignored decoy`);
      writeFileSync(resolve(repository.path, name), "ignored collision\n");
      assert.equal(await shape(), "retained", `${name}: the literal ignored collision must be kept`);
      assert.equal(readFileSync(resolve(repository.path, name), "utf8"), "ignored collision\n");
    }
  });
});
