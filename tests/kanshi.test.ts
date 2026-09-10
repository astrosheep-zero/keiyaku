import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import { breakBody, HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { parseArgv as parseInvocation, type ParsedExecution } from "../src/cli/parse.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { contractId, contractSegment } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { contractJournalPath } from "../src/git/identity.js";
import {
  GIT_FORMAT_PATH,
  GIT_REF,
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { observeTargetLag } from "../src/git/workspace.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import { Keiyaku, Repo } from "../src/index.js";
import { kanshi, selectKanshi, type ContractKanshiRow } from "../src/kanshi/index.js";
import { projectTaskBoardObservation } from "../src/task/board.js";
import { contractNamespace } from "../src/task/identity.js";
import { Tasks } from "../src/task/index.js";
import { authorityPath, readBoard } from "../src/task/store.js";
import type { WorldRoot } from "../src/world.js";
import { World } from "../src/world.js";
import { makeGitRepository, withGitShim } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import { taskDocument, writeTaskAuthority } from "./support/task.js";

function parseArgv(argv: readonly string[]): ParsedExecution {
  const parsed = parseInvocation(argv);
  if ("help" in parsed) throw new Error("expected executable command");
  return parsed;
}

async function invoke(
  invocation: Parameters<typeof invokeRaw>[0],
  runtime?: Parameters<typeof invokeRaw>[1],
): Promise<InvocationResult> {
  return (await invokeRaw(invocation, runtime)) as InvocationResult;
}

async function observe(path: string, repo?: Repo) {
  return kanshi({ world: await World.at(path), ...(repo === undefined ? {} : { repo }) });
}

function document(title = "Kanshi contract"): string {
  return contractMarkdown(title, {
    Context: "status",
    Objective: "render",
    Design: "project public values",
    Region: "```\nsrc/**\n```",
    Criteria: "### Visible\nThe status row is visible.\n",
  });
}

async function bornAkuma(root: string, suffix: string, createdAt = "2026-08-09T00:00:00.000Z", settle = false) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "watcher", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, {
    id: allocated.id,
    archetype: "watcher",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    allowed: [],
    cwd: root,
    origin: { kind: "direct" },
    createdAt,
  });
  if (settle) {
    const body = await leash.recordBody(allocated.paths, { leashTakenAt: createdAt });
    await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: createdAt });
  }
  leash.release();
  return allocated.id;
}

function fixtureRoot(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureRepository(t: TestContext) {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  return repository;
}

async function populatedWorld(t: TestContext) {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const tasks = Tasks.of(await World.at(repository.path));
  const added = await tasks.add({ title: "Render status", priority: 0 });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") throw new Error("task add failed");
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    task: added.value.id,
    markdown: document(),
    workspace: "worktree",
    target: "main",
  });
  const contract = await bound.keiyaku.state();
  const renamed = await tasks.task({ id: added.value.id }).update({ title: "Investigate status rendering" });
  assert.equal(renamed.kind, "accepted");
  await tasks.task({ id: added.value.id }).start();
  const akumaId = await bornAkuma(repository.path, "a0000001");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akuId: akumaId,
        contractId: contract.id,
      })
    ).kind,
    "dispatched",
  );
  await moveAlias({ world: repository.path as WorldRoot, alias: "@watch" as AkumaAlias, akuId: akumaId });
  return { repository, contract, keiyaku: bound.keiyaku, taskId: added.value.id, akumaId };
}

async function publishNewerActiveContractCopies(
  repository: ReturnType<typeof makeGitRepository>,
  sourceId: string,
): Promise<void> {
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const source = repository.run(["show", `${GIT_REF}:${contractJournalPath(sourceId as never)}`]);
  const ids = Array.from({ length: 11 }, (_, index) => `kei/omitted-associated-${String(index).padStart(2, "0")}`);
  const entries = await Promise.all(
    ids.map(async (id) => {
      const journal = JSON.parse(source) as { contract: string; at: string };
      journal.contract = id;
      journal.at = "2099-01-01T00:00:00.000Z";
      return [contractJournalPath(id as never), { oid: await writeBlob(git, `${JSON.stringify(journal)}\n`) }] as const;
    }),
  );
  const tree = await updateGitTree(git, snapshot.tree, new Map(entries));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
}

function gitInvocations(path: string): readonly string[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

function deleteLooseObject(repository: ReturnType<typeof makeGitRepository>, oid: string): void {
  unlinkSync(join(repository.path, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
}

test("named status resolves its address from the initial observation before the selected read", async (t) => {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo, markdown: document("Barrier"), workspace: "worktree" });
  await bound.keiyaku.reconcile();
  const contract = await bound.keiyaku.state();
  const activeRow = (await Keiyaku.list({ repo })).rows.find((row) => row.id === contract.id);
  assert.equal(activeRow?.disposition, "active");
  assert.equal(activeRow?.workspace, "worktree");
  assert.notEqual(activeRow?.worktreePath, null);
  const active = repository.run(["rev-parse", GIT_REF]).trim();
  await bound.keiyaku.abandon();
  const terminal = repository.run(["rev-parse", GIT_REF]).trim();
  repository.run(["update-ref", GIT_REF, active, terminal]);
  await bound.keiyaku.reconcile();
  const marker = join(repository.path, "named-status-barrier");

  const result = await withGitShim(
    [
      'if [ "$*" = "rev-parse --verify --quiet refs/heads/keiyaku-state" ] && [ ! -e "$KEIYAKU_BARRIER_MARKER" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$KEIYAKU_TERMINAL_OID" "$KEIYAKU_ACTIVE_OID"',
      '  : > "$KEIYAKU_BARRIER_MARKER"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_ACTIVE_OID: active,
      KEIYAKU_BARRIER_MARKER: marker,
      KEIYAKU_TERMINAL_OID: terminal,
    },
    async (gitPath) =>
      await invoke(parseArgv(["-C", repository.path, "status", `@${contract.id.slice("kei/".length)}`]), {
        environment: { KEIYAKU_GIT_PATH: gitPath },
      }),
  );

  assert.equal(result.kind, "status");
  assert.equal(result.kind === "status" && result.selection, "contract");
  assert.equal(
    result.kind === "status" &&
      result.report.contracts.kind === "present" &&
      result.report.contracts.value.rows.find((row) => row.id === contract.id)?.disposition,
    "terminal",
  );
  assert.equal(repository.run(["rev-parse", GIT_REF]).trim(), terminal);
});

test("canonical and Contract-alias status both assemble selected-only current physical issues", async (t) => {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document("Selected issue parity"),
    workspace: "worktree",
    hooks: {
      create: [{ name: "failing", argv: [process.execPath, "-e", "process.exit(9)"], timeoutMs: 5_000 }],
      destroy: [],
    },
  });
  const id = (await bound.keiyaku.state()).id;
  const world = await World.at(repository.path);
  const unselected = await kanshi({ world, repo: await Repo.at({ path: repository.path }) });
  assert.equal(unselected.contracts.kind, "present");
  if (unselected.contracts.kind !== "present") return;
  assert.equal("issue" in unselected.contracts.value.rows.find((row) => row.id === id)!, false);

  const readIssue = async (selector: string) => {
    const result = await invoke(parseArgv(["-C", repository.path, "status", selector]));
    assert.equal(result.kind, "status");
    if (result.kind !== "status" || result.report.contracts.kind !== "present")
      throw new Error("selected Contract status was unavailable");
    assert.deepEqual(
      result.report.contracts.value.rows.map((row) => row.id),
      [id],
    );
    return result.report.contracts.value.rows[0]?.issue;
  };

  const canonical = await readIssue(id);
  const alias = await readIssue(`@${id.slice("kei/".length)}`);
  assert.deepEqual(canonical, alias);
  assert.equal(canonical, undefined);
});

test("complete Contract status exposes a corrupt active dependency as a Contract section diagnostic", async (t) => {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const selected = await Keiyaku.bind({ repo, markdown: document("Selected"), workspace: "worktree" });
  const unrelated = await Keiyaku.bind({ repo, markdown: document("Unrelated"), workspace: "worktree" });
  const selectedId = (await selected.keiyaku.state()).id;
  const unrelatedId = (await unrelated.keiyaku.state()).id;
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([[contractJournalPath(unrelatedId), { oid: await writeBlob(git, "not a Contract journal\n") }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (
      await updateRefsAtomically(git, [
        {
          ref: GIT_REF,
          newOid: commit,
          expectedOid: snapshot.commit,
        },
      ])
    ).kind,
    "published",
  );

  const result = await invoke(parseArgv(["-C", repository.path, "status", selectedId]));

  assert.equal(result.kind, "status");
  if (result.kind !== "status") return;
  assert.equal(result.selection, "contract");
  assert.equal(result.report.contracts.kind, "failed");
});

test("same-target lag counts each workspace HEAD against the one frozen target head", async (t) => {
  const { repository, contract } = await populatedWorld(t);
  const tasks = Tasks.of(await World.at(repository.path));
  const added = await tasks.add({ title: "Second status row" });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") return;
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    task: added.value.id,
    markdown: document("Second Kanshi contract"),
    workspace: "worktree",
    target: "main",
  });
  const second = await bound.keiyaku.state();
  const log = join(repository.path, "kanshi-shared-target-lag.log");
  writeFileSync(log, "");
  const report = await withGitShim(
    'printf \'%s\\n\' "$*" >> "$KEIYAKU_KANSHI_GIT_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_KANSHI_GIT_LOG: log },
    async (gitPath) => observe(repository.path, await Repo.at({ path: repository.path, gitPath })),
  );

  assert.equal(report.contracts.kind, "present");
  if (report.contracts.kind !== "present") return;
  const contracts = report.contracts;
  const rows = [contract.id, second.id].map((id) =>
    contracts.value.rows.find((row: ContractKanshiRow) => row.id === id),
  );
  const head = rows[0]?.targetObservation?.head;
  assert.equal(typeof head, "string");
  assert.equal(
    rows.every((row) => row?.target === "refs/heads/main" && row.targetObservation?.head === head),
    true,
  );
  const invocations = gitInvocations(log);
  const lagReads = invocations.filter((command) => /rev-list --count HEAD\.\.[0-9a-f]{40}$/u.test(command));
  assert.equal(lagReads.length, 2);
  assert.equal(
    lagReads.every((command) => command.endsWith(`HEAD..${head}`)),
    true,
  );
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(
    invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)),
    false,
  );
});

test("a dead shared Kanshi batch fails every Git-backed owner without restarting", async (t) => {
  const { repository } = await populatedWorld(t);
  const log = join(repository.path, "kanshi-dead-batch.log");
  writeFileSync(log, "");

  const report = await withGitShim(
    [
      'printf \'%s\\n\' "$*" >> "$KEIYAKU_KANSHI_GIT_LOG"',
      'if [ "$1 $2" = "cat-file --batch" ]; then exit 74; fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_KANSHI_GIT_LOG: log },
    async (gitPath) => observe(repository.path, await Repo.at({ path: repository.path, gitPath })),
  );

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "failed");
  assert.equal(gitInvocations(log).filter((command) => command === "cat-file --batch").length, 1);
});

test("a missing Contract object fails only the Contract-dependent section", async (t) => {
  const { repository, contract } = await populatedWorld(t);
  const snapshot = await readGit(await repositoryAt(repository.path));
  deleteLooseObject(repository, snapshot.paths.get(contractJournalPath(contract.id))!.oid);

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
});

test("a missing TaskHolder object fails only the TaskHolder-dependent section", async (t) => {
  const { repository } = await populatedWorld(t);
  const snapshot = await readGit(await repositoryAt(repository.path));
  const holder = [...snapshot.paths].find(([path]) => path.startsWith("settlement/task-holders/"));
  assert.notEqual(holder, undefined);
  deleteLooseObject(repository, holder![1].oid);

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "present");
  if (report.contracts.kind === "present") {
    assert.equal(
      report.contracts.value.rows.every((row) => row.holder.kind === "unavailable"),
      true,
    );
    assert.equal(
      report.contracts.value.rows.every((row) => row.namespaceTasks === undefined),
      true,
    );
  }
});

test("a missing Dispatch object fails only the Dispatch-dependent section", async (t) => {
  const { repository } = await populatedWorld(t);
  const snapshot = await readGit(await repositoryAt(repository.path));
  const dispatch = [...snapshot.paths].find(([path]) => path.startsWith("dispatch/"));
  assert.notEqual(dispatch, undefined);
  deleteLooseObject(repository, dispatch![1].oid);

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("a corrupt shared Git format fails every state-backed Kanshi section", async (t) => {
  const { repository } = await populatedWorld(t);
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([[GIT_FORMAT_PATH, { oid: await writeBlob(git, "not the current format\n") }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "failed");
});

test("kanshi joins TaskHolder, Dispatch, and Alias without moving their authorities", async (t) => {
  const { repository, contract, taskId, akumaId } = await populatedWorld(t);
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.deepEqual([report.contracts.kind, report.tasks.kind, report.akuma.kind], ["present", "present", "present"]);
  if (report.akuma.kind === "present") {
    const row = report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
    assert.equal(row?.id, akumaId);
    assert.deepEqual(row?.aliases, ["@watch"]);
    assert.deepEqual(row?.contract, { id: contract.id, observed: "active" });
  }
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present") return;
  assert.equal(report.branch, "refs/heads/main");
  assert.equal(report.contracts.value.state, (await readGit(await repositoryAt(repository.path))).commit);
  assert.equal("state" in report, false);
  assert.equal(new Date(report.observedAt).toISOString(), report.observedAt);
  assert.deepEqual(report.contracts.value.rows.find((row) => row.id === contract.id)?.holder, {
    kind: "held",
    taskId,
  });
  assert.deepEqual(report.contracts.value.rows.find((row) => row.id === contract.id)?.fleet, [
    { id: akumaId, aliases: ["@watch"] },
  ]);
  assert.deepEqual(report.tasks.value.rows.find((row) => row.id === taskId)?.contract, {
    id: contract.id,
    observed: "active",
  });
});

test("kanshi keeps absent Contract and Task worlds explicit", async (t) => {
  const root = fixtureRoot(t, "keiyaku-kanshi-no-git-");
  const akumaId = await bornAkuma(root, "a0000002");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.tasks.kind === "present") assert.deepEqual(report.tasks.value.rows, []);
  if (report.akuma.kind === "present") {
    const row = report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
    assert.equal(row?.id, akumaId);
    assert.equal("lastActivityAt" in (row ?? {}), true);
    assert.equal(
      "lastActivityAt" in (row ?? {}) ? (row as { lastActivityAt?: string | null }).lastActivityAt : undefined,
      null,
    );
    assert.equal(row === undefined ? false : "contract" in row, false);
  }
});

test("a Task world without Git has no invented Contract endpoint", async (t) => {
  const root = fixtureRoot(t, "keiyaku-kanshi-task-only-");
  const tasks = Tasks.of(await World.at(root));
  const added = await tasks.add({ title: "Standalone Task" });
  assert.equal(added.kind, "accepted");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  if (report.tasks.kind !== "present" || added.kind !== "accepted") return;
  assert.equal(report.tasks.value.rows.find((row) => row.id === added.value.id)?.contract, undefined);
});

test("kanshi reports malformed Task authority as a failed section", async (t) => {
  const root = fixtureRoot(t, "keiyaku-kanshi-bad-task-");
  mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "tasks", "bad.md"), "not a task document\n");
  const report = await observe(root);
  assert.equal(report.tasks.kind, "failed");
  if (report.tasks.kind === "failed") assert.match(report.tasks.failure.message, /front matter/u);
  assert.deepEqual(report.contracts, { kind: "absent" });
});

test("a malformed TaskHolder root fails only the Kanshi Task section", async (t) => {
  const { repository } = await populatedWorld(t);
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([["settlement/task-holders", { oid: await writeBlob(git, "not holder authority\n") }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "present");
  if (report.tasks.kind === "failed")
    assert.match(report.tasks.failure.message, /TaskHolder authority root is not a tree/u);
  if (report.contracts.kind === "present") {
    assert.equal(
      report.contracts.value.rows.every((row) => row.holder.kind === "unavailable"),
      true,
    );
    assert.equal(
      report.contracts.value.rows.every((row) => row.namespaceTasks === undefined),
      true,
    );
  }
});

test("a malformed Contract journal fails only the Kanshi Contract section", async (t) => {
  const { repository, contract } = await populatedWorld(t);
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([[contractJournalPath(contract.id), { oid: await writeBlob(git, "not a Contract journal\n") }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
});

test("kanshi samples observedAt before section reads", async (t) => {
  const { repository } = await populatedWorld(t);
  const original = Date.prototype.toISOString;
  const currentBranch = Repo.prototype.currentBranch;
  let sampled = false;
  Date.prototype.toISOString = function () {
    sampled = true;
    return original.call(this);
  };
  Repo.prototype.currentBranch = async function () {
    assert.equal(sampled, true);
    return currentBranch.call(this);
  };
  try {
    await observe(repository.path, await Repo.at({ path: repository.path }));
  } finally {
    Date.prototype.toISOString = original;
    Repo.prototype.currentBranch = currentBranch;
  }
});

test("a failed branch observation does not suppress readable Contract state", async (t) => {
  const { repository } = await populatedWorld(t);
  const currentBranch = Repo.prototype.currentBranch;
  Repo.prototype.currentBranch = async function () {
    throw new Error("branch unavailable");
  };
  try {
    const report = await observe(repository.path, await Repo.at({ path: repository.path }));
    assert.equal(report.branch, null);
    assert.equal(report.contracts.kind, "present");
    if (report.contracts.kind === "present") {
      assert.notEqual(report.contracts.value.state, null);
    }
  } finally {
    Repo.prototype.currentBranch = currentBranch;
  }
});

test("blocked Kanshi rows preserve ordered structured Task blocker refs", async (t) => {
  const root = fixtureRoot(t, "keiyaku-kanshi-blockers-");
  const tasks = Tasks.of(await World.at(root));
  const first = await tasks.add({ title: "First blocker" });
  const second = await tasks.add({ title: "Second blocker", state: "in_progress" });
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  if (first.kind !== "accepted" || second.kind !== "accepted") return;
  const blocked = await tasks.add({ title: "Blocked work", needs: [second.value.id, first.value.id] });
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind !== "accepted") return;
  unlinkSync(authorityPath(root as WorldRoot, first.value.id));

  const report = await observe(root);

  assert.equal(report.tasks.kind, "present");
  if (report.tasks.kind !== "present") return;
  assert.deepEqual(report.tasks.value.rows.find((row) => row.id === blocked.value.id)?.blockers, [
    { id: second.value.id, title: "Second blocker", state: "in_progress" },
    { id: first.value.id, title: null, state: "missing" },
  ]);
  assert.equal("blockers" in report.tasks.value.rows.find((row) => row.id === second.value.id)!, false);

  await tasks.task({ id: blocked.value.id }).start();
  const running = await observe(root);
  assert.equal(running.tasks.kind, "present");
  if (running.tasks.kind === "present") {
    assert.equal(running.tasks.value.rows.find((row) => row.id === blocked.value.id)?.disposition, "in_progress");
    assert.deepEqual(running.tasks.value.rows.find((row) => row.id === blocked.value.id)?.blockers, [
      { id: second.value.id, title: "Second blocker", state: "in_progress" },
      { id: first.value.id, title: null, state: "missing" },
    ]);
  }
});

test("malformed Alias fails only the Kanshi Akuma section", async (t) => {
  const root = fixtureRoot(t, "keiyaku-kanshi-bad-alias-");
  await bornAkuma(root, "a0000003");
  mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "akuma", "alias.json"), "not alias authority\n");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("malformed Dispatch fails only the Kanshi Akuma section", async (t) => {
  const { repository } = await populatedWorld(t);
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([["dispatch", { oid: await writeBlob(git, "not dispatch authority\n") }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

function sectionBody(text: string, name: string): string {
  const section = name === "KEIYAKU" ? "CONTRACTS" : name === "FLEET" ? "AKUMA" : name === "TASK" ? "TASKS" : name;
  const open =
    section === "CONTRACTS" || section === "AKUMA" || section === "TASKS" ? `${section} //` : `[ ${section} ]`;
  const start = text.indexOf(open);
  assert.notEqual(start, -1, `missing ${name} aperture`);
  const after = text.indexOf("\n", start);
  const rest = text.slice(after + 1);
  const close = rest.search(/^(?:CONTRACTS|AKUMA|TASKS) \//mu);
  return close === -1 ? rest : rest.slice(0, close);
}

test("bare Kanshi marks an associated Contract outside its bounded aperture unavailable", async (t) => {
  const { repository, contract, taskId } = await populatedWorld(t);
  await publishNewerActiveContractCopies(repository, contract.id);

  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present") return;
  assert.equal(report.contracts.value.hasMore, true);
  assert.equal(
    report.contracts.value.rows.some((row) => row.id === contract.id),
    false,
  );
  assert.deepEqual(report.tasks.value.rows.find((row) => row.id === taskId)?.contract, {
    id: contract.id,
    observed: "unavailable",
  });
});

test("bare Kanshi treats a terminal Dispatch Contract as unavailable in an active-only catalogue", async (t) => {
  const { repository, contract, keiyaku, akumaId } = await populatedWorld(t);
  await keiyaku.abandon();

  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });

  assert.equal((await keiyaku.state()).terminal?.kind, "abandoned");
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present") return;
  assert.equal(report.contracts.value.hasMore, false);
  assert.equal(
    report.contracts.value.rows.some((row) => row.id === contract.id),
    false,
  );
  assert.deepEqual(report.akuma.value.rows.find((row) => row.id === akumaId)?.contract, {
    id: contract.id,
    observed: "unavailable",
  });
});

test("Kanshi reads ActivitySnapshots for the first three final Fleet display rows", async (t) => {
  const root = fixtureRoot(t, "keiyaku-kanshi-fleet-snapshots-");
  const ids = [
    await bornAkuma(root, "a0000001", "2026-08-09T00:00:00.000Z", true),
    await bornAkuma(root, "a0000002", "2026-08-09T00:03:00.000Z", true),
    await bornAkuma(root, "a0000003", "2026-08-09T00:01:00.000Z", true),
    await bornAkuma(root, "a0000004", "2026-08-09T00:02:00.000Z", true),
  ];
  const originalStatus = AkumaHandle.prototype.status;
  const statusReads: string[] = [];
  AkumaHandle.prototype.status = async function () {
    statusReads.push(this.id);
    return await originalStatus.call(this);
  };
  try {
    const report = await observe(root);
    assert.equal(report.akuma.kind, "present");
    if (report.akuma.kind !== "present") return;
    const fleet = sectionBody(renderKanshiText(report, { columns: 120, color: false }), "FLEET");
    const displayed = [...ids].sort((left, right) => fleet.indexOf(left) - fleet.indexOf(right));
    assert.deepEqual(displayed, [ids[1], ids[3], ids[2], ids[0]]);
    assert.equal(statusReads.length, 3);
    assert.deepEqual([...statusReads].sort(), [...displayed.slice(0, 3)].sort());
  } finally {
    AkumaHandle.prototype.status = originalStatus;
  }
});

test("Kanshi selection is a projection that preserves source presence", async (t) => {
  const { repository, contract, taskId } = await populatedWorld(t);
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  const selected = selectKanshi({ report, contract: contract.id });
  assert.equal(selected.contracts.kind, "present");
  assert.equal(selected.tasks.kind, "present");
  assert.equal(selected.akuma.kind, "present");
  if (selected.contracts.kind !== "present" || selected.tasks.kind !== "present" || selected.akuma.kind !== "present")
    return;
  if (report.akuma.kind !== "present") throw new Error("fixture Akuma must be present");
  assert.deepEqual(
    selected.contracts.value.rows.map((row) => row.id),
    [contract.id],
  );
  assert.deepEqual(
    selected.tasks.value.rows.map((row) => row.id),
    [taskId],
  );
  assert.deepEqual(
    selected.akuma.value.rows.map((row) => row.id),
    [report.akuma.value.rows[0]!.id],
  );
});

test("target lag counts the frozen targetObservation head after the live ref moves", async (t) => {
  const { repository, contract } = await populatedWorld(t);
  const frozen = repository.run(["rev-parse", "refs/heads/main"]).trim();
  repository.run(["checkout", "--quiet", "-b", "stay"]);
  const log = join(repository.path, "kanshi-target-race.log");
  writeFileSync(log, "");
  const first = join(repository.path, "target-first");
  const moved = join(repository.path, "target-moved");

  const report = await withGitShim(
    [
      'printf \'%s\\n\' "$*" >> "$KEIYAKU_KANSHI_GIT_LOG"',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$4" = "refs/heads/main" ]; then',
      '  if [ ! -e "$KEIYAKU_TARGET_FIRST" ]; then touch "$KEIYAKU_TARGET_FIRST"; exec "$KEIYAKU_REAL_GIT" "$@"; fi',
      "fi",
      'if [ -e "$KEIYAKU_TARGET_FIRST" ] && [ ! -e "$KEIYAKU_TARGET_MOVED" ]; then',
      '  touch "$KEIYAKU_TARGET_MOVED"',
      '  tree=$("$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" rev-parse "$KEIYAKU_FROZEN^{tree}")',
      '  advanced=$("$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" commit-tree "$tree" -p "$KEIYAKU_FROZEN" -m race)',
      '  "$KEIYAKU_REAL_GIT" -C "$KEIYAKU_REPO" update-ref refs/heads/main "$advanced"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {
      KEIYAKU_KANSHI_GIT_LOG: log,
      KEIYAKU_TARGET_FIRST: first,
      KEIYAKU_TARGET_MOVED: moved,
      KEIYAKU_REPO: repository.path,
      KEIYAKU_FROZEN: frozen,
    },
    async (gitPath) => observe(repository.path, await Repo.at({ path: repository.path, gitPath })),
  );

  assert.equal(report.contracts.kind, "present");
  if (report.contracts.kind !== "present") return;
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.deepEqual(row?.targetObservation, { head: frozen, drift: false });
  assert.deepEqual(row?.targetLag, {
    kind: "counted",
    behind: 0,
    subject: { kind: "worktree", path: join(repository.path, ".keiyaku", "wt", "commandroom") },
  });
  const invocations = gitInvocations(log);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(
    invocations.some((command) => command.endsWith(`rev-list --count HEAD..${frozen}`)),
    true,
  );
  assert.equal(
    invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)),
    false,
  );
  assert.notEqual(repository.run(["rev-parse", "refs/heads/main"]).trim(), frozen);
  const unknown = await observeTargetLag(await repositoryAt(repository.path), repository.path, null);
  assert.deepEqual(unknown, { kind: "unknown", subject: { kind: "worktree", path: repository.path } });
});

test("Contract namespace Tasks come from one Task board observation", async (t) => {
  const { repository, contract, taskId } = await populatedWorld(t);
  const world = await World.at(repository.path);
  const segment = contractSegment(contract.id);
  assert.deepEqual(contractNamespace(contract.id), ["kei", segment]);
  const sibling = contractId("kei/other-contract");
  writeTaskAuthority(world, taskDocument({ id: "task/root-unbound", title: "Root unbound", priority: 0 }));
  writeTaskAuthority(
    world,
    taskDocument({
      id: `task/kei/${segment}/alpha`,
      title: "Namespace alpha",
      state: "done",
      priority: 3,
    }),
  );
  writeTaskAuthority(
    world,
    taskDocument({
      id: `task/kei/${segment}/zeta`,
      title: "Namespace zeta",
      state: "on_hold",
      priority: 0,
    }),
  );
  writeTaskAuthority(
    world,
    taskDocument({
      id: `task/kei/${segment}/child/nested`,
      title: "Nested descendant",
      priority: 0,
    }),
  );
  writeTaskAuthority(
    world,
    taskDocument({
      id: `task/kei/${contractSegment(sibling)}/sibling`,
      title: "Sibling namespace",
      priority: 0,
    }),
  );

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  const selected = await kanshi({
    world,
    repo: await Repo.at({ path: repository.path }),
    contract: contract.id,
  });
  const board = projectTaskBoardObservation((await readBoard(world)).board);
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(selected.contracts.kind, "present");
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present" || selected.contracts.kind !== "present")
    return;
  assert.equal(
    report.contracts.value.rows.every((candidate) => candidate.namespaceTasks === undefined),
    true,
  );
  const row = selected.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  if (row === undefined || row.namespaceTasks === undefined) throw new Error("fixture namespace tasks must be present");
  assert.equal(row.namespaceTasks.kind, "present");
  if (row.namespaceTasks.kind !== "present") return;
  const expected = board.selectNamespace(contractNamespace(contract.id));
  assert.deepEqual(row.namespaceTasks.value, expected);
  assert.deepEqual(
    expected.map((task) => task.id),
    [`task/kei/${segment}/zeta`, `task/kei/${segment}/alpha`],
  );
  assert.deepEqual(
    expected.map((task) => task.state),
    ["on_hold", "done"],
  );
  assert.equal(
    expected.some((task) => task.id === taskId),
    false,
  );
  assert.equal(
    expected.some((task) => task.id === "task/root-unbound"),
    false,
  );
  assert.equal(
    expected.some((task) => task.id === `task/${segment}/child/nested`),
    false,
  );
  assert.equal(
    expected.some((task) => task.id === `task/kei/${contractSegment(sibling)}/sibling`),
    false,
  );
  assert.deepEqual(
    report.tasks.value.rows.map((task) => ({ id: task.id, disposition: task.disposition, blockers: task.blockers })),
    board.selectRecentStatus(10).rows.map((task) => ({
      id: task.id,
      disposition: task.disposition,
      blockers: "blockers" in task ? task.blockers : undefined,
    })),
  );
  assert.equal(report.tasks.value.hasMore, board.selectRecentStatus(10).hasMore);

  assert.equal(selected.tasks.kind, "present");
  if (selected.tasks.kind === "present") {
    assert.deepEqual(
      selected.tasks.value.rows.map((task) => task.id),
      [taskId],
    );
  }
  assert.equal(selected.contracts.kind, "present");
  if (selected.contracts.kind === "present") {
    assert.deepEqual(selected.contracts.value.rows[0]?.namespaceTasks, row.namespaceTasks);
  }
  const worldText = renderKanshiText(report, { columns: 120, color: false });
  const selectedText = renderKanshiText(selected, { columns: 120, color: false }, "contract");
  assert.doesNotMatch(sectionBody(worldText, "KEIYAKU"), /namespace tasks /u);
  assert.match(selectedText, new RegExp(String.raw`● ${taskId} · in_progress`, "u"));
  assert.match(selectedText, /  namespace tasks\n/u);
  assert.match(selectedText, new RegExp(String.raw`⧗ task/kei/${segment}/zeta · on_hold · P0 · Namespace zeta`, "u"));
  assert.match(selectedText, new RegExp(String.raw`✓ task/kei/${segment}/alpha · done · P3 · Namespace alpha`, "u"));
  assert.doesNotMatch(selectedText, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
});

test("Task board failure fails namespace context without suppressing Contract or Akuma", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  writeFileSync(join(repository.path, ".keiyaku", "tasks", "bad.md"), "not a task document\n");
  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
    contract: contract.id,
  });
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present") return;
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  if (row === undefined || row.namespaceTasks === undefined) throw new Error("fixture namespace tasks must be present");
  assert.equal(row.namespaceTasks.kind, "failed");
  if (row.namespaceTasks.kind === "failed") assert.match(row.namespaceTasks.failure.message, /front matter/u);
  assert.equal(
    report.akuma.value.rows.some((candidate) => candidate.id === akumaId),
    true,
  );
  const selected = renderKanshiText(
    selectKanshi({ report, contract: contract.id }),
    { columns: 80, color: false },
    "contract",
  );
  assert.match(selected, /  namespace tasks\n    failed /u);
  assert.doesNotMatch(selected, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
});
