import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo, type ContractId, type TopologyEffect } from "../src/index.js";
import { readRef, repositoryAt } from "../src/git/repository.js";
import { appointedWorktreePath, withGitShim } from "./support/git.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

function deliveryRefFor(contract: ContractId): string {
  return `refs/heads/keiyaku-delivery/kei-${contract.slice("kei/".length)}`;
}

function candidatePinRefFor(contract: ContractId): string {
  return `refs/heads/keiyaku-candidate/kei-${contract.slice("kei/".length)}`;
}

function unchangedRef(effects: readonly TopologyEffect[], name: string, oid: string): boolean {
  return effects.some((effect) =>
    effect.kind === "ref"
    && effect.name === name
    && effect.action === "unchanged"
    && effect.before === oid
    && effect.after === oid
  );
}

async function claimedTargeted() {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const contract = bound.keiyaku;
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), contract.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await contract.deliver();
  return { contract, repository, worktree };
}

async function restoreOwnedRefs(repository: ReturnType<typeof repositoryWithMain>, id: ContractId, tender: string, integration: string) {
  repository.run(["update-ref", deliveryRefFor(id), tender]);
  repository.run(["update-ref", candidatePinRefFor(id), integration]);
}

test("rewritten target history retains owned refs with unchanged effects", async () => {
  const { contract, repository } = await claimedTargeted();
  writeFileSync(join(repository.path, "target-only.txt"), "target only\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "target only"]);
  await contract.review({ verdict: "satisfied" });
  const state = await contract.state();
  assert.equal(state.terminal?.kind, "claimed");
  const tender = state.delivery?.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery?.data.integration.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  assert.notEqual(tender, integration);
  await restoreOwnedRefs(repository, state.id, tender, integration);
  const tree = repository.run(["rev-parse", "HEAD^{tree}"]).trim();
  const rewritten = repository.run(["commit-tree", tree, "-m", "rewritten target"]).trim();
  repository.run(["update-ref", "refs/heads/main", rewritten]);

  const report = await contract.reconcile();
  const git = await repositoryAt(repository.path);

  assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
  assert.equal(await readRef(git, candidatePinRefFor(state.id)), integration);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), rewritten);
  assert.equal(report.lag.length, 0);
  assert.equal(unchangedRef(report.effects, deliveryRefFor(state.id), tender), true);
  assert.equal(unchangedRef(report.effects, candidatePinRefFor(state.id), integration), true);
});

test("unequal tender and integration trees retain the delivery ref through a containing target", async () => {
  const { contract, repository } = await claimedTargeted();
  writeFileSync(join(repository.path, "target-only.txt"), "target only\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "target only"]);
  await contract.review({ verdict: "satisfied" });
  const state = await contract.state();
  assert.equal(state.terminal?.kind, "claimed");
  const tender = state.delivery?.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery?.data.integration.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  assert.notEqual(tender, integration);
  await restoreOwnedRefs(repository, state.id, tender, integration);
  writeFileSync(join(repository.path, "after-claim.txt"), "after claim\n");
  repository.run(["add", "after-claim.txt"]);
  repository.run(["commit", "--quiet", "-m", "after claim"]);
  const targetBefore = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const report = await contract.reconcile();
  const git = await repositoryAt(repository.path);

  assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
  assert.equal(await readRef(git, candidatePinRefFor(state.id)), null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetBefore);
  assert.equal(report.lag.length, 0);
  assert.equal(unchangedRef(report.effects, deliveryRefFor(state.id), tender), true);
  assert.equal(
    report.effects.some((effect) => effect.kind === "ref" && effect.name === candidatePinRefFor(state.id) && effect.action === "removed"),
    true,
  );
});

test("abandoned tender custody remains when it is the sole proof", async () => {
  const { contract, repository } = await claimedTargeted();
  const delivered = await contract.state();
  const tender = delivered.delivery?.data.tenderSnapshot;
  const integration = delivered.currentIntegration?.snapshot ?? delivered.delivery?.data.integration.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  const abandoned = await contract.abandon();
  const id = (await contract.state()).id;
  const git = await repositoryAt(repository.path);

  assert.equal(await readRef(git, deliveryRefFor(id)), tender);
  assert.equal(unchangedRef(abandoned.effects, deliveryRefFor(id), tender), true);
  if (tender === integration) {
    assert.equal(await readRef(git, candidatePinRefFor(id)), null);
  } else {
    assert.equal(await readRef(git, candidatePinRefFor(id)), integration);
    assert.equal(unchangedRef(abandoned.effects, candidatePinRefFor(id), integration), true);
  }

  const report = await contract.reconcile();
  assert.equal(await readRef(git, deliveryRefFor(id)), tender);
  assert.equal(report.lag.length, 0);
  assert.equal(unchangedRef(report.effects, deliveryRefFor(id), tender), true);
  if (tender === integration) {
    assert.equal(await readRef(git, candidatePinRefFor(id)), null);
  } else {
    assert.equal(await readRef(git, candidatePinRefFor(id)), integration);
    assert.equal(unchangedRef(report.effects, candidatePinRefFor(id), integration), true);
  }
});

test("expected-target CAS retains owned refs under a stale frozen tip", async () => {
  const { contract, repository } = await claimedTargeted();
  await contract.review({ verdict: "satisfied" });
  const state = await contract.state();
  assert.equal(state.terminal?.kind, "claimed");
  const tender = state.delivery?.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery?.data.integration.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  await restoreOwnedRefs(repository, state.id, tender, integration);
  const frozen = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const marker = join(repository.path, "moved-target");

  const report = await withGitShim(
    [
      'if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ] && [ ! -e "$KEIYAKU_MOVED_TARGET" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  parent=$("$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" rev-parse --verify refs/heads/main)',
      '  tree=$("$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" rev-parse "$parent^{tree}")',
      '  next=$("$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" -c user.name="Test User" -c user.email="test@example.com" commit-tree "$tree" -p "$parent" -m "concurrent target move")',
      '  "$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" update-ref refs/heads/main "$next" "$parent"',
      '  touch "$KEIYAKU_MOVED_TARGET"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_MOVED_TARGET: marker, KEIYAKU_REPO: repository.path },
    async (gitPath) =>
      (await Keiyaku.of({
        repo: await Repo.at({ path: repository.path, gitPath }),
        id: state.id,
      })).reconcile(),
  );
  const git = await repositoryAt(repository.path);
  const moved = repository.run(["rev-parse", "refs/heads/main"]).trim();

  assert.notEqual(moved, frozen);
  assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
  assert.equal(await readRef(git, candidatePinRefFor(state.id)), integration);
  assert.equal(report.lag.length, 0);
  assert.equal(unchangedRef(report.effects, deliveryRefFor(state.id), tender), true);
  assert.equal(unchangedRef(report.effects, candidatePinRefFor(state.id), integration), true);

  const retried = await contract.reconcile();
  assert.equal(await readRef(git, deliveryRefFor(state.id)), null);
  assert.equal(await readRef(git, candidatePinRefFor(state.id)), null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), moved);
  assert.equal(retried.lag.length, 0);
});
