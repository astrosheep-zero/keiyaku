import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { encodeEntry } from "../src/core/facts/codec.js";
import { changeId, contractId, entryUlid, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import { GIT_REF, readBlob, readGit, readRef, updateGitTree, writeBlob, writeCommit } from "../src/git/repository.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { Keiyaku, Repo } from "../src/index.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  snapshotGitRepository,
} from "./support/git.js";
import {
  document,
  refused,
  repositoryWithMain,
} from "./support/library-verbs.js";

type ContractHandle = Pick<Keiyaku, "state">;

async function publicContractId(handle: ContractHandle): Promise<ContractId> {
  return (await handle.state()).id;
}












function changeIdFromSubject(subject: string | undefined): string | undefined {
  return (JSON.parse(subject ?? "[]") as readonly (readonly [string, string])[]).find(
    ([kind]) => kind === "change",
  )?.[1];
}

type ReviewGatedConflictCandidateTemplate = Readonly<{
  repository: ReturnType<typeof repositoryWithMain>;
  id: ReturnType<typeof contractId>;
  targetHead: ReturnType<typeof snapshotId>;
  candidateHead: ReturnType<typeof snapshotId>;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

let reviewGatedConflictCandidateTemplate: Promise<ReviewGatedConflictCandidateTemplate> | undefined;

async function buildReviewGatedConflictCandidateTemplate(): Promise<ReviewGatedConflictCandidateTemplate> {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "a.txt"), "base\n");
  writeFileSync(join(repository.path, "z.txt"), "base\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const boundId = await publicContractId(bound.keiyaku);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), boundId);
  writeFileSync(join(repository.path, "a.txt"), "target\n");
  writeFileSync(join(repository.path, "z.txt"), "target\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  writeFileSync(join(worktree, "a.txt"), "tender\n");
  writeFileSync(join(worktree, "z.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const candidateHead = snapshotId(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim());
  const generatedFiles = captureWorktreeFiles(worktree);
  repository.run(["worktree", "remove", "--force", worktree]);
  return { repository, id: boundId, targetHead: snapshotId(targetHead), candidateHead, generatedFiles };
}

async function reviewGatedConflictCandidateFixture() {
  const templatePromise = (reviewGatedConflictCandidateTemplate ??= buildReviewGatedConflictCandidateTemplate());
  let template: ReviewGatedConflictCandidateTemplate;
  try {
    template = await templatePromise;
  } catch (error) {
    if (reviewGatedConflictCandidateTemplate === templatePromise) reviewGatedConflictCandidateTemplate = undefined;
    throw error;
  }
  const repository = snapshotGitRepository(template.repository);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), template.id);
  repository.run(["worktree", "add", "--detach", worktree, template.candidateHead]);
  restoreWorktreeFiles(worktree, template.generatedFiles);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: template.id });
  return { repository, repo, contract, targetHead: template.targetHead, worktree };
}

const DELIVER_CONFLICT_RECOVERY = {
  materialize: "deliver --materialize-conflict --include-dirty",
  deliver: "deliver --include-dirty",
  staging: "not-required",
} as const;

function mergeHead(repository: ReturnType<typeof repositoryWithMain>, worktree: string): string | null {
  try {
    return repository.run(["-C", worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim();
  } catch {
    return null;
  }
}


// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("library-contract-operations isolated repositories", { concurrency: 4 }, () => {

  test("plain deliver conflict is an executable handoff and does not mutate", async () => {
    const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const journal = await readRef(git, GIT_REF);
    await assert.rejects(
      () => contract.deliver(),
      refused({
        kind: "integration-failed",
        contractId: await publicContractId(contract),
        reason: "conflict",
        targetHead,
        conflictPaths: ["a.txt", "z.txt"],
        recovery: DELIVER_CONFLICT_RECOVERY,
      }),
    );
    const state = await contract.state();
    assert.equal(state.delivery, null);
    assert.equal(state.terminal, null);
    assert.equal(await readRef(git, GIT_REF), journal);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
    assert.equal(mergeHead(repository, worktree), null);
  });

  test("a satisfied review cannot interleave a stale integration stop across the target fence", async () => {
    const { repository, contract, targetHead } = await reviewGatedConflictCandidateFixture();
    const git = await cachedRepositoryAt(repository.path);
    const held = await acquireTargetPlacementFence(git, "refs/heads/main");
    const pending = contract.review({ verdict: "satisfied" });
    const deadline = Date.now() + 2000;
    let state = await contract.state();
    while (state.attestations.at(-1)?.data.verdict !== "satisfied" && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      state = await contract.state();
    }
    assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
    assert.equal(state.delivery, null);
    const reviewedChangeId = changeIdFromSubject(state.attestations.at(-1)?.data.subject);
    if (reviewedChangeId === undefined) throw new Error("reviewed subject is missing its ChangeId");
    const before = await readGit(git);
    const journalPath = contractJournalPath(state.id);
    const active = before.paths.get(journalPath);
    if (active?.type !== "blob") throw new Error("missing active journal");
    const oid = await writeBlob(
      git,
      Buffer.concat([
        await readBlob(git, active.oid),
        Buffer.from(
          encodeEntry({
            v: 1,
            kind: "bound",
            contract: state.id,
            entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBW"),
            at: "2026-08-17T00:00:00.000Z",
            data: {},
          }),
        ),
        Buffer.from(
          encodeEntry({
            v: 1,
            kind: "deliver",
            contract: state.id,
            entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBX"),
            at: "2026-08-17T00:00:01.000Z",
            data: {
              tenderSnapshot: snapshotId(targetHead),
              integration: {
                predecessor: snapshotId(targetHead),
                snapshot: snapshotId(targetHead),
                changeId: changeId(reviewedChangeId),
              },
              method: "squash",
              policy: { requireBranchesToBeUpToDate: false },
            },
          }),
        ),
      ]),
    );
    const tree = await updateGitTree(git, before.tree, new Map([[journalPath, { oid }]]));
    const commit = await writeCommit({ repository: git, tree, parent: before.commit });
    if (before.commit === null) throw new Error("missing state ref");
    repository.run(["update-ref", "refs/heads/keiyaku-state", commit, before.commit]);
    writeFileSync(join(repository.path, "unrelated-target.txt"), "moved\n");
    repository.run(["add", "unrelated-target.txt"]);
    repository.run(["commit", "--quiet", "-m", "move target under fence"]);
    const stillHeld = await Promise.race([
      pending.then(() => "finished" as const),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 50);
      }),
    ]);
    assert.equal(stillHeld, "blocked");
    held.close();
    const reviewed = await pending;
    assert.deepEqual(
      reviewed.facts.map((fact) => fact.kind),
      ["attestation", "reintegrated", "claimed"],
    );
    assert.equal(reviewed.value.placement, undefined);
    const finalState = await contract.state();
    assert.equal(finalState.terminal?.kind, "claimed");
    assert.equal(finalState.currentIntegration?.snapshot, repository.run(["rev-parse", "refs/heads/main"]).trim());
  });

  test("declared failing Verification with no gate does not block a library delivery claim", async () => {
    const repository = repositoryWithMain();
    const bound = await Keiyaku.bind({
      repo: await cachedRepoAt(repository.path),
      markdown: document("exit 1"),
      workspace: "worktree",
      gates: [],
    });
    const state = await bound.keiyaku.state();
    const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
    writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
    repository.run(["-C", worktree, "add", "candidate.txt"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

    const delivered = await bound.keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.deepEqual(delivered.value.completion?.verification, { mode: "ran", verdict: "unsatisfied" });
    assert.equal(delivered.value.placement, undefined);
    assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  });
});
