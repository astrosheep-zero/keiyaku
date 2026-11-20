import { accepted, present } from "./support/library-verbs.js";
import { captureWorktreeFiles, restoreWorktreeFiles, type WorktreeFixtureFile } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { prepareDelivery } from "../src/protocol/deliver.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { adjudicatePreviewTarget } from "../src/git/target-placement.js";
import { readRef } from "../src/git/repository.js";
import { readDeliveryDiff } from "../src/git/integration.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { AuthorityCorruptionError, Keis, Repo, type ContractId } from "../src/index.js";
import {
  appointedWorktreePath,
  cachedRepositoryAt,
  candidatePinRefFor,
  deliveryRefFor,
  makeGitRepository,
  observeContract,
  snapshotGitRepository,
  type TestGitRepository,
  withGitShim,
} from "./support/git.js";
import { acceptedDelivery, repositoryWithMain } from "./support/library-verbs.js";

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

type PostBindTemplate = Readonly<{
  repository: TestGitRepository;
  id: ContractId;
  start: ReturnType<typeof mintSnapshotId>;
  preparation: ReturnType<typeof preparationCoordinates>;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

const postBindTemplates = new Map<string, Promise<PostBindTemplate>>();

function postBindTemplateKey(target: "targetless" | "targeted", gates: readonly string[]): string {
  return JSON.stringify({ target, gates });
}

async function buildPostBindTemplate(
  target: "targetless" | "targeted",
  gates: readonly string[],
): Promise<PostBindTemplate> {
  const repository =
    target === "targetless" ? repositoryWithMain() : repositoryWithMain({ files: { "shared.txt": "base\n" } });
  if (target === "targetless") {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
  }
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: contractBody(),
      ...(target === "targeted"
        ? { target: "refs/heads/main", ...(gates.length === 0 ? {} : { gates }) }
        : // The targetless fixture stays deliberately targetless now that omission names the branch.
          { target: null }),
    }),
  );
  const state = present(await bound.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  const generatedFiles = captureWorktreeFiles(worktree);
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
  restoreWorktreeFiles(worktree, template.generatedFiles);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keis.of(repo).kei({ id: template.id });
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

function commitSignature(repository: TestGitRepository, commit: string): readonly string[] {
  return repository.run(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI", commit]).trim().split("\0");
}

async function targetedContract(gates: readonly string[] = []) {
  return await postBindFixture("targeted", gates);
}

async function directoryReplacementContract(ignore = "artifact/*.tmp\n") {
  const repository = repositoryWithMain({
    files: {
      ".gitignore": ignore,
      "artifact/tracked.txt": "tracked\n",
    },
    message: "tracked directory",
  });
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: contractBody(),
      target: "refs/heads/main",
    }),
  );
  const state = present(await bound.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  repository.run(["-C", worktree, "rm", "-r", "artifact"]);
  writeFileSync(join(worktree, "artifact"), "candidate file\n");
  repository.run(["-C", worktree, "add", "artifact"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "replace directory"]);
  return { contract: bound.kei, repository, worktree };
}

async function preparedAuditTarget() {
  const { repository, preparation, worktree } = await targetedContract();
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "disjoint candidate"]);
  const git = await cachedRepositoryAt(repository.path);
  const prepared = await prepareDelivery(git, preparation, {
    title: "Delivery patch identity",
    document: contractBody(),
  });
  assert.ok(prepared.kind === "prepared", 'expected prepared.kind = "prepared"');
  const targetName = preparation.coordinates.target;
  assert.notEqual(targetName, undefined);
  if (targetName === undefined) throw new Error("targeted contract has no target");
  return { repository, git, prepared, targetName, expected: prepared.data.integration.predecessor };
}

// Each case owns a separate repository and scoped fault injection, never a process-wide mock.
describe("git-delivery isolated repositories", { concurrency: 4 }, () => {
  test("an unavailable recorded integration materializes a fresh snapshot", async () => {
    const { repository, preparation } = await targetedContract(["reviewed"]);
    const missing = mintSnapshotId("0".repeat(40));
    const prepared = await prepareDelivery(await cachedRepositoryAt(repository.path), {
      ...preparation,
      recordedIntegrations: [missing],
    }, {
      title: "Unavailable integration",
      document: contractBody(),
      message: "fresh after missing integration",
    });
    assert.equal(prepared.kind, "prepared");
    if (prepared.kind !== "prepared") throw new Error("expected fresh integration");
    assert.notEqual(prepared.data.integration.snapshot, missing);
    assert.equal(repository.run(["show", "-s", "--format=%s", prepared.data.integration.snapshot]).trim(), "fresh after missing integration");
    assert.equal(prepared.data.note, "fresh after missing integration");
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
      refusal: { kind: "integration-unsupported" },
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
    assert.ok(configuredDelivery.kind === "prepared", 'expected configuredDelivery.kind = "prepared"');
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
    assert.ok(fallback.kind === "prepared", 'expected fallback.kind = "prepared"');
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

  test("audit target adjudicator reobserves movement after followability", async () => {
    const { repository, git, prepared, targetName, expected } = await preparedAuditTarget();

    const answer = await withGitShim(
      [
        'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
        '  "$KEIYAKU_REAL_GIT" -C "$KEIYAKU_TEST_REPO" commit --allow-empty --quiet -m move-during-follow',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_TEST_REPO: repository.path },
      async (gitPath) =>
        adjudicatePreviewTarget(
          { ...git, gitPath },
          {
            target: targetName,
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

  test("preview and follow agree on native currentness for a tracked alias with a distinct ignored hardlink", async (t) => {
    const repository = repositoryWithMain({ files: { ".gitignore": "ignored.txt\n", "tracked.txt": "base\n" } });
    const contracts = Keis.of(await Repo.at({ path: repository.path }));
    const bound = accepted(await contracts.bind({ terms: contractBody(), target: "main", gates: [] }));
    const worktree = bound.worktreePath!;
    writeFileSync(join(worktree, "tracked.txt"), "candidate\n");
    repository.run(["-C", worktree, "commit", "-qam", "change the tracked entry"]);

    const tracked = join(repository.path, "tracked.txt");
    const physical = join(repository.path, "TRACKED.txt");
    const ignored = join(repository.path, "ignored.txt");
    renameSync(tracked, ignored);
    renameSync(ignored, physical);
    if (!existsSync(tracked)) return t.skip("fixture needs actual case-insensitive lookups");
    linkSync(physical, ignored);
    assert.equal(statSync(tracked, { bigint: true }).ino, statSync(ignored, { bigint: true }).ino);
    // Make the real stat mismatch deterministic even on Git builds using second precision.
    utimesSync(physical, 1, 1);
    assert.equal(repository.run(["--no-optional-locks", "status", "--porcelain"]), "");
    const indexPath = join(repository.path, ".git", "index");
    const index = readFileSync(indexPath);
    const unchanged = () => {
      assert.deepEqual(readFileSync(indexPath), index);
      assert.equal(readFileSync(tracked, "utf8"), "base\n");
      assert.equal(readFileSync(ignored, "utf8"), "base\n");
    };

    const preview = await bound.kei.previewDelivery();
    assert.equal(preview.kind, "ready");
    assert.equal(preview.target?.kind, "placeable");
    const diagnostic = preview.target.checkouts?.find((checkout) => checkout.path === repository.path)?.diagnostic;
    assert.match(diagnostic ?? "", /tracked\.txt.*not uptodate/u);
    unchanged();

    const delivered = acceptedDelivery(await bound.kei.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(delivered.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic, diagnostic);
    assert.ok(!existsSync(worktree));
    unchanged();

    const journal = repository.run(["rev-parse", "refs/heads/keiyaku-state"]);
    const retained = await contracts.reconcile({ contract: bound.contractId });
    assert.equal(retained.kind, "contract");
    assert.equal(retained.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic, diagnostic);
    assert.ok(!retained.effects?.some((effect) => effect.kind === "target-checkout"));
    unchanged();

    // Only the checkout owner refreshes the real index. The first eligible reconcile follows.
    repository.run(["update-index", "--refresh"]);
    const recovered = await contracts.reconcile({ contract: bound.contractId });
    assert.equal(recovered.kind, "contract");
    assert.equal(recovered.effects?.filter((effect) => effect.kind === "target-checkout").length, 1);
    assert.ok(!recovered.issues?.some((issue) => issue.kind === "target-checkout-retained"));
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]), journal);
    assert.equal(repository.run(["diff", "--cached", "--name-only", "HEAD"]), "");
    assert.equal(readFileSync(tracked, "utf8"), "candidate\n");
    assert.equal(readFileSync(ignored, "utf8"), "base\n");
  });

  test("a sparse target retains the whole predecessor despite having every tracked file", async () => {
    const repository = repositoryWithMain({ files: { "keep/tracked.txt": "base\n" } });
    const contracts = Keis.of(await Repo.at({ path: repository.path }));
    const bound = accepted(await contracts.bind({ terms: contractBody(), target: "main", gates: [] }));
    const worktree = bound.worktreePath!;
    mkdirSync(join(worktree, "outside"));
    writeFileSync(join(worktree, "outside", "file"), "candidate\n");
    repository.run(["-C", worktree, "add", "outside/file"]);
    repository.run(["-C", worktree, "commit", "-qm", "change outside the sparse set"]);
    repository.run(["sparse-checkout", "set", "--cone", "--sparse-index", "keep"]);
    const indexPath = join(repository.path, ".git", "index");
    const index = readFileSync(indexPath);
    assert.equal(readFileSync(join(repository.path, "keep", "tracked.txt"), "utf8"), "base\n");

    const preview = await bound.kei.previewDelivery();
    assert.equal(preview.kind, "ready");
    assert.equal(preview.target?.kind, "placeable");
    const observation = preview.target.checkouts?.find((checkout) => checkout.path === repository.path);
    assert.match(observation?.diagnostic ?? "", /sparse/u);
    const delivered = acceptedDelivery(await bound.kei.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(delivered.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic, observation?.diagnostic);
    assert.deepEqual(readFileSync(indexPath), index);

    const retry = await contracts.reconcile({ contract: bound.contractId });
    assert.equal(retry.kind, "contract");
    assert.ok(!retry.effects?.some((effect) => effect.kind === "target-checkout"));
    assert.equal(retry.issues?.find((issue) => issue.kind === "target-checkout-retained")?.diagnostic, observation?.diagnostic);
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(readFileSync(join(repository.path, "keep", "tracked.txt"), "utf8"), "base\n");
    assert.ok(!existsSync(join(repository.path, "outside")));
  });

  test("a whole predecessor with unrelated ignored runtime and dependencies follows normally", async () => {
    const { contract, repository } = await directoryReplacementContract("node_modules/\n");
    mkdirSync(join(repository.path, "node_modules"));
    writeFileSync(join(repository.path, "node_modules", "dependency.js"), "cached dependency\n");
    writeFileSync(join(repository.path, ".keiyaku", "runtime-cache"), "runtime\n");

    const delivered = acceptedDelivery(await contract.deliver());

    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(delivered.issues?.some((issue) => issue.kind === "target-checkout-retained") ?? false, false);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(readFileSync(join(repository.path, "artifact"), "utf8"), "candidate file\n");
    assert.equal(readFileSync(join(repository.path, "node_modules", "dependency.js"), "utf8"), "cached dependency\n");
    assert.equal(readFileSync(join(repository.path, ".keiyaku", "runtime-cache"), "utf8"), "runtime\n");
  });

  test("a displaced directory with untracked contents leaves the checkout behind", async () => {
    const { contract, repository } = await directoryReplacementContract("");
    const name = `untracked-0000-${"x".repeat(220)}.txt`;
    writeFileSync(join(repository.path, "artifact", name), "untracked\n");

    const delivered = acceptedDelivery(await contract.deliver());

    const completion = delivered.placement;
    assert.ok(completion?.kind === "placed", "expected a completed placement");
    assert.equal(delivered.placement?.kind, "placed");
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    const retained = (delivered.issues ?? []).filter((issue) => issue.kind === "target-checkout-retained");
    assert.ok(retained.length > 0);
    assert.equal(new Set(retained.map((issue) => issue.diagnostic)).size, retained.length);
    for (const issue of retained) {
      assert.equal(issue.path, repository.path);
      assert.equal(issue.target, "refs/heads/main");
    }
    assert.equal(readFileSync(join(repository.path, "artifact", "tracked.txt"), "utf8"), "tracked\n");
    assert.equal(readFileSync(join(repository.path, "artifact", name), "utf8"), "untracked\n");
  });

  test("reconcile recreates a registered managed worktree whose directory disappeared", async () => {
    const repository = makeGitRepository();
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(
      await Keis.of(repo).bind({
        terms: contractBody(),
      }),
    );
    const contractId = present(await bound.kei.state()).id;
    await Keis.of(repo).reconcile({ contract: contractId });
    const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), contractId);
    renameSync(path, `${path}-moved`);

    const repaired = await Keis.of(repo).reconcile({ contract: contractId });
    assert.ok(repaired.kind === "contract");

    assert.equal(existsSync(path), true);
    assert.equal(
      (repaired.effects ?? []).some((effect) => effect.kind === "worktree-created"),
      true,
    );
  });

  test("a moved gitlink retains dirty submodule internals", async () => {
    const module = repositoryWithMain({ files: { "tracked.txt": "submodule\n" } });
    const repository = repositoryWithMain();
    repository.run(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", module.path, "module"]);
    repository.run(["commit", "--quiet", "-m", "submodule"]);
    const bound = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: contractBody(), target: "main", gates: [],
    }));
    const path = bound.worktreePath!;
    writeFileSync(join(repository.path, "module", "tracked.txt"), "moved\n");
    repository.run([
      "-C", join(repository.path, "module"),
      "-c", "user.name=Keiyaku Test", "-c", "user.email=keiyaku-test@example.invalid",
      "commit", "--quiet", "-am", "move the submodule",
    ]);
    const moved = repository.run(["-C", join(repository.path, "module"), "rev-parse", "HEAD"]).trim();
    writeFileSync(join(path, "candidate.txt"), "candidate\n");
    repository.run(["-C", path, "add", "candidate.txt"]);
    repository.run(["-C", path, "update-index", "--cacheinfo", `160000,${moved},module`]);
    repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
    const local = join(repository.path, "module", "untracked.txt");
    writeFileSync(local, "local submodule bytes\n");
    const indexPath = join(repository.path, ".git", "index");
    const index = readFileSync(indexPath);

    const delivered = acceptedDelivery(await bound.kei.deliver());
    assert.equal(delivered.placement?.kind, "placed");
    assert.ok(delivered.issues?.some((issue) => issue.kind === "target-checkout-retained"));
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
    assert.equal(existsSync(join(repository.path, "candidate.txt")), false);
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(readFileSync(local, "utf8"), "local submodule bytes\n");
  });

  test("delivery diff preserves an empty patch and treats a clean missing object as Git absence", async () => {
    const { repository, id } = await boundContract();
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "no-op candidate"]);
    const delivery = await preparedDelivery(repository, id);
    const git = await cachedRepositoryAt(repository.path);

    assert.equal(await readDeliveryDiff(git, delivery.integration.predecessor, delivery.integration.snapshot), "");
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
    await contract.review({ verdict: "satisfied", summary: "Delivery review passed" });
    const state = present(await contract.state());
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
    const report = await Keis.of(fresh).reconcile({  });

    assert.ok(report.kind === "world");
    assert.equal(report.contracts?.find((item) => item.contractId === id)?.issues, undefined);
    assert.equal(present(await Keis.of(fresh).kei({ id }).state()).terminal?.kind, "claimed");
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
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(
      await Keis.of(repo).bind({
        terms: contractBody(),
      }),
    );
    const contractId = present(await bound.kei.state()).id;
    await Keis.of(repo).reconcile({ contract: contractId });
    const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), contractId);
    repository.run([
      "-C",
      path,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      child.path,
      "module",
    ]);
    repository.run(["-C", path, "commit", "--quiet", "-am", "submodule"]);
    writeFileSync(join(path, "module", "child.txt"), "dirty child\n");

    const abandoned = accepted(await bound.kei.abandon());

    assert.deepEqual(
      (abandoned.issues ?? []).filter((issue) => issue.kind === "unsealed-bytes"),
      [{ kind: "unsealed-bytes", severity: "optional", path }],
    );
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(join(path, "module", "child.txt"), "utf8"), "dirty child\n");
  });

});
