import { contractMarkdown } from "./support/markdown.js";
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
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareDelivery } from "../src/protocol/deliver.js";
import { prepareReview } from "../src/protocol/review.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { adjudicateAuditTarget } from "../src/git/target-placement.js";
import { readRef } from "../src/git/repository.js";
import { readDeliveryDiff } from "../src/git/integration.js";
import { followDependentManagedWorktree } from "../src/git/workspace.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { AuthorityCorruptionError, Keiyaku, Repo, type ContractId, type Keiyaku as KeiyakuHandle } from "../src/index.js";
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

type AcceptedDelivery = Exclude<Awaited<ReturnType<KeiyakuHandle["deliver"]>>, { kind: "integration-conflict-materialized" }>;

function acceptedDelivery(result: Awaited<ReturnType<KeiyakuHandle["deliver"]>>): AcceptedDelivery {
  if (result.kind === "integration-conflict-materialized") {
    throw new Error(`unexpected integration conflict: ${result.conflictPaths.join(",")}`);
  }
  return result;
}

function contractBody(): string {
  return contractMarkdown("Delivery patch identity", {
    Context: "Exercise Git-backed delivery preparation.",
    Objective: "Keep patch-content identity independent of commit identity.",
    Design: "Prepare a targetless delivery from the current worktree.",
    Region: "~~~\nsrc/git/**\n~~~",
    Criteria: "### Patch identity\nEqual patch bytes have one ChangeId.",
  });
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
  assert.ok(prepared.kind === "prepared", "expected prepared.kind = \"prepared\"");
  return prepared.data;
}

function deliveryRefFor(contract: ContractId): string {
  return `refs/keiyaku/delivery/kei-${contract.slice("kei/".length)}`;
}

function candidatePinRefFor(contract: ContractId): string {
  return `refs/keiyaku/candidate/kei-${contract.slice("kei/".length)}`;
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

test("dirty delivery materializes a candidate without changing the caller index", async () => {
  const { repository, id, worktree } = await boundContract();
  writeFileSync(join(worktree, "candidate.txt"), "dirty candidate\n");
  const git = await cachedRepositoryAt(repository.path);
  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("contract was not observed");
  const review = await prepareReview(git, preparationCoordinates(state));
  assert.ok(review.kind === "prepared", "expected review.kind = \"prepared\"");
  assert.equal("documentKey" in review, false);
  const indexBefore = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);

  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Patch identity",
    document: contractBody(),
    includeDirty: true,
  });
  assert.ok(prepared.kind === "prepared", "expected prepared.kind = \"prepared\"");
  assert.equal(prepared.data.integration.changeId, review.data.changeId);
  assert.deepEqual(review.data.workspace, {
    staged: [],
    unstaged: [],
    untracked: ["candidate.txt"],
    shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
    unmergedPaths: [],
  });
  assert.equal(repository.run(["-C", worktree, "diff", "--cached", "--binary"]), indexBefore);
  assert.match(
    repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]),
    /kei\/.*: Patch identity/,
  );
  assert.match(repository.run(["show", "-s", "--format=%B", prepared.data.integration.snapshot]), /Keiyaku-Contract: /);
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
  assert.ok(configuredDelivery.kind === "prepared", "expected configuredDelivery.kind = \"prepared\"");
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
  assert.ok(fallback.kind === "prepared", "expected fallback.kind = \"prepared\"");
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
  assert.ok(prepared.kind === "prepared", "expected prepared.kind = \"prepared\"");
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
  assert.ok(prepared.kind === "prepared", "expected prepared.kind = \"prepared\"");
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

  const delivered = acceptedDelivery(await contract.deliver());

  const placement = delivered.value.placement;
  assert.ok(placement);
  if (!("refusal" in placement) || placement.refusal.kind !== "checkout-not-followable")
    assert.fail("expected checkout-not-followable placement refusal");
  assert.deepEqual(placement.refusal.paths, ["link"]);
  assert.equal(readFileSync(join(repository.path, "elsewhere", "retained.txt"), "utf8"), "retained\n");
});

test("a clean tracked directory may be replaced by a candidate file", async () => {
  const { contract, repository } = await directoryReplacementContract();

  const delivered = acceptedDelivery(await contract.deliver());

  assert.equal(delivered.value.placement, undefined);
  assert.equal(readFileSync(join(repository.path, "artifact"), "utf8"), "candidate file\n");
});

test("a displaced directory with untracked contents refuses at the directory", async () => {
  const { contract, repository } = await directoryReplacementContract("");
  // The directory guard refuses on the first `git ls-files --directory` result.
  for (let index = 0; index < 1; index += 1) {
    const name = `untracked-${String(index).padStart(4, "0")}-${"x".repeat(220)}.txt`;
    writeFileSync(join(repository.path, "artifact", name), "untracked\n");
  }
  const target = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const delivered = acceptedDelivery(await contract.deliver());

  const placement = delivered.value.placement;
  assert.ok(placement);
  if (!("refusal" in placement) || placement.refusal.kind !== "checkout-not-followable")
    assert.fail("expected checkout-not-followable placement refusal");
  assert.equal(placement.refusal.reason, "untracked");
  assert.deepEqual(placement.refusal.paths, ["artifact"]);
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

  assert.ok(report.kind === "completed", "expected report.kind = \"completed\"");
  assert.equal(report.contracts.find((item) => item.contractId === id)?.report.lag.length, 0);
  assert.equal((await Keiyaku.of({ repo: fresh, id }).state()).terminal?.kind, "claimed");
  assert.equal(await readRef(git, deliveryRefFor(id)), null);
  assert.equal(await readRef(git, candidatePinRefFor(id)), null);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetBefore);
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
      affects: "none",
    },
  ]);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(join(path, "module", "child.txt"), "utf8"), "dirty child\n");
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
