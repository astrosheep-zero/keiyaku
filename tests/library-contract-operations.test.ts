import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { contractId, snapshotId, type ContractId } from "../src/core/facts/types.js";
import { materializeJudgedConflict } from "../src/git/integration.js";
import { GIT_REF, readRef } from "../src/git/repository.js";
import { recordConflictHandoff } from "../src/git/workspace.js";
import { Keiyaku, Repo, type IntegrationConflictMaterialized, type MutationResult } from "../src/index.js";
import type { ContinuationStop } from "../src/library/continuation.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  snapshotGitRepository as rawSnapshotGitRepository,
  withGitShim,
} from "./support/git.js";
import {
  bind,
  commitCandidate,
  document,
  repositoryWithMain as rawRepositoryWithMain,
  refused,
} from "./support/library-verbs.js";

const fixtureRepositories = new Set<string>();
after(() => {
  for (const path of fixtureRepositories) rmSync(path, { recursive: true, force: true });
});
function repositoryWithMain() {
  const repository = rawRepositoryWithMain();
  fixtureRepositories.add(repository.path);
  return repository;
}
function snapshotGitRepository(source: Parameters<typeof rawSnapshotGitRepository>[0]) {
  const repository = rawSnapshotGitRepository(source);
  fixtureRepositories.add(repository.path);
  return repository;
}

type ContractHandle = Pick<Keiyaku, "state">;

async function publicContractId(handle: ContractHandle): Promise<ContractId> {
  return (await handle.state()).id;
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

async function retainedVerifiedCandidate(
  repository: ReturnType<typeof repositoryWithMain>,
  title: string,
  verification = "true",
) {
  const bound = await bindRetained(await cachedRepoAt(repository.path), title, [], true, verification);
  const contract = bound.keiyaku;
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    await publicContractId(contract),
  );
  commitCandidate(repository, worktree);
  return { contract, worktree };
}

async function cancelDuringVerification<Value>(
  marker: string,
  run: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  rmSync(marker, { force: true });
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (existsSync(marker)) controller.abort();
  }, 1);
  try {
    return await run(controller.signal);
  } finally {
    clearInterval(timer);
  }
}

function blockingVerification(marker: string): string {
  return `${process.execPath} -e ${JSON.stringify(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setTimeout(() => {}, 30000);`,
  )}`;
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

test("a receipt retires a crash after merge before materialization returns", async () => {
  const { repository, contract, targetHead, worktree } = await reviewGatedConflictCandidateFixture();
  const git = await cachedRepositoryAt(repository.path);
  const contractId = await publicContractId(contract);
  const appointment = await readManagedWorktreeAppointment(git, contractId);
  assert.ok(appointment.kind === "appointed", 'expected appointment.kind = "appointed"');
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
    () => contract.deliver({ includeDirty: true, materializeConflict: true, overwrite: true }),
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

test("redelivery recovers an unrecorded candidate without capturing later dirty work", async () => {
  const repository = repositoryWithMain();
  const marker = join(repository.path, "verification-started");
  const verification = blockingVerification(marker);
  const { contract, worktree } = await retainedVerifiedCandidate(repository, "Interrupted", verification);
  const first = expectMutation(
    await cancelDuringVerification(marker, async (signal) => await contract.deliver({ signal })),
  );
  const delivery = first.facts.find((fact) => fact.kind === "deliver");
  assert.ok(delivery);
  assert.equal(first.value.verification && "failure" in first.value.verification, true);

  writeFileSync(join(worktree, "later.txt"), "not part of the admitted candidate\n");
  const recovered = await withGitShim(
    [
      'if [ "$1" = "commit-tree" ]; then printf "unexpected recapture\\n" >&2; exit 97; fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const routed = Keiyaku.of({
        repo: await Repo.at({ path: repository.path, gitPath }),
        id: await publicContractId(contract),
      });
      return expectMutation(
        await cancelDuringVerification(marker, async (signal) => await routed.deliver({ includeDirty: true, signal })),
      );
    },
  );
  assert.deepEqual(recovered.facts, []);
  assert.deepEqual(recovered.value.leading, { kind: "already-admitted", fact: delivery!.entry });
  assert.deepEqual(recovered.value.integration, first.value.integration);

  const audited = await cancelDuringVerification(marker, (signal) => contract.audit({ includeDirty: true, signal }));
  assert.equal(audited.value.delivery?.relation, "differs");
  assert.equal(audited.value.delivery?.verification.kind, "unrecorded");

  const overwritten = expectMutation(
    await cancelDuringVerification(
      marker,
      async (signal) => await contract.deliver({ includeDirty: true, overwrite: true, signal }),
    ),
  );
  assert.equal(overwritten.value.leading, undefined);
  assert.notDeepEqual(overwritten.value.integration, first.value.integration);
  assert.equal(overwritten.facts.filter((fact) => fact.kind === "deliver").length, 1);
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
  assert.equal(
    blockedStop !== undefined && "refusal" in blockedStop.stop ? blockedStop.stop.refusal.kind : undefined,
    "gates-unsatisfied",
  );
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
