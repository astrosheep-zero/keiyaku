import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { prepareDelivery, prepareReview } from "../src/git/delivery.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { readRef, repositoryAt } from "../src/git/repository.js";
import { observeContract } from "../src/git/observe.js";
import { materializeVerificationCandidate, readDeliveryDiff } from "../src/git/verification.js";
import { reconcile } from "../src/git/reconcile.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { contractId } from "../src/core/facts/types.js";
import { AuthorityCorruptionError, Keiyaku, Repo, type ContractId } from "../src/index.js";
import { deliveryDiffOperation, scopeOperation } from "../src/protocol/operations.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

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

function preparationCoordinates(state: NonNullable<ReturnType<typeof observeContract>["state"]>) {
  return { contractId: state.id, coordinates: state.coordinates };
}

async function boundContract(): Promise<Readonly<{ repository: TestGitRepository; id: ContractId }>> {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  return { repository, id: (await bound.keiyaku.state()).id };
}

function preparedDelivery(repository: TestGitRepository, id: ContractId) {
  const state = observeContract(repositoryAt(repository.path), id).state;
  if (state === null) throw new Error("contract was not observed");
  const prepared = prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), { title: "Delivery patch identity" });
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

async function targetedContract() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    target: "refs/heads/main",
  });
  const state = await bound.keiyaku.state();
  return { repository, state, worktree: deliveryWorktreePath(repositoryAt(repository.path), state.id) };
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
  const git = repositoryAt(repository.path);
  const review = prepareReview(git, preparationCoordinates(state));
  const delivery = prepareDelivery(git, preparationCoordinates(state), {
    title: "Integrated delivery",
    requireBranchesToBeUpToDate: false,
  });
  assert.equal(review.kind, "prepared");
  assert.equal(delivery.kind, "prepared");
  if (review.kind !== "prepared" || delivery.kind !== "prepared") return;
  assert.equal(delivery.data.tenderSnapshot, tenderHead);
  assert.equal(delivery.data.integration.predecessor, targetHead);
  assert.equal(delivery.data.integration.changeId, review.data);
  assert.equal(repository.run(["rev-parse", `${delivery.data.integration.snapshot}^`]).trim(), targetHead);
  assert.equal(repository.run(["show", `${delivery.data.integration.snapshot}:target.txt`]), "target advance\n");
  assert.equal(repository.run(["show", `${delivery.data.integration.snapshot}:tender.txt`]), "tender\n");
});

test("strict targeted delivery refuses a tender not based on the target head", async () => {
  const { repository, state } = await targetedContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "advance target"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  assert.deepEqual(prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Strict delivery",
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
  assert.deepEqual(prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Conflicted delivery",
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
  const before = prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Conflicted delivery",
    requireBranchesToBeUpToDate: false,
  });
  assert.equal(before.kind, "refused");

  assert.throws(() => repository.run([
    "-C", worktree, "rebase", "--onto", targetHead, state.coordinates.start,
  ]));
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "-c", "core.editor=true", "rebase", "--continue"]);
  const after = prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Rebased delivery",
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
  const prepared = prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), {
    title: "Unrelated delivery",
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
  const permissive = withGitShim(shim, {}, () => prepareDelivery(
    repositoryAt(repository.path),
    preparationCoordinates(state),
    { title: "Permissive", requireBranchesToBeUpToDate: false },
  ));
  assert.deepEqual(permissive, {
    kind: "refused",
    refusal: { kind: "integration-unsupported", contractId: state.id, requiredGit: "2.38" },
  });
  const strict = withGitShim(shim, {}, () => prepareDelivery(
    repositoryAt(repository.path),
    preparationCoordinates(state),
    { title: "Strict", requireBranchesToBeUpToDate: true },
  ));
  assert.equal(strict.kind, "prepared");
});

test("Git materialization normalizes the complete prefixed identity", () => {
  const repository = makeGitRepository();
  assert.equal(
    basename(deliveryWorktreePath(repositoryAt(repository.path), contractId("kei/con"))),
    "kei-con",
  );
});

test("dirty delivery materializes a candidate without changing the caller index", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "dirty candidate\n");
  const git = repositoryAt(repository.path);
  const state = observeContract(git, id).state;
  if (state === null) throw new Error("contract was not observed");
  const review = prepareReview(git, preparationCoordinates(state));
  assert.equal(review.kind, "prepared");
  if (review.kind !== "prepared") throw new Error("review preparation was refused");
  assert.equal("documentKey" in review, false);
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);

  const prepared = prepareDelivery(git, preparationCoordinates(state), { title: "Patch identity" });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  assert.equal(prepared.data.integration.changeId, review.data);
  assert.equal(repository.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]), /kei\/.*: Patch identity/);
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]), /Keiyaku-Contract: /);
});

test("delivery preparation refuses an unregistered directory at the managed worktree path", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  const state = await bound.keiyaku.state();
  const git = repositoryAt(repository.path);
  const path = deliveryWorktreePath(git, state.id);
  repository.run(["worktree", "remove", path]);
  mkdirSync(path, { recursive: true });
  repository.run(["-C", path, "init", "--quiet"]);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "foreign"]);

  assert.deepEqual(prepareReview(git, preparationCoordinates(state)), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
  assert.deepEqual(prepareDelivery(git, preparationCoordinates(state), { title: "Delivery patch identity" }), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
});

test("reconcile recreates a registered managed worktree whose directory disappeared", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  await bound.keiyaku.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.keiyaku.state()).id);
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
    () => Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" }),
  );
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bind", "bound"]);
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
  const observation = await Keiyaku.observe({ repo: Repo.at({ path: repository.path }), id: state.id });
  assert.equal(observation.kind, "present");
});

test("distinct no-op candidates share the empty patch ChangeId", async () => {
  const { repository, id } = await boundContract();

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "first no-op"]);
  const first = preparedDelivery(repository, id);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "second no-op"]);
  const second = preparedDelivery(repository, id);

  assert.notEqual(first.integration.snapshot, second.integration.snapshot);
  assert.equal(first.integration.changeId, second.integration.changeId);
});

test("clean delivery resolves its workspace head and tree in one Git call", async () => {
  const { repository, id } = await boundContract();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");
  const prepared = withGitShim(
    [
      "if [ \"$1\" = \"-C\" ] && [ \"$3\" = \"rev-parse\" ]; then",
      "  printf '%s|%s|%s\\n' \"$3\" \"$4\" \"$5\" >> \"$KEIYAKU_GIT_CALLS\"",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    () => {
      const state = observeContract(repositoryAt(repository.path), id).state;
      if (state === null) throw new Error("contract was not observed");
      return prepareDelivery(repositoryAt(repository.path), preparationCoordinates(state), { title: "Delivery patch identity" });
    },
  );

  assert.equal(prepared.kind, "prepared");
  assert.equal(readFileSync(calls, "utf8"), "rev-parse|HEAD|HEAD^{tree}\n");
});

test("delivery diff preserves an empty patch and treats a clean missing object as Git absence", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const git = repositoryAt(repository.path);

  assert.equal(readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot), "");
  assert.equal(await deliveryDiffOperation({
    scope: scopeOperation({ coordinate: repository.path }),
    integrationPredecessor: delivery.integration.predecessor,
    integrationSnapshot: delivery.integration.snapshot,
  }), "");
  assert.equal(readDeliveryDiff(git, delivery.integration.predecessor, mintSnapshotId("0".repeat(40))), null);
});

test("delivery diff checks both snapshots in one batch process", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const git = repositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");

  const result = withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ]; then printf 'batch-check\\n' >> \"$KEIYAKU_GIT_CALLS\"; fi",
      "if [ \"$1\" = \"diff\" ]; then printf 'diff\\n' >> \"$KEIYAKU_GIT_CALLS\"; fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    () => readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot),
  );

  assert.equal(result, "");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff"]);
});

test("delivery diff rejects a recorded non-commit object", async () => {
  const { repository, id } = await boundContract();
  const delivery = preparedDelivery(repository, id);
  const blob = mintSnapshotId(repository.run(["hash-object", "-w", "--stdin"], "not a commit\n").trim());

  assert.throws(
    () => readDeliveryDiff(repositoryAt(repository.path), delivery.integration.predecessor, blob),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === "recorded delivery snapshot is not a Git commit",
  );
});

test("delivery diff rechecks one batch for a pruning race", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const git = repositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");
  const pruned = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-pruned-")), "marker");

  const result = withGitShim(
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
    () => readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot),
  );

  assert.equal(result, null);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff", "batch-check"]);
});

test("delivery diff leaves probe diagnostics as Git errors", async () => {
  const { repository, id } = await boundContract();
  const delivery = preparedDelivery(repository, id);

  withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ]; then",
      "  printf '%s\\n' 'error: corrupt object' >&2",
      "  exit 128",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    () => {
      assert.throws(
    () => readDeliveryDiff(repositoryAt(repository.path), delivery.integration.predecessor, delivery.integration.snapshot),
        (error: unknown) => error instanceof Error && error.message.startsWith("cat-file"),
      );
    },
  );
});

test("a terminal cleanup can leave a delivery diff unavailable after Git prunes its tender", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const predecessor = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });

  await bound.keiyaku.reconcile();
  const worktreePath = deliveryWorktreePath(repositoryAt(repository.path), (await bound.keiyaku.state()).id);
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
  assert.equal(await recovered.diff(), null);
});

test("terminal reconcile retains an untracked managed worktree and its reachability refs", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  writeFileSync(join(path, "untracked-agent-work.txt"), "retain me\n");
  await bound.keiyaku.abandon();

  const reconciled = await bound.keiyaku.reconcile();

  assert.deepEqual(reconciled.lag, [{ kind: "worktree-retained", path }]);
  assert.equal(existsSync(path), true);
  assert.equal(repository.run(["-C", path, "status", "--porcelain", "--untracked-files=all"]), "?? untracked-agent-work.txt\n");
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor((await bound.keiyaku.state()).id)), candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor((await bound.keiyaku.state()).id)), candidate);
});

test("terminal reconcile retains a clean managed worktree whose HEAD is not the tender", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  await bound.keiyaku.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "later agent work"]);
  const later = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.abandon();

  const reconciled = await bound.keiyaku.reconcile();

  assert.deepEqual(reconciled.lag, [{ kind: "worktree-retained", path }]);
  assert.equal(repository.run(["-C", path, "status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), later);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor((await bound.keiyaku.state()).id)), candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor((await bound.keiyaku.state()).id)), candidate);
});

test("a clean no-delivery abandonment releases the managed worktree from its start", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  await bound.keiyaku.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.keiyaku.state()).id);
  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(abandoned.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);
  assert.equal(existsSync(path), false);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor((await bound.keiyaku.state()).id)), null);
  assert.equal(repository.run(["cat-file", "-e", `${start}^{commit}`]), "");
});

test("nonempty candidates retain Git stable patch identity", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);

  const delivery = preparedDelivery(repository, id);
  assert.equal(delivery.integration.snapshot, repository.run(["rev-parse", "HEAD"]).trim());
  const diff = repository.run(["diff", "--binary", delivery.integration.predecessor, delivery.integration.snapshot]);
  const stablePatchId = repository.run(["patch-id", "--stable"], diff).trim().split(" ")[0];
  assert.equal(delivery.integration.changeId, stablePatchId);
});

test("verification materializes the protocol-selected candidate snapshot", () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "candidate"]);
  const candidate = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "later head"]);

  const prepared = materializeVerificationCandidate(repositoryAt(repository.path), candidate);
  try {
    assert.equal(repository.run(["-C", prepared.cwd, "rev-parse", "HEAD"]).trim(), candidate);
  } finally {
    prepared.dispose();
  }
});
