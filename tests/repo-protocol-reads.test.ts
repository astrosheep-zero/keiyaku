import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appointManagedWorktrees } from "../src/workspace-place.js";
import { appointedWorktreePath, type TestGitRepository } from "./support/git.js";
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
import { readContractCount, readContractMembership, readContractObservation } from "../src/protocol/read/status.js";
import { Keis, Repo, kanshiCounts } from "../src/index.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { observeNamedAddress, resolveNamedAddress } from "../src/library/address.js";
import { contractJournalPath, contractJournalPaths } from "../src/git/identity.js";
import { prepareVerificationDeclaration } from "../src/verification/declaration.js";
import { bindOperation } from "../src/protocol/bind.js";
import { completeRepoReconcile } from "../src/library/reconcile.js";
import {
  contractCatalogueOperation,
  contractObservationOperation,
  contractsOperation,
  scopeOperation,
} from "../src/protocol/operations.js";
import { changeId, entryUlid, snapshotId, type ContractId, type JournalEntry } from "../src/core/facts/types.js";
import { renderContractCatalogue } from "../src/cli/render/catalog.js";
import { protocolContractId } from "./support/git.js";

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
  return result.value.contractId;
}

test("git repository resolution rejects omitted and empty coordinates", async () => {
  await assert.rejects(Reflect.apply(repositoryAt, undefined, []), /repository path must be a nonempty string/);
  await assert.rejects(repositoryAt(""), /repository path must be a nonempty string/);
});

test("public Contract rows select the source entry for every phase", async () => {
  const repository = repositoryWithMain();
  const ids = {
    fresh: await bind(repository, "Phase fresh"),
    bound: await bind(repository, "Phase bound"),
    delivered: await bind(repository, "Phase delivered"),
    claimed: await bind(repository, "Phase claimed"),
    abandoned: await bind(repository, "Phase abandoned"),
  };
  const times = {
    delivered: "2026-08-12T00:02:00.000Z",
    claimed: "2026-08-12T00:03:00.000Z",
    abandoned: "2026-08-12T00:04:00.000Z",
  };
  const git = await repositoryAt(repository.path);
  const before = await readGitPaths(git, Object.values(ids).flatMap(contractJournalPaths));
  if (before.commit === null) throw new Error("Keiyaku state was not published");
  const snapshot = snapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  const deliverEntry = (id: ContractId, at: string, entry: string): JournalEntry => ({
    v: 1,
    kind: "deliver",
    contract: id,
    entry: entryUlid(entry),
    at,
    data: {
      tenderSnapshot: snapshot,
      integration: { predecessor: snapshot, snapshot, changeId: changeId(`change-${id}`) },
      method: "squash",
      policy: { requireBranchesToBeUpToDate: false },
    },
  });
  const deliveredDelivery = deliverEntry(ids.delivered, times.delivered, "01ARZ3NDEKTSV4RRFFQ69G5FBC");
  const claimedDelivery = deliverEntry(ids.claimed, "2026-08-12T00:02:30.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBD");
  const additions = new Map<ContractId, readonly JournalEntry[]>([
    [
      ids.bound,
      [
        {
          v: 1,
          kind: "amend",
          contract: ids.bound,
          entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBN"),
          at: times.delivered,
          data: terms("Phase bound", [ids.claimed, ids.delivered, ids.abandoned, protocolContractId("Missing")]),
        },
      ],
    ],
    [ids.delivered, [deliveredDelivery]],
    [
      ids.claimed,
      [
        claimedDelivery,
        {
          v: 1,
          kind: "claimed",
          contract: ids.claimed,
          entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBG"),
          at: times.claimed,
          data: { delivery: claimedDelivery.entry },
        },
      ],
    ],
    [
      ids.abandoned,
      [
        {
          v: 1,
          kind: "abandoned",
          contract: ids.abandoned,
          entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBH"),
          at: times.abandoned,
          data: {},
        },
      ],
    ],
  ]);
  const updates = new Map<string, { oid: string } | null>();
  for (const [id, entries] of additions) {
    const activePath = contractJournalPath(id, "active");
    const active = before.paths.get(activePath);
    if (active?.type !== "blob") throw new Error(`missing active journal for ${id}`);
    const oid = await writeBlob(
      git,
      Buffer.concat([await readBlob(git, active.oid), ...entries.map((entry) => Buffer.from(encodeEntry(entry)))]),
    );
    const terminal = entries.at(-1)?.kind === "claimed" || entries.at(-1)?.kind === "abandoned";
    if (terminal) {
      updates.set(activePath, null);
      updates.set(contractJournalPath(id, "terminal"), { oid });
    } else updates.set(activePath, { oid });
  }
  const tree = await updateGitTree(git, before.tree, updates);
  const commit = await writeCommit({ repository: git, tree, parent: before.commit });
  repository.run(["update-ref", "refs/heads/keiyaku-state", commit, before.commit]);

  const expected = [
    [ids.fresh, "bound"],
    [ids.bound, "bound"],
    [ids.delivered, "bound"],
    [ids.claimed, "claimed"],
    [ids.abandoned, "abandoned"],
  ] as const;
  const scope = await scopeOperation({ coordinate: repository.path });
  for (const [id, phase] of expected) {
    const observed = await withGitDecodeChannel(scope, (channel) =>
      contractObservationOperation({
        scope,
        channel,
        contractId: id,
      }),
    );
    assert.equal(observed.kind, "present");
    if (observed.kind !== "present") continue;
    assert.equal(observed.row.phase, phase);
  }
  const detailed = await withGitDecodeChannel(scope, (channel) =>
    withGitReadObservation(scope, channel, (observation) => readContractObservation(observation, ids.bound)),
  );
  assert.equal(detailed.kind, "present");
  if (detailed.kind === "present")
    assert.deepEqual(detailed.row.after, [
      { contractId: ids.delivered, state: "active" },
      { contractId: ids.abandoned, state: "abandoned" },
      { contractId: protocolContractId("Missing"), state: "missing" },
    ]);
  const membership = await withGitDecodeChannel(scope, (channel) =>
    contractsOperation({
      scope,
      channel,
    }),
  );
  const delivered = membership.find((row) => row.id === ids.delivered);
  assert.equal(delivered?.phase, "bound");
  assert.equal(JSON.parse(JSON.stringify(delivered)).phase, "bound");
  const catalogue = await withGitDecodeChannel(scope, (channel) => contractCatalogueOperation({ scope, channel }));
  const catalog = renderContractCatalogue(catalogue);
  assert.match(catalog, new RegExp(`${ids.delivered} · [^\\n]+ · Phase delivered`, "u"));
  const current = await readGitPaths(git, contractJournalPaths(ids.claimed));
  const corrupt = await writeBlob(git, "corrupt prerequisite\n");
  const corruptTree = await updateGitTree(
    git,
    current.tree,
    new Map([[contractJournalPath(ids.claimed, "terminal"), { oid: corrupt }]]),
  );
  const corruptCommit = await writeCommit({ repository: git, tree: corruptTree, parent: current.commit });
  repository.run(["update-ref", GIT_REF, corruptCommit, current.commit!]);
  const unchanged = await withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel }));
  assert.deepEqual(unchanged, membership, "contextual membership never expands prerequisite journals");
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
  assert.deepEqual((await kanshiCounts({ world: null, repo })).contracts, { kind: "present", value: 2 });
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
  assert.deepEqual((await kanshiCounts({ world: null, repo })).contracts, { kind: "present", value: 2 });
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
  assert.equal((await kanshiCounts({ world: null, repo })).contracts.kind, "failed");
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
      await completeRepoReconcile({ scope, channel, hooks: { create: [], destroy: [] }, retryHooks: false }),
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
      await completeRepoReconcile({ scope, channel, hooks: { create: [], destroy: [] }, retryHooks: false }),
  );
  assert.ok(recovered.kind === "world");
  assert.equal(recovered.contracts?.[0]?.issues, undefined);
  assert.match(readFileSync(guidance, "utf8"), new RegExp(id));
  assert.equal(readFileSync(join(foreignPath, ".keiyaku", "KEIYAKU.md"), "utf8"), foreignBytes);
  assert.equal(readFileSync(join(foreignPath, "foreign.txt"), "utf8"), "foreign bytes\n");
});
