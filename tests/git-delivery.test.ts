import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { prepareDelivery, prepareReview } from "../src/protocol/operations.js";
import { actorId } from "../src/core/facts/types.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { adjudicateAuditTarget, observeTargetPlacement } from "../src/git/target-placement.js";
import { readRef, repositoryAt } from "../src/git/repository.js";
import { readDeliveryDiff } from "../src/git/integration.js";
import { materializeScratchCandidate } from "../src/git/scratch.js";
import { reconcile } from "../src/git/reconcile.js";
import { worktreePath } from "../src/git/workspace.js";
import {
  AuthorityCorruptionError,
  Keiyaku,
  Repo,
  type ContractId,
  type TopologyEffect,
} from "../src/index.js";
import { deliveryDiffOperation, scopeOperation } from "../src/protocol/operations.js";
import { appointedWorktreePath, makeGitRepository, observeContract, type TestGitRepository, withGitShim } from "./support/git.js";

function contractBody(): string {
  return [
    "# Delivery patch identity",
    "",
    "## Context",
    "Exercise Git-backed delivery preparation.",
    "",
    "## Objective",
    "Keep patch-content identity independent of commit identity.",
    "",
    "## Design",
    "Prepare a targetless delivery from the current worktree.",
    "",
    "## Region",
    "~~~",
    "src/git/**",
    "~~~",
    "",
    "## Criteria",
    "### Patch identity",
    "Equal patch bytes have one ChangeId.",
  ].join("\n");
}

function preparationCoordinates(state: NonNullable<Awaited<ReturnType<typeof observeContract>>["state"]>) {
  return { contractId: state.id, coordinates: state.coordinates };
}

async function boundContract(): Promise<Readonly<{ repository: TestGitRepository; id: ContractId }>> {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  return { repository, id: (await bound.keiyaku.state()).id };
}

async function preparedDelivery(repository: TestGitRepository, id: ContractId) {
  const state = (await observeContract(await repositoryAt(repository.path), id)).state;
  if (state === null) throw new Error("contract was not observed");
  const prepared = await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  return prepared.data;
}

function deliveryRefFor(contract: ContractId): string {
  return `refs/heads/keiyaku-delivery/kei-${contract.slice("kei/".length)}`;
}

function candidatePinRefFor(contract: ContractId): string {
  return `refs/heads/keiyaku-candidate/kei-${contract.slice("kei/".length)}`;
}

function recoverySnapshot(effects: readonly TopologyEffect[]): string {
  const recovery = effects.find((effect) => effect.kind === "recovery-snapshot");
  assert.ok(recovery);
  return recovery.snapshot;
}

function commitMessage(repository: TestGitRepository, commit: string): string {
  const object = repository.run(["cat-file", "commit", commit]);
  const separator = object.indexOf("\n\n");
  if (separator < 0) throw new Error("commit object has no message separator");
  return object.slice(separator + 2);
}

function commitSignature(repository: TestGitRepository, commit: string): readonly string[] {
  return repository.run([
    "show",
    "-s",
    "--format=%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI",
    commit,
  ]).trim().split("\0");
}

async function targetedContract() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    target: "refs/heads/main",
  });
  const state = await bound.keiyaku.state();
  return {
    contract: bound.keiyaku,
    repository,
    state,
    worktree: await appointedWorktreePath(await repositoryAt(repository.path), state.id),
  };
}

async function directoryReplacementContract(ignore = "artifact/*.tmp\n") {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  mkdirSync(join(repository.path, "artifact"));
  writeFileSync(join(repository.path, ".gitignore"), ignore);
  writeFileSync(join(repository.path, "artifact", "tracked.txt"), "tracked\n");
  repository.run(["add", ".gitignore", "artifact/tracked.txt"]);
  repository.run(["commit", "--quiet", "-m", "tracked directory"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    target: "refs/heads/main",
  });
  const state = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), state.id);
  repository.run(["-C", worktree, "rm", "-r", "artifact"]);
  writeFileSync(join(worktree, "artifact"), "candidate file\n");
  repository.run(["-C", worktree, "add", "artifact"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "replace directory"]);
  return { contract: bound.keiyaku, repository, worktree };
}

test("permissive targeted delivery integrates tender bytes over the observed target head", async () => {
  const { repository, state, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "target.txt"), "target advance\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "tender.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "tender.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender"]);
  const tenderHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const git = await repositoryAt(repository.path);
  const review = await prepareReview(git, preparationCoordinates(state));
  const delivery = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Integrated delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  });
  assert.equal(review.kind, "prepared");
  assert.equal(delivery.kind, "prepared");
  if (review.kind !== "prepared" || delivery.kind !== "prepared") return;
  assert.equal(delivery.data.tenderSnapshot, tenderHead);
  assert.equal(delivery.data.integration.predecessor, targetHead);
  assert.equal(delivery.data.integration.changeId, review.data.changeId);
  assert.equal(repository.run(["rev-parse", `${delivery.data.integration.snapshot}^`]).trim(), targetHead);
  assert.equal(repository.run(["show", `${delivery.data.integration.snapshot}:target.txt`]), "target advance\n");
  assert.equal(repository.run(["show", `${delivery.data.integration.snapshot}:tender.txt`]), "tender\n");
});

test("strict targeted delivery refuses a tender not based on the target head", async () => {
  const { repository, state } = await targetedContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "advance target"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  assert.deepEqual(await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Strict delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: true,
  }), {
    kind: "refused",
    refusal: {
      kind: "integration-failed",
      contractId: state.id,
      reason: "not-based-on-target",
      targetHead,
    },
  });
});

test("targeted integration conflict returns structured paths", async () => {
  const { repository, state, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  assert.deepEqual(await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Conflicted delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  }), {
    kind: "refused",
    refusal: {
      kind: "integration-failed",
      contractId: state.id,
      reason: "conflict",
      targetHead,
      conflictPaths: ["shared.txt"],
    },
  });
});

test("rebasing a managed tender onto the current target resolves its integration base", async () => {
  const { repository, state, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();

  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const before = await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Conflicted delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  });
  assert.equal(before.kind, "refused");

  assert.throws(() => repository.run([
    "-C", worktree, "rebase", "--onto", targetHead, state.coordinates.start,
  ]));
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "-c", "core.editor=true", "rebase", "--continue"]);
  const after = await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Rebased delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  });
  assert.equal(after.kind, "prepared");
  if (after.kind !== "prepared") return;
  assert.equal(after.data.integration.predecessor, targetHead);
  assert.equal(repository.run(["show", `${after.data.integration.snapshot}:shared.txt`]), "tender\n");
});

test("targeted integration refuses unrelated histories without invoking merge-tree", async () => {
  const { repository, state, worktree } = await targetedContract();
  repository.run(["-C", worktree, "checkout", "--orphan", "unrelated"]);
  repository.run(["-C", worktree, "rm", "--quiet", "-rf", "."]);
  writeFileSync(join(worktree, "unrelated.txt"), "unrelated\n");
  repository.run(["-C", worktree, "add", "unrelated.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "unrelated"]);
  const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const prepared = await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Unrelated delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  });
  assert.deepEqual(prepared, {
    kind: "refused",
    refusal: {
      kind: "integration-failed",
      contractId: state.id,
      reason: "unrelated-histories",
      targetHead,
    },
  });
});

test("permissive integration reports unsupported Git while strict policy needs no merge-tree", async () => {
  const { repository, state } = await targetedContract();
  const shim = [
    'if [ "$1" = "merge-tree" ]; then',
    '  printf "unsupported merge-tree\n" >&2',
    '  exit 129',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const permissive = await withGitShim(shim, {}, async () => await prepareDelivery(
    await repositoryAt(repository.path),
    preparationCoordinates(state),
    { title: "Permissive", document: contractBody(), requireBranchesToBeUpToDate: false },
  ));
  assert.deepEqual(permissive, {
    kind: "refused",
    refusal: { kind: "integration-unsupported", contractId: state.id, requiredGit: "2.38" },
  });
  const strict = await withGitShim(shim, {}, async () => await prepareDelivery(
    await repositoryAt(repository.path),
    preparationCoordinates(state),
    { title: "Strict", document: contractBody(), requireBranchesToBeUpToDate: true },
  ));
  assert.equal(strict.kind, "prepared");
});

test("Git materialization uses the appointed Place basename", async () => {
  const repository = makeGitRepository();
  assert.equal(basename(worktreePath(await repositoryAt(repository.path), "atlantis")), "atlantis");
});

test("dirty delivery materializes a candidate without changing the caller index", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "dirty candidate\n");
  const git = await repositoryAt(repository.path);
  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("contract was not observed");
  const review = await prepareReview(git, preparationCoordinates(state));
  assert.equal(review.kind, "prepared");
  if (review.kind !== "prepared") throw new Error("review preparation was refused");
  assert.equal("documentKey" in review, false);
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);

  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Patch identity",
    document: contractBody(),
    includeDirty: true,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  assert.equal(prepared.data.integration.changeId, review.data.changeId);
  assert.deepEqual(review.data.workspace, {
    staged: [],
    unstaged: [],
    untracked: ["candidate.txt"],
    shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
  });
  assert.equal(repository.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]), /kei\/.*: Patch identity/);
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]), /Keiyaku-Contract: /);
});

test("one preparation freezes Contract content, actor identity, and dates across tender and integration", async () => {
  const { repository, state, worktree } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "dirty candidate\n");
  const document = `${contractBody()}\n\n`;
  const expectedAt = repository.run(["-C", worktree, "show", "-s", "--format=%cI", "HEAD"]).trim();
  const prepared = await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Ignored default subject",
    document,
    actor: actorId("Release Bot"),
    message: "Chosen subject",
    includeDirty: true,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") return;

  const commits = [prepared.data.tenderSnapshot, prepared.data.integration.snapshot];
  const expectedMessage = `Chosen subject\n\n${contractBody()}\n\nKeiyaku-Contract: ${state.id}\n`;
  for (const commit of commits) {
    assert.equal(commitMessage(repository, commit), expectedMessage);
    const [author, authorEmail, committer, committerEmail, authoredAt, committedAt] = commitSignature(
      repository,
      commit,
    );
    assert.deepEqual([author, authorEmail, committer, committerEmail], [
      "Release Bot",
      "keiyaku@localhost",
      "Release Bot",
      "keiyaku@localhost",
    ]);
    assert.equal(authoredAt, committedAt);
    assert.equal(authoredAt, expectedAt);
  }
  assert.deepEqual(commitSignature(repository, commits[0]), commitSignature(repository, commits[1]));
});

test("materialized delivery identity uses the complete repository pair or the neutral fallback", async () => {
  const configured = await boundContract();
  writeFileSync(join(configured.repository.path, "configured.txt"), "configured\n");
  const configuredState = (await observeContract(await repositoryAt(configured.repository.path), configured.id)).state;
  if (configuredState === null) throw new Error("configured contract was not observed");
  const configuredDelivery = await prepareDelivery(
    await repositoryAt(configured.repository.path),
    preparationCoordinates(configuredState),
    { title: "Configured", document: contractBody(), includeDirty: true },
  );
  assert.equal(configuredDelivery.kind, "prepared");
  if (configuredDelivery.kind !== "prepared") return;
  assert.deepEqual(commitSignature(configured.repository, configuredDelivery.data.tenderSnapshot).slice(0, 4), [
    "Test User",
    "test@example.com",
    "Test User",
    "test@example.com",
  ]);

  const incomplete = await boundContract();
  incomplete.repository.run(["config", "--unset", "user.email"]);
  writeFileSync(join(incomplete.repository.path, "fallback.txt"), "fallback\n");
  const incompleteState = (await observeContract(await repositoryAt(incomplete.repository.path), incomplete.id)).state;
  if (incompleteState === null) throw new Error("incomplete contract was not observed");
  const fallback = await withGitShim("exec \"$KEIYAKU_REAL_GIT\" \"$@\"", {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  }, async () => await prepareDelivery(
    await repositoryAt(incomplete.repository.path),
    preparationCoordinates(incompleteState),
    { title: "Fallback", document: contractBody(), includeDirty: true },
  ));
  assert.equal(fallback.kind, "prepared");
  if (fallback.kind !== "prepared") return;
  assert.deepEqual(commitSignature(incomplete.repository, fallback.data.tenderSnapshot).slice(0, 4), [
    "Keiyaku",
    "keiyaku@localhost",
    "Keiyaku",
    "keiyaku@localhost",
  ]);
  assert.deepEqual(commitSignature(incomplete.repository, "refs/heads/keiyaku-state").slice(0, 2), [
    "Keiyaku Git",
    "keiyaku@localhost",
  ]);
});

test("dirty delivery refuses classified paths unless the complete workspace is authorized", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repository.path, "staged.txt"), "staged\n");
  repository.run(["add", ".gitignore", "staged.txt"]);
  repository.run(["commit", "--quiet", "-m", "tracked inputs"]);
  writeFileSync(join(repository.path, "staged.txt"), "staged final\n");
  repository.run(["add", "staged.txt"]);
  writeFileSync(join(repository.path, "staged.txt"), "unstaged final\n");
  writeFileSync(join(repository.path, "untracked.txt"), "untracked\n");
  writeFileSync(join(repository.path, "ignored.txt"), "ignored\n");
  const git = await repositoryAt(repository.path);
  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("contract was not observed");
  const headBefore = repository.run(["rev-parse", "HEAD"]);
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);
  const statusBefore = repository.run(["status", "--porcelain=v2", "--untracked-files=all"]);

  assert.deepEqual(await prepareDelivery(git, preparationCoordinates(state), {
    title: "Explicit dirty",
    document: contractBody(),
  }), {
    kind: "refused",
    refusal: {
      kind: "dirty-workspace",
      contractId: id,
      staged: ["staged.txt"],
      unstaged: ["staged.txt"],
      untracked: ["untracked.txt"],
      submodules: [],
      shortStat: { filesChanged: 2, insertions: 2, deletions: 1 },
    },
  });
  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Explicit dirty",
    document: contractBody(),
    includeDirty: true,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") return;
  assert.equal(repository.run(["show", `${prepared.data.tenderSnapshot}:staged.txt`]), "unstaged final\n");
  assert.equal(repository.run(["show", `${prepared.data.tenderSnapshot}:untracked.txt`]), "untracked\n");
  assert.throws(() => repository.run(["show", `${prepared.data.tenderSnapshot}:ignored.txt`]));
  assert.equal(repository.run(["rev-parse", "HEAD"]), headBefore);
  assert.equal(repository.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.equal(repository.run(["status", "--porcelain=v2", "--untracked-files=all"]), statusBefore);
});

test("target placement ignores a large unrelated ignored population", async () => {
  const { contract, repository, worktree } = await targetedContract();
  writeFileSync(join(repository.path, ".gitignore"), "node_modules/\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore dependencies"]);
  const dependencies = join(repository.path, "node_modules", "package");
  mkdirSync(dependencies, { recursive: true });
  for (let index = 0; index < 30_100; index += 1) {
    writeFileSync(join(dependencies, `module-${index}.js`), "x");
  }
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement, undefined);
  assert.equal(readFileSync(join(repository.path, "candidate.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(join(dependencies, "module-30099.js"), "utf8"), "x");
});

test("a deep candidate write does not observe ignored sibling contents", async () => {
  const { contract, repository, worktree } = await targetedContract();
  writeFileSync(join(repository.path, ".gitignore"), "artifact/cache/\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore cache"]);
  const cache = join(repository.path, "artifact", "cache");
  mkdirSync(cache, { recursive: true });
  for (let index = 0; index < 5_000; index += 1) {
    writeFileSync(join(cache, `entry-${index}.tmp`), "cache");
  }
  mkdirSync(join(worktree, "artifact", "deep"), { recursive: true });
  writeFileSync(join(worktree, "artifact", "deep", "result.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "artifact/deep/result.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "deep candidate"]);

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement, undefined);
  assert.equal(readFileSync(join(repository.path, "artifact", "deep", "result.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(join(cache, "entry-4999.tmp"), "utf8"), "cache");
});

test("target placement observation reports checkout collisions without moving the target", async () => {
  const { contract, repository, worktree, state } = await targetedContract();
  const collision = "literal[1].tmp";
  writeFileSync(join(repository.path, ".gitignore"), "literal*.tmp\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore literal candidate"]);
  writeFileSync(join(repository.path, collision), "local\n");
  writeFileSync(join(worktree, collision), "candidate\n");
  repository.run(["-C", worktree, "add", collision]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "literal candidate"]);
  const git = await repositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);
  const worktreeBefore = repository.run(["status", "--porcelain=v1", "--untracked-files=all"]);

  const targetName = state.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) return;
  const observed = await observeTargetPlacement(git, {
    contractId: state.id,
    coordinates: { ...state.coordinates, target: targetName },
    predecessor: mintSnapshotId(target),
    candidate: prepared.data.integration.snapshot,
  });

  assert.equal(observed.kind, "refused");
  if (observed.kind !== "refused") return;
  assert.equal(observed.refusal.kind, "checkout-not-followable");
  if (observed.refusal.kind !== "checkout-not-followable") return;
  assert.equal(observed.refusal.reason, "untracked");
  assert.deepEqual(observed.refusal.paths, [collision]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(repository.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.equal(repository.run(["status", "--porcelain=v1", "--untracked-files=all"]), worktreeBefore);
  assert.equal(readFileSync(join(repository.path, collision), "utf8"), "local\n");

  const delivered = await contract.deliver();
  assert.deepEqual(delivered.value.placement?.refusal, observed.refusal);
});

test("target placement observation reports a ready targeted candidate without following it", async () => {
  const { repository, worktree, state } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await repositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const targetName = state.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) return;
  const observed = await observeTargetPlacement(git, {
    contractId: state.id,
    coordinates: { ...state.coordinates, target: targetName },
    predecessor: mintSnapshotId(target),
    candidate: prepared.data.integration.snapshot,
  });

  assert.equal(observed.kind, "ready");
  if (observed.kind !== "ready") return;
  assert.deepEqual(observed.arms.map((arm) => arm.kind), ["ordinary"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(existsSync(join(repository.path, "candidate.txt")), false);
});

test("audit target adjudicator reports initial movement without observing followability", async () => {
  const { repository, worktree, state } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await repositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const targetName = state.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) return;
  const expected = prepared.data.integration.predecessor;
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "move-target"]);
  const observed = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const answer = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  printf "followability must not run after initial movement\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    () => adjudicateAuditTarget(git, {
      contractId: state.id,
      coordinates: { ...state.coordinates, target: targetName },
      predecessor: expected,
      candidate: prepared.data.integration.snapshot,
    }),
  );

  assert.deepEqual(answer, {
    kind: "moved",
    ref: "refs/heads/main",
    expected,
    observed,
  });
});

test("audit target adjudicator reobserves movement after followability", async () => {
  const { repository, worktree, state } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await repositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const targetName = state.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) return;
  const expected = prepared.data.integration.predecessor;

  const answer = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  "$KEIYAKU_REAL_GIT" -C "$KEIYAKU_TEST_REPO" commit --allow-empty --quiet -m move-during-follow',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_TEST_REPO: repository.path },
    () => adjudicateAuditTarget(git, {
      contractId: state.id,
      coordinates: { ...state.coordinates, target: targetName },
      predecessor: expected,
      candidate: prepared.data.integration.snapshot,
    }),
  );

  const observed = repository.run(["rev-parse", "refs/heads/main"]).trim();
  assert.notEqual(observed, expected);
  assert.deepEqual(answer, {
    kind: "moved",
    ref: "refs/heads/main",
    expected,
    observed,
  });
});

test("ignored custody treats candidate metacharacters as a literal path", async () => {
  const { contract, repository, worktree } = await targetedContract();
  const collision = "literal[1].tmp";
  writeFileSync(join(repository.path, ".gitignore"), "literal*.tmp\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore literal candidate"]);
  writeFileSync(join(repository.path, collision), "local\n");
  writeFileSync(join(worktree, collision), "candidate\n");
  repository.run(["-C", worktree, "add", collision]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "literal candidate"]);
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, [collision]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(readFileSync(join(repository.path, collision), "utf8"), "local\n");
});

test("ignored custody stops at an ignored physical ancestor leaf", async () => {
  const { contract, repository, worktree } = await targetedContract();
  writeFileSync(join(repository.path, ".gitignore"), "artifact\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore ancestor"]);
  writeFileSync(join(repository.path, "artifact"), "local leaf\n");
  mkdirSync(join(worktree, "artifact"));
  writeFileSync(join(worktree, "artifact", "result.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "artifact/result.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "replace ancestor"]);

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["artifact"]);
  assert.equal(readFileSync(join(repository.path, "artifact"), "utf8"), "local leaf\n");
});

test("ignored custody treats a symlink ancestor as a leaf", async () => {
  const { contract, repository, worktree } = await targetedContract();
  writeFileSync(join(repository.path, ".gitignore"), "link\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore symlink"]);
  mkdirSync(join(repository.path, "elsewhere"));
  writeFileSync(join(repository.path, "elsewhere", "retained.txt"), "retained\n");
  symlinkSync("elsewhere", join(repository.path, "link"));
  mkdirSync(join(worktree, "link"));
  writeFileSync(join(worktree, "link", "result.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "link/result.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "replace symlink"]);

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.deepEqual(delivered.value.placement.refusal.paths, ["link"]);
  assert.equal(readFileSync(join(repository.path, "elsewhere", "retained.txt"), "utf8"), "retained\n");
});

test("a clean tracked directory may be replaced by a candidate file", async () => {
  const { contract, repository } = await directoryReplacementContract();

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement, undefined);
  assert.equal(readFileSync(join(repository.path, "artifact"), "utf8"), "candidate file\n");
});

test("a displaced directory with large ignored contents refuses at the directory", async () => {
  const { contract, repository } = await directoryReplacementContract();
  for (let index = 0; index < 4_400; index += 1) {
    const name = `ignored-${String(index).padStart(4, "0")}-${"x".repeat(220)}.tmp`;
    writeFileSync(join(repository.path, "artifact", name), "ignored\n");
  }
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["artifact"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(readFileSync(join(repository.path, "artifact", "tracked.txt"), "utf8"), "tracked\n");
});

test("a displaced directory with large untracked contents refuses at the directory", async () => {
  const { contract, repository } = await directoryReplacementContract("");
  for (let index = 0; index < 4_400; index += 1) {
    const name = `untracked-${String(index).padStart(4, "0")}-${"x".repeat(220)}.txt`;
    writeFileSync(join(repository.path, "artifact", name), "untracked\n");
  }
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const delivered = await contract.deliver();

  assert.equal(delivered.value.placement?.refusal?.kind, "checkout-not-followable");
  if (delivered.value.placement?.refusal?.kind !== "checkout-not-followable") return;
  assert.equal(delivered.value.placement.refusal.reason, "untracked");
  assert.deepEqual(delivered.value.placement.refusal.paths, ["artifact"]);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(readFileSync(join(repository.path, "artifact", "tracked.txt"), "utf8"), "tracked\n");
});

test("a failed displaced-directory observation leaves the target untouched", async () => {
  const { contract, repository } = await directoryReplacementContract();
  writeFileSync(join(repository.path, "artifact", "ignored.tmp"), "ignored\n");
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const delivered = await withGitShim(
    [
      "if [ \"$1\" = \"-C\" ] && [ \"$3\" = \"ls-files\" ]; then",
      "  for argument do",
      "    if [ \"$argument\" = \"--ignored\" ]; then",
      "      printf 'forced ignored observation failure\\n' >&2",
      "      exit 9",
      "    fi",
      "  done",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    () => contract.deliver(),
  );

  assert.equal(delivered.value.placement?.failure, "target-placement-failed");
  if (delivered.value.placement?.failure === "target-placement-failed") {
    assert.match(delivered.value.placement.diagnostic, /forced ignored observation failure/);
  }
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(readFileSync(join(repository.path, "artifact", "ignored.tmp"), "utf8"), "ignored\n");
});

test("review observes dirty bytes but refuses dirty submodule internals", async () => {
  const child = makeGitRepository();
  child.run(["config", "user.name", "Test User"]);
  child.run(["config", "user.email", "test@example.com"]);
  writeFileSync(join(child.path, "child.txt"), "child\n");
  child.run(["add", "child.txt"]);
  child.run(["commit", "--quiet", "-m", "child"]);
  const { repository, id } = await boundContract();
  repository.run(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child.path, "module"]);
  repository.run(["commit", "--quiet", "-am", "submodule"]);
  writeFileSync(join(repository.path, "module", "child.txt"), "dirty child\n");
  const git = await repositoryAt(repository.path);
  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("contract was not observed");
  const expected = {
    kind: "refused" as const,
    refusal: {
      kind: "dirty-workspace" as const,
      contractId: id,
      staged: [],
      unstaged: ["module"],
      untracked: [],
      submodules: ["module"],
      shortStat: { filesChanged: 0, insertions: 0, deletions: 0 },
    },
  };

  assert.deepEqual(await prepareReview(git, preparationCoordinates(state)), expected);
  assert.deepEqual(await prepareDelivery(git, preparationCoordinates(state), {
    title: "Submodule",
    document: contractBody(),
    includeDirty: true,
  }), expected);
});

test("delivery preparation refuses an unregistered directory at the managed worktree path", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  const state = await bound.keiyaku.state();
  const git = await repositoryAt(repository.path);
  const path = await appointedWorktreePath(git, state.id);
  repository.run(["worktree", "remove", path]);
  mkdirSync(path, { recursive: true });
  repository.run(["-C", path, "init", "--quiet"]);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "foreign"]);

  assert.deepEqual(await prepareReview(git, preparationCoordinates(state)), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
  assert.deepEqual(await prepareDelivery(git, preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  }), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
});

test("reconcile recreates a registered managed worktree whose directory disappeared", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  renameSync(path, `${path}-moved`);

  const repaired = await bound.keiyaku.reconcile();

  assert.equal(existsSync(path), true);
  assert.equal(repaired.effects.some((effect) => effect.kind === "worktree" && effect.action === "created"), true);
});

test("managed bind preserves its admitted Contract when worktree reconciliation fails", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const result = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
      '  printf "forced managed worktree failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async () => Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" }),
  );
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bind"]);
  assert.notEqual(result.head, null);
  assert.deepEqual(result.effects.map((effect) => [effect.kind, effect.action]), [["ref", "created"]]);
  assert.equal(result.lags[0]?.kind, "reconcile-failed");
  if (result.lags[0]?.kind === "reconcile-failed") {
    assert.equal(result.lags[0].stage, "effect");
    assert.match(result.lags[0].diagnostic, /forced managed worktree failure/);
  }
  assert.deepEqual(result.settlement, { actions: [], lags: [] });
  const state = await result.keiyaku.state();
  assert.equal(state.id, result.facts[0]?.contract);
  assert.equal(state.head, result.head);
  assert.equal(state.terminal, null);
  const observation = await Keiyaku.observe({ repo: await Repo.at({ path: repository.path }), id: state.id });
  assert.equal(observation.kind, "present");
});

test("distinct no-op candidates share the empty patch ChangeId", async () => {
  const { repository, id } = await boundContract();

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "first no-op"]);
  const first = await preparedDelivery(repository, id);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "second no-op"]);
  const second = await preparedDelivery(repository, id);

  assert.notEqual(first.integration.snapshot, second.integration.snapshot);
  assert.equal(first.integration.changeId, second.integration.changeId);
});

test("clean delivery resolves its workspace head and tree in one Git call", async () => {
  const { repository, id } = await boundContract();
  const state = (await observeContract(await repositoryAt(repository.path), id)).state;
  if (state === null) throw new Error("contract was not observed");
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");
  const prepared = await withGitShim(
    [
      "for argument do",
      "  case \"$argument\" in *'^{tree}'*) exit 97 ;; esac",
      "done",
      "if [ \"$1\" = \"-C\" ] && [ \"$3\" = \"show\" ]; then",
      "  printf '%s|%s|%s|%s\\n' \"$3\" \"$4\" \"$5\" \"$6\" >> \"$KEIYAKU_GIT_CALLS\"",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    async () => await prepareDelivery(await repositoryAt(repository.path), preparationCoordinates(state), {
      title: "Delivery patch identity",
      document: contractBody(),
    }),
  );

  assert.equal(prepared.kind, "prepared");
  assert.equal(readFileSync(calls, "utf8"), "show|-s|--format=%H%n%T%n%cI|HEAD\n");
});

test("delivery diff preserves an empty patch and treats a clean missing object as Git absence", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = await preparedDelivery(repository, id);
  const git = await repositoryAt(repository.path);

  assert.equal(await readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot), "");
  assert.equal(await deliveryDiffOperation({
    scope: await scopeOperation({ coordinate: repository.path }),
    integrationPredecessor: delivery.integration.predecessor,
    integrationSnapshot: delivery.integration.snapshot,
  }), "");
  assert.equal(await readDeliveryDiff(git, delivery.integration.predecessor, mintSnapshotId("0".repeat(40))), null);
});

test("delivery diff checks both snapshots in one batch process", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = await preparedDelivery(repository, id);
  const git = await repositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");

  const result = await withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ]; then printf 'batch-check\\n' >> \"$KEIYAKU_GIT_CALLS\"; fi",
      "if [ \"$1\" = \"diff\" ]; then printf 'diff\\n' >> \"$KEIYAKU_GIT_CALLS\"; fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    async () => await readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot),
  );

  assert.equal(result, "");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff"]);
});

test("delivery diff rejects a recorded non-commit object", async () => {
  const { repository, id } = await boundContract();
  const delivery = await preparedDelivery(repository, id);
  const blob = mintSnapshotId(repository.run(["hash-object", "-w", "--stdin"], "not a commit\n").trim());

  await assert.rejects(
    async () => readDeliveryDiff(await repositoryAt(repository.path), delivery.integration.predecessor, blob),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === "recorded delivery snapshot is not a Git commit",
  );
});

test("delivery diff rechecks one batch for a pruning race", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = await preparedDelivery(repository, id);
  const git = await repositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");
  const pruned = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-pruned-")), "marker");

  const result = await withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ]; then",
      "  printf 'batch-check\\n' >> \"$KEIYAKU_GIT_CALLS\"",
      "  if [ -e \"$KEIYAKU_PRUNED_MARKER\" ]; then",
      "    IFS= read -r predecessor",
      "    IFS= read -r candidate",
      "    printf '%s commit\\n%s missing\\n' \"$predecessor\" \"$candidate\"",
      "    exit 0",
      "  fi",
      "fi",
      "if [ \"$1\" = \"diff\" ]; then",
      "  printf 'diff\\n' >> \"$KEIYAKU_GIT_CALLS\"",
      "  : > \"$KEIYAKU_PRUNED_MARKER\"",
      "  printf '%s\\n' 'fatal: object pruned' >&2",
      "  exit 128",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls, KEIYAKU_PRUNED_MARKER: pruned },
    async () => await readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot),
  );

  assert.equal(result, null);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff", "batch-check"]);
});

test("delivery diff leaves probe diagnostics as Git errors", async () => {
  const { repository, id } = await boundContract();
  const delivery = await preparedDelivery(repository, id);

  await withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ]; then",
      "  printf '%s\\n' 'error: corrupt object' >&2",
      "  exit 128",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    async () => {
      await assert.rejects(
        async () => readDeliveryDiff(await repositoryAt(repository.path), delivery.integration.predecessor, delivery.integration.snapshot),
        (error: unknown) => error instanceof Error && error.message.startsWith("cat-file"),
      );
    },
  );
});

test("targetless terminal cleanup retains tender custody for Delivery.diff", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const predecessor = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });

  await bound.keiyaku.reconcile();
  const worktreePath = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(worktreePath, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktreePath, "add", "candidate.txt"]);
  repository.run(["-C", worktreePath, "commit", "--quiet", "-m", "candidate"]);
  await bound.keiyaku.deliver();
  await bound.keiyaku.reconcile();

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  assert.ok((await bound.keiyaku.state()).terminal);
  assert.equal(reviewed.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);

  repository.run(["reflog", "expire", "--expire=now", "--all"]);
  repository.run(["gc", "--prune=now"]);

  const recovered = await bound.keiyaku.delivery();
  assert.ok(recovered);
  assert.match(await recovered.diff() ?? "", /candidate\.txt/);
});

test("abandon salvages untracked managed-worktree bytes without retaining the worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  writeFileSync(join(path, "untracked-agent-work.txt"), "retain me\n");
  const abandoned = await bound.keiyaku.abandon();
  const recovery = recoverySnapshot(abandoned.effects);

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["show", `${recovery}:untracked-agent-work.txt`]), "retain me\n");
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "--points-at", recovery]), "");
  const id = (await bound.keiyaku.state()).id;
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)), candidate);
  assert.equal(await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)), null);

  repository.run(["prune", "--expire=now"]);
  assert.throws(() => repository.run(["cat-file", "-e", `${recovery}^{commit}`]));
});

test("abandon salvages a later managed-worktree commit without retaining the worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "later agent work"]);
  const later = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const abandoned = await bound.keiyaku.abandon();
  const recovery = recoverySnapshot(abandoned.effects);

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["rev-parse", `${recovery}^`]).trim(), later);
  const id = (await bound.keiyaku.state()).id;
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor(id)), candidate);
  assert.equal(await readRef(await repositoryAt(repository.path), candidatePinRefFor(id)), null);
});

test("abandon retains dirty submodule internals that a recovery snapshot cannot capture", async () => {
  const child = makeGitRepository();
  child.run(["config", "user.name", "Test User"]);
  child.run(["config", "user.email", "test@example.com"]);
  writeFileSync(join(child.path, "child.txt"), "child\n");
  child.run(["add", "child.txt"]);
  child.run(["commit", "--quiet", "-m", "child"]);

  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child.path, "module"]);
  repository.run(["-C", path, "commit", "--quiet", "-am", "submodule"]);
  writeFileSync(join(path, "module", "child.txt"), "dirty child\n");

  const abandoned = await bound.keiyaku.abandon();

  assert.equal(abandoned.effects.some((effect) => effect.kind === "recovery-snapshot"), false);
  const head = mintSnapshotId(repository.run(["-C", path, "rev-parse", "HEAD"]).trim());
  assert.deepEqual(abandoned.lags, [{
    kind: "unsealed-bytes",
    path,
    paths: ["module"],
    head,
  }]);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(join(path, "module", "child.txt"), "utf8"), "dirty child\n");
});

test("terminal reconcile removes a delivered managed worktree reset to its sealed start", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(path, "candidate.txt"), "candidate\n");
  repository.run(["-C", path, "add", "candidate.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "reset", "--hard", start]);

  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(abandoned.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["cat-file", "-e", `${start}^{commit}`]), "");
  assert.equal(repository.run(["cat-file", "-e", `${candidate}^{commit}`]), "");
});

test("terminal reconcile removes dirty deliver bytes over their sealed base HEAD", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(path, "candidate.txt"), "dirty candidate\n");
  const baseHead = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();

  const delivered = await bound.keiyaku.deliver({ includeDirty: true });
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), baseHead);
  assert.deepEqual(delivered.lags, []);
  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(abandoned.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);
  assert.equal(existsSync(path), false);
});

test("abandon salvages an unsealed tender parent without retaining the worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(path, "candidate.txt"), "candidate\n");
  repository.run(["-C", path, "add", "candidate.txt"]);
  const tenderTree = repository.run(["-C", path, "write-tree"]).trim();
  const firstParent = repository.run(["commit-tree", tenderTree, "-p", start], "first parent\n").trim();
  const secondParent = repository.run(["commit-tree", `${start}^{tree}`, "-p", start], "second parent\n").trim();
  const mergeTender = repository.run(["commit-tree", tenderTree, "-p", firstParent, "-p", secondParent], "merge tender\n").trim();
  repository.run(["-C", path, "checkout", "--quiet", "--detach", mergeTender]);
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "reset", "--soft", secondParent]);
  const abandoned = await bound.keiyaku.abandon();
  const recovery = recoverySnapshot(abandoned.effects);

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["rev-parse", `${recovery}^`]).trim(), secondParent);
  assert.equal(repository.run(["show", `${recovery}:candidate.txt`]), "candidate\n");
});

test("a clean no-delivery abandonment releases the managed worktree from its start", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(abandoned.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);
  assert.equal(existsSync(path), false);
  assert.equal(await readRef(await repositoryAt(repository.path), deliveryRefFor((await bound.keiyaku.state()).id)), null);
  assert.equal(repository.run(["cat-file", "-e", `${start}^{commit}`]), "");
});

test("nonempty candidates retain Git start-to-tender ChangeId", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);

  const delivery = await preparedDelivery(repository, id);
  assert.equal(delivery.integration.snapshot, repository.run(["rev-parse", "HEAD"]).trim());
  const patch = repository.run([
    "-c", "core.quotePath=false",
    "-c", "core.abbrev=40",
    "-c", "diff.algorithm=myers",
    "-c", "diff.renames=false",
    "-c", "diff.indentHeuristic=false",
    "-c", "diff.suppressBlankEmpty=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-indent-heuristic",
    "--no-renames",
    "--full-index",
    "--binary",
    "--no-color",
    "--diff-algorithm=myers",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--inter-hunk-context=0",
    "--no-relative",
    "--ignore-submodules=none",
    "--submodule=short",
    `${delivery.integration.predecessor}^{tree}`,
    `${delivery.integration.snapshot}^{tree}`,
  ]);
  const changeId = repository.run(["patch-id", "--verbatim"], patch).trim().split(/\s/, 1)[0];
  assert.equal(delivery.integration.changeId, changeId);
});

test("verification materializes the protocol-selected candidate snapshot", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "candidate"]);
  const candidate = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "later head"]);

  const prepared = await materializeScratchCandidate(await repositoryAt(repository.path), candidate);
  try {
    assert.equal(repository.run(["-C", prepared.cwd, "rev-parse", "HEAD"]).trim(), candidate);
  } finally {
    await prepared.dispose();
  }
});
