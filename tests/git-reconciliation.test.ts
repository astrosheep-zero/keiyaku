import { accepted, present } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keiyaku, Repo, type ContractId, type TopologyEffect } from "../src/index.js";
import { snapshotId } from "../src/core/facts/types.js";
import { readRef, repositoryAt } from "../src/git/repository.js";
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

function unchangedRef(effects: readonly TopologyEffect[], name: string, oid: string): boolean {
  return effects.some(
    (effect) =>
      effect.kind === "ref" &&
      effect.name === name &&
      effect.action === "unchanged" &&
      effect.before === oid &&
      effect.after === oid,
  );
}

type DeliveredReviewGatedTargetTemplate = Readonly<{
  repository: TestGitRepository;
  id: ContractId;
  workspaceHead: ReturnType<typeof snapshotId>;
  generatedFiles: readonly WorktreeFixtureFile[];
}>;

let deliveredReviewGatedTargetTemplate: Promise<DeliveredReviewGatedTargetTemplate> | undefined;

async function buildDeliveredReviewGatedTargetTemplate(): Promise<DeliveredReviewGatedTargetTemplate> {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const bound = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  }));
  const contract = bound.value.keiyaku;
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
  const contract = Keiyaku.with().select({ repo, id: template.id });
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
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), workspace: "worktree" }));
  const id = present(await bound.value.keiyaku.state()).id;
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), id);
  return { repository, repo, id, worktree };
}

// Each case owns its repository, fault injector and cleanup; no process-global mocks.
describe("git-reconciliation isolated fixtures", { concurrency: 3 }, () => {
  for (const [index, relativePath, completed] of [
    ["primary", ".keiyaku/.gitignore", []],
    ["managed", ".keiyaku/.gitignore", ["primary:.keiyaku/.gitignore"]],
    [
      "managed",
      ".agents/skills/keiyaku-deliver/SKILL.md",
      [
        "primary:.keiyaku/.gitignore",
        "managed:.keiyaku/.gitignore",
        "managed:.keiyaku/KEIYAKU.md",
        "managed:.agents/skills/keiyaku-onboarding/.gitignore",
        "managed:.agents/skills/keiyaku-onboarding/SKILL.md",
      ],
    ],
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
      const override = join(worktree, ".keiyaku", "namespace", "current");
      writeFileSync(override, "custom\n");

      const report = await Keiyaku.with().reconcile({ repo, contract: id });

      const lag = report.lag.find((entry) => entry.kind === "contract-file-failed");
      assert.ok(lag);
      assert.equal(report.lag.length, 1);
      assert.equal(lag.worktree, root);
      assert.equal(
        lag.path,
        relativePath.endsWith("SKILL.md") ? join(root, ".agents", "skills", "keiyaku-deliver") : path,
      );
      assert.equal(lag.diagnostic, `generated path is tracked by Git: ${path}`);
      assert.equal(readFileSync(path, "utf8"), "authored generated location\n");
      assert.equal(readFileSync(override, "utf8"), "custom\n");
      assert.equal(repository.run(["-C", root, "ls-files", "--stage"]), beforeIndex);
      assert.deepEqual(
        report.effects
          .filter((effect) => effect.kind === "contract-file")
          .map((effect) => {
            const prefix = effect.path.startsWith(`${worktree}/`) ? "managed" : "primary";
            return `${prefix}:${effect.path.slice((prefix === "managed" ? worktree : repository.path).length + 1)}`;
          }),
        completed,
      );

      repository.run(["-C", root, "reset", "--quiet", "HEAD", "--", relativePath]);
      const retried = await Keiyaku.with().reconcile({ repo, contract: id });
      assert.deepEqual(retried.lag, []);
      assert.notEqual(readFileSync(path, "utf8"), "authored generated location\n");
      assert.equal(readFileSync(override, "utf8"), "custom\n");
    });
  }

  for (const index of ["primary", "managed"] as const) {
    test(`tracking query failure in the ${index} index is lag and preserves prior effects`, async () => {
      const { repository, repo, id, worktree } = await projectionFixture();
      const root = index === "primary" ? repository.path : worktree;
      const guidance = readFileSync(join(worktree, ".keiyaku", "KEIYAKU.md"), "utf8");
      const context = join(worktree, ".keiyaku", "namespace", "current");
      unlinkSync(context);
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
          Keiyaku.with().reconcile({ repo: await Repo.at({ path: repository.path, gitPath }), contract: id }),
      );

      const lag = report.lag.find((entry) => entry.kind === "contract-file-failed");
      assert.ok(lag);
      assert.equal(report.lag.length, 1);
      assert.equal(lag.worktree, root);
      assert.equal(lag.path, join(root, ".keiyaku", ".gitignore"));
      assert.match(lag.diagnostic, /ls-files -z -- .*tracking read failed/);
      assert.equal(readFileSync(join(worktree, ".keiyaku", "KEIYAKU.md"), "utf8"), guidance);
      assert.deepEqual(
        report.effects.filter((effect) => effect.kind === "contract-file").map((effect) => effect.path),
        index === "primary" ? [] : [join(repository.path, ".keiyaku", ".gitignore")],
      );
      if (index === "managed") assert.equal(readFileSync(context, "utf8"), `${id}\n`);
      else assert.equal(statSync(context, { throwIfNoEntry: false }), undefined);
      assert.deepEqual((await Keiyaku.with().reconcile({ repo, contract: id })).lag, []);
    });
  }
  test("reconciliation repairs sentinelled skills and preserves a tracked user override", async () => {
    const repository = repositoryWithMain();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keiyaku.with().bind({
      repo,
      markdown: document(),
      workspace: "worktree",
    }));
    const contract = bound.value.keiyaku;
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

    const report = await Keiyaku.with().reconcile({ repo, contract: contractId });

    assert.deepEqual(report.lag, []);
    assert.equal(readFileSync(deliverSkill, "utf8"), "# User deliverer skill\n");
    assert.equal(statSync(join(deliverLeaf, ".gitignore"), { throwIfNoEntry: false }), undefined);
    assert.match(readFileSync(reviewSkill, "utf8"), /^---\nname: keiyaku-review$/m);
    const status = repository.run(["-C", worktree, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(status.includes("keiyaku-review"), false);
  });

  test("rewritten target history retains owned refs with unchanged effects", async () => {
    const { contract, repository, repo } = await deliveredReviewGatedTargetFixture();
    writeFileSync(join(repository.path, "target-only.txt"), "target only\n");
    repository.run(["add", "target-only.txt"]);
    repository.run(["commit", "--quiet", "-m", "target only"]);
    await contract.review({ verdict: "satisfied" });
    const state = present(await contract.state());
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

    const report = await Keiyaku.with().reconcile({ repo, contract: state.id });
    const git = await repositoryAt(repository.path);

    assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
    assert.equal(await readRef(git, candidatePinRefFor(state.id)), integration);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), rewritten);
    assert.equal(report.lag.length, 0);
    assert.equal(unchangedRef(report.effects, deliveryRefFor(state.id), tender), true);
    assert.equal(unchangedRef(report.effects, candidatePinRefFor(state.id), integration), true);
  });

  test("expected-target CAS retains owned refs under a stale frozen tip", async () => {
    const { contract, repository, repo } = await deliveredReviewGatedTargetFixture();
    await contract.review({ verdict: "satisfied" });
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
        Keiyaku.with().reconcile({
          repo: await Repo.at({ path: repository.path, gitPath }),
          contract: state.id,
        }),
    );
    const git = await repositoryAt(repository.path);
    const moved = repository.run(["rev-parse", "refs/heads/main"]).trim();

    assert.notEqual(moved, frozen);
    assert.equal(await readRef(git, deliveryRefFor(state.id)), tender);
    assert.equal(await readRef(git, candidatePinRefFor(state.id)), integration);
    assert.equal(report.lag.length, 0);
    assert.equal(unchangedRef(report.effects, deliveryRefFor(state.id), tender), true);
    assert.equal(unchangedRef(report.effects, candidatePinRefFor(state.id), integration), true);

    const retried = await Keiyaku.with().reconcile({ repo, contract: state.id });
    assert.equal(await readRef(git, deliveryRefFor(state.id)), null);
    assert.equal(await readRef(git, candidatePinRefFor(state.id)), null);
    assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), moved);
    assert.equal(retried.lag.length, 0);
  });
});
