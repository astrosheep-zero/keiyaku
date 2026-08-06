import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prepareDelivery } from "../src/carrier/delivery.js";
import { mintSnapshotId } from "../src/carrier/identity.js";
import { GitPlumbingError, repositoryAt } from "../src/carrier/repository.js";
import { readDeliveryDiff } from "../src/carrier/verification.js";
import { Keiyaku, type ContractId } from "../src/index.js";
import { deliveryDiffOperation } from "../src/protocol/operations.js";
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

async function boundContract(): Promise<Readonly<{ repository: TestGitRepository; id: ContractId }>> {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({ markdown: contractBody(), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");
  return { repository, id: (await bound.value.state()).id };
}

function preparedDelivery(repository: TestGitRepository, id: ContractId) {
  const prepared = prepareDelivery(repositoryAt(repository.path), id);
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  return prepared.delivery;
}

test("distinct no-op candidates share the empty patch ChangeId", async () => {
  const { repository, id } = await boundContract();

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "first no-op"]);
  const first = preparedDelivery(repository, id);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "second no-op"]);
  const second = preparedDelivery(repository, id);

  assert.notEqual(first.candidate, second.candidate);
  assert.equal(first.deliveryPatchId, second.deliveryPatchId);
});

test("delivery diff preserves an empty patch and treats a clean missing object as transport absence", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = preparedDelivery(repository, id);
  const carrier = repositoryAt(repository.path);

  assert.equal(readDeliveryDiff(carrier, delivery.expectedPredecessor, delivery.candidate), "");
  assert.equal(await deliveryDiffOperation({
    coordinate: repository.path,
    expectedPredecessor: delivery.expectedPredecessor,
    snapshotId: delivery.candidate,
  }), "");
  assert.equal(readDeliveryDiff(carrier, delivery.expectedPredecessor, mintSnapshotId("0".repeat(40))), null);
});

test("delivery diff leaves probe diagnostics as carrier errors", async () => {
  const { repository, id } = await boundContract();
  const delivery = preparedDelivery(repository, id);

  withGitShim(
    [
      "if [ \"$1\" = \"cat-file\" ] && [ \"$2\" = \"-t\" ]; then",
      "  printf '%s\\n' 'error: corrupt object' >&2",
      "  exit 128",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    {},
    () => {
      assert.throws(
        () => readDeliveryDiff(repositoryAt(repository.path), delivery.expectedPredecessor, delivery.candidate),
        (error: unknown) => error instanceof GitPlumbingError && error.command[0] === "cat-file",
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
  const bound = await Keiyaku.bind({ markdown: contractBody(), repo: repository.path, workspace: "worktree" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was refused");

  const prepared = await bound.value.reconcile();
  assert.ok(prepared.worktreePath);
  writeFileSync(join(prepared.worktreePath, "candidate.txt"), "candidate\n");
  repository.run(["-C", prepared.worktreePath, "add", "candidate.txt"]);
  repository.run(["-C", prepared.worktreePath, "commit", "--quiet", "-m", "candidate"]);
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver was refused");
  await bound.value.reconcile();

  const reviewed = await delivered.value.review({ verdict: "approved" });
  assert.equal(reviewed.kind, "accepted");
  assert.ok((await bound.value.state()).terminal);
  assert.equal((await bound.value.reconcile()).kind, "cleaned");

  repository.run(["reflog", "expire", "--expire=now", "--all"]);
  repository.run(["gc", "--prune=now"]);

  const recovered = await bound.value.delivery();
  assert.ok(recovered);
  assert.equal(await recovered.diff(), null);
});

test("nonempty candidates retain Git stable patch identity", async () => {
  const { repository, id } = await boundContract();
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);

  const delivery = preparedDelivery(repository, id);
  const diff = repository.run(["diff", "--binary", delivery.expectedPredecessor, delivery.candidate]);
  const stablePatchId = repository.run(["patch-id", "--stable"], diff).trim().split(" ")[0];
  assert.equal(delivery.deliveryPatchId, stablePatchId);
});
