import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Keiyaku } from "../src/index.js";
import { gate } from "../src/core/facts/types.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { tryAcquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { observeTargetPlacement } from "../src/git/target-placement.js";
import { admitIntent } from "../src/protocol/intent.js";
import { admitPlacement } from "../src/protocol/placement.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  type TestGitRepository,
  waitForFile,
  withGitShim,
} from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";

const TARGET_FILES = {
  "delivered.txt": "base\n",
  "local.txt": "base\n",
};

function document(title = "Target checkout placement"): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "A target branch may already be checked out.",
    "",
    "## Objective",
    "Keep the checked-out target coherent with placement.",
    "",
    "## Design",
    "Fence publication and Git-native follow.",
    "",
    "## Region",
    "~~~",
    "delivered.txt",
    "~~~",
    "",
    "## Criteria",
    "### Preserve bytes",
    "Refuse before publication when local content conflicts.",
    "",
  ].join("\n");
}

async function managedCandidate(repository: TestGitRepository, gates: readonly string[] = []) {
  const bound = await Keiyaku.bind({
    repo: await cachedRepoAt(repository.path),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates,
  });
  const contract = bound.keiyaku;
  const state = await contract.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(resolve(path, "delivered.txt"), "candidate\n");
  repository.run(["-C", path, "add", "delivered.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
  return { contract, id: state.id, path };
}

async function readyPlacementFixture() {
  const repository = repositoryWithMain({ files: TARGET_FILES });
  const value = { repository, ...(await managedCandidate(repository, ["reviewed"])) };
  await value.contract.deliver();
  await value.contract.review({ verdict: "unsatisfied" });
  const git = await cachedRepositoryAt(value.repository.path);
  const subject = (await value.contract.state()).attestations.at(-1)!.data.subject;
  await withGitDecodeChannel(git, async (channel) => {
    const result = await admitIntent(
      channel,
      git,
      {
        contractId: value.id,
        at: new Date().toISOString(),
        preparation: {
          kind: "prepared" as const,
          data: { gate: gate("reviewed"), subject, verdict: "satisfied" as const },
        },
      },
      decideAttestation<never>,
    );
    assert.equal(result.kind, "accepted");
  });
  return { ...value, git };
}

test("immutable placement preparation leaves the publication seat free and rechecks mutable state", async () => {
  for (const mutation of ["checkout", "authority"] as const) {
    const value = await readyPlacementFixture();
    const { repository, git, id, contract } = value;
    const before = repository.run(["rev-parse", "refs/heads/main"]);
    const marker = resolve(repository.path, ".git", "shape-started");
    const release = resolve(repository.path, ".git", "shape-release");
    await withGitShim(
      [
        'case " $* " in',
        '  *" --no-renames "*)',
        '    if [ ! -e "$SHAPE_STARTED" ]; then',
        '      touch "$SHAPE_STARTED"',
        '      while [ ! -e "$SHAPE_RELEASE" ]; do sleep 0.01; done',
        "    fi ;;",
        "esac",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { SHAPE_STARTED: marker, SHAPE_RELEASE: release },
      async (gitPath) => {
        const observedGit = await cachedRepositoryAt(repository.path, gitPath);
        const placing = withGitDecodeChannel(observedGit, (channel) =>
          admitPlacement({
            channel,
            repository: observedGit,
            target: "refs/heads/main",
            placement: { contractId: id, at: new Date().toISOString() },
          }),
        );
        void placing.catch(() => undefined);
        try {
          await waitForFile(marker);
          const otherWriter = await tryAcquireSqliteTransactionLock({
            path: privateStatePublicationSeatPath(git),
            mode: "immediate",
          });
          assert.ok(otherWriter, "immutable diff preparation held the shared publication seat");
          otherWriter.close();
          if (mutation === "checkout")
            writeFileSync(resolve(repository.path, "delivered.txt"), "local edit during preparation\n");
          else await contract.abandon();
        } finally {
          writeFileSync(release, "release");
          await placing.catch(() => undefined);
        }
        const result = await placing;
        assert.equal(result.kind, "refused");
        if (result.kind !== "refused") assert.fail("stale preparation was accepted");
        if (mutation === "checkout") {
          assert.equal(result.refusal.kind, "checkout-not-followable");
          if (result.refusal.kind === "checkout-not-followable") assert.equal(result.refusal.reason, "dirty-tracked");
          assert.equal((await contract.state()).terminal, null);
          assert.equal(
            readFileSync(resolve(repository.path, "delivered.txt"), "utf8"),
            "local edit during preparation\n",
          );
        } else {
          assert.equal(result.refusal.kind, "terminal");
          assert.equal((await contract.state()).terminal?.kind, "abandoned");
        }
        assert.equal(repository.run(["rev-parse", "refs/heads/main"]), before);
      },
    );
  }
});

test("placement shares ancestor observations and batches directory refusals without caching mutable state", async (context) => {
  const repository = repositoryWithMain({ files: { ...TARGET_FILES, ".gitignore": "*.cache\n" } });
  const candidate = await managedCandidate(repository);
  const paths = Array.from({ length: 20 }, (_, index) => `shared/deep/item-${String(index).padStart(2, "0")}`);
  for (const path of paths) {
    mkdirSync(dirname(resolve(candidate.path, path)), { recursive: true });
    writeFileSync(resolve(candidate.path, path), "new blob\n");
    mkdirSync(resolve(repository.path, path), { recursive: true });
  }
  repository.run(["-C", candidate.path, "add", "shared"]);
  repository.run(["-C", candidate.path, "commit", "--quiet", "-m", "replace empty directories with blobs"]);
  const last = paths.at(-1)!;
  const collision = resolve(repository.path, last, "owned.cache");
  writeFileSync(collision, "preserve ignored bytes\n");
  const state = await candidate.contract.state();
  const input = {
    contractId: candidate.id,
    coordinates: { ...state.coordinates, target: "refs/heads/main" },
    predecessor: mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim()),
    candidate: mintSnapshotId(repository.run(["-C", candidate.path, "rev-parse", "HEAD"]).trim()),
  };
  const trace = resolve(repository.path, ".git", "shape-trace");
  const counts = new Map<string, number>();
  const original = promises.lstat;
  const mocked = context.mock.method(
    promises,
    "lstat",
    (path: Parameters<typeof original>[0], ...options: unknown[]) => {
      const key = String(path);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Reflect.apply(original, promises, [path, ...options]);
    },
  );
  syncBuiltinESMExports();
  try {
    await withGitShim(
      'printf "%s\\n" "$*" >> "$SHAPE_TRACE"\nexec "$KEIYAKU_REAL_GIT" "$@"',
      { SHAPE_TRACE: trace },
      async (gitPath) => {
        const git = await cachedRepositoryAt(repository.path, gitPath);
        const result = await observeTargetPlacement(git, input);
        assert.equal(result.kind, "refused");
        if (result.kind !== "refused") assert.fail("ignored directory contents were not protected");
        assert.equal(result.refusal.reason, "untracked");
        assert.deepEqual(result.refusal.paths, [last]);
        assert.equal(readFileSync(collision, "utf8"), "preserve ignored bytes\n");
        assert.equal(counts.get(resolve(repository.path, "shared")), 1);
        assert.equal(counts.get(resolve(repository.path, "shared/deep")), 1);
        const commands = readFileSync(trace, "utf8").trim().split("\n");
        assert.equal(commands.filter((command) => /(?:^| )ls-tree(?: |$)/u.test(command)).length, 0);
        assert.ok(commands.filter((command) => /(?:^| )ls-files(?: |$)/u.test(command)).length <= 2);
        rmSync(collision);
        counts.clear();
        assert.equal((await observeTargetPlacement(git, input)).kind, "ready");
        assert.equal(counts.get(resolve(repository.path, "shared")), 1);
      },
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
