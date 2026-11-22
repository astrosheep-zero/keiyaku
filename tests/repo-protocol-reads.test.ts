import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appointManagedWorktrees, readPlaceRegister } from "../src/workspace-place.js";
import { appointedWorktreePath, withGitShim, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import {
  GIT_FORMAT_PATH,
  GIT_REF,
  readBlob,
  readGitPaths,
  repositoryAt,
  updateGitTree,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import {
  contractCatalogueSchema,
  readContractCount,
  readContractMembership,
} from "../src/protocol/read/status.js";
import { Keis, KeiyakuError, Repo, Kanshi } from "../src/index.js";
import { decodeContractDocument } from "../src/document/decode.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { observeNamedAddress, resolveNamedAddress } from "../src/library/address.js";
import { contractJournalPath, contractJournalPaths } from "../src/git/identity.js";
import { prepareVerificationDeclaration } from "../src/verification/declaration.js";
import { bindOperation } from "../src/protocol/bind.js";
import { InvocationAccumulator } from "../src/library/invocation.js";
import { completeRepoReconcile } from "../src/library/reconcile.js";
import {
  scopeOperation,
} from "../src/protocol/operations.js";
import { type ContractId } from "../src/core/facts/types.js";
import { renderContractCatalogue } from "../src/cli/render/catalog.js";
import { protocolContractId } from "./support/git.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";

function terms(title: string, after: readonly ContractId[] = []) {
  const document = decodeContractDocument(
    contractMarkdown(title, {
      Context: "Exercise the repository-level protocol reads.",
      Objective: "Expose one pinned scope and snapshot-backed status.",
      Design: "The protocol owns git observation and effects.",
      Region: "```\nsrc/**\n```",
      Criteria: "### Protocol result\nThe operation returns only plain data.\n",
    }),
  );
  return { document: document.document, segments: document.segments, gates: [], requirements: {}, after };
}

async function bind(
  repository: TestGitRepository,
  title: string,
  after: readonly ContractId[] = [],
): Promise<ContractId> {
  const scope = await scopeOperation({ coordinate: repository.path });
  const result = await withGitDecodeChannel(scope, (channel) =>
    bindOperation({
      scope,
      channel,
      contractId: protocolContractId(title),
      terms: terms(title, after),
      targetSelection: { kind: "targetless" },
      verification: prepareVerificationDeclaration(null),
    }),
  );
  assert.ok(result.kind === "accepted", 'expected result.kind = "accepted"');
  return result.state.id;
}

test("readable Contract catalogue skips one malformed journal while exact authority stays strict", async () => {
  const repository = repositoryWithMain();
  const healthy = await bind(repository, "Readable catalogue healthy");
  const laterHealthy = await bind(repository, "Readable catalogue later");
  const malformed = await bind(repository, "Malformed catalogue journal");
  const repo = await Repo.at({ path: repository.path });
  const contracts = Keis.of(repo);
  assert.equal((await contracts.list()).skipped, undefined, "a complete catalogue reports no skipped count");

  const git = await repositoryAt(repository.path);
  const path = contractJournalPath(malformed);
  const before = await readGitPaths(git, [path]);
  const journal = before.paths.get(path);
  if (journal?.type !== "blob") throw new Error(`missing active journal for ${malformed}`);
  const bytes = `${(await readBlob(git, journal.oid))
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const entry = JSON.parse(line) as { kind: string; data: { terms?: { requirements?: unknown } } };
      if (entry.kind === "bind") delete entry.data.terms!.requirements;
      return JSON.stringify(entry);
    })
    .join("\n")}\n`;
  const oid = await writeBlob(git, bytes);
  const tree = await updateGitTree(git, before.tree, new Map([[path, { oid }]]));
  const commit = await writeCommit({ repository: git, tree, parent: before.commit });
  repository.run(["update-ref", GIT_REF, commit, before.commit!]);

  const catalogue = await contracts.list();
  assert.deepEqual(new Set(catalogue.rows?.map((row) => row.id)), new Set([healthy, laterHealthy]));
  assert.equal(catalogue.more, undefined);
  assert.equal(catalogue.skipped, 1);
  assertWireRoundTrip(contractCatalogueSchema, catalogue);
  const bounded = await contracts.list({ limit: 1 });
  assert.equal(bounded.rows?.length, 1, "the readable row bound is independent of the skipped count");
  assert.equal(bounded.more, true);
  assert.equal(bounded.skipped, 1);

  const twinPath = contractJournalPath(laterHealthy, "terminal");
  const twinTree = await updateGitTree(
    git,
    tree,
    new Map([[twinPath, { oid: await writeBlob(git, "corrupt twin\n") }]]),
  );
  const twinCommit = await writeCommit({ repository: git, tree: twinTree, parent: commit });
  repository.run(["update-ref", GIT_REF, twinCommit, commit]);
  const twinned = await contracts.list();
  assert.deepEqual(twinned.rows?.map((row) => row.id), [healthy], "an unreadable canonical twin suppresses its row");
  assert.equal(twinned.skipped, 2, "only selected source paths are skipped");
  const text = renderContractCatalogue(catalogue);
  assert.match(text, /! 1 journal skipped/u);
  assert.ok(!text.includes(malformed), "the omitted record has no placeholder row");
  await assert.rejects(contracts.observe({ id: malformed }), { category: "authority-corruption" });
  const { contracts: section } = await Kanshi.of({ world: null, repo }).board();
  assert.ok("kind" in section && section.kind === "failed");
});

test("counts and selection observe only their membership authority", async () => {
  const repository = repositoryWithMain();
  const good = await bind(repository, "Selectable");
  const bad = await bind(repository, "Broken target");
  const scope = await repositoryAt(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const library = Keis.of(repo);
  await appointManagedWorktrees(scope, [good, bad]);
  const cwd = await appointedWorktreePath(scope, good);
  mkdirSync(cwd, { recursive: true });
  const selector = `@${good.slice(4)}`;
  const badPath = contractJournalPath(bad);
  const publish = async (path: string, bytes: string) => {
    const before = await readGitPaths(scope, [path]);
    const oid = await writeBlob(scope, bytes);
    const tree = await updateGitTree(scope, before.tree, new Map([[path, { oid }]]));
    const commit = await writeCommit({ repository: scope, tree, parent: before.commit });
    repository.run(["update-ref", GIT_REF, commit, before.commit!]);
  };
  const original = await readGitPaths(scope, [badPath]);
  const journal = original.paths.get(badPath)!;
  const entries = decodeJournal((await readBlob(scope, journal.oid)).toString("utf8"));
  const brokenTarget = entries.map((entry) =>
    entry.kind === "bind"
      ? {
          ...entry,
          data: { ...entry.data, coordinates: { ...entry.data.coordinates, target: "invalid Git ref" } },
        }
      : entry,
  );
  await publish(badPath, brokenTarget.map(encodeEntry).join(""));
  await assert.rejects(library.observe({ id: bad }), /invalid Git ref/u);
  assert.equal((await Kanshi.of({ world: null, repo }).counts()).contracts, 2);
  assert.deepEqual(await library.resolve({ selector }), { kind: "resolved", id: good });
  assert.deepEqual(await library.resolve({ cwd }), { kind: "resolved", id: good });
  const authority = await observeNamedAddress({ world: null, repo, selectors: [selector] });
  assert.deepEqual(resolveNamedAddress({ ...authority, selector }), { kind: "contract", id: good });
  await withGitDecodeChannel(scope, (channel) =>
    withGitReadObservation(scope, channel, async (observation) => {
      assert.equal(
        readContractCount({
          ...observation,
          readBlobs: async () => {
            throw new Error("count must not read journal blobs");
          },
        }),
        2,
      );
      const goodBlob = observation.snapshot.paths.get(contractJournalPath(good))!.oid;
      const reads: string[] = [];
      await readContractMembership(
        {
          ...observation,
          readBlobs: async (oids) => {
            reads.push(...oids);
            return observation.readBlobs(oids);
          },
        },
        [good],
      );
      assert.deepEqual(reads, [goodBlob]);
    }),
  );
  await publish(badPath, "corrupt journal\n");
  assert.equal((await Kanshi.of({ world: null, repo }).counts()).contracts, 2);
  assert.deepEqual(await library.resolve({ selector }), { kind: "resolved", id: good });
  assert.deepEqual(
    resolveNamedAddress({
      ...(await observeNamedAddress({ world: null, repo, selectors: [selector] })),
      selector,
    }),
    { kind: "contract", id: good },
  );
  await assert.rejects(library.resolve({ selector: `@${bad.slice(4)}` }));
  await assert.rejects(library.resolve({ cwd }));
  await publish(GIT_FORMAT_PATH, "corrupt membership format\n");
  const { contracts: count } = await Kanshi.of({ world: null, repo }).counts();
  assert.ok(typeof count !== "number" && count.kind === "failed");
});

test("world reconcile distinguishes empty from failed discovery and starts no repair on incomplete authority", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const contracts = Keis.of(repo);
  assert.deepEqual(await contracts.reconcile({}), { kind: "world" });
  const missing = protocolContractId("Missing");
  assert.deepEqual(await contracts.reconcile({ contract: missing }), { kind: "missing", contractId: missing });
  const first = await bind(repository, "Unrealized first");
  const second = await bind(repository, "Unrealized second");
  const git = await repositoryAt(repository.path);
  const shim = [
    'if [ "$1 $2 $3 $4" = "rev-parse --verify --quiet refs/heads/keiyaku-state" ]; then',
    '  echo "discovery read unavailable" >&2',
    "  exit 2",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const unavailable = await withGitShim(shim, {}, async (gitPath) =>
    Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({}),
  );
  assert.equal(unavailable.kind, "world-observation-failed");
  assert.match(unavailable.diagnostic, /discovery read unavailable/u);
  const before = await readGitPaths(git, contractJournalPaths(second));
  const corrupt = await writeBlob(git, "corrupt later journal\n");
  const tree = await updateGitTree(git, before.tree, new Map([[contractJournalPath(second), { oid: corrupt }]]));
  const commit = await writeCommit({ repository: git, tree, parent: before.commit });
  repository.run(["update-ref", GIT_REF, commit, before.commit!]);
  await assert.rejects(contracts.reconcile({}), { category: "authority-corruption" });
  assert.equal((await readPlaceRegister(git)).has(first), false);
  assert.equal(existsSync(join(repository.path, ".keiyaku", "wt")), false);
});

test("world reconcile preserves earlier Contract effects when later authority is corrupt", async () => {
  const repository = repositoryWithMain();
  const ids = [await bind(repository, "First repair"), await bind(repository, "Second repair")];
  const git = await repositoryAt(repository.path);
  const blob = await writeBlob(git, "not a state commit");
  const marker = join(git.commonDirectory, "worktree-created");
  const shim = [
    'if [ "$1 $2" = "worktree add" ]; then',
    '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
    '  : > "$KEIYAKU_MARKER"',
    "  exit 0",
    "fi",
    'if [ "$1 $2 $3 $4" = "rev-parse --verify --quiet refs/heads/keiyaku-state" ] && [ -e "$KEIYAKU_MARKER" ]; then',
    '  printf "%s\\n" "$KEIYAKU_BLOB"',
    "  exit 0",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  await withGitShim(shim, { KEIYAKU_MARKER: marker, KEIYAKU_BLOB: blob }, async (gitPath) => {
    const repo = await Repo.at({ path: repository.path, gitPath });
    await assert.rejects(Keis.of(repo).reconcile({}), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "authority-corruption");
      const outcome = error.outcome;
      assert.ok(outcome?.kind === "world");
      assert.equal(outcome.contracts?.length, 1);
      const first = outcome.contracts?.[0];
      assert.ok(first?.contractId && ids.includes(first.contractId));
      const repaired = first.effects?.filter((effect) => effect.kind === "worktree-created");
      assert.equal(repaired?.length, 1);
      const creation = repaired?.[0];
      assert.ok(creation?.kind === "worktree-created");
      assert.ok(existsSync(join(creation.path, ".keiyaku", "KEIYAKU.md")));
      return true;
    });
  });
  assert.equal((await readPlaceRegister(git)).size, 1);
});

test("repo reconcile leaves a refused foreign worktree untouched until recovery realizes it", async () => {
  const repository = repositoryWithMain();
  const id = await bind(repository, "Recover foreign worktree");
  const git = await repositoryAt(repository.path);
  await appointManagedWorktrees(git, [id]);
  const path = await appointedWorktreePath(git, id);
  const guidance = join(path, ".keiyaku", "KEIYAKU.md");
  const foreignBytes = "foreign guidance\n";
  mkdirSync(join(path, ".keiyaku"), { recursive: true });
  writeFileSync(guidance, foreignBytes);
  writeFileSync(join(path, "foreign.txt"), "foreign bytes\n");

  const scope = await scopeOperation({ coordinate: repository.path });
  const refused = await withGitDecodeChannel(
    scope,
    async (channel) =>
      await completeRepoReconcile({
        scope,
        channel,
        hooks: { create: [], destroy: [] },
        retryHooks: false,
        accumulator: new InvocationAccumulator(),
      }),
  );
  assert.ok(refused.kind === "world");
  const issue = refused.contracts?.[0]?.issues?.[0];
  assert.equal(issue?.kind, "reconcile-failed");
  assert.equal(readFileSync(guidance, "utf8"), foreignBytes);
  assert.equal(readFileSync(join(path, "foreign.txt"), "utf8"), "foreign bytes\n");
  assert.equal(existsSync(join(path, ".agents")), false);

  const foreignPath = `${path}-foreign`;
  renameSync(path, foreignPath);
  const recovered = await withGitDecodeChannel(
    scope,
    async (channel) =>
      await completeRepoReconcile({
        scope,
        channel,
        hooks: { create: [], destroy: [] },
        retryHooks: false,
        accumulator: new InvocationAccumulator(),
      }),
  );
  assert.ok(recovered.kind === "world");
  assert.equal(recovered.contracts?.[0]?.issues, undefined);
  assert.match(readFileSync(guidance, "utf8"), new RegExp(id));
  assert.equal(readFileSync(join(foreignPath, ".keiyaku", "KEIYAKU.md"), "utf8"), foreignBytes);
  assert.equal(readFileSync(join(foreignPath, "foreign.txt"), "utf8"), "foreign bytes\n");
});
