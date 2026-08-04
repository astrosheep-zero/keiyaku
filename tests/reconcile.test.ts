import assert from "node:assert/strict";
import test from "node:test";
import { writeCommit, writeTree, readRef, runGit, repositoryAt } from "../src/core/facts/repository.js";
import {
  commitOid,
  contractHead,
  contractId,
  type ContractState,
  type PetitionEntry,
} from "../src/core/facts/types.js";
import { deliveryRefFor, deliveryWorktreePath, reconcile } from "../src/core/reconcile.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-04T00:00:00Z";

function commit(repository: ReturnType<typeof repositoryAt>, parent: string | null = null): ReturnType<typeof commitOid> {
  const tree = writeTree(repository, []);
  return commitOid(writeCommit(repository, tree, parent, "test commit", { actor: "tester", at: AT }));
}

function state(
  id: ReturnType<typeof contractId>,
  phase: ContractState["phase"],
  head: ReturnType<typeof commitOid>,
): ContractState {
  return {
    id,
    head: contractHead(head),
    phase,
    body: null,
    delivery: { target: "refs/heads/main", base: head, head },
    approval: null,
    petition: null,
    evidence: [],
    terminal: null,
  };
}

function petitionEntry(id: ReturnType<typeof contractId>, head: ReturnType<typeof commitOid>): PetitionEntry {
  return {
    v: 1,
    kind: "petition",
    contract: id,
    entry: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as PetitionEntry["entry"],
    at: AT,
    actor: "tester",
    data: { expectedPredecessor: head, deliveryHead: head, candidate: head },
  };
}

test("open reconstructs from a null handoff and is idempotent after restart", () => {
  const fixture = makeGitRepository();
  const repository = repositoryAt(fixture.path);
  const id = contractId("kei/reconcile-open");
  const head = commit(repository);
  const openState = state(id, "active", head);
  const first = reconcile({ repository, state: openState, handoff: null });
  const ref = deliveryRefFor(id);
  const path = deliveryWorktreePath(repository, id);

  assert.equal(first.kind, "aligned");
  assert.equal(first.changed, true);
  assert.equal(readRef(repository, ref), head);
  assert.equal(fixture.run(["worktree", "list", "--porcelain"]).includes(path), true);

  const second = reconcile({ repository, state: { ...openState }, handoff: null });
  assert.deepEqual(second, { kind: "aligned", deliveryRef: ref, worktreePath: path, changed: false });
  assert.equal(readRef(repository, ref), head);
});

test("renew moves the delivery projection to its journaled head and refreshes the worktree", () => {
  const fixture = makeGitRepository();
  const repository = repositoryAt(fixture.path);
  const id = contractId("kei/reconcile-renew");
  const oldHead = commit(repository);
  const newHead = commit(repository, oldHead);
  const openState = state(id, "active", oldHead);
  reconcile(repository, openState, null);

  const renewed = state(id, "active", newHead);
  const result = reconcile({ repository, state: renewed, handoff: null });
  assert.equal(result.changed, true);
  assert.equal(readRef(repository, deliveryRefFor(id)), newHead);
  assert.equal(runGit(repository, ["-C", deliveryWorktreePath(repository, id), "rev-parse", "HEAD"]).toString("utf8").trim(), newHead);
});

test("petition is a reconcile no-op", () => {
  const fixture = makeGitRepository();
  const repository = repositoryAt(fixture.path);
  const id = contractId("kei/reconcile-petition");
  const head = commit(repository);
  const petitionState = state(id, "awaiting-verdict", head);
  const result = reconcile({ repository, state: petitionState, entries: [petitionEntry(id, head)], handoff: null });
  assert.deepEqual(result, {
    kind: "noop",
    deliveryRef: deliveryRefFor(id),
    worktreePath: deliveryWorktreePath(repository, id),
    changed: false,
  });
  assert.equal(readRef(repository, deliveryRefFor(id)), null);
});

for (const terminal of ["claimed", "forfeited"] as const) {
  test(`${terminal} removes the delivery ref and conventional worktree`, () => {
    const fixture = makeGitRepository();
    const repository = repositoryAt(fixture.path);
    const id = contractId(`kei/reconcile-${terminal}`);
    const head = commit(repository);
    const openState = state(id, "active", head);
    reconcile(repository, openState, null);
    const terminalState = state(id, terminal, head);

    const result = reconcile({ repository, state: terminalState, handoff: null });
    assert.equal(result.kind, "cleaned");
    assert.equal(readRef(repository, deliveryRefFor(id)), null);
    assert.equal(fixture.run(["worktree", "list", "--porcelain"]).includes(deliveryWorktreePath(repository, id)), false);
  });
}

test("reconcile never follows a newer delivery ref", () => {
  const fixture = makeGitRepository();
  const repository = repositoryAt(fixture.path);
  const id = contractId("kei/reconcile-newer");
  const journaled = commit(repository);
  const newer = commit(repository, journaled);
  const ref = deliveryRefFor(id);
  runGit(repository, ["update-ref", ref, newer]);

  const result = reconcile(repository, state(id, "active", journaled), null);
  assert.equal(result.changed, false);
  assert.equal(readRef(repository, ref), newer);
});

test("reconcile uses the journaled head instead of a moved external target", () => {
  const fixture = makeGitRepository();
  const repository = repositoryAt(fixture.path);
  const id = contractId("kei/reconcile-target");
  const journaled = commit(repository);
  const newerTarget = commit(repository, journaled);
  runGit(repository, ["update-ref", "refs/heads/main", newerTarget]);

  reconcile(repository, state(id, "active", journaled), null);
  assert.equal(readRef(repository, deliveryRefFor(id)), journaled);
  assert.equal(readRef(repository, "refs/heads/main"), newerTarget);
});
