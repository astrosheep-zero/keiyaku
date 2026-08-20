import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { appointManagedWorktrees } from "../src/workspace-place.js";
import { appointedWorktreePath, type TestGitRepository, withGitShim } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import {
  readBlob,
  readGit,
  repositoryAt,
  updateGitTree,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { contractJournalPath } from "../src/git/identity.js";
import { bindOperation } from "../src/protocol/bind.js";
import { reconcileAllOperation, worldContractStates } from "../src/protocol/reconcile.js";
import {
  contractObservationOperation,
  contractsOperation,
  scopeOperation,
} from "../src/protocol/operations.js";
import {
  changeId,
  contractIdFromSegment,
  entryUlid,
  snapshotId,
  type ContractId,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { fitIdentityStem, normalizeIdentityStem } from "../src/identity/normalize.js";


function firstJournalAt(repository: TestGitRepository, id: ContractId): string {
  const path = contractJournalPath(id, "active");
  const first = JSON.parse(repository.run(["show", `refs/heads/keiyaku-state:${path}`]).split("\n", 1)[0]!) as { at: string };
  return first.at;
}

function hereWorkspace(scope: Awaited<ReturnType<typeof scopeOperation>>) {
  return async () => ({ kind: "appointed" as const, path: scope.effectiveCwd });
}

function terms(title: string) {
  const document = decodeContractDocument([
    `# ${title}`,
    "",
    "## Context",
    "Exercise the repository-level protocol reads.",
    "",
    "## Objective",
    "Expose one pinned scope and snapshot-backed status.",
    "",
    "## Design",
    "The protocol owns git observation and effects.",
    "",
    "## Region",
    "```",
    "src/**",
    "```",
    "",
    "## Criteria",
    "### Protocol result",
    "The operation returns only plain data.",
    "",
  ].join("\n"));
  return { document: document.document, segments: document.segments, gates: [], after: [] };
}

function protocolContractId(title: string): ContractId {
  return contractIdFromSegment(fitIdentityStem({
    stem: normalizeIdentityStem({ source: title }) || "contract",
    maxBytes: 48,
  }));
}

async function bind(repository: TestGitRepository, title: string, workspace: "worktree" | "here"): Promise<ContractId> {
  const scope = await scopeOperation({ coordinate: repository.path });
  const result = await withGitDecodeChannel(scope, (channel) => bindOperation({
    scope,
    channel,
    contractId: protocolContractId(title),
    terms: terms(title),
    verification: { kind: "prepared", data: null },
    workspace,
  }));
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind did not succeed");
  return result.value.contractId;
}

test("git repository resolution rejects omitted and empty coordinates", async () => {
  await assert.rejects(Reflect.apply(repositoryAt, undefined, []), /repository path must be a nonempty string/);
  await assert.rejects(repositoryAt(""), /repository path must be a nonempty string/);
});

test("Contract board keeps an absent Keiyaku state snapshot explicit", async () => {
  const repository = repositoryWithMain();
  const scope = await scopeOperation({ coordinate: repository.path });
  const report = await withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel }));
  assert.equal(report.state, null);
  assert.deepEqual(report.rows, []);
});

test("Contract reads return plain pinned data from one git snapshot", async () => {
  const repository = repositoryWithMain();
  const first = await bind(repository, "First status row", "here");
  const second = await bind(repository, "Second status row", "worktree");
  const scope = await scopeOperation({ coordinate: repository.path });
  const log = resolve(tmpdir(), `keiyaku-status-blob-reads-${process.pid}.log`);
  writeFileSync(log, "");

  const report = await withGitShim(
    [
      "for argument do",
      "  case \"$argument\" in *'^{tree}'*) exit 97 ;; esac",
      "done",
      "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_STATUS_READ_LOG\"; fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_STATUS_READ_LOG: log },
    () => withGitDecodeChannel(scope, (channel) => contractsOperation({
      scope, channel, hereWorkspace: hereWorkspace(scope),
    })),
  );
  const git = await repositoryAt(repository.path);

  assert.equal(report.rows.length, 2);
  assert.equal(scope.effectiveCwd, resolve(repository.path));
  assert.equal(scope.primaryWorktree, git.primaryWorktree);
  assert.equal(git.effectiveCwd, resolve(repository.path));
  assert.equal(report.root, git.primaryWorktree);
  assert.equal(report.state, (await readGit(git)).commit);
  const zeros = { staged: 0, unstaged: 0, untracked: 0, submodules: 0 };
  assert.deepEqual(report.rows.find((contract) => contract.id === first), {
    id: first,
    title: "First status row",
    phase: "waiting",
    phaseAt: firstJournalAt(repository, first),
    disposition: "active",
    workspace: "here",
    worktreePath: null,
    workspaceObservation: { kind: "clean", location: { kind: "here" }, counts: zeros },
    target: null,
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    gates: { reports: [], satisfied: true },
  });
  assert.deepEqual(report.rows.find((contract) => contract.id === second), {
    id: second,
    title: "Second status row",
    phase: "waiting",
    phaseAt: firstJournalAt(repository, second),
    disposition: "active",
    workspace: "worktree",
    worktreePath: null,
    workspaceObservation: { kind: "unappointed" },
    target: null,
    targetLag: { kind: "none" },
    delivery: null,
    targetObservation: null,
    gates: { reports: [], satisfied: true },
  });
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 0);

  assert.deepEqual(await withGitDecodeChannel(scope, (channel) => contractObservationOperation({
    scope,
    channel,
    contractId: first,
    hereWorkspace: hereWorkspace(scope),
  })), {
    kind: "present",
    row: report.rows.find((contract) => contract.id === first),
  });
});

test("public Contract rows select the source entry for every phase", async () => {
  const repository = repositoryWithMain();
  const ids = {
    waiting: await bind(repository, "Phase waiting", "here"),
    bound: await bind(repository, "Phase bound", "here"),
    pending: await bind(repository, "Phase pending", "here"),
    claimed: await bind(repository, "Phase claimed", "here"),
    abandoned: await bind(repository, "Phase abandoned", "here"),
  };
  const times = {
    waiting: firstJournalAt(repository, ids.waiting),
    bound: "2026-08-12T00:01:00.000Z",
    pending: "2026-08-12T00:02:00.000Z",
    claimed: "2026-08-12T00:03:00.000Z",
    abandoned: "2026-08-12T00:04:00.000Z",
  };
  const git = await repositoryAt(repository.path);
  const before = await readGit(git);
  if (before.commit === null) throw new Error("Keiyaku state was not published");
  const snapshot = snapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  const boundEntry = (id: ContractId, at: string, entry: string): JournalEntry => ({
    v: 1, kind: "bound", contract: id, entry: entryUlid(entry), at, data: {},
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
  const pendingDelivery = deliverEntry(ids.pending, times.pending, "01ARZ3NDEKTSV4RRFFQ69G5FBC");
  const claimedDelivery = deliverEntry(ids.claimed, "2026-08-12T00:02:30.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBD");
  const additions = new Map<ContractId, readonly JournalEntry[]>([
    [ids.bound, [boundEntry(ids.bound, times.bound, "01ARZ3NDEKTSV4RRFFQ69G5FBB")]],
    [ids.pending, [boundEntry(ids.pending, "2026-08-12T00:01:30.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBE"), pendingDelivery]],
    [ids.claimed, [
      boundEntry(ids.claimed, "2026-08-12T00:01:45.000Z", "01ARZ3NDEKTSV4RRFFQ69G5FBF"),
      claimedDelivery,
      {
        v: 1, kind: "claimed", contract: ids.claimed,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBG"), at: times.claimed,
        data: { delivery: claimedDelivery.entry },
      },
    ]],
    [ids.abandoned, [{
      v: 1, kind: "abandoned", contract: ids.abandoned,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBH"), at: times.abandoned, data: {},
    }]],
  ]);
  const updates = new Map<string, { oid: string } | null>();
  for (const [id, entries] of additions) {
    const activePath = contractJournalPath(id, "active");
    const active = before.paths.get(activePath);
    if (active?.type !== "blob") throw new Error(`missing active journal for ${id}`);
    const oid = await writeBlob(git, Buffer.concat([
      await readBlob(git, active.oid),
      ...entries.map((entry) => Buffer.from(encodeEntry(entry))),
    ]));
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
    [ids.pending, "pending-delivery", times.pending],
    [ids.claimed, "claimed", times.claimed],
    [ids.abandoned, "abandoned", times.abandoned],
  ] as const;
  const scope = await scopeOperation({ coordinate: repository.path });
  for (const [id, phase, phaseAt] of expected) {
    const observed = await withGitDecodeChannel(scope, (channel) => contractObservationOperation({
      scope, channel, contractId: id, hereWorkspace: hereWorkspace(scope),
    }));
    assert.equal(observed.kind, "present");
    if (observed.kind !== "present") continue;
    assert.equal(observed.row.phase, phase);
    assert.equal(observed.row.phaseAt, phaseAt);
  }
});

test("single Contract observation never combines state and target from different epochs", async () => {
  const repository = repositoryWithMain();
  repository.run(["branch", "target"]);
  repository.run(["checkout", "--quiet", "target"]);
  const targetBefore = repository.run(["rev-parse", "refs/heads/target"]).trim();
  const scope = await scopeOperation({ coordinate: repository.path });
  const contract = await withGitDecodeChannel(scope, (channel) => bindOperation({
    scope,
    channel,
    contractId: protocolContractId("Frozen observation"),
    terms: terms("Frozen observation"),
    verification: { kind: "prepared", data: null },
    workspace: "here",
    target: "refs/heads/target",
  }));
  assert.equal(contract.kind, "accepted");
  if (contract.kind !== "accepted") throw new Error("bind did not succeed");
  const id = contract.value.contractId;
  const git = await repositoryAt(repository.path);
  const before = await readGit(git);
  const activePath = contractJournalPath(id, "active");
  const active = before.paths.get(activePath);
  if (active?.type !== "blob" || before.commit === null) throw new Error("active Contract journal was not published");
  const abandoned: JournalEntry = {
    v: 1,
    kind: "abandoned",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    at: "2026-08-13T00:00:00Z",
    data: {},
  };
  const terminalBlob = await writeBlob(git, Buffer.concat([await readBlob(git, active.oid), Buffer.from(encodeEntry(abandoned))]));
  const terminalTree = await updateGitTree(git, before.tree, new Map([
    [activePath, null],
    [contractJournalPath(id, "terminal"), { oid: terminalBlob }],
  ]));
  const terminalCommit = await writeCommit({ repository: git, tree: terminalTree, parent: before.commit });
  const targetTree = repository.run(["rev-parse", `${targetBefore}^{tree}`]).trim();
  const movedTarget = await writeCommit({ repository: git, tree: targetTree, parent: targetBefore });
  const firstRead = join(tmpdir(), `keiyaku-first-state-read-${process.pid}`);
  const moved = join(tmpdir(), `keiyaku-moved-state-${process.pid}`);
  const result = await withGitShim([
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$4" = "refs/heads/keiyaku-state" ]; then',
    '  if [ -e "$KEIYAKU_FIRST_READ" ] && [ ! -e "$KEIYAKU_MOVED" ]; then',
    '    touch "$KEIYAKU_MOVED"',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$KEIYAKU_TERMINAL" "$KEIYAKU_CURRENT"',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/target "$KEIYAKU_TARGET_MOVED" "$KEIYAKU_TARGET_BEFORE"',
    '  else touch "$KEIYAKU_FIRST_READ"; fi',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), {
    KEIYAKU_FIRST_READ: firstRead,
    KEIYAKU_MOVED: moved,
    KEIYAKU_TERMINAL: terminalCommit,
    KEIYAKU_CURRENT: before.commit,
    KEIYAKU_TARGET_MOVED: movedTarget,
    KEIYAKU_TARGET_BEFORE: targetBefore,
  }, () => withGitDecodeChannel(git, (channel) => contractObservationOperation({
    scope,
    channel,
    contractId: id,
    hereWorkspace: hereWorkspace(scope),
  })));

  assert.deepEqual(result, {
    kind: "present",
    row: {
      id,
      title: "Frozen observation",
      phase: "waiting",
      phaseAt: firstJournalAt(repository, id),
      disposition: "active",
      workspace: "here",
      worktreePath: null,
      workspaceObservation: {
        kind: "clean",
        location: { kind: "here" },
        counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 },
      },
      target: "refs/heads/target",
      targetLag: { kind: "counted", behind: 0 },
      delivery: null,
      targetObservation: { head: targetBefore, drift: false },
      gates: { reports: [], satisfied: true },
    },
  });
});

test("batch reconcile isolates a failed contract and retains successful reports", async () => {
  const repository = repositoryWithMain();
  const blocked = await bind(repository, "Blocked reconcile", "worktree");
  const healthy = await bind(repository, "Healthy reconcile", "worktree");
  const git = await repositoryAt(repository.path);
  const appointed = await appointManagedWorktrees(git, [blocked, healthy]);
  const places = new Map(appointed.appointments.map((appointment) => [appointment.contract, appointment.place]));
  mkdirSync(await appointedWorktreePath(git, blocked), { recursive: true });

  const scope = await scopeOperation({ coordinate: repository.path });
  const report = await withGitDecodeChannel(scope, async (channel) => reconcileAllOperation({
    scope,
    channel,
    states: await worldContractStates({ scope, channel }),
    hooks: { create: [], destroy: [] },
    retryHooks: false,
    places,
  }));
  assert.equal(report.contracts.length, 2);

  const failed = report.contracts.find((contract) => contract.contractId === blocked);
  assert.equal(failed?.report.lag[0]?.kind, "reconcile-failed");
  if (failed?.report.lag[0]?.kind === "reconcile-failed") {
    assert.equal(failed.report.lag[0].stage, "effect");
    assert.match(failed.report.lag[0].diagnostic, /delivery worktree path is occupied/);
  }

  const reconciled = report.contracts.find((contract) => contract.contractId === healthy);
  assert.deepEqual(reconciled?.report.lag, []);
  assert.equal(existsSync(await appointedWorktreePath(git, healthy)), true);
});
