import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { deliveryWorktreePath } from "../src/git/workspace.js";
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
import {
  bindOperation,
  contractObservationOperation,
  contractsOperation,
  reconcileAllOperation,
  scopeOperation,
} from "../src/protocol/operations.js";
import { entryUlid, type ContractId, type JournalEntry } from "../src/core/facts/types.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
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

async function bind(repository: TestGitRepository, title: string, workspace: "worktree" | "here"): Promise<ContractId> {
  const scope = await scopeOperation({ coordinate: repository.path });
  const result = await withGitDecodeChannel(scope, (channel) => bindOperation({
    scope,
    channel,
    title,
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
  const log = resolve(repository.path, "status-blob-reads.log");
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
    () => withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel })),
  );
  const git = await repositoryAt(repository.path);

  assert.equal(report.rows.length, 2);
  assert.equal(scope.effectiveCwd, resolve(repository.path));
  assert.equal(scope.primaryWorktree, git.primaryWorktree);
  assert.equal(git.effectiveCwd, resolve(repository.path));
  assert.equal(report.root, git.primaryWorktree);
  assert.equal(report.state, (await readGit(git)).commit);
  assert.deepEqual(report.rows.find((contract) => contract.id === first), {
    id: first,
    phase: "waiting",
    disposition: "active",
    workspace: "here",
    worktreePath: null,
    target: null,
    delivery: null,
    targetObservation: null,
    gates: { reports: [], satisfied: true },
  });
  assert.deepEqual(report.rows.find((contract) => contract.id === second), {
    id: second,
    phase: "waiting",
    disposition: "active",
    workspace: "worktree",
    worktreePath: deliveryWorktreePath(git, second),
    target: null,
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
  })), {
    kind: "present",
    row: report.rows.find((contract) => contract.id === first),
  });
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
    title: "Frozen observation",
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
  const firstRead = join(repository.path, "first-state-read");
  const moved = join(repository.path, "moved-state");
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
  })));

  assert.deepEqual(result, {
    kind: "present",
    row: {
      id,
      phase: "waiting",
      disposition: "active",
      workspace: "here",
      worktreePath: null,
      target: "refs/heads/target",
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
  mkdirSync(deliveryWorktreePath(git, blocked), { recursive: true });

  const scope = await scopeOperation({ coordinate: repository.path });
  const report = await withGitDecodeChannel(scope, (channel) => reconcileAllOperation({
    scope,
    channel,
    hooks: { create: [], destroy: [] },
    retryHooks: false,
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
  assert.equal(existsSync(deliveryWorktreePath(git, healthy)), true);
});
