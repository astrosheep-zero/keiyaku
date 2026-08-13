import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo } from "../src/index.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { gate, type ContractId } from "../src/core/facts/types.js";
import { admitDecidedOffer, mintAttempts } from "../src/protocol/attempt.js";
import { admitIntent } from "../src/protocol/intent.js";
import { observeContractsForAdmissionAt } from "../src/git/observe.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { makeGitRepository, observeContract, type TestGitRepository, withGitShim } from "./support/git.js";

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "delivered.txt"), "base\n");
  writeFileSync(resolve(repository.path, "local.txt"), "base\n");
  repository.run(["add", "delivered.txt", "local.txt"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  return repository;
}

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

async function managedCandidate(repository: TestGitRepository, gates: readonly string[] = []) {
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates,
  });
  const contract = bound.keiyaku;
  const path = deliveryWorktreePath(repositoryAt(repository.path), contract.id);
  writeFileSync(resolve(path, "delivered.txt"), "candidate\n");
  repository.run(["-C", path, "add", "delivered.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
  return { contract, id: contract.id as ContractId, path };
}

test("ordinary placement follows a checked-out target and preserves unrelated worktree bytes", async () => {
  const repository = repositoryWithMain();
  const { contract } = await managedCandidate(repository);
  writeFileSync(resolve(repository.path, "local.txt"), "unstaged local\n");
  writeFileSync(resolve(repository.path, "untracked.txt"), "untracked local\n");

  const delivered = await contract.deliver();

  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "unstaged local\n");
  assert.equal(readFileSync(resolve(repository.path, "untracked.txt"), "utf8"), "untracked local\n");
  assert.equal(repository.run(["diff", "--cached", "--name-only"]), "");
  assert.equal(delivered.lags.length, 0);
  assert.ok(delivered.effects.some((effect) =>
    effect.kind === "target-checkout"
    && effect.path === realpathSync(repository.path)
    && effect.action === "followed"));
});

test("claimed target observation is current at integration and drifts after rewind", async () => {
  const repository = repositoryWithMain();
  const { contract } = await managedCandidate(repository);
  await contract.deliver();
  const delivery = (await contract.state()).delivery?.data;
  if (delivery === undefined) throw new Error("delivery was not recorded");
  const repo = Repo.at({ path: repository.path });
  const placed = await Keiyaku.observe({ repo, id: contract.id });
  assert.equal(placed.kind, "present");
  if (placed.kind !== "present") return;
  assert.deepEqual(placed.row.targetObservation, { head: delivery.integration.snapshot, drift: false });
  assert.deepEqual((await contract.audit()).value.targetObservation, {
    head: delivery.integration.snapshot,
    drift: false,
  });

  repository.run(["reset", "--hard", delivery.integration.predecessor]);
  const rewound = await Keiyaku.observe({ repo, id: contract.id });
  assert.equal(rewound.kind, "present");
  if (rewound.kind !== "present") return;
  assert.deepEqual(rewound.row.targetObservation, { head: delivery.integration.predecessor, drift: true });
  assert.deepEqual((await contract.audit()).value.targetObservation, {
    head: delivery.integration.predecessor,
    drift: true,
  });
});

test("ordinary placement carries unrelated staged index bytes through the follow", async () => {
  const repository = repositoryWithMain();
  const { contract, path } = await managedCandidate(repository);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]);
  writeFileSync(resolve(repository.path, "local.txt"), "staged local\n");
  repository.run(["add", "local.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "local.txt"]);

  const delivered = await contract.deliver();

  const integrated = (await contract.state()).delivery?.data.integration.snapshot;
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), `${integrated}\n`);
  assert.notEqual(candidate, predecessor);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "staged local\n");
  assert.equal(repository.run(["diff", "--cached", "--", "local.txt"]), stagedPatch);
  assert.deepEqual(delivered.lags, []);
  assert.ok(delivered.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "followed"));
});

test("ordinary placement follows the target checkout in another worktree", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "observer"]);
  repository.run(["checkout", "--quiet", "observer"]);
  const checkout = `${repository.path}-main-checkout`;
  repository.run(["worktree", "add", "--quiet", checkout, "main"]);
  const { contract } = await managedCandidate(repository);

  const delivered = await contract.deliver();

  assert.equal(readFileSync(resolve(checkout, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(repository.run(["-C", checkout, "status", "--porcelain"]), "");
  assert.ok(delivered.effects.some((effect) =>
    effect.kind === "target-checkout"
    && effect.path === realpathSync(checkout)
    && effect.action === "followed"));
});

test("conflicting target bytes refuse placement before claimed or target movement", async () => {
  const repository = repositoryWithMain();
  const { contract } = await managedCandidate(repository);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "delivered.txt"), "local conflict\n");

  const delivered = await contract.deliver();

  assert.deepEqual(delivered.value.placement, {
    refusal: {
      kind: "checkout-not-followable",
      contractId: contract.id,
      target: "refs/heads/main",
      path: realpathSync(repository.path),
      reason: "conflict",
      paths: ["delivered.txt"],
    },
  });
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "local conflict\n");
  assert.equal((await observeContract(repositoryAt(repository.path), contract.id)).state?.terminal, null);
  assert.deepEqual(delivered.lags, []);
});

test("an untracked collision refuses placement before target movement", async () => {
  const repository = repositoryWithMain();
  const candidate = await managedCandidate(repository);
  writeFileSync(resolve(candidate.path, "collision.txt"), "candidate\n");
  repository.run(["-C", candidate.path, "add", "collision.txt"]);
  repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "add collision"]);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "collision.txt"), "local untracked\n");

  const delivered = await candidate.contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") {
    assert.fail("expected checkout-not-followable");
  }
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["collision.txt"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(readFileSync(resolve(repository.path, "collision.txt"), "utf8"), "local untracked\n");
});

test("an ignored untracked collision remains a typed refusal", async () => {
  const repository = repositoryWithMain();
  writeFileSync(resolve(repository.path, ".gitignore"), "generated.dat\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore generated output"]);
  const candidate = await managedCandidate(repository);
  writeFileSync(resolve(candidate.path, "generated.dat"), "candidate\n");
  repository.run(["-C", candidate.path, "add", "--force", "generated.dat"]);
  repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "add generated output"]);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "generated.dat"), "ignored local\n");

  const delivered = await candidate.contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") {
    assert.fail("expected checkout-not-followable");
  }
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["generated.dat"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(readFileSync(resolve(repository.path, "generated.dat"), "utf8"), "ignored local\n");
});

test("a staged candidate-changed path refuses placement with its exact path", async () => {
  const repository = repositoryWithMain();
  const { contract } = await managedCandidate(repository);
  const predecessor = repository.run(["rev-parse", "refs/heads/main"]);
  writeFileSync(resolve(repository.path, "delivered.txt"), "staged conflict\n");
  repository.run(["add", "delivered.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "delivered.txt"]);

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") {
    assert.fail("expected checkout-not-followable");
  }
  assert.equal(delivered.value.placement.refusal.reason, "staged");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["delivered.txt"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]), predecessor);
  assert.equal(repository.run(["diff", "--cached", "--", "delivered.txt"]), stagedPatch);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "staged conflict\n");
  assert.deepEqual(delivered.lags, []);
  assert.ok(!delivered.effects.some((effect) => effect.kind === "target-checkout"));
});

test("dirty here placement commits staged unstaged and untracked bytes without rewriting the worktree", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document("Here placement"),
    workspace: "here",
    target: "main",
    gates: [],
  });
  writeFileSync(resolve(repository.path, "delivered.txt"), "staged candidate\n");
  repository.run(["add", "delivered.txt"]);
  writeFileSync(resolve(repository.path, "local.txt"), "unstaged candidate\n");
  writeFileSync(resolve(repository.path, "untracked.txt"), "untracked candidate\n");

  const delivered = await bound.keiyaku.deliver({ includeDirty: true });

  assert.equal(repository.run(["status", "--porcelain"]), "");
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "staged candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "local.txt"), "utf8"), "unstaged candidate\n");
  assert.equal(readFileSync(resolve(repository.path, "untracked.txt"), "utf8"), "untracked candidate\n");
  assert.ok(delivered.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "followed"));
});

test("here delivery refuses before tender after its workspace leaves the target branch", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "other"]);
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document("Moved here workspace"),
    workspace: "here",
    target: "main",
    gates: [],
  });
  repository.run(["checkout", "--quiet", "other"]);

  await assert.rejects(
    () => bound.keiyaku.deliver(),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.code === "workspace-not-on-target"
      && error.refusal.branch === "refs/heads/other",
  );
  assert.equal((await observeContract(repositoryAt(repository.path), bound.keiyaku.id)).state?.delivery, null);
});

test("targeted here bind refuses a foreign branch before Contract birth", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "foreign"]);

  await assert.rejects(
    () => Keiyaku.bind({
      repo: Repo.at({ path: repository.path }),
      markdown: document("Foreign here target"),
      workspace: "here",
      target: "foreign",
      gates: [],
    }),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.code === "here-target-mismatch"
      && error.refusal.branch === "refs/heads/main",
  );
});

async function admitClaimWithoutFollow(repository: TestGitRepository, contract: Awaited<ReturnType<typeof managedCandidate>>["contract"]): Promise<void> {
  await contract.deliver({ includeDirty: true });
  await contract.review({ verdict: "unsatisfied" });
  const git = repositoryAt(repository.path);
  const state = (await observeContract(git, contract.id)).state;
  const subject = state?.attestations.at(-1)?.data.subject;
  assert.ok(subject);
  await withGitDecodeChannel(git, async (channel) => {
    const attested = await admitIntent(channel, git, {
      contractId: contract.id,
      at: new Date().toISOString(),
      preparation: {
        kind: "prepared" as const,
        data: { gate: gate("reviewed"), subject, verdict: "satisfied" as const },
      },
    }, decideAttestation);
    assert.equal(attested.kind, "accepted");

    const observation = await observeContractsForAdmissionAt(git, channel, [contract.id]);
    const attempt = mintAttempts({ entryCount: 2 })[0]!;
    const decision = decidePlacement({
      input: { contractId: contract.id, at: new Date().toISOString() },
      attempt,
      observation: observation.decision,
    });
    assert.equal(decision.kind, "offer");
    if (decision.kind !== "offer") assert.fail("expected placement offer");
    const admitted = await admitDecidedOffer({
      channel,
      repository: git,
      decisionObservation: observation,
      attempt,
      offer: decision.offer,
      primaryContract: contract.id,
    });
    assert.equal(admitted.kind, "accepted");
  });
}

test("reconcile completes an ordinary follow interrupted after atomic publication", async () => {
  const repository = repositoryWithMain();
  const candidate = await managedCandidate(repository, ["reviewed"]);
  await admitClaimWithoutFollow(repository, candidate.contract);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "base\n");

  const reconciled = await withGitShim(
    [
      "for argument do",
      "  case \"$argument\" in *'^{tree}'*) exit 97 ;; esac",
      "done",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    () => candidate.contract.reconcile(),
  );

  assert.deepEqual(reconciled.lag, []);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(repository.run(["status", "--porcelain"]), "");
  assert.ok(reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
});

test("reconcile recognizes a completed ordinary follow despite unrelated staged and unstaged bytes", async () => {
  const repository = repositoryWithMain();
  const candidate = await managedCandidate(repository, ["reviewed"]);
  await admitClaimWithoutFollow(repository, candidate.contract);
  const delivery = (await observeContract(repositoryAt(repository.path), candidate.contract.id)).state?.delivery?.data;
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
  const repository = repositoryWithMain();
  const candidate = await managedCandidate(repository, ["reviewed"]);
  writeFileSync(resolve(repository.path, "local.txt"), "staged local\n");
  repository.run(["add", "local.txt"]);
  const stagedPatch = repository.run(["diff", "--cached", "--", "local.txt"]);
  await admitClaimWithoutFollow(repository, candidate.contract);
  const delivery = (await observeContract(repositoryAt(repository.path), candidate.contract.id)).state?.delivery?.data;
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

test("reconcile completes a dirty here index alignment interrupted after atomic publication", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document("Interrupted here placement"),
    workspace: "here",
    target: "main",
    gates: ["reviewed"],
  });
  writeFileSync(resolve(repository.path, "delivered.txt"), "staged candidate\n");
  repository.run(["add", "delivered.txt"]);
  writeFileSync(resolve(repository.path, "local.txt"), "unstaged candidate\n");
  writeFileSync(resolve(repository.path, "untracked.txt"), "untracked candidate\n");
  await admitClaimWithoutFollow(repository, bound.keiyaku);
  assert.notEqual(repository.run(["status", "--porcelain"]), "");

  const reconciled = await bound.keiyaku.reconcile();

  assert.deepEqual(reconciled.lag, []);
  assert.equal(repository.run(["status", "--porcelain"]), "");
  assert.ok(reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
});

test("reconcile independently recovers here and ordinary checkouts of one target", async () => {
  const repository = repositoryWithMain();
  const checkout = `${repository.path}-forced-main-checkout`;
  repository.run(["worktree", "add", "--force", "--quiet", checkout, "main"]);
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document("Interrupted multiple-checkout here placement"),
    workspace: "here",
    target: "main",
    gates: ["reviewed"],
  });
  writeFileSync(resolve(repository.path, "delivered.txt"), "candidate\n");
  await admitClaimWithoutFollow(repository, bound.keiyaku);

  const reconciled = await bound.keiyaku.reconcile();

  assert.deepEqual(reconciled.lag, []);
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(resolve(checkout, "delivered.txt"), "utf8"), "candidate\n");
  assert.equal(repository.run(["status", "--porcelain"]), "");
  assert.equal(repository.run(["-C", checkout, "status", "--porcelain"]), "");
  assert.equal(reconciled.effects.filter((effect) =>
    effect.kind === "target-checkout" && effect.action === "recovered").length, 2);
});

test("reconcile identifies a dirty here source by checkout shape instead of invocation path", async () => {
  const repository = repositoryWithMain();
  const checkout = `${repository.path}-reconcile-caller`;
  repository.run(["worktree", "add", "--force", "--quiet", checkout, "main"]);
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document("Shape-proven here recovery"),
    workspace: "here",
    target: "main",
    gates: ["reviewed"],
  });
  writeFileSync(resolve(repository.path, "delivered.txt"), "staged candidate\n");
  repository.run(["add", "delivered.txt"]);
  writeFileSync(resolve(repository.path, "local.txt"), "unstaged candidate\n");
  writeFileSync(resolve(repository.path, "untracked.txt"), "untracked candidate\n");
  await admitClaimWithoutFollow(repository, bound.keiyaku);

  const reconciled = await Keiyaku.of({ repo: Repo.at({ path: checkout }), id: bound.keiyaku.id }).reconcile();

  assert.deepEqual(reconciled.lag, []);
  assert.equal(repository.run(["status", "--porcelain"]), "");
  assert.equal(repository.run(["-C", checkout, "status", "--porcelain"]), "");
  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "staged candidate\n");
  assert.equal(readFileSync(resolve(checkout, "delivered.txt"), "utf8"), "staged candidate\n");
  assert.equal(reconciled.effects.filter((effect) =>
    effect.kind === "target-checkout" && effect.action === "recovered").length, 2);
});

test("reconcile does not guess after the user changes an interrupted target checkout", async () => {
  const repository = repositoryWithMain();
  const candidate = await managedCandidate(repository, ["reviewed"]);
  await admitClaimWithoutFollow(repository, candidate.contract);
  writeFileSync(resolve(repository.path, "delivered.txt"), "changed after publication\n");

  const reconciled = await candidate.contract.reconcile();

  assert.equal(readFileSync(resolve(repository.path, "delivered.txt"), "utf8"), "changed after publication\n");
  assert.ok(reconciled.lag.some((lag) => lag.kind === "target-checkout-retained"));
  assert.ok(!reconciled.effects.some((effect) => effect.kind === "target-checkout" && effect.action === "recovered"));
});
