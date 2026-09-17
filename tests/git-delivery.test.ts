import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { readDeliveryDiff } from "../src/git/integration.js";
import { followDependentManagedWorktree } from "../src/git/workspace.js";
import {
  AuthorityCorruptionError,
  Keiyaku,
  Repo,
  type ContractId,
  type Keiyaku as KeiyakuHandle,
} from "../src/index.js";
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

type AcceptedDelivery = Exclude<
  Awaited<ReturnType<KeiyakuHandle["deliver"]>>,
  { kind: "integration-conflict-materialized" }
>;

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
  assert.ok(prepared.kind === "prepared", 'expected prepared.kind = "prepared"');
  return prepared.data;
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
  assert.ok(review.kind === "prepared", 'expected review.kind = "prepared"');
  assert.equal("documentKey" in review, false);
  const indexBefore = repository.run(["-C", worktree, "diff", "--cached", "--binary"]);

  const prepared = await prepareDelivery(git, preparationCoordinates(state), {
    title: "Patch identity",
    document: contractBody(),
    includeDirty: true,
  });
  assert.ok(prepared.kind === "prepared", 'expected prepared.kind = "prepared"');
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
