import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Keiyaku, Repo, type Keiyaku as KeiyakuHandle } from "../src/index.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { gate, type ContractId } from "../src/core/facts/types.js";
import { admitDecidedOffer, mintAttempts } from "../src/protocol/attempt.js";
import { admitIntent } from "../src/protocol/intent.js";
import { observeContractsForAdmissionAt } from "../src/git/observe.js";
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
import { repositoryWithMain } from "./support/library-verbs.js";

const TARGET_FILES = {
  "delivered.txt": "base\n",
  "local.txt": "base\n",
};

function document(title = "Target checkout placement"): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "A target branch may already be checked out.",
    "",
    "## Objective",
    "Keep the checked-out target coherent with placement.",
    "",
    "## Design",
    "Fence publication and Git-native follow.",
    "",
    "## Region",
    "~~~",
    "delivered.txt",
    "~~~",
    "",
    "## Criteria",
    "### Preserve bytes",
    "Refuse before publication when local content conflicts.",
    "",
  ].join("\n");
}

type GeneratedWorktreeFile = Readonly<{ path: string; bytes: Buffer; mode: number }>;
type ManagedCandidateTemplate = Readonly<{
  repository: TestGitRepository;
  id: ContractId;
  candidateHead: string;
  generatedFiles: readonly GeneratedWorktreeFile[];
}>;

type AcceptedDelivery = Exclude<Awaited<ReturnType<KeiyakuHandle["deliver"]>>, { kind: "integration-conflict-materialized" }>;

function acceptedDelivery(result: Awaited<ReturnType<KeiyakuHandle["deliver"]>>): AcceptedDelivery {
  if (result.kind === "integration-conflict-materialized") {
    throw new Error(`unexpected integration conflict: ${result.conflictPaths.join(",")}`);
  }
  return result;
}

const TEMPLATE_CANDIDATE_REF = "refs/heads/keiyaku-test-template-candidate";
const ordinaryCandidateTemplates = new Map<string, Promise<ManagedCandidateTemplate>>();
let claimedUnfollowedCandidateTemplate: Promise<ManagedCandidateTemplate> | undefined;

async function managedCandidate(repository: TestGitRepository, gates: readonly string[] = []) {
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates,
  });
  const contract = bound.keiyaku;
  const state = await contract.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(resolve(path, "delivered.txt"), "candidate\n");
  repository.run(["-C", path, "add", "delivered.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
  return { contract, id: state.id, path };
}

function captureManagedCandidateTemplate(
  repository: TestGitRepository,
  candidate: Awaited<ReturnType<typeof managedCandidate>>,
): ManagedCandidateTemplate {
  const candidateHead = repository.run(["-C", candidate.path, "rev-parse", "HEAD"]).trim();
  const generatedFiles = [".keiyaku/.gitignore", ".keiyaku/KEIYAKU.md"].map((path) => ({
    path,
    bytes: readFileSync(join(candidate.path, path)),
    mode: statSync(join(candidate.path, path)).mode & 0o777,
  }));
  repository.run(["update-ref", TEMPLATE_CANDIDATE_REF, candidateHead]);
  repository.run(["worktree", "remove", "--force", candidate.path]);
  return { repository, id: candidate.id, candidateHead, generatedFiles };
}

async function buildOrdinaryCandidateTemplate(gates: readonly string[]): Promise<ManagedCandidateTemplate> {
  const repository = repositoryWithMain({ files: TARGET_FILES });
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
  for (const generated of template.generatedFiles) {
    const path = join(worktree, generated.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated.bytes);
    chmodSync(path, generated.mode);
  }
  repository.run(["update-ref", "-d", TEMPLATE_CANDIDATE_REF]);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: template.id });
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

test("ordinary placement follows a checked-out target and preserves unrelated worktree bytes", async () => {
  const { repository, contract } = await ordinaryCandidateFixture();
  writeFileSync(resolve(repository.path, "local.txt"), "unstaged local\n");
  writeFileSync(resolve(repository.path, "untracked.txt"), "untracked local\n");

  const delivered = acceptedDelivery(await contract.deliver());

  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "unstaged local\n");
  assert.equal(readFileSync(resolve(repository.path, "untracked.txt"), "utf8"), "untracked local\n");
  assert.equal(repository.run(["diff", "--cached", "--name-only"]), "");
  assert.equal(delivered.lags.length, 0);
});

test("claimed target observation is current at integration and drifts after rewind", async () => {
  const { repository, contract } = await ordinaryCandidateFixture();
  await contract.deliver();
  const delivery = (await contract.state()).delivery?.data;
  if (delivery === undefined) throw new Error("delivery was not recorded");
  const repo = await cachedRepoAt(repository.path);
  const contractId = (await contract.state()).id;
  const placed = await Keiyaku.observe({ repo, id: contractId });
  assert.equal(placed.kind, "present");
  if (placed.kind !== "present") return;
  assert.deepEqual(placed.row.targetObservation, { head: delivery.integration.snapshot, drift: false });

  repository.run(["reset", "--hard", delivery.integration.predecessor]);
  const rewound = await Keiyaku.observe({ repo, id: contractId });
  assert.equal(rewound.kind, "present");
  if (rewound.kind !== "present") return;
  assert.deepEqual(rewound.row.targetObservation, { head: delivery.integration.predecessor, drift: true });
});

test("ordinary placement carries unrelated staged index bytes through the follow", async () => {
  const { repository, contract, path } = await ordinaryCandidateFixture();
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]);
  writeFileSync(resolve(repository.path, "local.txt"), "staged local\n");
  repository.run(["add", "local.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "local.txt"]);

  const delivered = acceptedDelivery(await contract.deliver());

  const integrated = (await contract.state()).delivery?.data.integration.snapshot;
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), `${integrated}\n`);
  assert.notEqual(candidate, predecessor);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "staged local\n");
  assert.equal(repository.run(["diff", "--cached", "--", "local.txt"]), stagedPatch);
  assert.deepEqual(delivered.lags, []);
});

test("ordinary placement follows the target checkout in another worktree", async () => {
  const repository = repositoryWithMain({ files: TARGET_FILES });
  repository.run(["branch", "observer"]);
  repository.run(["checkout", "--quiet", "observer"]);
  const checkout = `${repository.path}-main-checkout`;
  repository.run(["worktree", "add", "--quiet", checkout, "main"]);
  const { contract } = await managedCandidate(repository);

  await contract.deliver();

  assert.equal(readFileSync(resolve(checkout, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(repository.run(["-C", checkout, "status", "--porcelain"]), "");
});

test("conflicting target bytes refuse placement before claimed or target movement", async () => {
  const { repository, contract } = await ordinaryCandidateFixture();
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "delivered.txt"), "local conflict\n");

  const delivered = acceptedDelivery(await contract.deliver());

  assert.deepEqual(delivered.value.placement, {
    refusal: {
      kind: "checkout-not-followable",
      contractId: (await contract.state()).id,
      target: "refs/heads/main",
      path: realpathSync(repository.path),
      reason: "conflict",
      paths: ["delivered.txt"],
    },
  });
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "local conflict\n");
  assert.equal((await observeContract(await cachedRepositoryAt(repository.path), (await contract.state()).id)).state?.terminal, null);
  assert.deepEqual(delivered.lags, []);
});

test("an untracked collision refuses placement before target movement", async () => {
  const candidate = await ordinaryCandidateFixture();
  const { repository } = candidate;
  writeFileSync(resolve(candidate.path, "collision.txt"), "candidate\n");
  repository.run(["-C", candidate.path, "add", "collision.txt"]);
  repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "add collision"]);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "collision.txt"), "local untracked\n");

  const delivered = acceptedDelivery(await candidate.contract.deliver());

  const placement = delivered.value.placement;
  assert.ok(placement);
  if (!("refusal" in placement) || placement.refusal.kind !== "checkout-not-followable") {
    assert.fail("expected checkout-not-followable");
  }
  assert.equal(placement.refusal.reason, "untracked");
  assert.deepEqual(placement.refusal.paths, ["collision.txt"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(readFileSync(resolve(repository.path, "collision.txt"), "utf8"), "local untracked\n");
});

test("an ignored untracked collision remains a typed refusal", async () => {
  const repository = repositoryWithMain({ files: TARGET_FILES });
  writeFileSync(resolve(repository.path, ".gitignore"), "generated.dat\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore generated output"]);
  const candidate = await managedCandidate(repository);
  writeFileSync(resolve(candidate.path, "generated.dat"), "candidate\n");
  repository.run(["-C", candidate.path, "add", "--force", "generated.dat"]);
  repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "add generated output"]);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "generated.dat"), "ignored local\n");

  const delivered = acceptedDelivery(await candidate.contract.deliver());

  const placement = delivered.value.placement;
  assert.ok(placement);
  if (!("refusal" in placement) || placement.refusal.kind !== "checkout-not-followable") {
    assert.fail("expected checkout-not-followable");
  }
  assert.equal(placement.refusal.reason, "untracked");
  assert.deepEqual(placement.refusal.paths, ["generated.dat"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(readFileSync(resolve(repository.path, "generated.dat"), "utf8"), "ignored local\n");
});

test("a staged candidate-changed path refuses placement with its exact path", async () => {
  const { repository, contract } = await ordinaryCandidateFixture();
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "delivered.txt"), "staged conflict\n");
  repository.run(["add", "delivered.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "delivered.txt"]);

  const delivered = acceptedDelivery(await contract.deliver());

  const placement = delivered.value.placement;
  assert.ok(placement);
  if (!("refusal" in placement) || placement.refusal.kind !== "checkout-not-followable") {
    assert.fail("expected checkout-not-followable");
  }
  assert.equal(placement.refusal.reason, "staged");
  assert.deepEqual(placement.refusal.paths, ["delivered.txt"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(repository.run(["diff", "--cached", "--", "delivered.txt"]), stagedPatch);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "staged conflict\n");
  assert.deepEqual(delivered.lags, []);
});

async function admitClaimWithoutFollow(
  repository: TestGitRepository,
  contract: Awaited<ReturnType<typeof managedCandidate>>["contract"],
): Promise<void> {
  await contract.deliver({ includeDirty: true });
  await contract.review({ verdict: "unsatisfied" });
  const git = await cachedRepositoryAt(repository.path);
  const contractId = (await contract.state()).id;
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
          data: { gate: gate("reviewed"), subject, verdict: "satisfied" as const },
        },
      },
      decideAttestation<never>,
    );
    assert.equal(attested.kind, "accepted");

    const admitted = (
      await withPrivateStatePublicationSeat(git, async (seat) => {
      const observation = await observeContractsForAdmissionAt(git, channel, [contractId]);
      const attempt = mintAttempts({ entryCount: 2 })[0]!;
      const decision = decidePlacement({
        input: { contractId, at: new Date().toISOString() },
        attempt,
        observation: observation.decision,
      });
      assert.equal(decision.kind, "offer");
      if (decision.kind !== "offer") assert.fail("expected placement offer");
      return await admitDecidedOffer({
        channel,
        repository: git,
        seat,
        decisionObservation: observation,
        attempt,
        offer: decision.offer,
        primaryContract: contractId,
      });
    })
    ).value;
    assert.equal(admitted.kind, "accepted");
  });
}

test("reconcile completes an ordinary follow interrupted after atomic publication", async () => {
  const candidate = await claimedUnfollowedCandidateFixture();
  const { repository } = candidate;
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");

  const reconciled = await withGitShim(
    [
      "for argument do",
      "  case \"$argument\" in *'^{tree}'*) exit 97 ;; esac",
      "done",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id: candidate.id }).reconcile(),
  );

  assert.deepEqual(reconciled.lag, []);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(repository.run(["status", "--porcelain"]), "");
  assert.ok(reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
});

test("reconcile recognizes a completed ordinary follow despite unrelated staged and unstaged bytes", async () => {
  const candidate = await claimedUnfollowedCandidateFixture();
  const { repository } = candidate;
  const delivery = (await observeContract(await cachedRepositoryAt(repository.path), candidate.id)).state
    ?.delivery?.data;
  assert.ok(delivery);
  repository.run(["read-tree", "-m", "-u", delivery.integration.predecessor, delivery.integration.snapshot]);
  writeFileSync(resolve(repository.path, "local.txt"), "staged local\n");
  repository.run(["add", "local.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "local.txt"]);
  writeFileSync(resolve(repository.path, "local.txt"), "unstaged local\n");

  const reconciled = await candidate.contract.reconcile();

  assert.deepEqual(reconciled.lag, []);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), `${delivery.integration.snapshot}\n`);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "unstaged local\n");
  assert.equal(repository.run(["diff", "--cached", "--", "local.txt"]), stagedPatch);
  assert.ok(!reconciled.effects.some((effect) => effect.kind === "target-checkout"));
});

test("reconcile aligns a candidate worktree to its index without disturbing unrelated staged content", async () => {
  const candidate = await claimedUnfollowedCandidateFixture();
  const { repository } = candidate;
  writeFileSync(resolve(repository.path, "local.txt"), "staged local\n");
  repository.run(["add", "local.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "local.txt"]);
  const delivery = (await observeContract(await cachedRepositoryAt(repository.path), candidate.id)).state
    ?.delivery?.data;
  assert.ok(delivery);
  writeFileSync(resolve(repository.path, "delivered.txt"), "candidate\n");
  assert.equal(repository.run(["diff", "--cached", "--name-only", delivery.integration.predecessor]), "local.txt\n");
  assert.equal(repository.run(["diff-files", "--name-only"]), "delivered.txt\n");

  const reconciled = await candidate.contract.reconcile();

  assert.deepEqual(reconciled.lag, []);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), `${delivery.integration.snapshot}\n`);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "staged local\n");
  assert.equal(repository.run(["diff", "--cached", "--", "local.txt"]), stagedPatch);
  assert.ok(reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
});

test("recovery preserves an unrelated path staged after classification and before mutation", async () => {
  const candidate = await claimedUnfollowedCandidateFixture();
  const { repository } = candidate;
  const delivery = (await observeContract(await cachedRepositoryAt(repository.path), candidate.id)).state
    ?.delivery?.data;
  assert.ok(delivery);
  writeFileSync(resolve(repository.path, "delivered.txt"), "candidate\n");
  const marker = `${repository.path}/recovery-unrelated-stage.marker`;
  const stagedBytes = "concurrent unrelated stage\n";
  const expectedIndexLine = repository.run(["hash-object", "-w", "--stdin"], stagedBytes).trim();
  const expectedMode = repository.run(["ls-files", "--stage", "--", "local.txt"]).split(" ")[0];

  const reconciled = await withGitShim(
    [
      'if [ "$1" = "-C" ]; then',
      "  shift",
      '  cd "$1" || exit $?',
      "  shift",
      "fi",
      'if [ "$1" = "read-tree" ] && [ -z "$GIT_INDEX_FILE" ] && [ "$2" != "HEAD" ] && [ ! -e "$KEIYAKU_RECOVERY_UNRELATED_STAGE" ]; then',
      '  printf "%s" "$KEIYAKU_STAGED_BYTES" > "$KEIYAKU_UNRELATED_PATH"',
      '  "$KEIYAKU_REAL_GIT" add -- "$KEIYAKU_UNRELATED_PATH" || exit $?',
      '  touch "$KEIYAKU_RECOVERY_UNRELATED_STAGE"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_RECOVERY_UNRELATED_STAGE: marker,
      KEIYAKU_UNRELATED_PATH: resolve(repository.path, "local.txt"),
      KEIYAKU_STAGED_BYTES: stagedBytes,
    },
    async (gitPath) =>
      (
        await Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id: candidate.id })
      ).reconcile(),
  );

  const stage = repository.run(["ls-files", "--stage", "--", "local.txt"]).trim().split(/\s+/u);
  assert.deepEqual(reconciled.lag, []);
  assert.ok(reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), stagedBytes);
  assert.equal(stage[0], expectedMode);
  assert.equal(stage[1], expectedIndexLine);
  assert.equal(repository.run(["status", "--porcelain", "--untracked-files=no", "--", "local.txt"]), "M  local.txt\n");
});

test("an incompatible relevant index is retained without mutation", async () => {
  const candidate = await claimedUnfollowedCandidateFixture();
  const { repository } = candidate;
  const delivery = (await observeContract(await cachedRepositoryAt(repository.path), candidate.id)).state
    ?.delivery?.data;
  assert.ok(delivery);
  writeFileSync(resolve(repository.path, "delivered.txt"), "incompatible relevant\n");
  repository.run(["add", "delivered.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "delivered.txt"]);
  const status = repository.run(["status", "--porcelain", "--untracked-files=no"]);

  const reconciled = await candidate.contract.reconcile();

  assert.ok(reconciled.lag.some((lag) => lag.kind === "target-checkout-retained"));
  assert.ok(!reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), `${delivery.integration.snapshot}\n`);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "incompatible relevant\n");
  assert.equal(repository.run(["diff", "--cached", "--", "delivered.txt"]), stagedPatch);
  assert.equal(repository.run(["status", "--porcelain", "--untracked-files=no"]), status);
});

test("a relevant staged change after classification fails into lag without overwriting it", async () => {
  const candidate = await claimedUnfollowedCandidateFixture();
  const { repository } = candidate;
  const delivery = (await observeContract(await cachedRepositoryAt(repository.path), candidate.id)).state
    ?.delivery?.data;
  assert.ok(delivery);
  const marker = `${repository.path}/recovery-relevant-stage.marker`;
  const stagedBytes = "relevant concurrent stage\n";
  const expectedBlob = repository.run(["hash-object", "-w", "--stdin"], stagedBytes).trim();
  const reconciled = await withGitShim(
    [
      'if [ "$1" = "-C" ]; then',
      "  shift",
      '  cd "$1" || exit $?',
      "  shift",
      "fi",
      'if [ "$1" = "read-tree" ] && [ -z "$GIT_INDEX_FILE" ] && [ "$2" != "HEAD" ] && [ ! -e "$KEIYAKU_RECOVERY_RELEVANT_STAGE" ]; then',
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
      (
        await Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id: candidate.id })
      ).reconcile(),
  );

  const stage = repository.run(["ls-files", "--stage", "--", "delivered.txt"]).trim().split(/\s+/u);
  assert.ok(reconciled.lag.some((lag) => lag.kind === "target-checkout-retained"));
  assert.ok(!reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
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

  const reconciled = await candidate.contract.reconcile();

  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "changed after publication\n");
  assert.ok(reconciled.lag.some((lag) => lag.kind === "target-checkout-retained"));
  assert.ok(!reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
});
