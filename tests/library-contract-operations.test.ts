import type { ContinuationStop } from "../src/library/continuation.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  Keiyaku,
  KeiyakuRefused,
  Repo,
  type IntegrationConflictMaterialized,
  type MutationResult,
} from "../src/index.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { changeId, contractId, entryUlid, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import { materializeJudgedConflict } from "../src/git/integration.js";
import { GIT_REF, readBlob, readGit, readRef, updateGitTree, writeBlob, writeCommit } from "../src/git/repository.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { recordConflictHandoff } from "../src/git/workspace.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { completeRepoReconcile } from "../src/library/reconcile.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  snapshotGitRepository,
  withGitShim,
} from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

type ContractHandle = Pick<Keiyaku, "state">;

async function publicContractId(handle: ContractHandle): Promise<ContractId> {
  return (await handle.state()).id;
}

function expectMaterialized(
  result: MutationResult<unknown> | IntegrationConflictMaterialized,
): IntegrationConflictMaterialized {
  if (result.kind !== "integration-conflict-materialized") {
    throw new Error("expected an integration conflict materialization");
  }
  return result;
}

function expectMutation<Value>(result: MutationResult<Value> | IntegrationConflictMaterialized): MutationResult<Value> {
  if (result.kind !== "accepted") throw new Error("expected an admitted mutation result");
  return result;
}

function placementRefusalKind(placement: ContinuationStop | undefined): string | undefined {
  return placement !== undefined && "refusal" in placement ? placement.refusal.kind : undefined;
}

type GeneratedWorktreeFile = Readonly<{ path: string; bytes: Buffer; mode: number }>;
type DefaultPostBindTemplate = Readonly<{
  repository: ReturnType<typeof repositoryWithMain>;
  id: ReturnType<typeof contractId>;
  start: ReturnType<typeof snapshotId>;
  generatedFiles: readonly GeneratedWorktreeFile[];
}>;

let defaultPostBindTemplate: Promise<DefaultPostBindTemplate> | undefined;

async function buildDefaultPostBindTemplate(): Promise<DefaultPostBindTemplate> {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = await contract.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  const generatedFiles = [
    ".keiyaku/.gitignore",
    ".keiyaku/KEIYAKU.md",
    ".agents/skills/keiyaku-deliver/.gitignore",
    ".agents/skills/keiyaku-deliver/SKILL.md",
    ".agents/skills/keiyaku-review/.gitignore",
    ".agents/skills/keiyaku-review/SKILL.md",
  ].map((path) => ({
    path,
    bytes: readFileSync(join(worktree, path)),
    mode: statSync(join(worktree, path)).mode & 0o777,
  }));
  repository.run(["worktree", "remove", "--force", worktree]);
  return { repository, id: state.id, start: state.coordinates.start, generatedFiles };
}

async function defaultBoundFixture() {
  const templatePromise = (defaultPostBindTemplate ??= buildDefaultPostBindTemplate());
  let template: DefaultPostBindTemplate;
  try {
    template = await templatePromise;
  } catch (error) {
    if (defaultPostBindTemplate === templatePromise) defaultPostBindTemplate = undefined;
    throw error;
  }
  const repository = snapshotGitRepository(template.repository);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), template.id);
  repository.run(["worktree", "add", "--detach", worktree, template.start]);
  for (const generated of template.generatedFiles) {
    const path = join(worktree, generated.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated.bytes);
    chmodSync(path, generated.mode);
  }
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: template.id });
  return { repository, repo, contract, worktree };
}

async function bindRetained(
  repo: Repo,
  title: string,
  after: readonly ReturnType<typeof contractId>[] = [],
  reviewed = false,
  verification?: string,
) {
  return await Keiyaku.bind({
    repo,
    markdown: document(verification).replace("# Library verbs", `# ${title}`),
    workspace: "worktree",
    gates: reviewed ? ["reviewed"] : [],
    ...(after.length === 0 ? {} : { after }),
  });
}

async function plantDispatch(
  repository: ReturnType<typeof repositoryWithMain>,
  akuId: string,
  owner: string,
  dispatchedAt: string,
  bytes?: Buffer,
): Promise<void> {
  const git = await cachedRepositoryAt(repository.path);
  const path = `dispatch/${createHash("sha256").update(akuId).digest("hex")}.json`;
  const payload =
    bytes ??
    Buffer.from(
      `${JSON.stringify({
        akuId,
        contractId: owner,
        dispatchedAt,
      })}\n`,
    );
  const before = await readGit(git);
  const tree = await updateGitTree(git, before.tree, new Map([[path, { oid: await writeBlob(git, payload) }]]));
  const commit = await writeCommit({
    repository: git,
    tree,
    parent: before.commit,
    message: `dispatch ${akuId}`,
    at: dispatchedAt,
  });
  repository.run(["update-ref", GIT_REF, commit, before.commit ?? ""]);
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
  generatedFiles: readonly GeneratedWorktreeFile[];
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
  const generatedFiles = [
    ".keiyaku/.gitignore",
    ".keiyaku/KEIYAKU.md",
    ".agents/skills/keiyaku-deliver/.gitignore",
    ".agents/skills/keiyaku-deliver/SKILL.md",
    ".agents/skills/keiyaku-review/.gitignore",
    ".agents/skills/keiyaku-review/SKILL.md",
  ].map((path) => ({
    path,
    bytes: readFileSync(join(worktree, path)),
    mode: statSync(join(worktree, path)).mode & 0o777,
  }));
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
  for (const generated of template.generatedFiles) {
    const path = join(worktree, generated.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated.bytes);
    chmodSync(path, generated.mode);
  }
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: template.id });
  return { repository, repo, contract, targetHead: template.targetHead, worktree };
}

const DELIVER_CONFLICT_RECOVERY = {
  materialize: "deliver --materialize-conflict --include-dirty",
  continue: "deliver --include-dirty",
} as const;

function mergeHead(repository: ReturnType<typeof repositoryWithMain>, worktree: string): string | null {
  try {
    return repository.run(["-C", worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim();
  } catch {
    return null;
  }
}

async function disjointTargetedDelivery(materializeConflict?: boolean) {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
  });
  const boundId = await publicContractId(bound.keiyaku);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), boundId);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const delivered =
    materializeConflict === undefined
      ? await bound.keiyaku.deliver()
      : await bound.keiyaku.deliver({ materializeConflict });
  return { repository, bound, delivered };
}

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

test("explicit materialization projects the judged conflict in the appointed workspace", async () => {
  const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
  const git = await cachedRepositoryAt(repository.path);
  const journal = await readRef(git, GIT_REF);
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.deepEqual(materialized, {
    kind: "integration-conflict-materialized",
    targetHead,
    conflictPaths: ["a.txt", "z.txt"],
    workspace: { kind: "worktree", path: worktree },
  });
  const state = await contract.state();
  assert.equal(state.delivery, null);
  assert.equal(state.terminal, null);
  assert.equal(await readRef(git, GIT_REF), journal);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
  assert.equal(mergeHead(repository, worktree), targetHead);
});

test("an orphaned pre-materialization receipt is retired before retry", async () => {
  const { repository, contract, targetHead } = await reviewGatedConflictCandidateFixture();
  await assert.rejects(
    () =>
      withGitShim(
        [
          'if [ "$1" = "-C" ] && [ "$3" = "merge" ] && [ "$4" = "--no-commit" ]; then',
          '  printf "forced materialization interruption\\n" >&2',
          "  exit 2",
          "fi",
          'exec "$KEIYAKU_REAL_GIT" "$@"',
        ].join("\n"),
        {},
        async (gitPath) =>
          await Keiyaku.of({
            repo: await Repo.at({ path: repository.path, gitPath }),
            id: await publicContractId(contract),
          }).deliver({
            materializeConflict: true,
          }),
      ),
    /git merge --no-commit failed/u,
  );

  const retried = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(retried.kind, "integration-conflict-materialized");
  assert.equal(retried.targetHead, targetHead);
});

test("a receipt retires a crash after merge before materialization returns", async () => {
  const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
  const git = await cachedRepositoryAt(repository.path);
  const contractId = await publicContractId(contract);
  const appointment = await readManagedWorktreeAppointment(git, contractId);
  assert.equal(appointment.kind, "appointed");
  if (appointment.kind !== "appointed") return;
  await recordConflictHandoff(git, {
    contractId,
    place: appointment.place,
    workspace: worktree,
    head: snapshotId(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim()),
    mergeHead: targetHead,
  });
  await materializeJudgedConflict(git, worktree, targetHead);
  const before = {
    index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
    status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
  };

  await assert.rejects(
    () => contract.deliver({ materializeConflict: true }),
    refused({
      kind: "merge-state-present",
      contractId,
      workspace: { kind: "worktree", path: worktree },
    }),
  );

  assert.equal(mergeHead(repository, worktree), null);
  assert.deepEqual(
    {
      index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
      status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
    },
    before,
  );
});

test("Contract reads observe materialized merge conflicts and staged resolutions", async () => {
  const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  const contractId = await publicContractId(contract);
  assert.equal(materialized.kind, "integration-conflict-materialized");
  const conflict = (await Keiyaku.list({ repo: await cachedRepoAt(repository.path) })).rows.find(
    (row) => row.id === contractId,
  )?.workspaceObservation;
  assert.deepEqual(conflict?.kind === "dirty" ? conflict.merge : undefined, {
    head: targetHead,
    unmergedPaths: ["a.txt", "z.txt"],
  });

  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  const staged = (await Keiyaku.list({ repo: await cachedRepoAt(repository.path) })).rows.find(
    (row) => row.id === contractId,
  )?.workspaceObservation;
  assert.deepEqual(staged?.kind === "dirty" ? staged.merge : undefined, {
    head: targetHead,
    unmergedPaths: [],
  });
});

test("resolved merge delivery requires dirty authority and preserves native parents", async () => {
  const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
  const git = await cachedRepositoryAt(repository.path);
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  const journal = await readRef(git, GIT_REF);

  const indexBefore = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);
  const statusBefore = repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]);
  await assert.rejects(
    () => contract.deliver(),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuRefused);
      assert.equal(error.refusal.kind, "dirty-workspace");
      return true;
    },
  );
  assert.equal(await readRef(git, GIT_REF), journal);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), indexBefore);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]), statusBefore);

  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  const unresolvedIndex = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);
  const unresolvedStatus = repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]);
  await assert.rejects(
    () => contract.deliver(),
    (error: unknown) => error instanceof KeiyakuRefused && error.refusal.kind === "dirty-workspace",
  );
  const workspaceHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const delivered = await contract.deliver({ includeDirty: true });
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.notEqual(await readRef(git, GIT_REF), journal);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), unresolvedIndex);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]), unresolvedStatus);
  assert.deepEqual(repository.run(["show", "-s", "--format=%P", delivered.value.tenderSnapshot]).trim().split(" "), [
    workspaceHead,
    targetHead,
  ]);
});

test("delivery retires a resolved Keiyaku handoff without changing its caller state", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  const headBefore = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const indexBefore = repository.run(["-C", worktree, "ls-files", "--stage", "-z"]);
  const statusBefore = repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]);

  const delivered = await contract.deliver({ includeDirty: true });
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.equal(mergeHead(repository, worktree), null);
  assert.equal(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim(), headBefore);
  assert.equal(repository.run(["-C", worktree, "ls-files", "--stage", "-z"]), indexBefore);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]), statusBefore);
});

test("delivery retirement preserves staged and unstaged caller bytes", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  writeFileSync(join(worktree, "a.txt"), "staged A\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  writeFileSync(join(worktree, "z.txt"), "unstaged B\n");
  const before = {
    index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
    status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
    staged: repository.run(["-C", worktree, "diff", "--cached", "--binary"]),
    unstaged: repository.run(["-C", worktree, "diff", "--binary"]),
    a: readFileSync(join(worktree, "a.txt"), "utf8"),
    z: readFileSync(join(worktree, "z.txt"), "utf8"),
  };

  const delivered = await contract.deliver({ includeDirty: true });
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.equal(mergeHead(repository, worktree), null);
  assert.deepEqual(
    {
      index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
      status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
      staged: repository.run(["-C", worktree, "diff", "--cached", "--binary"]),
      unstaged: repository.run(["-C", worktree, "diff", "--binary"]),
      a: readFileSync(join(worktree, "a.txt"), "utf8"),
      z: readFileSync(join(worktree, "z.txt"), "utf8"),
    },
    before,
  );
});

test("reconciliation retries receipt-proved handoff retirement after delivery", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);

  const delivered = await withGitShim(
    [
      'if [ "$1" = "-C" ] && [ "$3" = "merge" ] && [ "$4" = "--quit" ]; then',
      '  printf "forced handoff cleanup failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      return await Keiyaku.of({ repo, id: await publicContractId(contract) }).deliver({ includeDirty: true });
    },
  );
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.equal(mergeHead(repository, worktree), materialized.targetHead);
  assert.ok(delivered.lags.some((lag) => lag.kind === "reconcile-failed"));
  const reconciled = await contract.reconcile();
  assert.equal(
    reconciled.lag.some((lag) => lag.kind === "reconcile-failed"),
    false,
  );
  assert.equal(mergeHead(repository, worktree), null);
});

test("terminal claim retries a lagged receipt retirement before worktree removal", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);

  const delivered = await withGitShim(
    [
      'if [ "$1" = "-C" ] && [ "$3" = "merge" ] && [ "$4" = "--quit" ]; then',
      '  printf "forced handoff cleanup failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      return await Keiyaku.of({ repo, id: await publicContractId(contract) }).deliver({ includeDirty: true });
    },
  );
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.equal(mergeHead(repository, worktree), materialized.targetHead);

  const reviewed = await withGitShim(
    [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  printf "forced terminal worktree retention\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const repo = await Repo.at({ path: repository.path, gitPath });
      return await Keiyaku.of({ repo, id: await publicContractId(contract) }).review({ verdict: "satisfied" });
    },
  );

  assert.equal((await contract.state()).terminal?.kind, "claimed");
  assert.equal(mergeHead(repository, worktree), null);
  assert.ok(reviewed.lags.some((lag) => lag.kind === "worktree-retained"));
});

test("materializeConflict is inert when the judge reports no conflict", async () => {
  const plain = await disjointTargetedDelivery();
  const flagged = await disjointTargetedDelivery(true);
  assert.equal("facts" in plain.delivered, true);
  assert.equal("facts" in flagged.delivered, true);
  if (!("facts" in plain.delivered) || !("facts" in flagged.delivered)) return;
  assert.deepEqual(
    plain.delivered.facts.map((fact) => fact.kind),
    flagged.delivered.facts.map((fact) => fact.kind),
  );
  assert.equal(plain.delivered.value.integration.changeId, flagged.delivered.value.integration.changeId);
  assert.deepEqual(plain.delivered.value.placement, flagged.delivered.value.placement);
  assert.equal(
    (await plain.bound.keiyaku.state()).terminal?.kind,
    (await flagged.bound.keiyaku.state()).terminal?.kind,
  );
});

test("materialization preserves a dirty workspace with includeDirty", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  writeFileSync(join(worktree, "extra.txt"), "dirty\n");
  const materialized = expectMaterialized(await contract.deliver({ includeDirty: true, materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  assert.equal(mergeHead(repository, worktree), materialized.targetHead);
  assert.equal(readFileSync(join(worktree, "extra.txt"), "utf8"), "dirty\n");
  assert.equal((await contract.state()).delivery, null);
});

test("explicit rematerialization retires an owned handoff without changing unresolved bytes", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  const first = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(first.kind, "integration-conflict-materialized");
  const before = {
    index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
    status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
  };
  await assert.rejects(
    () => contract.deliver({ includeDirty: true, materializeConflict: true }),
    refused({
      kind: "merge-state-present",
      contractId: await publicContractId(contract),
      workspace: { kind: "worktree", path: worktree },
    }),
  );
  assert.equal(mergeHead(repository, worktree), null);
  assert.deepEqual(
    {
      index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
      status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
    },
    before,
  );
  assert.equal((await contract.state()).delivery, null);
});

test("a matching foreign merge is refused without changing Git state", async () => {
  const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
  const git = await cachedRepositoryAt(repository.path);
  await materializeJudgedConflict(git, worktree, targetHead);
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  const manualHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const manualTree = repository.run(["-C", worktree, "write-tree"]).trim();
  const delivered = await contract.deliver({ includeDirty: true });
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.deepEqual(repository.run(["show", "-s", "--format=%P", delivered.value.tenderSnapshot]).trim().split(" "), [
    manualHead,
    targetHead,
  ]);
  assert.equal(repository.run(["show", "-s", "--format=%T", delivered.value.tenderSnapshot]).trim(), manualTree);
  const mergeMessagePath = repository.run(["-C", worktree, "rev-parse", "--git-path", "MERGE_MSG"]).trim();
  const before = {
    head: repository.run(["-C", worktree, "rev-parse", "HEAD"]),
    mergeHead: mergeHead(repository, worktree),
    message: readFileSync(mergeMessagePath, "utf8"),
    index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
    status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
  };

  await assert.rejects(
    () => contract.deliver({ includeDirty: true, materializeConflict: true }),
    refused({
      kind: "merge-state-present",
      contractId: await publicContractId(contract),
      workspace: { kind: "worktree", path: worktree },
    }),
  );

  assert.deepEqual(
    {
      head: repository.run(["-C", worktree, "rev-parse", "HEAD"]),
      mergeHead: mergeHead(repository, worktree),
      message: readFileSync(mergeMessagePath, "utf8"),
      index: repository.run(["-C", worktree, "ls-files", "--stage", "-z"]),
      status: repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
    },
    before,
  );
});

test("native resolution continues through plain deliver against the then-current target", async () => {
  const { repository, contract, worktree } = await reviewGatedConflictCandidateFixture();
  const materialized = expectMaterialized(await contract.deliver({ materializeConflict: true }));
  assert.equal(materialized.kind, "integration-conflict-materialized");
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "resolve merge"]);
  const mergeCommit = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository.path, "unrelated.txt"), "target only\n");
  repository.run(["add", "unrelated.txt"]);
  repository.run(["commit", "--quiet", "-m", "move target"]);
  const thenHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const delivered = await contract.deliver();
  assert.equal("facts" in delivered, true);
  if (!("facts" in delivered)) return;
  assert.equal(delivered.value.tenderSnapshot, mergeCommit);
  assert.equal(delivered.value.integration.predecessor, thenHead);
  assert.equal(mergeHead(repository, worktree), null);
});

test("Delivery.diff freshly reads its pinned candidate diff", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  commitCandidate(repository, worktree);
  await contract.deliver();

  const log = resolve(repository.path, "delivery-diff.log");
  writeFileSync(log, "");
  const shim =
    'if [ "$1" = "diff" ]; then printf \'diff\\n\' >> "$KEIYAKU_DELIVERY_DIFF_LOG"; fi\nexec "$KEIYAKU_REAL_GIT" "$@"';
  const variables = { KEIYAKU_DELIVERY_DIFF_LOG: log };
  const id = (await contract.state()).id;
  const readDiff = async (gitPath: string) => {
    const recovered = await Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id }).delivery();
    if (recovered === null) throw new Error("missing delivery");
    return recovered.diff();
  };
  const first = await withGitShim(shim, variables, readDiff);
  const second = await withGitShim(shim, variables, readDiff);

  if (first === null) throw new Error("missing delivery diff");
  assert.match(first, /diff --git a\/candidate\.txt b\/candidate\.txt/);
  assert.equal(second, first);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
});

test("one public handle reuses its resolved repository scope", async () => {
  const repository = repositoryWithMain();
  const initial = await bind(repository);
  const id = (await initial.state()).id;
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), id);
  commitCandidate(repository, worktree);
  const log = resolve(repository.path, ".git", "scope-discovery.log");
  writeFileSync(log, "");

  const operations = await withGitShim(
    [
      'if [ "$*" = "rev-parse --path-format=absolute --git-common-dir" ]; then',
      "  printf 'discovery\\n' >> \"$KEIYAKU_SCOPE_DISCOVERY_LOG\"",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_SCOPE_DISCOVERY_LOG: log },
    async (gitPath) => {
      const contract = Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id });
      return [contract.state(), contract.deliver(), contract.reconcile()] as const;
    },
  );
  const [state] = await Promise.all(operations);

  assert.equal(state.id, id);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["discovery"]);
});

test("repo reconcile reports an empty completed world", async () => {
  const repository = repositoryWithMain();
  const report = await (await cachedRepoAt(repository.path)).reconcile();
  assert.deepEqual(report, { kind: "completed", contracts: [] });
});

test("repo reconcile returns a typed discovery failure without a synthetic ContractId", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const id = (await bound.state()).id;
  const report = await withGitShim(
    [
      `if [ "$*" = "rev-parse --verify --quiet ${GIT_REF}" ]; then`,
      '  printf "forced world observation failure\\n" >&2',
      "  exit 128",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => (await Repo.at({ path: repository.path, gitPath })).reconcile(),
  );
  assert.equal(report.kind, "world-observation-failed");
  if (report.kind !== "world-observation-failed") return;
  assert.equal("contracts" in report, false);
  assert.equal(report.diagnostic.includes(id), false);
  assert.match(report.diagnostic, /forced world observation failure/u);
});

test("repo reconcile still throws TypeError during world discovery", async () => {
  const { repository } = await defaultBoundFixture();
  const git = await cachedRepositoryAt(repository.path);
  await assert.rejects(
    () =>
      withGitDecodeChannel(git, (channel) =>
        completeRepoReconcile({
          scope: git,
          channel: {
            ...channel,
            readObjects: async () => {
              throw new TypeError("forced type error");
            },
          },
          hooks: { create: [], destroy: [] },
          retryHooks: false,
        }),
      ),
    (error: unknown) => error instanceof TypeError && error.message === "forced type error",
  );
});

test("repo reconcile still throws authority corruption during world discovery", async () => {
  const { repository, contract: bound } = await defaultBoundFixture();
  const id = (await bound.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const before = await readGit(git);
  const journal = before.paths.get(contractJournalPath(id));
  if (journal?.type !== "blob") throw new Error("missing journal");
  const tree = await updateGitTree(
    git,
    before.tree,
    new Map([[contractJournalPath(id), { oid: await writeBlob(git, Buffer.from("not-a-journal\n")) }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: before.commit, message: "corrupt journal" });
  if (before.commit === null) throw new Error("missing state ref");
  repository.run(["update-ref", GIT_REF, commit, before.commit]);
  await assert.rejects(
    () => cachedRepoAt(repository.path).then((repo) => repo.reconcile()),
    (error: unknown) => error instanceof AuthorityCorruptionError,
  );
});

test("repo reconcile keeps per-Contract reports after discovery", async () => {
  const { repository, contract: bound } = await defaultBoundFixture();
  const id = (await bound.state()).id;
  const report = await (await cachedRepoAt(repository.path)).reconcile();
  assert.equal(report.kind, "completed");
  if (report.kind !== "completed") return;
  assert.equal(report.contracts.length, 1);
  assert.equal(report.contracts[0]?.contractId, id);
  assert.equal(Array.isArray(report.contracts[0]?.report.effects), true);
  assert.equal(Array.isArray(report.contracts[0]?.report.lag), true);
  assert.deepEqual(report.contracts[0]?.report.settlement, {
    actions: [],
    lags: [],
  });
});

test("repo reconcile does not observe the Contract world again after discovery", async () => {
  const { repository } = await defaultBoundFixture();
  await plantDispatch(repository, "aku/01ARZ3NDEKTSV4RRFFQ69G5FA", "kei/reconcile", "2026-08-20T00:00:00Z");
  const dispatchTree = repository.run(["rev-parse", `${GIT_REF}:dispatch`]).trim();
  const git = await cachedRepositoryAt(repository.path);
  let dispatchTreeReads = 0;

  const report = await withGitDecodeChannel(git, async (channel) =>
    completeRepoReconcile({
      scope: git,
      channel: {
        ...channel,
        readObjects: async (oids) => {
          if (oids.includes(dispatchTree)) {
            dispatchTreeReads += 1;
            if (dispatchTreeReads > 1) throw new Error("second Contract world observation");
          }
          return await channel.readObjects(oids);
        },
      },
      hooks: { create: [], destroy: [] },
      retryHooks: false,
    }),
  );

  assert.equal(dispatchTreeReads, 1);
  assert.equal(report.kind, "completed");
});

test("public review, abandon, and Arc preserve their ruled testimony", async () => {
  const { repository, contract } = await defaultBoundFixture();
  assert.equal(await contract.delivery(), null);

  await contract.arc({
    markdown: [
      "# Implementation",
      "",
      "## Objective",
      "Complete the public path.",
      "",
      "## Brief",
      "Keep the change bounded.",
      "",
    ].join("\n"),
  });
  assert.equal((await contract.state()).currentArc?.data.seq, 1);

  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  commitCandidate(repository, worktree);
  const delivered = expectMutation(await contract.deliver());
  const recovered = await contract.delivery();
  assert.equal(recovered?.integration.snapshot, delivered.value.integration.snapshot);
  assert.equal(recovered?.integration.changeId, delivered.value.integration.changeId);

  await contract.review({
    verdict: "unsatisfied",
    summary: "The candidate still needs one correction.",
  });
  assert.equal((await contract.state()).attestations.at(-1)?.data.summary, "The candidate still needs one correction.");

  await assert.rejects(
    // @ts-expect-error The deleted reason enum is not an abandon options object.
    () => contract.abandon("manual"),
    /abandon input must be an object/,
  );
  await contract.abandon({ note: "Return the task to planning." });
  assert.equal((await contract.state()).terminal?.kind, "abandoned");
  assert.deepEqual((await contract.state()).terminal?.data, { note: "Return the task to planning." });
  const terminalDelivery = await contract.delivery();
  assert.equal(terminalDelivery?.integration.snapshot, delivered.value.integration.snapshot);
  const contractId = (await contract.state()).id;
  await assert.rejects(() => contract.review({ verdict: "satisfied" }), refused({ kind: "terminal", contractId }));

  await assert.rejects(
    () =>
      contract.arc({
        markdown: ["# Late", "", "## Objective", "Too late.", "", "## Brief", "Must refuse.", ""].join("\n"),
      }),
    refused({ kind: "terminal", contractId }),
  );
});

test("delivery terminal refusal outranks a missing managed worktree", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository);
  const prerequisiteId = (await prerequisite.state()).id;
  const dependent = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
    after: [prerequisiteId],
  });
  assert.equal((await dependent.keiyaku.state()).bound, null);
  const dependentId = (await dependent.keiyaku.state()).id;
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), dependentId);
  await dependent.keiyaku.abandon();
  assert.equal(existsSync(path), false);

  const terminalContractId = (await dependent.keiyaku.state()).id;
  await assert.rejects(
    () => dependent.keiyaku.deliver(),
    refused({ kind: "terminal", contractId: terminalContractId }),
  );
});

test("claim continues one retained dependent without another delivery", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const prerequisite = await bindRetained(repo, "Prerequisite");
  const prerequisiteId = await publicContractId(prerequisite.keiyaku);
  const dependent = await bindRetained(repo, "Dependent", [prerequisiteId]);
  const retained = expectMutation(await dependent.keiyaku.deliver());
  assert.equal(placementRefusalKind(retained.value.placement), "prerequisites-unsatisfied");
  const delivered = expectMutation(await prerequisite.keiyaku.deliver());
  const dependentId = await publicContractId(dependent.keiyaku);

  assert.deepEqual(delivered.value.continuation, {
    claimed: [dependentId],
    stopped: [],
  });
  assert.equal(delivered.head, (await prerequisite.keiyaku.state()).head);
  assert.equal((await dependent.keiyaku.state()).terminal?.kind, "claimed");
  const dependentFacts = (await dependent.keiyaku.history()).events.flatMap((event) =>
    event.source === "journal" ? [event.fact.kind] : [],
  );
  assert.equal(dependentFacts.filter((kind) => kind === "deliver").length, 1);
  assert.equal(dependentFacts.filter((kind) => kind === "claimed").length, 1);
});

test("a stopped continuation does not block an eligible sibling", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const prerequisite = await bindRetained(repo, "Prerequisite");
  const prerequisiteId = await publicContractId(prerequisite.keiyaku);
  const blocked = await bindRetained(repo, "Blocked dependent", [prerequisiteId], true);
  const eligible = await bindRetained(repo, "Eligible dependent", [prerequisiteId]);
  await blocked.keiyaku.deliver();
  await eligible.keiyaku.deliver();
  const delivered = expectMutation(await prerequisite.keiyaku.deliver());
  const blockedId = await publicContractId(blocked.keiyaku);
  const eligibleId = await publicContractId(eligible.keiyaku);

  assert.deepEqual(delivered.value.continuation?.claimed, [eligibleId]);
  const stopped = delivered.value.continuation?.stopped;
  assert.equal(stopped?.length, 1);
  const blockedStop = stopped?.[0];
  assert.equal(blockedStop?.contractId, blockedId);
  assert.equal(placementRefusalKind(blockedStop?.stop), "gates-unsatisfied");
  if (
    blockedStop === undefined ||
    !("refusal" in blockedStop.stop) ||
    blockedStop.stop.refusal.kind !== "gates-unsatisfied"
  )
    return;
  assert.deepEqual(blockedStop.stop.refusal.unmet, [{ gate: "reviewed", current: { kind: "missing" } }]);
  assert.equal((await prerequisite.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal((await eligible.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal((await blocked.keiyaku.state()).terminal, null);
});

test("claim continuation walks a retained dependency chain once", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const root = await bindRetained(repo, "Root");
  const rootId = await publicContractId(root.keiyaku);
  const middle = await bindRetained(repo, "Middle", [rootId]);
  const middleId = await publicContractId(middle.keiyaku);
  const leaf = await bindRetained(repo, "Leaf", [middleId]);
  await leaf.keiyaku.deliver();
  await middle.keiyaku.deliver();
  const delivered = expectMutation(await root.keiyaku.deliver());
  const leafId = await publicContractId(leaf.keiyaku);

  assert.deepEqual(delivered.value.continuation, {
    claimed: [middleId, leafId],
    stopped: [],
  });
  for (const contract of [middle.keiyaku, leaf.keiyaku]) {
    const facts = (await contract.history()).events.flatMap((event) =>
      event.source === "journal" ? [event.fact.kind] : [],
    );
    assert.equal(facts.filter((kind) => kind === "deliver").length, 1);
    assert.equal(facts.filter((kind) => kind === "claimed").length, 1);
  }
});

test("a dependent claimed during continuation reports already-terminal", async () => {
  const repository = repositoryWithMain();
  const repo = await cachedRepoAt(repository.path);
  const prerequisite = await bindRetained(repo, "Prerequisite");
  const prerequisiteId = await publicContractId(prerequisite.keiyaku);
  const dependent = await bindRetained(repo, "Dependent", [prerequisiteId], true, "true");
  const dependentId = await publicContractId(dependent.keiyaku);
  await dependent.keiyaku.deliver();

  const reviewScript = [
    `const { Keiyaku, Repo } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});`,
    `const repo = await Repo.at({ path: ${JSON.stringify(repository.path)} });`,
    `await Keiyaku.of({ repo, id: ${JSON.stringify(dependentId)} }).review({ verdict: "satisfied" });`,
  ].join(" ");
  const encoded = Buffer.from(`(async () => { ${reviewScript} })()`).toString("base64");
  const verification = [
    "## Replace: Verification",
    "~~~bash",
    `${JSON.stringify(process.execPath)} --import '${new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href}' --input-type=module -e 'await eval(Buffer.from("${encoded}", "base64").toString())'`,
    "~~~",
    "",
  ].join("\n");
  await dependent.keiyaku.amend({ markdown: verification });
  const delivered = expectMutation(await prerequisite.keiyaku.deliver());

  assert.deepEqual(delivered.value.continuation, {
    claimed: [],
    stopped: [
      {
        contractId: dependentId,
        stop: { kind: "already-terminal" },
      },
    ],
  });
  assert.equal((await dependent.keiyaku.state()).terminal?.kind, "claimed");
});

test("review records before delivery and the same patch can be placed", async () => {
  const { repository, contract } = await defaultBoundFixture();
  const contractId = await publicContractId(contract);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), contractId);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");

  const reviewed = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(
    reviewed.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.deepEqual(reviewed.value.workspace, {
    staged: [],
    unstaged: [],
    untracked: ["candidate.txt"],
    shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
  });
  assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
  const subject = (await contract.state()).attestations.at(-1)?.data.subject;
  const testimony = JSON.stringify((await contract.state()).attestations.at(-1)?.data);
  assert.equal(testimony.includes("workspace"), false);
  assert.equal(testimony.includes("dirty"), false);

  const delivered = expectMutation(await contract.deliver({ includeDirty: true }));
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "claimed"],
  );
  assert.equal((await contract.state()).attestations.at(-1)?.data.subject, subject);
  assert.equal((await contract.state()).terminal?.kind, "claimed");
});

test("a satisfied review before delivery records testimony and reports delivery-missing", async () => {
  const { repository, contract, targetHead } = await reviewGatedConflictCandidateFixture();
  const contractId = await publicContractId(contract);

  const reviewed = await contract.review({ verdict: "satisfied" });

  assert.deepEqual(
    reviewed.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.deepEqual(reviewed.value.placement, {
    refusal: { kind: "delivery-missing", contractId },
  });
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
  const reviewedState = await contract.state();
  assert.equal(reviewedState.delivery, null);
  assert.equal(reviewedState.terminal, null);
  assert.equal(reviewedState.attestations.at(-1)?.data.verdict, "satisfied");
  const reviewedObservation = await Keiyaku.observe({ repo: await cachedRepoAt(repository.path), id: contractId });
  assert.equal(reviewedObservation.kind, "present");
  if (reviewedObservation.kind !== "present") throw new Error("contract was not observed");
  assert.deepEqual(reviewedObservation.row.gates, {
    reports: [{ gate: "reviewed", current: { kind: "stale", priorVerdict: "satisfied" } }],
    satisfied: false,
  });

  writeFileSync(join(repository.path, "a.txt"), "base\n");
  writeFileSync(join(repository.path, "z.txt"), "base\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "resolve target"]);
  const delivered = expectMutation(await contract.deliver());
  const reviewedSubject = reviewedState.attestations.at(-1)?.data.subject;
  const reviewedChangeId = changeIdFromSubject(reviewedSubject);

  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "claimed"],
  );
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  const claimedObservation = await Keiyaku.observe({ repo: await cachedRepoAt(repository.path), id: contractId });
  assert.equal(claimedObservation.kind, "present");
  if (claimedObservation.kind !== "present") throw new Error("contract was not observed");
  const claimedGate = claimedObservation.row.gates;
  assert.equal(claimedGate.satisfied, true);
  assert.equal(claimedGate.reports.length, 1);
  assert.equal(claimedGate.reports[0]?.gate, "reviewed");
  assert.equal(claimedGate.reports[0]?.current.kind, "attested");
  if (claimedGate.reports[0]?.current.kind !== "attested") throw new Error("reviewed gate was not attested");
  assert.equal(claimedGate.reports[0].current.verdict, "satisfied");
  assert.equal(typeof claimedGate.reports[0].current.at, "string");
});

test("target movement alone does not stale reviewed worktree content", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
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
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await bound.keiyaku.state()).attestations.at(-1)?.data.subject);
  writeFileSync(join(repository.path, "unrelated.txt"), "target only\n");
  repository.run(["add", "unrelated.txt"]);
  repository.run(["commit", "--quiet", "-m", "move target"]);
  const delivered = expectMutation(await bound.keiyaku.deliver());

  assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "claimed"],
  );
});

test("review and delivery share a worktree ChangeId after the tender incorporates its target", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "target.txt"), "base\n");
  repository.run(["add", "target.txt"]);
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
  writeFileSync(join(repository.path, "target.txt"), "target advance\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  repository.run(["-C", worktree, "rebase", "refs/heads/main"]);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await bound.keiyaku.state()).attestations.at(-1)?.data.subject);
  const delivered = expectMutation(await bound.keiyaku.deliver());

  assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "claimed"],
  );
});

test("an unsatisfied conflicted review records the same subject without requesting placement", async () => {
  const { contract } = await reviewGatedConflictCandidateFixture();

  const unsatisfied = await contract.review({ verdict: "unsatisfied" });
  const unsatisfiedSubject = (await contract.state()).attestations.at(-1)?.data.subject;
  assert.deepEqual(
    unsatisfied.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(unsatisfied.value.placement, undefined);

  const satisfied = await contract.review({ verdict: "satisfied" });
  const satisfiedState = await contract.state();
  assert.equal(satisfiedState.attestations.at(-1)?.data.subject, unsatisfiedSubject);
  assert.equal(placementRefusalKind(satisfied.value.placement), "delivery-missing");
});

test("diff presentation config does not change a reviewed worktree ChangeId", async () => {
  const module = makeGitRepository();
  module.run(["commit", "--allow-empty", "--quiet", "-m", "module"]);
  const repository = repositoryWithMain();
  mkdirSync(join(repository.path, "dir"), { recursive: true });
  writeFileSync(join(repository.path, "dir", "nested.txt"), "nested\n");
  writeFileSync(join(repository.path, "hunks.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
  writeFileSync(join(repository.path, "blank.txt"), "keep\n\nkeep2\nkeep3\n");
  repository.run(["add", "dir/nested.txt", "hunks.txt", "blank.txt"]);
  repository.run(["commit", "--quiet", "-m", "base content"]);
  const result = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const resultId = await publicContractId(result.keiyaku);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), resultId);
  writeFileSync(join(worktree, "dir", "nested.txt"), "nested2\n");
  writeFileSync(join(worktree, "hunks.txt"), "X\n2\n3\n4\n5\n6\n7\n8\n9\nY\n");
  writeFileSync(join(worktree, "blank.txt"), "KEEP\n\nkeep2\nkeep3\n");
  repository.run([
    "-C",
    worktree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    module.path,
    "vendor/mod",
  ]);
  repository.run(["-C", worktree, "add", "dir/nested.txt", "hunks.txt", "blank.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await result.keiyaku.state()).attestations.at(-1)?.data.subject);
  for (const [key, value] of [
    ["core.abbrev", "4"],
    ["diff.algorithm", "histogram"],
    ["core.quotePath", "false"],
    ["diff.srcPrefix", "aaa/"],
    ["diff.dstPrefix", "bbb/"],
    ["diff.noPrefix", "true"],
    ["diff.relative", "true"],
    ["diff.interHunkContext", "20"],
    ["diff.suppressBlankEmpty", "true"],
    ["diff.ignoreSubmodules", "all"],
    ["diff.submodule", "log"],
    ["diff.mnemonicPrefix", "true"],
  ] as const)
    repository.run(["config", key, value]);

  const delivered = expectMutation(
    await Keiyaku.of({
      repo: await Repo.at({ path: join(worktree, "dir") }),
      id: resultId,
    }).deliver(),
  );
  assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver", "claimed"],
  );
});

test("a satisfied review waits on the target-placement fence before reporting delivery-missing", async () => {
  const { repository, contract } = await reviewGatedConflictCandidateFixture();
  const held = await acquireTargetPlacementFence(await cachedRepositoryAt(repository.path), "refs/heads/main");
  const pending = contract.review({ verdict: "satisfied" });
  const raced = await Promise.race([
    pending.then(() => "finished" as const),
    new Promise<"blocked">((resolve) => {
      setTimeout(() => resolve("blocked"), 150);
    }),
  ]);
  assert.equal(raced, "blocked");
  held.close();
  const reviewed = await pending;
  assert.deepEqual(
    reviewed.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
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

test("a whitespace-only worktree change stales prior review testimony", async () => {
  const { repository, contract } = await defaultBoundFixture();
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  const reviewed = await contract.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await contract.state()).attestations.at(-1)?.data.subject);
  writeFileSync(join(worktree, "candidate.txt"), "candidate \n");

  const delivered = expectMutation(await contract.deliver({ includeDirty: true }));
  assert.equal(placementRefusalKind(reviewed.value.placement), "delivery-missing");
  assert.notEqual(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver"],
  );
  assert.equal(placementRefusalKind(delivered.value.placement), "gates-unsatisfied");
  assert.equal((await contract.state()).terminal, null);
});

test("a changed worktree patch leaves the reviewed placement pending", async () => {
  const { repository, contract } = await defaultBoundFixture();
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  writeFileSync(join(worktree, "candidate.txt"), "first\n");
  const reviewed = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.value.workspace?.untracked, ["candidate.txt"]);
  writeFileSync(join(worktree, "candidate.txt"), "second\n");

  const delivered = expectMutation(await contract.deliver({ includeDirty: true }));
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver"],
  );
  assert.equal(placementRefusalKind(delivered.value.placement), "gates-unsatisfied");
  assert.equal((await contract.state()).terminal, null);
});

test("terms-only amend copies Markdown bytes and identities without rendering", async () => {
  const repository = repositoryWithMain();
  const markdown = document().replace("## Context\n", "## Context\n\n\n");
  const prerequisite = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document().replace("# Library verbs", "# Prerequisite"),
    workspace: "worktree",
  });
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown,
    workspace: "worktree",
    gates: ["reviewed", "held"],
  });
  const boundId = await publicContractId(bound.keiyaku);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), boundId);
  commitCandidate(repository, worktree);
  await bound.keiyaku.deliver();
  await bound.keiyaku.review({ verdict: "satisfied" });
  const before = await bound.keiyaku.state();
  const reviewed = await Keiyaku.observe({ repo: await cachedRepoAt(repository.path), id: boundId });
  assert.equal(reviewed.kind === "present" && reviewed.row.gates.reports[0]?.current.kind, "attested");

  const prerequisiteId = await publicContractId(prerequisite.keiyaku);
  const amended = await bound.keiyaku.amend({ after: [prerequisiteId] });
  const after = await bound.keiyaku.state();
  assert.equal(amended.documentDiff, "");
  assert.deepEqual(after.terms.after, [prerequisiteId]);
  assert.deepEqual(after.terms.gates, before.terms.gates);
  assert.equal(after.terms.document.bytes, markdown);
  assert.equal(after.terms.document.key, before.terms.document.key);
  assert.deepEqual(after.terms.segments, before.terms.segments);
  const observed = await Keiyaku.observe({ repo: await cachedRepoAt(repository.path), id: boundId });
  assert.equal(observed.kind === "present" && observed.row.gates.reports[0]?.current.kind, "attested");
});

test("a changed document leaves an otherwise unchanged reviewed patch pending", async () => {
  const { repository, contract } = await defaultBoundFixture();
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  await contract.review({ verdict: "satisfied" });

  await contract.amend({
    markdown: "## Replace: Objective\nRequire review of the current contract document.\n",
  });

  const delivered = expectMutation(await contract.deliver({ includeDirty: true }));
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["bound", "deliver"],
  );
  assert.equal(placementRefusalKind(delivered.value.placement), "gates-unsatisfied");
  assert.equal((await contract.state()).terminal, null);
});

test("review testimony is recorded when reviewed is not a placement gate", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    gates: [],
  });
  const resultId = await publicContractId(result.keiyaku);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), resultId);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");

  const reviewed = await result.keiyaku.review({ verdict: "unsatisfied" });
  assert.deepEqual(
    reviewed.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(reviewed.value.placement, undefined);
  assert.deepEqual(reviewed.value.workspace?.untracked, ["candidate.txt"]);
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.gate, "reviewed");
});

test("contract history composes one frozen journal and Dispatch observation", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository);
  const firstId = (await first.state()).id;
  const other = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document().replace("# Library verbs", "# Other contract"),
    workspace: "worktree",
  });
  const otherId = (await other.keiyaku.state()).id;
  const observedBind = (await first.history()).events.find(
    (event) => event.source === "journal" && event.fact.kind === "bind",
  );
  if (observedBind === undefined || observedBind.source !== "journal") throw new Error("missing bind fact");
  const bindTime = observedBind.fact.at;
  await plantDispatch(repository, "aku/worker/bbbbbbbb", firstId, bindTime);
  await plantDispatch(repository, "aku/worker/aaaaaaaa", firstId, bindTime);
  await plantDispatch(repository, "aku/reviewer/cccccccc", firstId, "2099-01-01T00:00:00.000Z");
  await plantDispatch(repository, "aku/worker/dddddddd", otherId, bindTime);
  await first.abandon({ note: "done" });
  const abandoned = (await first.history()).events.find(
    (event) => event.source === "journal" && event.fact.kind === "abandoned",
  );
  if (abandoned === undefined || abandoned.source !== "journal") throw new Error("missing abandoned fact");
  await plantDispatch(repository, "aku/worker/eeeeeeee", firstId, abandoned.fact.at);

  const log = resolve(repository.path, "history-observation.log");
  writeFileSync(log, "");
  const history = await withGitShim(
    'printf \'%s\\n\' "$*" >> "$KEIYAKU_HISTORY_OBSERVATION_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_HISTORY_OBSERVATION_LOG: log },
    async (gitPath) => Keiyaku.of({ repo: await Repo.at({ path: repository.path, gitPath }), id: firstId }).history(),
  );
  const snapshot = await readRef(await cachedRepositoryAt(repository.path), GIT_REF);
  assert.equal(history.id, firstId);
  assert.equal(history.state, snapshot);
  assert.equal(history.events.filter((event) => event.source === "journal").length, 2);
  assert.deepEqual(
    history.events
      .filter((event) => event.source === "dispatch")
      .map((event) => (event.source === "dispatch" ? event.dispatch.akuId : "")),
    ["aku/worker/aaaaaaaa", "aku/worker/bbbbbbbb", "aku/worker/eeeeeeee", "aku/reviewer/cccccccc"],
  );
  assert.equal(
    history.events.some((event) => event.source === "dispatch" && event.dispatch.akuId === "aku/worker/dddddddd"),
    false,
  );
  const times = history.events.map((event) =>
    event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt,
  );
  assert.deepEqual(times, [...times].sort());
  const equalBind = history.events.filter(
    (event) => (event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt) === bindTime,
  );
  assert.equal(equalBind[0]?.source, "journal");
  assert.deepEqual(
    equalBind
      .filter((event) => event.source === "dispatch")
      .map((event) => (event.source === "dispatch" ? event.dispatch.akuId : "")),
    ["aku/worker/aaaaaaaa", "aku/worker/bbbbbbbb"],
  );
  const equalAbandon = history.events.filter(
    (event) => (event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt) === abandoned.fact.at,
  );
  assert.equal(equalAbandon[0]?.source, "journal");
  assert.equal(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.includes(`rev-parse --verify --quiet ${GIT_REF}`)).length,
    1,
  );
});

test("contract history reports only journal events when Dispatch is absent", async () => {
  const { contract } = await defaultBoundFixture();
  const history = await contract.history();
  assert.equal(
    history.events.every((event) => event.source === "journal"),
    true,
  );
  assert.equal(history.events.length >= 1, true);
  assert.equal(history.events[0]?.source === "journal" && history.events[0].fact.kind === "bind", true);
});

test("contract history uses the existing contract-missing refusal", async () => {
  const repository = repositoryWithMain();
  const missing = contractId("kei/missing-history");
  await assert.rejects(
    async () => Keiyaku.of({ repo: await cachedRepoAt(repository.path), id: missing }).history(),
    refused({ kind: "contract-missing", contractId: missing }),
  );
});

test("contract history fails the whole read when journal or Dispatch is corrupt", async () => {
  const { repository, contract } = await defaultBoundFixture();
  const id = (await contract.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const before = await readGit(git);
  const journal = before.paths.get(contractJournalPath(id));
  if (journal?.type !== "blob") throw new Error("missing journal");
  const tree = await updateGitTree(
    git,
    before.tree,
    new Map([[contractJournalPath(id), { oid: await writeBlob(git, Buffer.from("not-a-journal\n")) }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: before.commit, message: "corrupt journal" });
  if (before.commit === null) throw new Error("missing state ref");
  repository.run(["update-ref", GIT_REF, commit, before.commit]);
  await assert.rejects(
    async () => Keiyaku.of({ repo: await cachedRepoAt(repository.path), id }).history(),
    (error: unknown) => error instanceof AuthorityCorruptionError,
  );

  const { repository: clean, contract: intact } = await defaultBoundFixture();
  const intactId = (await intact.state()).id;
  await plantDispatch(
    clean,
    "aku/worker/ffffffff",
    intactId,
    "2026-08-17T00:00:00.000Z",
    Buffer.from("{not-canonical\n"),
  );
  await assert.rejects(
    () => intact.history(),
    (error: unknown) => error instanceof AuthorityCorruptionError,
  );
});
