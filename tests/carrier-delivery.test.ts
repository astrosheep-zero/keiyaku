import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { prepareDelivery, prepareReview } from "../src/carrier/delivery.js";
import { mintSnapshotId } from "../src/carrier/identity.js";
import { readRef, repositoryAt } from "../src/carrier/repository.js";
import { observeContract } from "../src/carrier/observe.js";
import { materializeVerificationCandidate, readDeliveryDiff } from "../src/carrier/verification.js";
import { deliveryWorktreePath, reconcile } from "../src/carrier/reconcile.js";
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
    "src/carrier/**",
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
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  return { repository, id: (await bound.value.state()).id };
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

test("carrier materialization adds the identity-family namespace", () => {
  const repository = makeGitRepository();
  assert.equal(
    basename(deliveryWorktreePath(repositoryAt(repository.path), contractId("kei/con"))),
    "kei-con",
  );
});

test("dirty delivery materializes a candidate without changing the caller index", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "dirty candidate\n");
  const carrier = repositoryAt(repository.path);
  const state = observeContract(carrier, id).state;
  if (state === null) throw new Error("contract was not observed");
  const review = prepareReview(carrier, preparationCoordinates(state));
  assert.equal(review.kind, "prepared");
  if (review.kind !== "prepared") throw new Error("review preparation was refused");
  assert.equal("documentKey" in review, false);
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);

  const prepared = prepareDelivery(carrier, preparationCoordinates(state), { title: "Patch identity" });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  assert.equal(prepared.data.deliveryPatchId, review.data);
  assert.equal(repository.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.candidate]), /kei\/.*: Patch identity/);
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.candidate]), /Keiyaku-Contract: /);
});

test("delivery preparation refuses an unregistered directory at the managed worktree path", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  const state = await bound.value.state();
  const carrier = repositoryAt(repository.path);
  const path = deliveryWorktreePath(carrier, state.id);
  mkdirSync(path, { recursive: true });
  repository.run(["-C", path, "init", "--quiet"]);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "foreign"]);

  assert.deepEqual(prepareReview(carrier, preparationCoordinates(state)), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
  assert.deepEqual(prepareDelivery(carrier, preparationCoordinates(state), { title: "Delivery patch identity" }), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
});

test("reconcile recreates a registered managed worktree whose directory disappeared", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  await bound.value.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.value.state()).id);
  renameSync(path, `${path}-moved`);

  const repaired = await bound.value.reconcile();

  assert.equal(existsSync(path), true);
  assert.equal(repaired.effects.some((effect) => effect.kind === "worktree" && effect.action === "created"), true);
});

test("distinct no-op candidates share the empty patch ChangeId", async () => {
  const { repository, id } = await boundContract();

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "first no-op"]);
  const first = preparedDelivery(repository, id);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "second no-op"]);
  const second = preparedDelivery(repository, id);

  assert.notEqual(first.candidate, second.candidate);
  assert.equal(first.deliveryPatchId, second.deliveryPatchId);
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

test("delivery diff preserves an empty patch and treats a clean missing object as transport absence", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const carrier = repositoryAt(repository.path);

  assert.equal(readDeliveryDiff(carrier, delivery.expectedPredecessor, delivery.candidate), "");
  assert.equal(await deliveryDiffOperation({
    scope: scopeOperation({ coordinate: repository.path }),
    expectedPredecessor: delivery.expectedPredecessor,
    snapshotId: delivery.candidate,
  }), "");
  assert.equal(readDeliveryDiff(carrier, delivery.expectedPredecessor, mintSnapshotId("0".repeat(40))), null);
});

test("delivery diff checks both snapshots in one batch process", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const carrier = repositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");

  const result = withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ]; then printf 'batch-check\\n' >> \"$KEIYAKU_GIT_CALLS\"; fi",
      "if [ \"$1\" = \"diff\" ]; then printf 'diff\\n' >> \"$KEIYAKU_GIT_CALLS\"; fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    () => readDeliveryDiff(carrier, delivery.expectedPredecessor, delivery.candidate),
  );

  assert.equal(result, "");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff"]);
});

test("delivery diff rejects a recorded non-commit object", async () => {
  const { repository, id } = await boundContract();
  const delivery = preparedDelivery(repository, id);
  const blob = mintSnapshotId(repository.run(["hash-object", "-w", "--stdin"], "not a commit\n").trim());

  assert.throws(
    () => readDeliveryDiff(repositoryAt(repository.path), delivery.expectedPredecessor, blob),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === "recorded delivery snapshot is not a Git commit",
  );
});

test("delivery diff rechecks one batch for a pruning race", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const carrier = repositoryAt(repository.path);
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
    () => readDeliveryDiff(carrier, delivery.expectedPredecessor, delivery.candidate),
  );

  assert.equal(result, null);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff", "batch-check"]);
});

test("delivery diff leaves probe diagnostics as carrier errors", async () => {
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
        () => readDeliveryDiff(repositoryAt(repository.path), delivery.expectedPredecessor, delivery.candidate),
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
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");

  await bound.value.reconcile();
  const worktreePath = deliveryWorktreePath(repositoryAt(repository.path), (await bound.value.state()).id);
  writeFileSync(join(worktreePath, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktreePath, "add", "candidate.txt"]);
  repository.run(["-C", worktreePath, "commit", "--quiet", "-m", "candidate"]);
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was refused");
  await bound.value.reconcile();

  const reviewed = await bound.value.review({ verdict: "satisfied" });
  assert.equal(reviewed.kind, "accepted");
  assert.ok((await bound.value.state()).terminal);
  const reconciled = await bound.value.reconcile();
  assert.equal(reconciled.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);

  repository.run(["reflog", "expire", "--expire=now", "--all"]);
  repository.run(["gc", "--prune=now"]);

  const recovered = await bound.value.delivery();
  assert.ok(recovered);
  assert.equal(await recovered.diff(), null);
});

test("terminal reconcile retains an untracked managed worktree and its reachability refs", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  await bound.value.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.value.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  writeFileSync(join(path, "untracked-agent-work.txt"), "retain me\n");
  const abandoned = await bound.value.abandon();
  assert.equal(abandoned.kind, "accepted");

  const reconciled = await bound.value.reconcile();

  assert.deepEqual(reconciled.lag, [{ kind: "worktree-retained", path }]);
  assert.equal(existsSync(path), true);
  assert.equal(repository.run(["-C", path, "status", "--porcelain", "--untracked-files=all"]), "?? untracked-agent-work.txt\n");
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor((await bound.value.state()).id)), candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor((await bound.value.state()).id)), candidate);
});

test("terminal reconcile retains a clean managed worktree whose HEAD is not the tender", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree", gates: ["reviewed"] });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  await bound.value.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.value.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "later agent work"]);
  const later = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const abandoned = await bound.value.abandon();
  assert.equal(abandoned.kind, "accepted");

  const reconciled = await bound.value.reconcile();

  assert.deepEqual(reconciled.lag, [{ kind: "worktree-retained", path }]);
  assert.equal(repository.run(["-C", path, "status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), later);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor((await bound.value.state()).id)), candidate);
  assert.equal(readRef(repositoryAt(repository.path), candidatePinRefFor((await bound.value.state()).id)), candidate);
});

test("a clean no-delivery abandonment releases the managed worktree from its start", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  await bound.value.reconcile();
  const path = deliveryWorktreePath(repositoryAt(repository.path), (await bound.value.state()).id);
  const abandoned = await bound.value.abandon();
  assert.equal(abandoned.kind, "accepted");

  const reconciled = await bound.value.reconcile();

  assert.deepEqual(reconciled.lag, []);
  assert.equal(reconciled.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), true);
  assert.equal(existsSync(path), false);
  assert.equal(readRef(repositoryAt(repository.path), deliveryRefFor((await bound.value.state()).id)), null);
  assert.equal(repository.run(["cat-file", "-e", `${start}^{commit}`]), "");
});

test("nonempty candidates retain Git stable patch identity", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);

  const delivery = preparedDelivery(repository, id);
  assert.equal(delivery.candidate, repository.run(["rev-parse", "HEAD"]).trim());
  const diff = repository.run(["diff", "--binary", delivery.expectedPredecessor, delivery.candidate]);
  const stablePatchId = repository.run(["patch-id", "--stable"], diff).trim().split(" ")[0];
  assert.equal(delivery.deliveryPatchId, stablePatchId);
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
