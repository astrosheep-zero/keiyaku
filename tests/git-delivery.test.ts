import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { prepareDelivery } from "../src/protocol/deliver.js";
import { prepareReview } from "../src/protocol/review.js";
import { actorId } from "../src/core/facts/types.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { adjudicateAuditTarget, observeTargetPlacement } from "../src/git/target-placement.js";
import { readRef } from "../src/git/repository.js";
import { materializeJudgedConflict, readDeliveryDiff, workspaceMergeStatePresent } from "../src/git/integration.js";
import { materializeScratchCandidate } from "../src/git/scratch.js";
import { reconcile } from "../src/git/reconcile.js";
import { followDependentManagedWorktree, worktreePath } from "../src/git/workspace.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { AuthorityCorruptionError, Keiyaku, Repo, type ContractId } from "../src/index.js";
import { deliveryDiffOperation, scopeOperation } from "../src/protocol/operations.js";
import {
  appointedWorktreePath,
  cachedRepositoryAt,
  makeGitRepository,
  observeContract,
  snapshotGitRepository,
  type TestGitRepository,
  withGitShim,
} from "./support/git.js";

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

const fixtureTemplates = new Map<string, TestGitRepository>();

function deliveryFixture(files: Readonly<Record<string, string>> = {}, message = "initial"): TestGitRepository {
  const key = JSON.stringify({
    files: Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
    message,
  });
  let template = fixtureTemplates.get(key);
  if (template === undefined) {
    template = makeGitRepository();
    for (const [path, contents] of Object.entries(files)) {
      const target = join(template.path, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    if (Object.keys(files).length === 0) {
      template.run(["commit", "--allow-empty", "--quiet", "-m", message]);
    } else {
      template.run(["add", "--", ...Object.keys(files)]);
      template.run(["commit", "--quiet", "-m", message]);
    }
    fixtureTemplates.set(key, template);
  }
  return snapshotGitRepository(template);
}

test("delivery fixtures snapshot independent initial repositories", () => {
  const first = deliveryFixture({ "fixture.txt": "template\n" });
  const second = deliveryFixture({ "fixture.txt": "template\n" });
  assert.notEqual(first.path, second.path);
  assert.equal(existsSync(join(second.path, ".git", "objects", "info", "alternates")), false);
  assert.equal(second.run(["remote"]).trim(), "");

  writeFileSync(join(first.path, "fixture.txt"), "changed\n");
  first.run(["add", "fixture.txt"]);
  first.run(["commit", "--quiet", "-m", "changed fixture"]);
  first.run(["config", "test.fixture", "changed"]);

  const third = deliveryFixture({ "fixture.txt": "template\n" });
  for (const repository of [second, third]) {
    assert.equal(readFileSync(join(repository.path, "fixture.txt"), "utf8"), "template\n");
    assert.equal(repository.run(["log", "-1", "--format=%s"]).trim(), "initial");
    assert.equal(repository.run(["remote"]).trim(), "");
    assert.equal(existsSync(join(repository.path, ".git", "objects", "info", "alternates")), false);
    assert.throws(() => repository.run(["config", "--get", "test.fixture"]));
  }
});

type GeneratedWorktreeFile = Readonly<{ path: string; bytes: Buffer; mode: number }>;
type PostBindTemplate = Readonly<{
  repository: TestGitRepository;
  id: ContractId;
  start: ReturnType<typeof mintSnapshotId>;
  preparation: ReturnType<typeof preparationCoordinates>;
  generatedFiles: readonly GeneratedWorktreeFile[];
}>;

const postBindTemplates = new Map<string, Promise<PostBindTemplate>>();

function postBindTemplateKey(target: "targetless" | "targeted", gates: readonly string[]): string {
  return JSON.stringify({ target, gates });
}

async function buildPostBindTemplate(
  target: "targetless" | "targeted",
  gates: readonly string[],
): Promise<PostBindTemplate> {
  const repository = target === "targetless" ? deliveryFixture() : deliveryFixture({ "shared.txt": "base\n" });
  if (target === "targetless") {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
  }
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    ...(target === "targeted" ? { target: "refs/heads/main", ...(gates.length === 0 ? {} : { gates }) } : {}),
  });
  const state = await bound.keiyaku.state();
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
  return {
    repository,
    id: state.id,
    start: state.coordinates.start,
    preparation: preparationCoordinates(state),
    generatedFiles,
  };
}

function postBindTemplate(target: "targetless" | "targeted", gates: readonly string[] = []): Promise<PostBindTemplate> {
  const key = postBindTemplateKey(target, gates);
  const existing = postBindTemplates.get(key);
  if (existing !== undefined) return existing;
  const template = buildPostBindTemplate(target, gates);
  postBindTemplates.set(key, template);
  void template.catch(() => {
    if (postBindTemplates.get(key) === template) postBindTemplates.delete(key);
  });
  return template;
}

async function postBindFixture(target: "targetless" | "targeted", gates: readonly string[] = []) {
  const template = await postBindTemplate(target, gates);
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
  return { contract, repository, id: template.id, preparation: template.preparation, worktree };
}

async function boundContract() {
  const { contract, repository, id, worktree } = await postBindFixture("targetless");
  return { contract, repository, id, worktree };
}

async function preparedDelivery(repository: TestGitRepository, id: ContractId) {
  const state = (await observeContract(await cachedRepositoryAt(repository.path), id)).state;
  if (state === null) throw new Error("contract was not observed");
  const prepared = await prepareDelivery(await cachedRepositoryAt(repository.path), preparationCoordinates(state), {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  return prepared.data;
}

function deliveryRefFor(contract: ContractId): string {
  return `refs/keiyaku/delivery/kei-${contract.slice("kei/".length)}`;
}

function candidatePinRefFor(contract: ContractId): string {
  return `refs/keiyaku/candidate/kei-${contract.slice("kei/".length)}`;
}

function recoverySnapshot(result: Readonly<{ recoverySnapshot?: string }>): string {
  if (result.recoverySnapshot === undefined) assert.fail("accepted mutation is missing recoverySnapshot");
  return result.recoverySnapshot;
}

function commitMessage(repository: TestGitRepository, commit: string): string {
  const object = repository.run(["cat-file", "commit", commit]);
  const separator = object.indexOf("\n\n");
  if (separator < 0) throw new Error("commit object has no message separator");
  return object.slice(separator + 2);
}

function commitSignature(repository: TestGitRepository, commit: string): readonly string[] {
  return repository.run(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI", commit]).trim().split("\0");
}

async function targetedContract(gates: readonly string[] = []) {
  return await postBindFixture("targeted", gates);
}

async function directoryReplacementContract(ignore = "artifact/*.tmp\n") {
  const repository = deliveryFixture(
    {
      ".gitignore": ignore,
      "artifact/tracked.txt": "tracked\n",
    },
    "tracked directory",
  );
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    target: "refs/heads/main",
  });
  const state = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  repository.run(["-C", worktree, "rm", "-r", "artifact"]);
  writeFileSync(join(worktree, "artifact"), "candidate file\n");
  repository.run(["-C", worktree, "add", "artifact"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "replace directory"]);
  return { contract: bound.keiyaku, repository, worktree };
}

test("permissive targeted delivery integrates tender bytes over the observed target head", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "target.txt"), "target advance\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "tender.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "tender.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender"]);
  const tenderHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const git = await cachedRepositoryAt(repository.path);
  const review = await prepareReview(git, preparation);
  const delivery = await prepareDelivery(git, preparation, {
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
  const { repository, preparation } = await targetedContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "advance target"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  assert.deepEqual(
    await prepareDelivery(await cachedRepositoryAt(repository.path), preparation, {
      title: "Strict delivery",
      document: contractBody(),
      requireBranchesToBeUpToDate: true,
    }),
    {
      kind: "refused",
      refusal: {
        kind: "integration-failed",
        contractId: preparation.contractId,
        reason: "not-based-on-target",
        targetHead,
      },
    },
  );
});

test("targeted integration conflict returns structured paths", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  assert.deepEqual(
    await prepareDelivery(await cachedRepositoryAt(repository.path), preparation, {
      title: "Conflicted delivery",
      document: contractBody(),
      requireBranchesToBeUpToDate: false,
    }),
    {
      kind: "refused",
      refusal: {
        kind: "integration-failed",
        contractId: preparation.contractId,
        reason: "conflict",
        targetHead,
        conflictPaths: ["shared.txt"],
      },
    },
  );
});

test("Git merge-state detection and judged conflict projection stay with the one judge", async () => {
  const { repository, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const git = await cachedRepositoryAt(repository.path);
  assert.equal(await workspaceMergeStatePresent(git, worktree), false);
  await materializeJudgedConflict(git, worktree, targetHead);
  assert.equal(await workspaceMergeStatePresent(git, worktree), true);
  assert.equal(repository.run(["-C", worktree, "rev-parse", "MERGE_HEAD"]).trim(), targetHead);
});

test("delivery refuses unresolved index paths and captures a resolved merge as a native graph", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "a.txt"), "target\n");
  writeFileSync(join(repository.path, "z.txt"), "target\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "a.txt"), "tender\n");
  writeFileSync(join(worktree, "z.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const tenderHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const git = await cachedRepositoryAt(repository.path);
  await materializeJudgedConflict(git, worktree, mintSnapshotId(targetHead));
  const indexBefore = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);
  const statusBefore = repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]);

  const omitted = await prepareDelivery(git, preparation, {
    title: "Resolved merge",
    document: contractBody(),
  });
  assert.equal(omitted.kind, "refused");
  if (omitted.kind === "refused") {
    assert.equal(omitted.refusal.kind, "dirty-workspace");
  }
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), indexBefore);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]), statusBefore);

  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  writeFileSync(join(worktree, "z.txt"), "resolved\n");
  const unresolvedIndex = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);
  const unresolvedStatus = repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]);
  const preparedUnresolved = await prepareDelivery(git, preparation, {
    title: "Resolved merge",
    document: contractBody(),
    includeDirty: true,
  });
  assert.equal(preparedUnresolved.kind, "prepared");
  if (preparedUnresolved.kind !== "prepared") return;
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), unresolvedIndex);
  assert.equal(
    repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]),
    unresolvedStatus,
  );
  const unresolvedTender = preparedUnresolved.data.tenderSnapshot;
  assert.deepEqual(repository.run(["show", "-s", "--format=%P", unresolvedTender]).trim().split(" "), [
    tenderHead,
    targetHead,
  ]);
  assert.equal(repository.run(["show", `${unresolvedTender}:a.txt`]), "resolved\n");
  assert.equal(repository.run(["show", `${unresolvedTender}:z.txt`]), "resolved\n");

  const plain = await prepareDelivery(git, preparation, {
    title: "Resolved merge",
    document: contractBody(),
  });
  assert.equal(plain.kind, "refused");
  if (plain.kind === "refused") {
    assert.equal(plain.refusal.kind, "dirty-workspace");
  }

  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  const dirtyOmitted = await prepareDelivery(git, preparation, {
    title: "Resolved merge",
    document: contractBody(),
  });
  assert.equal(dirtyOmitted.kind, "refused");
  if (dirtyOmitted.kind === "refused") {
    assert.equal(dirtyOmitted.refusal.kind, "dirty-workspace");
    if (dirtyOmitted.refusal.kind === "dirty-workspace") {
      assert.deepEqual(dirtyOmitted.refusal.staged, ["a.txt", "z.txt"]);
    }
  }

  const prepared = await prepareDelivery(git, preparation, {
    title: "Resolved merge",
    document: contractBody(),
    includeDirty: true,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") return;
  const tender = prepared.data.tenderSnapshot;
  assert.deepEqual(repository.run(["show", "-s", "--format=%P", tender]).trim().split(" "), [tenderHead, targetHead]);

  repository.run(["-C", worktree, "commit", "--quiet", "-m", "native resolved merge"]);
  const native = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  assert.equal(
    repository.run(["show", "-s", "--format=%T", tender]),
    repository.run(["show", "-s", "--format=%T", native]),
  );
  assert.equal(
    repository.run(["show", "-s", "--format=%P", tender]),
    repository.run(["show", "-s", "--format=%P", native]),
  );
});

test("resolved merge state remains dirty authorization when its tree equals HEAD", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const tenderHead = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const git = await cachedRepositoryAt(repository.path);
  await materializeJudgedConflict(git, worktree, mintSnapshotId(targetHead));
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);

  const plain = await prepareDelivery(git, preparation, {
    title: "Equal resolved merge",
    document: contractBody(),
  });
  assert.equal(plain.kind, "refused");
  if (plain.kind === "refused") assert.equal(plain.refusal.kind, "dirty-workspace");
  const prepared = await prepareDelivery(git, preparation, {
    title: "Equal resolved merge",
    document: contractBody(),
    includeDirty: true,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") return;
  assert.equal(
    repository.run(["show", "-s", "--format=%T", prepared.data.tenderSnapshot]),
    repository.run(["show", "-s", "--format=%T", tenderHead]),
  );
  assert.deepEqual(repository.run(["show", "-s", "--format=%P", prepared.data.tenderSnapshot]).trim().split(" "), [
    tenderHead,
    targetHead,
  ]);
});

test("rebasing a managed tender onto the current target resolves its integration base", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "HEAD"]).trim();

  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  const before = await prepareDelivery(await cachedRepositoryAt(repository.path), preparation, {
    title: "Conflicted delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  });
  assert.equal(before.kind, "refused");

  assert.throws(() => repository.run(["-C", worktree, "rebase", "--onto", targetHead, preparation.coordinates.start]));
  writeFileSync(join(worktree, "shared.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "-c", "core.editor=true", "rebase", "--continue"]);
  const after = await prepareDelivery(await cachedRepositoryAt(repository.path), preparation, {
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
  const { repository, preparation, worktree } = await targetedContract();
  repository.run(["-C", worktree, "checkout", "--orphan", "unrelated"]);
  repository.run(["-C", worktree, "rm", "--quiet", "-rf", "."]);
  writeFileSync(join(worktree, "unrelated.txt"), "unrelated\n");
  repository.run(["-C", worktree, "add", "unrelated.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "unrelated"]);
  const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const prepared = await prepareDelivery(await cachedRepositoryAt(repository.path), preparation, {
    title: "Unrelated delivery",
    document: contractBody(),
    requireBranchesToBeUpToDate: false,
  });
  assert.deepEqual(prepared, {
    kind: "refused",
    refusal: {
      kind: "integration-failed",
      contractId: preparation.contractId,
      reason: "unrelated-histories",
      targetHead,
    },
  });
});

test("permissive integration reports unsupported Git while strict policy needs no merge-tree", async () => {
  const { repository, preparation } = await targetedContract();
  const shim = [
    'if [ "$1" = "merge-tree" ]; then',
    '  printf "unsupported merge-tree\n" >&2',
    "  exit 129",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const permissive = await withGitShim(
    shim,
    {},
    async (gitPath) =>
      await prepareDelivery(await cachedRepositoryAt(repository.path, gitPath), preparation, {
        title: "Permissive",
        document: contractBody(),
        requireBranchesToBeUpToDate: false,
      }),
  );
  assert.deepEqual(permissive, {
    kind: "refused",
    refusal: { kind: "integration-unsupported", contractId: preparation.contractId, requiredGit: "2.38" },
  });
  const strict = await withGitShim(
    shim,
    {},
    async (gitPath) =>
      await prepareDelivery(await cachedRepositoryAt(repository.path, gitPath), preparation, {
        title: "Strict",
        document: contractBody(),
        requireBranchesToBeUpToDate: true,
      }),
  );
  assert.equal(strict.kind, "prepared");
});

test("Git materialization uses the appointed Place basename", async () => {
  const repository = makeGitRepository();
  assert.equal(basename(worktreePath(await cachedRepositoryAt(repository.path), "atlantis")), "atlantis");
});

test("Git realizes managed worktrees under the primary .keiyaku/wt root", async () => {
  const { repository, worktree } = await boundContract();
  const git = await cachedRepositoryAt(repository.path);
  assert.equal(dirname(worktree), join(git.primaryWorktree, ".keiyaku", "wt"));
  const excludePath = join(git.commonDirectory, "info", "exclude");
  const exclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  assert.equal(
    exclude.split(/\r?\n/u).some((line) => {
      const trimmed = line.trim();
      return trimmed === "/.keiyaku/" || trimmed === ".keiyaku/";
    }),
    false,
  );
  assert.equal(
    readFileSync(join(git.primaryWorktree, ".keiyaku", ".gitignore"), "utf8"),
    "*\n!settings.json\n!tasks/\n!tasks/**\n",
  );
  assert.equal(repository.run(["status", "--porcelain", "--untracked-files=all"]).includes(".keiyaku"), false);
});

test("primary management bytes stay ignored while nested managed-worktree bytes remain capturable", async () => {
  const { repository, worktree } = await boundContract();
  const git = await cachedRepositoryAt(repository.path);
  writeFileSync(join(git.primaryWorktree, ".keiyaku", "owned.dat"), "primary-only\n");
  mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
  writeFileSync(join(worktree, ".keiyaku", "settings.json"), "{}\n");
  assert.equal(repository.run(["status", "--porcelain", "--untracked-files=all"]).includes(".keiyaku"), false);
  assert.equal(
    repository.run(["check-ignore", "--", ".keiyaku/owned.dat", ".keiyaku/wt"]).trim(),
    ".keiyaku/owned.dat\n.keiyaku/wt",
  );
  const nestedStatus = repository.run(["-C", worktree, "status", "--porcelain", "--untracked-files=all"]);
  assert.equal(nestedStatus.includes(".keiyaku/settings.json"), true);
  repository.run(["-C", worktree, "add", "--", ".keiyaku/settings.json"]);
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--name-only"]).trim(), ".keiyaku/settings.json");
});

test("dirty delivery materializes a candidate without changing the caller index", async () => {
  const { repository, id, worktree } = await boundContract();
  writeFileSync(join(worktree, "candidate.txt"), "dirty candidate\n");
  const git = await cachedRepositoryAt(repository.path);
  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("contract was not observed");
  const review = await prepareReview(git, preparationCoordinates(state));
  assert.equal(review.kind, "prepared");
  if (review.kind !== "prepared") throw new Error("review preparation was refused");
  assert.equal("documentKey" in review, false);
  const indexBefore = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);

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
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), indexBefore);
  assert.match(
    repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]),
    /kei\/.*: Patch identity/,
  );
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]), /Keiyaku-Contract: /);
});

test("one preparation freezes Contract content, actor identity, and dates across tender and integration", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "dirty candidate\n");
  const document = `${contractBody()}\n\n`;
  const expectedAt = repository.run(["-C", worktree, "show", "-s", "--format=%cI", "HEAD"]).trim();
  const prepared = await prepareDelivery(await cachedRepositoryAt(repository.path), preparation, {
    title: "Ignored default subject",
    document,
    actor: actorId("Release Bot"),
    message: "Chosen subject",
    includeDirty: true,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") return;

  const commits = [prepared.data.tenderSnapshot, prepared.data.integration.snapshot];
  const expectedMessage = `Chosen subject\n\n${contractBody()}\n\nKeiyaku-Contract: ${preparation.contractId}\n`;
  for (const commit of commits) {
    assert.equal(commitMessage(repository, commit), expectedMessage);
    const [author, authorEmail, committer, committerEmail, authoredAt, committedAt] = commitSignature(
      repository,
      commit,
    );
    assert.deepEqual(
      [author, authorEmail, committer, committerEmail],
      ["Release Bot", "keiyaku@localhost", "Release Bot", "keiyaku@localhost"],
    );
    assert.equal(authoredAt, committedAt);
    assert.equal(authoredAt, expectedAt);
  }
  assert.deepEqual(commitSignature(repository, commits[0]), commitSignature(repository, commits[1]));
});

test("materialized delivery identity uses the complete repository pair or the neutral fallback", async () => {
  const configured = await boundContract();
  writeFileSync(join(configured.worktree, "configured.txt"), "configured\n");
  const configuredState = (await observeContract(await cachedRepositoryAt(configured.repository.path), configured.id))
    .state;
  if (configuredState === null) throw new Error("configured contract was not observed");
  const configuredGit = await cachedRepositoryAt(configured.repository.path);
  const configuredDelivery = await prepareDelivery(configuredGit, preparationCoordinates(configuredState), {
    title: "Configured",
    document: contractBody(),
    includeDirty: true,
  });
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
  writeFileSync(join(incomplete.worktree, "fallback.txt"), "fallback\n");
  const incompleteState = (await observeContract(await cachedRepositoryAt(incomplete.repository.path), incomplete.id))
    .state;
  if (incompleteState === null) throw new Error("incomplete contract was not observed");
  const fallback = await withGitShim(
    'exec "$KEIYAKU_REAL_GIT" "$@"',
    {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    async (gitPath) => {
      const incompleteGit = await cachedRepositoryAt(incomplete.repository.path, gitPath);
      return await prepareDelivery(incompleteGit, preparationCoordinates(incompleteState), {
        title: "Fallback",
        document: contractBody(),
        includeDirty: true,
      });
    },
  );
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
  const { repository, id, worktree } = await boundContract();
  writeFileSync(join(worktree, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(worktree, "staged.txt"), "staged\n");
  repository.run(["-C", worktree, "add", ".gitignore", "staged.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tracked inputs"]);
  writeFileSync(join(worktree, "staged.txt"), "staged final\n");
  repository.run(["-C", worktree, "add", "staged.txt"]);
  writeFileSync(join(worktree, "staged.txt"), "unstaged final\n");
  writeFileSync(join(worktree, "untracked.txt"), "untracked\n");
  writeFileSync(join(worktree, "ignored.txt"), "ignored\n");
  const git = await cachedRepositoryAt(repository.path);
  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("contract was not observed");
  const headBefore = repository.run(["-C", worktree, "rev-parse", "HEAD"]);
  const indexBefore = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);
  const statusBefore = repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]);

  assert.deepEqual(
    await prepareDelivery(git, preparationCoordinates(state), {
      title: "Explicit dirty",
      document: contractBody(),
    }),
    {
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
    },
  );
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
  assert.equal(repository.run(["-C", worktree, "rev-parse", "HEAD"]), headBefore);
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), indexBefore);
  assert.equal(repository.run(["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"]), statusBefore);
});

test("target placement observation reports checkout collisions without moving the target", async () => {
  const { contract, repository, preparation, worktree } = await targetedContract();
  const collision = "literal[1].tmp";
  writeFileSync(join(repository.path, ".gitignore"), "literal*.tmp\n");
  repository.run(["add", ".gitignore"]);
  repository.run(["commit", "--quiet", "-m", "ignore literal candidate"]);
  writeFileSync(join(repository.path, collision), "local\n");
  writeFileSync(join(worktree, collision), "candidate\n");
  repository.run(["-C", worktree, "add", collision]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "literal candidate"]);
  const git = await cachedRepositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparation, {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const indexBefore = repository.run(["diff", "--cached", "--binary"]);
  const worktreeBefore = repository.run(["status", "--porcelain=v1", "--untracked-files=all"]);

  const targetName = preparation.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) return;
  const observed = await observeTargetPlacement(git, {
    contractId: preparation.contractId,
    coordinates: { ...preparation.coordinates, target: targetName },
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
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await cachedRepositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparation, {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const targetName = preparation.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) return;
  const observed = await observeTargetPlacement(git, {
    contractId: preparation.contractId,
    coordinates: { ...preparation.coordinates, target: targetName },
    predecessor: mintSnapshotId(target),
    candidate: prepared.data.integration.snapshot,
  });

  assert.equal(observed.kind, "ready");
  if (observed.kind !== "ready") return;
  assert.deepEqual(
    observed.arms.map((arm) => arm.kind),
    ["ordinary"],
  );
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), target);
  assert.equal(existsSync(join(repository.path, "candidate.txt")), false);
});

test("audit target adjudicator reports initial movement without observing followability", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await cachedRepositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparation, {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const targetName = preparation.coordinates.target;
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
    async (gitPath) =>
      adjudicateAuditTarget(
        { ...git, gitPath },
        {
          contractId: preparation.contractId,
          coordinates: { ...preparation.coordinates, target: targetName },
          predecessor: expected,
          candidate: prepared.data.integration.snapshot,
        },
      ),
  );

  assert.deepEqual(answer, {
    kind: "moved",
    ref: "refs/heads/main",
    expected,
    observed,
  });
});

test("audit target adjudicator reobserves movement after followability", async () => {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await cachedRepositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparation, {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("delivery preparation was refused");
  const targetName = preparation.coordinates.target;
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
    async (gitPath) =>
      adjudicateAuditTarget(
        { ...git, gitPath },
        {
          contractId: preparation.contractId,
          coordinates: { ...preparation.coordinates, target: targetName },
          predecessor: expected,
          candidate: prepared.data.integration.snapshot,
        },
      ),
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

test("a displaced directory with ignored contents refuses at the directory", async () => {
  const { contract, repository } = await directoryReplacementContract();
  // The directory guard refuses on the first `git ls-files --ignored --directory` result.
  for (let index = 0; index < 1; index += 1) {
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

test("a displaced directory with untracked contents refuses at the directory", async () => {
  const { contract, repository } = await directoryReplacementContract("");
  // The directory guard refuses on the first `git ls-files --directory` result.
  for (let index = 0; index < 1; index += 1) {
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

test("delivery preparation refuses an unregistered directory at the managed worktree path", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const state = await bound.keiyaku.state();
  const git = await cachedRepositoryAt(repository.path);
  const path = await appointedWorktreePath(git, state.id);
  repository.run(["worktree", "remove", path]);
  mkdirSync(path, { recursive: true });
  repository.run(["-C", path, "init", "--quiet"]);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "foreign"]);

  assert.deepEqual(await prepareReview(git, preparationCoordinates(state)), {
    kind: "refused",
    refusal: { kind: "worktree-missing", contractId: state.id },
  });
  assert.deepEqual(
    await prepareDelivery(git, preparationCoordinates(state), {
      title: "Delivery patch identity",
      document: contractBody(),
    }),
    {
      kind: "refused",
      refusal: { kind: "worktree-missing", contractId: state.id },
    },
  );
});

test("reconcile recreates a registered managed worktree whose directory disappeared", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  renameSync(path, `${path}-moved`);

  const repaired = await bound.keiyaku.reconcile();

  assert.equal(existsSync(path), true);
  assert.equal(
    repaired.effects.some((effect) => effect.kind === "worktree" && effect.action === "created"),
    true,
  );
});

test("dependent managed follow only advances a clean ancestor", async () => {
  const repository = makeGitRepository();
  writeFileSync(join(repository.path, "tracked.txt"), "base\n");
  repository.run(["add", "tracked.txt"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["checkout", "--detach", "--quiet", start]);
  writeFileSync(join(repository.path, "tracked.txt"), "target\n");
  repository.run(["add", "tracked.txt"]);
  repository.run(["commit", "--quiet", "-m", "predecessor"]);
  const target = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["checkout", "--detach", "--quiet", start]);
  const git = await cachedRepositoryAt(repository.path);

  assert.deepEqual(await followDependentManagedWorktree(git, repository.path, mintSnapshotId(target)), {
    kind: "followed",
    before: mintSnapshotId(start),
    after: mintSnapshotId(target),
  });
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), target);
  assert.equal(readFileSync(join(repository.path, "tracked.txt"), "utf8"), "target\n");
  writeFileSync(join(repository.path, "at-target.txt"), "keep at target\n");
  assert.deepEqual(await followDependentManagedWorktree(git, repository.path, mintSnapshotId(target)), {
    kind: "retained",
    head: mintSnapshotId(target),
    reason: "operation-in-progress",
    paths: ["at-target.txt"],
  });
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), target);
  assert.equal(readFileSync(join(repository.path, "at-target.txt"), "utf8"), "keep at target\n");
  repository.run(["clean", "-fd", "--quiet"]);
  repository.run(["reset", "--hard", "--quiet", start]);
  writeFileSync(join(repository.path, "untracked.txt"), "keep\n");
  assert.deepEqual(await followDependentManagedWorktree(git, repository.path, mintSnapshotId(target)), {
    kind: "retained",
    head: mintSnapshotId(start),
    reason: "operation-in-progress",
    paths: ["untracked.txt"],
  });
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), start);
  assert.equal(readFileSync(join(repository.path, "untracked.txt"), "utf8"), "keep\n");
  repository.run(["clean", "-fd", "--quiet"]);
  const later = repository.run(["commit-tree", `${target}^{tree}`, "-p", target], "later\n").trim();
  repository.run(["reset", "--hard", "--quiet", later]);
  assert.deepEqual(await followDependentManagedWorktree(git, repository.path, mintSnapshotId(target)), {
    kind: "retained",
    head: mintSnapshotId(later),
    reason: "head-moved",
    paths: [],
  });
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), later);
});

test("dependent managed follow reports attached dirty paths without mutation", async () => {
  const repository = makeGitRepository();
  writeFileSync(join(repository.path, "tracked.txt"), "base\n");
  repository.run(["add", "tracked.txt"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["checkout", "--detach", "--quiet", start]);
  writeFileSync(join(repository.path, "tracked.txt"), "target\n");
  repository.run(["add", "tracked.txt"]);
  repository.run(["commit", "--quiet", "-m", "target"]);
  const target = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["checkout", "--quiet", "main"]);
  writeFileSync(join(repository.path, "tracked.txt"), "attached dirty\n");
  writeFileSync(join(repository.path, "untracked.txt"), "untracked\n");
  const before = readFileSync(join(repository.path, "tracked.txt"));
  const git = await cachedRepositoryAt(repository.path);

  assert.deepEqual(await followDependentManagedWorktree(git, repository.path, mintSnapshotId(target)), {
    kind: "retained",
    head: mintSnapshotId(start),
    reason: "head-attached",
    paths: ["tracked.txt", "untracked.txt"],
  });
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), start);
  assert.deepEqual(readFileSync(join(repository.path, "tracked.txt")), before);
  assert.equal(readFileSync(join(repository.path, "untracked.txt"), "utf8"), "untracked\n");
});

test("dependent managed follow reports submodule-only dirt", async () => {
  const child = makeGitRepository();
  writeFileSync(join(child.path, "child.txt"), "child\n");
  child.run(["add", "child.txt"]);
  child.run(["commit", "--quiet", "-m", "child"]);

  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  repository.run(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child.path, "module"]);
  repository.run(["commit", "--quiet", "-am", "submodule"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["checkout", "--detach", "--quiet", start]);
  writeFileSync(join(repository.path, "target.txt"), "target\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "target"]);
  const target = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["checkout", "--detach", "--quiet", start]);
  writeFileSync(join(repository.path, "module", "child.txt"), "dirty child\n");
  const git = await cachedRepositoryAt(repository.path);

  assert.deepEqual(await followDependentManagedWorktree(git, repository.path, mintSnapshotId(target)), {
    kind: "retained",
    head: mintSnapshotId(start),
    reason: "operation-in-progress",
    paths: ["module"],
  });
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), start);
  assert.equal(readFileSync(join(repository.path, "module", "child.txt"), "utf8"), "dirty child\n");
});

test("dirty managed delivery preserves its caller checkout", async () => {
  const repository = makeGitRepository();
  writeFileSync(join(repository.path, "tracked.txt"), "base\n");
  repository.run(["add", "tracked.txt"]);
  repository.run(["commit", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  const before = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  writeFileSync(join(path, "tracked.txt"), "delivered\n");
  writeFileSync(join(path, "delivered.txt"), "delivered\n");

  const delivered = await bound.keiyaku.deliver({ includeDirty: true });
  const tender = (await bound.keiyaku.state()).delivery?.data.tenderSnapshot;

  assert.notEqual(tender, undefined);
  if (tender === undefined) return;
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), before);
  assert.notEqual(repository.run(["-C", path, "status", "--porcelain=v2", "--untracked-files=all"]), "");
  assert.equal(readFileSync(join(path, "tracked.txt"), "utf8"), "delivered\n");
  assert.equal(readFileSync(join(path, "delivered.txt"), "utf8"), "delivered\n");
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
    async (gitPath) =>
      Keiyaku.bind({
        repo: await Repo.at({ path: repository.path, gitPath }),
        markdown: contractBody(),
        workspace: "worktree",
      }),
  );
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["bind"],
  );
  assert.notEqual(result.head, null);
  assert.equal(result.lags[0]?.kind, "reconcile-failed");
  if (result.lags[0]?.kind === "reconcile-failed") {
    assert.equal(result.lags[0].stage, "effect");
    assert.match(result.lags[0].diagnostic, /forced managed worktree failure/);
  }
  assert.deepEqual(result.settlementLags, []);
  const state = await result.keiyaku.state();
  assert.equal(state.id, result.facts[0]?.contract);
  assert.equal(state.head, result.head);
  assert.equal(state.terminal, null);
  const observation = await Keiyaku.observe({ repo: await Repo.at({ path: repository.path }), id: state.id });
  assert.equal(observation.kind, "present");
});

test("distinct no-op candidates share the empty patch ChangeId", async () => {
  const { repository, id, worktree } = await boundContract();

  repository.run(["-C", worktree, "commit", "--allow-empty", "--quiet", "-m", "first no-op"]);
  const first = await preparedDelivery(repository, id);
  repository.run(["-C", worktree, "commit", "--allow-empty", "--quiet", "-m", "second no-op"]);
  const second = await preparedDelivery(repository, id);

  assert.notEqual(first.integration.snapshot, second.integration.snapshot);
  assert.equal(first.integration.changeId, second.integration.changeId);
});

test("clean delivery resolves its workspace head and tree in one Git call", async () => {
  const { repository, id } = await boundContract();
  const state = (await observeContract(await cachedRepositoryAt(repository.path), id)).state;
  if (state === null) throw new Error("contract was not observed");
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");
  const prepared = await withGitShim(
    [
      "for argument do",
      "  case \"$argument\" in *'^{tree}'*) exit 97 ;; esac",
      "done",
      'if [ "$1" = "-C" ] && [ "$3" = "show" ]; then',
      '  printf \'%s|%s|%s|%s\\n\' "$3" "$4" "$5" "$6" >> "$KEIYAKU_GIT_CALLS"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    async (gitPath) => {
      const git = await cachedRepositoryAt(repository.path, gitPath);
      return await prepareDelivery(git, preparationCoordinates(state), {
        title: "Delivery patch identity",
        document: contractBody(),
      });
    },
  );

  assert.equal(prepared.kind, "prepared");
  assert.equal(readFileSync(calls, "utf8"), "show|-s|--format=%H%n%T%n%cI|HEAD\n");
});

test("delivery diff preserves an empty patch and treats a clean missing object as Git absence", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = await preparedDelivery(repository, id);
  const git = await cachedRepositoryAt(repository.path);

  assert.equal(await readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot), "");
  assert.equal(
    await deliveryDiffOperation({
      scope: await scopeOperation({ coordinate: repository.path }),
      integrationPredecessor: delivery.integration.predecessor,
      integrationSnapshot: delivery.integration.snapshot,
    }),
    "",
  );
  assert.equal(await readDeliveryDiff(git, delivery.integration.predecessor, mintSnapshotId("0".repeat(40))), null);
});

test("delivery diff checks both snapshots in one batch process", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = await preparedDelivery(repository, id);
  const git = await cachedRepositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");

  const result = await withGitShim(
    [
      'if [ "$1" = "cat-file" ]; then printf \'batch-check\\n\' >> "$KEIYAKU_GIT_CALLS"; fi',
      'if [ "$1" = "diff" ]; then printf \'diff\\n\' >> "$KEIYAKU_GIT_CALLS"; fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls },
    async (gitPath) =>
      await readDeliveryDiff({ ...git, gitPath }, delivery.integration.predecessor, delivery.integration.snapshot),
  );

  assert.equal(result, "");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff"]);
});

test("delivery diff rejects a recorded non-commit object", async () => {
  const { repository, id } = await boundContract();
  const delivery = await preparedDelivery(repository, id);
  const blob = mintSnapshotId(repository.run(["hash-object", "-w", "--stdin"], "not a commit\n").trim());

  await assert.rejects(
    async () => readDeliveryDiff(await cachedRepositoryAt(repository.path), delivery.integration.predecessor, blob),
    (error: unknown) =>
      error instanceof AuthorityCorruptionError && error.message === "recorded delivery snapshot is not a Git commit",
  );
});

test("delivery diff rechecks one batch for a pruning race", async () => {
  const { repository, id } = await boundContract();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
  const delivery = await preparedDelivery(repository, id);
  const git = await cachedRepositoryAt(repository.path);
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-calls-")), "calls");
  const pruned = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-pruned-")), "marker");

  const result = await withGitShim(
    [
      'if [ "$1" = "cat-file" ]; then',
      "  printf 'batch-check\\n' >> \"$KEIYAKU_GIT_CALLS\"",
      '  if [ -e "$KEIYAKU_PRUNED_MARKER" ]; then',
      "    IFS= read -r predecessor",
      "    IFS= read -r candidate",
      '    printf \'%s commit\\n%s missing\\n\' "$predecessor" "$candidate"',
      "    exit 0",
      "  fi",
      "fi",
      'if [ "$1" = "diff" ]; then',
      "  printf 'diff\\n' >> \"$KEIYAKU_GIT_CALLS\"",
      '  : > "$KEIYAKU_PRUNED_MARKER"',
      "  printf '%s\\n' 'fatal: object pruned' >&2",
      "  exit 128",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_GIT_CALLS: calls, KEIYAKU_PRUNED_MARKER: pruned },
    async (gitPath) =>
      await readDeliveryDiff({ ...git, gitPath }, delivery.integration.predecessor, delivery.integration.snapshot),
  );

  assert.equal(result, null);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["batch-check", "diff", "batch-check"]);
});

test("delivery diff leaves probe diagnostics as Git errors", async () => {
  const { repository, id } = await boundContract();
  const delivery = await preparedDelivery(repository, id);

  await withGitShim(
    [
      'if [ "$1" = "cat-file" ]; then',
      "  printf '%s\\n' 'error: corrupt object' >&2",
      "  exit 128",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      await assert.rejects(
        async () =>
          readDeliveryDiff(
            await cachedRepositoryAt(repository.path, gitPath),
            delivery.integration.predecessor,
            delivery.integration.snapshot,
          ),
        (error: unknown) => error instanceof Error && error.message.startsWith("cat-file"),
      );
    },
  );
});

test("targetless terminal cleanup retains tender custody for Delivery.diff", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const predecessor = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });

  await bound.keiyaku.reconcile();
  const worktreePath = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    (await bound.keiyaku.state()).id,
  );
  writeFileSync(join(worktreePath, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktreePath, "add", "candidate.txt"]);
  repository.run(["-C", worktreePath, "commit", "--quiet", "-m", "candidate"]);
  await bound.keiyaku.deliver();
  await bound.keiyaku.reconcile();

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  assert.ok((await bound.keiyaku.state()).terminal);

  repository.run(["reflog", "expire", "--expire=now", "--all"]);
  repository.run(["gc", "--prune=now"]);

  const recovered = await bound.keiyaku.delivery();
  assert.ok(recovered);
  assert.match((await recovered.diff()) ?? "", /candidate\.txt/);
});

test("repository reconcile does not recreate released terminal custody without a Place", async () => {
  const { contract, repository, worktree } = await targetedContract(["reviewed"]);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await contract.deliver();
  await contract.review({ verdict: "satisfied" });
  const state = await contract.state();
  const id = state.id;
  assert.equal(state.terminal?.kind, "claimed");
  const git = await cachedRepositoryAt(repository.path);
  assert.deepEqual(await readManagedWorktreeAppointment(git, id), { kind: "unappointed" });
  assert.equal(await readRef(git, deliveryRefFor(id)), null);
  assert.equal(await readRef(git, candidatePinRefFor(id)), null);

  writeFileSync(join(repository.path, "target-only.txt"), "target advance\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "target advance"]);
  const targetBefore = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const fresh = await Repo.at({ path: repository.path });
  const report = await fresh.reconcile();

  assert.equal(report.kind, "completed");
  if (report.kind !== "completed") throw new Error("expected completed repository reconcile");
  assert.equal(report.contracts.find((item) => item.contractId === id)?.report.lag.length, 0);
  assert.equal((await Keiyaku.of({ repo: fresh, id }).state()).terminal?.kind, "claimed");
  assert.equal(await readRef(git, deliveryRefFor(id)), null);
  assert.equal(await readRef(git, candidatePinRefFor(id)), null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetBefore);
});

test("repository reconcile releases a lone candidate pin after its tender is pruned", async () => {
  const { contract, repository, worktree } = await targetedContract(["reviewed"]);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await contract.deliver();
  const delivered = await contract.state();
  const tender = delivered.delivery?.data.tenderSnapshot;
  const integration = delivered.currentIntegration?.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  assert.notEqual(tender, integration);
  await contract.review({ verdict: "satisfied" });

  const id = (await contract.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  assert.deepEqual(await readManagedWorktreeAppointment(git, id), { kind: "unappointed" });
  assert.equal(await readRef(git, deliveryRefFor(id)), null);
  assert.equal(await readRef(git, candidatePinRefFor(id)), null);
  repository.run(["update-ref", candidatePinRefFor(id), integration]);
  assert.equal(await readRef(git, deliveryRefFor(id)), null);

  repository.run(["reflog", "expire", "--expire=now", "--all"]);
  repository.run(["gc", "--prune=now"]);
  assert.throws(() => repository.run(["cat-file", "-e", `${tender}^{commit}`]));

  const targetBefore = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const fresh = await Repo.at({ path: repository.path });
  const report = await fresh.reconcile();

  assert.equal(report.kind, "completed");
  if (report.kind !== "completed") throw new Error("expected completed repository reconcile");
  assert.equal(report.contracts.find((item) => item.contractId === id)?.report.lag.length, 0);
  assert.equal((await Keiyaku.of({ repo: fresh, id }).state()).terminal?.kind, "claimed");
  assert.equal(await readRef(git, candidatePinRefFor(id)), null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetBefore);
});

test("one repository reconcile sweeps unappointed claimed custody through exact target bytes", async () => {
  const first = await targetedContract(["reviewed"]);
  writeFileSync(join(first.worktree, "first.txt"), "first candidate\n");
  first.repository.run(["-C", first.worktree, "add", "first.txt"]);
  first.repository.run(["-C", first.worktree, "commit", "--quiet", "-m", "first candidate"]);
  await first.contract.deliver();
  await first.contract.review({ verdict: "satisfied" });
  const firstState = await first.contract.state();
  assert.equal(firstState.terminal?.kind, "claimed");
  const firstId = firstState.id;
  const firstTender = firstState.delivery?.data.tenderSnapshot;
  const firstIntegration = firstState.currentIntegration?.snapshot;
  assert.ok(firstTender);
  assert.ok(firstIntegration);
  const git = await cachedRepositoryAt(first.repository.path);
  assert.deepEqual(await readManagedWorktreeAppointment(git, firstId), { kind: "unappointed" });
  first.repository.run(["update-ref", deliveryRefFor(firstId), firstTender]);
  first.repository.run(["update-ref", candidatePinRefFor(firstId), firstIntegration]);
  first.repository.run(["update-ref", "refs/heads/secondary", "refs/heads/main"]);

  const secondBound = await Keiyaku.bind({
    repo: await Repo.at({ path: first.repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    target: "refs/heads/secondary",
    gates: ["reviewed"],
  });
  const second = secondBound.keiyaku;
  const secondId = (await second.state()).id;
  const secondWorktree = await appointedWorktreePath(git, secondId);
  writeFileSync(join(secondWorktree, "second.txt"), "second candidate\n");
  first.repository.run(["-C", secondWorktree, "add", "second.txt"]);
  first.repository.run(["-C", secondWorktree, "commit", "--quiet", "-m", "second candidate"]);
  await second.deliver();
  const deliveredSecond = await second.state();
  const secondTender = deliveredSecond.delivery?.data.tenderSnapshot;
  assert.ok(secondTender);
  writeFileSync(join(first.repository.path, "target-only.txt"), "target advance\n");
  first.repository.run(["checkout", "--quiet", "secondary"]);
  first.repository.run(["add", "target-only.txt"]);
  first.repository.run(["commit", "--quiet", "-m", "target advance"]);
  first.repository.run(["checkout", "--quiet", "main"]);
  await second.review({ verdict: "satisfied" });
  const secondState = await second.state();
  assert.equal(secondState.terminal?.kind, "claimed");
  const secondIntegration = secondState.currentIntegration?.snapshot;
  assert.ok(secondIntegration);
  assert.deepEqual(await readManagedWorktreeAppointment(git, secondId), { kind: "unappointed" });
  first.repository.run(["update-ref", deliveryRefFor(secondId), secondTender]);
  first.repository.run(["update-ref", candidatePinRefFor(secondId), secondIntegration]);

  const targetBefore = first.repository.run(["rev-parse", "refs/heads/main"]).trim();
  const secondaryBefore = first.repository.run(["rev-parse", "refs/heads/secondary"]).trim();
  const fresh = await Repo.at({ path: first.repository.path });
  const report = await fresh.reconcile();

  assert.equal(report.kind, "completed");
  if (report.kind !== "completed") throw new Error("expected completed repository reconcile");
  assert.deepEqual(new Set(report.contracts.map((contract) => contract.contractId)), new Set([firstId, secondId]));
  assert.equal(
    report.contracts.every((contract) => contract.report.lag.length === 0),
    true,
  );
  assert.equal((await Keiyaku.of({ repo: fresh, id: firstId }).state()).terminal?.kind, "claimed");
  assert.equal((await Keiyaku.of({ repo: fresh, id: secondId }).state()).terminal?.kind, "claimed");
  assert.equal(await readRef(git, deliveryRefFor(firstId)), null);
  assert.equal(await readRef(git, candidatePinRefFor(firstId)), null);
  assert.equal(await readRef(git, deliveryRefFor(secondId)), secondTender);
  assert.equal(await readRef(git, candidatePinRefFor(secondId)), null);
  assert.equal(first.repository.run(["rev-parse", "refs/heads/main"]).trim(), targetBefore);
  assert.equal(first.repository.run(["rev-parse", "refs/heads/secondary"]).trim(), secondaryBefore);
});

test("claimed target history keeps integration custody after a normal target advance", async () => {
  const { contract, repository, worktree } = await targetedContract(["reviewed"]);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await contract.deliver();
  await contract.review({ verdict: "satisfied" });
  const state = await contract.state();
  assert.equal(state.terminal?.kind, "claimed");
  const tender = state.delivery?.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery?.data.integration.snapshot;
  assert.ok(tender);
  assert.ok(integration);
  repository.run(["update-ref", deliveryRefFor(state.id), tender]);
  repository.run(["update-ref", candidatePinRefFor(state.id), integration]);
  writeFileSync(join(repository.path, "after-claim.txt"), "after claim\n");
  repository.run(["add", "after-claim.txt"]);
  repository.run(["commit", "--quiet", "-m", "after claim"]);
  const targetBefore = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const report = await contract.reconcile();
  const git = await cachedRepositoryAt(repository.path);

  assert.equal(await readRef(git, candidatePinRefFor(state.id)), null);
  assert.equal(await readRef(git, deliveryRefFor(state.id)), null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetBefore);
  assert.equal(report.lag.length, 0);
  assert.equal(
    report.effects.some(
      (effect) => effect.kind === "ref" && effect.name === candidatePinRefFor(state.id) && effect.action === "removed",
    ),
    true,
  );
  assert.equal(
    report.effects.some(
      (effect) => effect.kind === "ref" && effect.name === deliveryRefFor(state.id) && effect.action === "removed",
    ),
    true,
  );
});

test("abandon salvages untracked managed-worktree bytes without retaining the worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  writeFileSync(join(path, "untracked-agent-work.txt"), "retain me\n");
  const abandoned = await bound.keiyaku.abandon();
  const recovery = recoverySnapshot(abandoned);

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["show", `${recovery}:untracked-agent-work.txt`]), "retain me\n");
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "--points-at", recovery]), "");
  const id = (await bound.keiyaku.state()).id;
  assert.equal(await readRef(await cachedRepositoryAt(repository.path), deliveryRefFor(id)), candidate);
  assert.equal(await readRef(await cachedRepositoryAt(repository.path), candidatePinRefFor(id)), null);

  repository.run(["prune", "--expire=now"]);
  assert.throws(() => repository.run(["cat-file", "-e", `${recovery}^{commit}`]));
});

test("abandon salvages a later managed-worktree commit without retaining the worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "commit", "--allow-empty", "--quiet", "-m", "later agent work"]);
  const later = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  const abandoned = await bound.keiyaku.abandon();
  const recovery = recoverySnapshot(abandoned);

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["rev-parse", `${recovery}^`]).trim(), later);
  const id = (await bound.keiyaku.state()).id;
  assert.equal(await readRef(await cachedRepositoryAt(repository.path), deliveryRefFor(id)), candidate);
  assert.equal(await readRef(await cachedRepositoryAt(repository.path), candidatePinRefFor(id)), null);
});

test("abandon retains dirty submodule internals that a recovery snapshot cannot capture", async () => {
  const child = makeGitRepository();
  writeFileSync(join(child.path, "child.txt"), "child\n");
  child.run(["add", "child.txt"]);
  child.run(["commit", "--quiet", "-m", "child"]);

  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  repository.run(["-C", path, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child.path, "module"]);
  repository.run(["-C", path, "commit", "--quiet", "-am", "submodule"]);
  writeFileSync(join(path, "module", "child.txt"), "dirty child\n");

  const abandoned = await bound.keiyaku.abandon();

  assert.equal(abandoned.recoverySnapshot, undefined);
  const head = mintSnapshotId(repository.run(["-C", path, "rev-parse", "HEAD"]).trim());
  assert.deepEqual(abandoned.lags, [
    {
      kind: "unsealed-bytes",
      path,
      paths: ["module"],
      head,
    },
  ]);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(join(path, "module", "child.txt"), "utf8"), "dirty child\n");
});

test("terminal reconcile removes a delivered managed worktree reset to its sealed start", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(path, "candidate.txt"), "candidate\n");
  repository.run(["-C", path, "add", "candidate.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "tendered candidate"]);
  const candidate = repository.run(["-C", path, "rev-parse", "HEAD"]).trim();
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "reset", "--hard", start]);

  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["cat-file", "-e", `${start}^{commit}`]), "");
  assert.equal(repository.run(["cat-file", "-e", `${candidate}^{commit}`]), "");
});

test("terminal reconcile removes sealed dirty bytes over the original HEAD", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(path, "candidate.txt"), "dirty candidate\n");
  const delivered = await bound.keiyaku.deliver({ includeDirty: true });
  assert.equal(repository.run(["-C", path, "rev-parse", "HEAD"]).trim(), start);
  assert.deepEqual(delivered.lags, []);
  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(abandoned.recoverySnapshot, undefined);
  assert.equal(existsSync(path), false);
});

test("abandon salvages an unsealed tender parent without retaining the worktree", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  writeFileSync(join(path, "candidate.txt"), "candidate\n");
  repository.run(["-C", path, "add", "candidate.txt"]);
  const tenderTree = repository.run(["-C", path, "write-tree"]).trim();
  const firstParent = repository.run(["commit-tree", tenderTree, "-p", start], "first parent\n").trim();
  const secondParent = repository.run(["commit-tree", `${start}^{tree}`, "-p", start], "second parent\n").trim();
  const mergeTender = repository
    .run(["commit-tree", tenderTree, "-p", firstParent, "-p", secondParent], "merge tender\n")
    .trim();
  repository.run(["-C", path, "checkout", "--quiet", "--detach", mergeTender]);
  await bound.keiyaku.deliver();
  repository.run(["-C", path, "reset", "--soft", secondParent]);
  const abandoned = await bound.keiyaku.abandon();
  const recovery = recoverySnapshot(abandoned);

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(repository.run(["rev-parse", `${recovery}^`]).trim(), secondParent);
  assert.equal(repository.run(["show", `${recovery}:candidate.txt`]), "candidate\n");
});

test("a clean no-delivery abandonment releases the managed worktree from its start", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody(),
    workspace: "worktree",
  });
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  await bound.keiyaku.reconcile();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), (await bound.keiyaku.state()).id);
  const abandoned = await bound.keiyaku.abandon();

  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(path), false);
  assert.equal(
    await readRef(await cachedRepositoryAt(repository.path), deliveryRefFor((await bound.keiyaku.state()).id)),
    null,
  );
  assert.equal(repository.run(["cat-file", "-e", `${start}^{commit}`]), "");
});

test("nonempty candidates retain Git start-to-tender ChangeId", async () => {
  const { repository, id, worktree } = await boundContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

  const delivery = await preparedDelivery(repository, id);
  assert.equal(delivery.integration.snapshot, repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim());
  const patch = repository.run([
    "-c",
    "core.quotePath=false",
    "-c",
    "core.abbrev=40",
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.renames=false",
    "-c",
    "diff.indentHeuristic=false",
    "-c",
    "diff.suppressBlankEmpty=false",
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
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "candidate"]);
  const candidate = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "later head"]);

  const prepared = await materializeScratchCandidate(await cachedRepositoryAt(repository.path), candidate);
  try {
    assert.equal(repository.run(["-C", prepared.cwd, "rev-parse", "HEAD"]).trim(), candidate);
  } finally {
    await prepared.dispose();
  }
});
