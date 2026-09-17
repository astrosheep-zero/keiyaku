import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appointManagedWorktrees } from "../src/workspace-place.js";
import { appointedWorktreePath, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { readBlob, readGit, repositoryAt, updateGitTree, writeBlob, writeCommit } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { contractJournalPath } from "../src/git/identity.js";
import { bindOperation } from "../src/protocol/bind.js";
import { completeRepoReconcile } from "../src/library/reconcile.js";
import { contractObservationOperation, contractsOperation, scopeOperation } from "../src/protocol/operations.js";
import { changeId, entryUlid, snapshotId, type ContractId, type JournalEntry } from "../src/core/facts/types.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import { protocolContractId } from "./support/git.js";

function firstJournalAt(repository: TestGitRepository, id: ContractId): string {
  const path = contractJournalPath(id, "active");
  const first = JSON.parse(repository.run(["show", `refs/heads/keiyaku-state:${path}`]).split("\n", 1)[0]!) as {
    at: string;
  };
  return first.at;
}

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
  return { document: document.document, segments: document.segments, gates: [], after };
}

async function bind(
  repository: TestGitRepository,
  title: string,
  workspace: "worktree",
  after: readonly ContractId[] = [],
): Promise<ContractId> {
  const scope = await scopeOperation({ coordinate: repository.path });
  const result = await withGitDecodeChannel(scope, (channel) =>
    bindOperation({
      scope,
      channel,
      contractId: protocolContractId(title),
      terms: terms(title, after),
      verification: { kind: "prepared", data: null },
      workspace,
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
    waiting: await bind(repository, "Phase waiting", "worktree"),
    bound: await bind(repository, "Phase bound", "worktree"),
    tendered: await bind(repository, "Phase tendered", "worktree"),
    claimed: await bind(repository, "Phase claimed", "worktree"),
    abandoned: await bind(repository, "Phase abandoned", "worktree"),
  };
  const times = {
    waiting: firstJournalAt(repository, ids.waiting),
    bound: "2026-08-12T00:01:00.000Z",
    tendered: "2026-08-12T00:02:00.000Z",
    claimed: "2026-08-12T00:03:00.000Z",
    abandoned: "2026-08-12T00:04:00.000Z",
  };
  const git = await repositoryAt(repository.path);
  const before = await readGit(git);
  if (before.commit === null) throw new Error("Keiyaku state was not published");
  const snapshot = snapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  const boundEntry = (id: ContractId, at: string, entry: string): JournalEntry => ({
    v: 1,
    kind: "bound",
    contract: id,
    entry: entryUlid(entry),
    at,
    data: {},
  });
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
  const tenderedDelivery = deliverEntry(ids.tendered, times.tendered, "01ARZ3NDEKTSV4RRFFQ69G5FBC");
  const claimedDelivery = deliverEntry(ids.claimed, "2026-08-12T00:02:30.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBD");
  const additions = new Map<ContractId, readonly JournalEntry[]>([
    [ids.bound, [boundEntry(ids.bound, times.bound, "01ARZ3NDEKTSV4RRFFQ69G5FBB")]],
    [
      ids.tendered,
      [boundEntry(ids.tendered, "2026-08-12T00:01:30.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBE"), tenderedDelivery],
    ],
    [
      ids.claimed,
      [
        boundEntry(ids.claimed, "2026-08-12T00:01:45.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBF"),
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
    [ids.waiting, "waiting", times.waiting],
    [ids.bound, "bound", times.bound],
    [ids.tendered, "tendered", times.tendered],
    [ids.claimed, "claimed", times.claimed],
    [ids.abandoned, "abandoned", times.abandoned],
  ] as const;
  const scope = await scopeOperation({ coordinate: repository.path });
  for (const [id, phase, phaseAt] of expected) {
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
    assert.equal(observed.row.phaseAt, phaseAt);
  }
  const board = await withGitDecodeChannel(scope, (channel) =>
    contractsOperation({
      scope,
      channel,
    }),
  );
  const tendered = board.rows.find((row) => row.id === ids.tendered);
  assert.equal(tendered?.phase, "tendered");
  assert.equal(JSON.parse(JSON.stringify(tendered)).phase, "tendered");
  const catalog = renderCatalogText({
    kind: "contracts",
    root: board.root,
    state: board.state,
    observedAt: board.observedAt,
    rows: board.rows,
    hasMore: false,
  });
  assert.match(catalog, new RegExp(`${ids.tendered} · tendered · .* · Phase tendered`, "u"));
});

test("repo reconcile leaves a refused foreign worktree untouched until recovery realizes it", async () => {
  const repository = repositoryWithMain();
  const id = await bind(repository, "Recover foreign worktree", "worktree");
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
  assert.ok(refused.kind === "completed", 'expected refused.kind = "completed"');
  assert.equal(refused.contracts[0]?.report.lag[0]?.kind, "reconcile-failed");
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
  assert.ok(recovered.kind === "completed", 'expected recovered.kind = "completed"');
  assert.deepEqual(recovered.contracts[0]?.report.lag, []);
  assert.match(readFileSync(guidance, "utf8"), new RegExp(id));
  assert.equal(readFileSync(join(foreignPath, ".keiyaku", "KEIYAKU.md"), "utf8"), foreignBytes);
  assert.equal(readFileSync(join(foreignPath, "foreign.txt"), "utf8"), "foreign bytes\n");
});
