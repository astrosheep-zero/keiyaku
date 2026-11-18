import { accepted, present } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keis, Repo, type ContractId } from "../src/index.js";
import { snapshotId } from "../src/core/facts/types.js";
import { readRef, repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { abandonOperation } from "../src/protocol/abandon.js";
import { cleanupTerminalOperation } from "../src/protocol/reconcile.js";
import { worktreePath } from "../src/git/workspace.js";
import { placeRegisterPath, readManagedWorktreeAppointment } from "../src/workspace-place.js";
import {
  appointedWorktreePath,
  candidatePinRefFor,
  captureWorktreeFiles,
  deliveryRefFor,
  restoreWorktreeFiles,
  snapshotGitRepository,
  type TestGitRepository,
  type WorktreeFixtureFile,
  withGitShim,
} from "./support/git.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

type DeliveredReviewGatedTargetTemplate = Readonly<{
  repository: TestGitRepository;
  id: ContractId;
  workspaceHead: ReturnType<typeof snapshotId>;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

let deliveredReviewGatedTargetTemplate: Promise<DeliveredReviewGatedTargetTemplate> | undefined;

async function buildDeliveredReviewGatedTargetTemplate(): Promise<DeliveredReviewGatedTargetTemplate> {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const bound = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    terms: document(),
    target: "refs/heads/main",
    gates: ["reviewed"],
  }));
  const contract = bound.kei;
  const contractId = (present(await contract.state())).id;
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), contractId);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await contract.deliver();
  const workspaceHead = snapshotId(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim());
  const generatedFiles = captureWorktreeFiles(worktree);
  repository.run(["worktree", "remove", "--force", worktree]);
  return { repository, id: contractId, workspaceHead, generatedFiles };
}

async function deliveredReviewGatedTargetFixture() {
  const templatePromise = (deliveredReviewGatedTargetTemplate ??= buildDeliveredReviewGatedTargetTemplate());
  let template: DeliveredReviewGatedTargetTemplate;
  try {
    template = await templatePromise;
  } catch (error) {
    if (deliveredReviewGatedTargetTemplate === templatePromise) deliveredReviewGatedTargetTemplate = undefined;
    throw error;
  }
  const repository = snapshotGitRepository(template.repository);
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), template.id);
  repository.run(["worktree", "add", "--detach", worktree, template.workspaceHead]);
  restoreWorktreeFiles(worktree, template.generatedFiles);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keis.of(repo).kei({ id: template.id });
  return { contract, repository, repo, worktree };
}

async function restoreOwnedRefs(
  repository: ReturnType<typeof repositoryWithMain>,
  id: ContractId,
  tender: string,
  integration: string,
) {
  repository.run(["update-ref", deliveryRefFor(id), tender]);
  repository.run(["update-ref", candidatePinRefFor(id), integration]);
}

async function projectionFixture() {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document() }));
  const id = present(await bound.kei.state()).id;
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), id);
  return { repository, repo, id, worktree };
}

test("head movement spends repair once; stale cleanup cannot remove a newly terminal worktree", async () => {
  const { repository, repo, id, worktree } = await projectionFixture();
  const scope = await repositoryAt(repository.path);
  const head = present(await Keis.of(repo).kei({ id }).state()).head;
  const reads = join(scope.commonDirectory, "state-reads");
  const shim = [
    'if [ "$1 $2 $3 $4" = "rev-parse --verify --quiet refs/heads/keiyaku-state" ]; then',
    '  printf "read\\n" >> "$KEIYAKU_READS"',
    '  if [ "$(wc -l < "$KEIYAKU_READS" | tr -d " ")" = 2 ]; then',
    '    frozen=$("$KEIYAKU_REAL_GIT" "$@") || exit $?',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$KEIYAKU_TERMINAL" "$frozen" || exit $?',
    '    printf "%s\\n" "$frozen"',
    "    exit 0",
    "  fi",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const before = repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim();
  const terminal = await withGitDecodeChannel(scope, (channel) => abandonOperation({ scope, channel, contractId: id }));
  assert.equal(terminal.kind, "accepted");
  const after = repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim();
  repository.run(["update-ref", "refs/heads/keiyaku-state", before, after]);
  const report = await withGitShim(shim, { KEIYAKU_READS: reads, KEIYAKU_TERMINAL: after }, async (gitPath) =>
    Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({ contract: id }),
  );
  assert.equal(report.kind, "contract");
  assert.equal(report.effects, undefined);
  assert.deepEqual(report.issues, [
    { kind: "reconcile-failed", severity: "required", diagnostic: `Contract moved during reconciliation: ${id}` },
  ]);
  assert.equal(existsSync(worktree), true);

  const cleanup = await withGitDecodeChannel(scope, (channel) =>
    cleanupTerminalOperation({
      scope,
      channel,
      contractId: id,
      expectedHead: head,
      handoffSafe: true,
      retryHooks: false,
      hooks: { create: [], destroy: [] },
    }),
  );
  assert.equal(cleanup.appointedPathAbsent, false);
  assert.equal(cleanup.report.lag[0]?.kind, "reconcile-failed");
  assert.equal(existsSync(worktree), true);
  const retried = await Keis.of(repo).reconcile({ contract: id });
  assert.equal(retried.kind, "contract");
  assert.equal(retried.issues, undefined);
  assert.equal(existsSync(worktree), false);
});

test("recovery and confirmed removal survive a later ref custody failure without retaining Place", async () => {
  const { repository, id, worktree } = await projectionFixture();
  writeFileSync(join(worktree, "abandoned.txt"), "recover these bytes\n");
  const scope = await repositoryAt(repository.path);
  const terminal = await withGitDecodeChannel(scope, (channel) => abandonOperation({ scope, channel, contractId: id }));
  assert.equal(terminal.kind, "accepted");
  const shim = [
    'if [ "$1" = "for-each-ref" ]; then',
    '  echo "ref custody observation failed" >&2',
    "  exit 2",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const report = await withGitShim(shim, {}, async (gitPath) =>
    Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({ contract: id }),
  );
  assert.equal(report.kind, "contract");
  const [recovery, removal] = report.effects ?? [];
  assert.equal(report.effects?.length, 2);
  assert.equal(recovery?.kind, "recovery-snapshot");
  assert.equal(repository.run(["show", `${recovery.snapshot}:abandoned.txt`]), "recover these bytes\n");
  assert.deepEqual(removal, { kind: "worktree-removed", path: worktree });
  assert.equal(report.issues?.length, 1);
  const issue = report.issues?.[0];
  assert.equal(issue?.kind, "reconcile-failed");
  assert.match(issue.diagnostic, /ref custody observation failed/u);
  assert.deepEqual(await readManagedWorktreeAppointment(scope, id), { kind: "unappointed" });
  assert.notEqual(await readRef(scope, deliveryRefFor(id)), null);
  const replay = await Keis.of(await Repo.at({ path: repository.path })).reconcile({ contract: id });
  assert.equal(replay.kind, "contract");
  assert.equal(replay.issues, undefined);
  assert.equal(await readRef(scope, deliveryRefFor(id)), null);
});

async function withPlaceWritesBlocked<T>(git: Awaited<ReturnType<typeof repositoryAt>>, run: () => Promise<T>) {
  const directory = join(git.commonDirectory, "keiyaku");
  chmodSync(directory, 0o555);
  try {
    return await run();
  } finally {
    chmodSync(directory, 0o755);
  }
}

async function terminalLegacyPlaceFixture() {
  const repository = repositoryWithMain();
  const scope = await repositoryAt(repository.path);
  const keis = Keis.of(await Repo.at({ path: repository.path }));
  const { kei } = accepted(await keis.bind({ terms: document(), target: "refs/heads/main", gates: [] }));
  const { id } = present(await kei.state());
  const place = "litterbox2";
  const path = worktreePath(scope, place);
  const register = placeRegisterPath(scope);
  repository.run(["worktree", "move", await appointedWorktreePath(scope, id), path]);
  writeFileSync(register, `{"version":1,"appointments":{"${place}":"${id}"}}\n`);
  writeFileSync(join(path, "candidate.txt"), "candidate\n");
  repository.run(["-C", path, "add", "candidate.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);

  const receipt = accepted(await withPlaceWritesBlocked(scope, () => kei.deliver()));
  assert.equal(receipt.placement?.kind, "placed");
  assert.ok(receipt.issues?.some((issue) => issue.kind === "contract-file-failed" && issue.path === register));
  const tender = present(present(await kei.state()).delivery).data.tenderSnapshot;
  const integration = receipt.integration;
  assert.notEqual(tender, integration);
  const refs = [deliveryRefFor(id), candidatePinRefFor(id)] as const;
  const pinValues = () => Promise.all(refs.map((ref) => readRef(scope, ref)));
  assert.equal(existsSync(path), false);
  assert.deepEqual(await pinValues(), [null, null]);
  assert.deepEqual(await readManagedWorktreeAppointment(scope, id), { kind: "appointed", place, path });
  assert.equal(await readRef(scope, "refs/heads/main"), integration);
  return { repository, scope, keis, id, tender, integration, refs, pinValues };
}

function pruneUnreachableCommits(repository: TestGitRepository) {
  repository.run(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
  repository.run(["gc", "--prune=now"]);
}

for (const scenario of ["retired", "pruned"] as const) {
  test(`release-only retry at a legacy Place with a ${scenario} tender`, async () => {
    const { repository, scope, keis, id, tender, pinValues } = await terminalLegacyPlaceFixture();
    if (scenario === "pruned") {
      pruneUnreachableCommits(repository);
      assert.throws(() => repository.run(["cat-file", "-e", tender]));
    }
    const retry = await keis.reconcile({ contract: id });
    assert.equal(retry.kind, "contract");
    assert.equal(retry.effects, undefined);
    assert.deepEqual(await readManagedWorktreeAppointment(scope, id), { kind: "unappointed" });
    assert.deepEqual(await pinValues(), [null, null]);
    if (scenario === "retired") assert.equal(retry.issues, undefined);
    else {
      assert.equal(retry.issues?.length, 1);
      assert.equal(retry.issues?.[0]?.kind, "reconcile-failed");
      assert.match(retry.issues[0].diagnostic, /missing|nonexistent/u);
      assert.ok(retry.issues[0].diagnostic.includes(tender));
    }
  });
}

for (const missing of ["tender", "integration"] as const) {
  test(`terminal retry repairs the surviving ref when the ${missing} commit was pruned`, async () => {
    const { repository, scope, keis, id, tender, integration, refs, pinValues } = await terminalLegacyPlaceFixture();
    const target = "refs/heads/main";
    const hold = "refs/heads/retain-tender-for-prune";
    const tree = repository.run(["rev-parse", `${integration}^{tree}`]).trim();
    if (missing === "tender") pruneUnreachableCommits(repository);
    else repository.run(["update-ref", hold, tender]);
    const rewritten = repository.run(["commit-tree", tree, "-m", "rewrite target without the integration"]).trim();
    repository.run(["update-ref", target, rewritten, integration]);
    if (missing === "integration") {
      pruneUnreachableCommits(repository);
      repository.run(["update-ref", "-d", hold, tender]);
    }
    const unavailable = missing === "tender" ? tender : integration;
    const available = missing === "tender" ? integration : tender;
    assert.throws(() => repository.run(["cat-file", "-e", unavailable]));
    assert.equal(repository.run(["cat-file", "-t", available]).trim(), "commit");

    const retry = await keis.reconcile({ contract: id });
    assert.equal(retry.kind, "contract");
    assert.deepEqual(await readManagedWorktreeAppointment(scope, id), { kind: "unappointed" });
    assert.equal(await readRef(scope, target), rewritten);
    assert.deepEqual(await pinValues(), missing === "tender" ? [null, integration] : [tender, null]);
    assert.deepEqual(retry.effects, [
      { kind: "ref", name: refs[missing === "tender" ? 1 : 0], before: null, after: available },
    ]);
    assert.equal(retry.issues?.length, 1);
    assert.equal(retry.issues[0]?.kind, "reconcile-failed");
    assert.match(retry.issues[0].diagnostic, /missing|nonexistent/u);
    assert.ok(retry.issues[0].diagnostic.includes(unavailable));
  });
}

// Each case owns its repository, fault injector and cleanup; no process-global mocks.
describe("git-reconciliation isolated fixtures", { concurrency: 3 }, () => {
  for (const [index, relativePath] of [
    ["primary", ".keiyaku/.gitignore"],
    ["managed", ".keiyaku/.gitignore"],
    ["managed", ".agents/skills/keiyaku-deliver/SKILL.md"],
  ] as const) {
    test(`projection refuses ${relativePath} tracked only in the ${index} index before overwrite`, async () => {
      const { repository, repo, id, worktree } = await projectionFixture();
      const root = index === "primary" ? repository.path : worktree;
      const other = index === "primary" ? worktree : repository.path;
      const path = join(root, relativePath);
      writeFileSync(path, "authored generated location\n");
      repository.run(["-C", root, "add", "--force", relativePath]);
      assert.equal(repository.run(["-C", root, "ls-tree", "HEAD", "--", relativePath]), "");
      assert.equal(repository.run(["-C", other, "ls-files", "--", relativePath]), "");
      const beforeIndex = repository.run(["-C", root, "ls-files", "--stage"]);

      const report = await Keis.of(repo).reconcile({ contract: id });
      assert.ok(report.kind === "contract");

      const lag = (report.issues ?? []).find((issue) => issue.kind === "contract-file-failed");
      assert.ok(lag?.kind === "contract-file-failed", JSON.stringify(report));
      assert.equal((report.issues ?? []).filter((issue) => issue.kind === "contract-file-failed").length, 1);
      assert.equal(
        lag.path,
        relativePath.endsWith("SKILL.md") ? join(root, ".agents", "skills", "keiyaku-deliver") : path,
      );
      assert.equal(lag.diagnostic, `generated path is tracked by Git: ${path}`);
      assert.equal(readFileSync(path, "utf8"), "authored generated location\n");
      assert.equal(repository.run(["-C", root, "ls-files", "--stage"]), beforeIndex);

      repository.run(["-C", root, "reset", "--quiet", "HEAD", "--", relativePath]);
      const retried = await Keis.of(repo).reconcile({ contract: id });
      assert.ok(retried.kind === "contract");
      assert.equal((retried.issues ?? []).some((issue) => issue.kind === "contract-file-failed"), false);
      assert.notEqual(readFileSync(path, "utf8"), "authored generated location\n");
    });
  }

  for (const index of ["primary", "managed"] as const) {
    test(`tracking query failure in the ${index} index is lag and preserves prior effects`, async () => {
      const { repository, repo, id, worktree } = await projectionFixture();
      const root = index === "primary" ? repository.path : worktree;
      const guidance = readFileSync(join(worktree, ".keiyaku", "KEIYAKU.md"), "utf8");
      const report = await withGitShim(
        [
          'if [ "$1" = "ls-files" ] && [ "$PWD" = "$KEIYAKU_FAILED_INDEX" ]; then',
          '  printf ".keiyaku/KEIYAKU.md\\0"',
          '  echo "tracking read failed" >&2',
          "  exit 1",
          "fi",
          'exec "$KEIYAKU_REAL_GIT" "$@"',
        ].join("\n"),
        { KEIYAKU_FAILED_INDEX: root },
        async (gitPath) =>
          Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({ contract: id }),
      );
      assert.ok(report.kind === "contract");

      const lag = (report.issues ?? []).find((issue) => issue.kind === "contract-file-failed");
      assert.ok(lag?.kind === "contract-file-failed", JSON.stringify(report));
      assert.equal((report.issues ?? []).filter((issue) => issue.kind === "contract-file-failed").length, 1);
      assert.equal(lag.path, join(root, ".keiyaku", ".gitignore"));
      assert.match(lag.diagnostic, /ls-files -z -- .*tracking read failed/);
      assert.equal(readFileSync(join(worktree, ".keiyaku", "KEIYAKU.md"), "utf8"), guidance);

      const recovered = await Keis.of(repo).reconcile({ contract: id });
      assert.ok(recovered.kind === "contract");
      assert.equal(recovered.issues, undefined);
    });
  }
  test("reconciliation repairs sentinelled skills and preserves a tracked user override", async () => {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      terms: document(),
    }));
    const contract = bound.kei;
    const contractId = (present(await contract.state())).id;
    const worktree = await appointedWorktreePath(await repositoryAt(repository.path), contractId);
    const deliverLeaf = join(worktree, ".agents", "skills", "keiyaku-deliver");
    const deliverSkill = join(deliverLeaf, "SKILL.md");
    const reviewSkill = join(worktree, ".agents", "skills", "keiyaku-review", "SKILL.md");
    unlinkSync(join(deliverLeaf, ".gitignore"));
    writeFileSync(deliverSkill, "# User deliverer skill\n");
    repository.run(["-C", worktree, "add", ".agents/skills/keiyaku-deliver/SKILL.md"]);
    repository.run(["-C", worktree, "commit", "--quiet", "-m", "user seat skill"]);
    writeFileSync(reviewSkill, "stale generated skill\n");

    const report = await Keis.of(repo).reconcile({ contract: contractId });
    assert.ok(report.kind === "contract");

    assert.equal((report.issues ?? []).length, 0, JSON.stringify(report));
    assert.equal(readFileSync(deliverSkill, "utf8"), "# User deliverer skill\n");
    assert.equal(statSync(join(deliverLeaf, ".gitignore"), { throwIfNoEntry: false }), undefined);
    assert.match(readFileSync(reviewSkill, "utf8"), /^---\nname: keiyaku-review$/m);
    const status = repository.run(["-C", worktree, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(status.includes("keiyaku-review"), false);
  });

  test("rewritten target history repairs missing custody without reporting target movement", async () => {
    const { contract, repository, repo, worktree } = await deliveredReviewGatedTargetFixture();
    writeFileSync(join(repository.path, "target-only.txt"), "target only\n");
    repository.run(["add", "target-only.txt"]);
    repository.run(["commit", "--quiet", "-m", "target only"]);
    const git = await repositoryAt(repository.path);
    await withPlaceWritesBlocked(git, () =>
      contract.review({ verdict: "satisfied", summary: "Reconciliation review passed" }),
    );
    const state = present(await contract.state());
    assert.equal(state.terminal?.kind, "claimed");
    assert.equal(existsSync(worktree), false);
    assert.equal((await readManagedWorktreeAppointment(git, state.id)).kind, "appointed");
    const tender = state.delivery?.data.tenderSnapshot;
    const integration = state.currentIntegration?.snapshot ?? state.delivery?.data.integration.snapshot;
    assert.ok(tender);
    assert.ok(integration);
    assert.notEqual(tender, integration);
    repository.run(["update-ref", "-d", deliveryRefFor(state.id)]);
    repository.run(["update-ref", "-d", candidatePinRefFor(state.id)]);
    const tree = repository.run(["rev-parse", "HEAD^{tree}"]).trim();
    const rewritten = repository.run(["commit-tree", tree, "-m", "rewritten target"]).trim();
    repository.run(["update-ref", "refs/heads/main", rewritten]);

    const report = await Keis.of(repo).reconcile({ contract: state.id });
    assert.ok(report.kind === "contract");
    assert.deepEqual(report.effects, [
      { kind: "ref", name: deliveryRefFor(state.id), before: null, after: tender },
      { kind: "ref", name: candidatePinRefFor(state.id), before: null, after: integration },
    ]);
    assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
    assert.equal(await readRef(git, candidatePinRefFor(state.id)), integration);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), rewritten);
    assert.equal((report.issues ?? []).length, 0);
  });

  test("expected-target CAS retains owned refs under a stale frozen tip", async () => {
    const { contract, repository, repo } = await deliveredReviewGatedTargetFixture();
    await contract.review({ verdict: "satisfied", summary: "Reconciliation review passed" });
    const state = present(await contract.state());
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
        Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({
          contract: state.id,
        }),
    );
    assert.ok(report.kind === "contract");
    const git = await repositoryAt(repository.path);
    const moved = repository.run(["rev-parse", "refs/heads/main"]).trim();

    assert.notEqual(moved, frozen);
    assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
    assert.equal(await readRef(git, candidatePinRefFor(state.id)), integration);
    assert.equal((report.issues ?? []).length, 0);

    const retried = await Keis.of(repo).reconcile({ contract: state.id });
    assert.ok(retried.kind === "contract");
    assert.equal(await readRef(git, deliveryRefFor(state.id)), null);
    assert.equal(await readRef(git, candidatePinRefFor(state.id)), null);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), moved);
    assert.equal((retried.issues ?? []).length, 0);
  });
});
