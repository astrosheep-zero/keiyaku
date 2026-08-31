import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { AkumaHandle } from "../src/akuma/index.js";
import { breakBody, HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { Keiyaku, Repo } from "../src/index.js";
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
import { contractJournalPath } from "../src/git/identity.js";
import { lastJournalAtFor, phaseAtFor } from "../src/protocol/read/status.js";
import { changeId, contractId, contractSegment, snapshotId } from "../src/core/facts/types.js";
import { kanshi, selectKanshi, type KanshiReport } from "../src/kanshi/index.js";
import { visibleFleetRows } from "../src/kanshi/fleet.js";
import { contractNamespace } from "../src/settlement/settle.js";
import { projectTaskBoardObservation } from "../src/task/board.js";
import { serializeTaskDocument, type TaskDocument } from "../src/task/document.js";
import { Tasks, type TaskId } from "../src/task/index.js";
import { authorityPath, readBoard } from "../src/task/store.js";
import { World } from "../src/world.js";
import { moveAlias } from "../src/alias/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

async function observe(path: string, repo?: Repo) {
  return kanshi({ world: await World.at(path), ...(repo === undefined ? {} : { repo }) });
}

function document(title = "Kanshi contract"): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "status",
    "",
    "## Objective",
    "render",
    "",
    "## Design",
    "project public values",
    "",
    "## Region",
    "```",
    "src/**",
    "```",
    "",
    "## Criteria",
    "### Visible",
    "The status row is visible.",
    "",
  ].join("\n");
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

async function populatedWorld() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
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
  await moveAlias({ world: repository.path, alias: "@watch", akuId: akumaId });
  return { repository, contract, keiyaku: bound.keiyaku, taskId: added.value.id, akumaId };
}

function gitInvocations(path: string): readonly string[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

async function observedGitInvocations(repository: ReturnType<typeof makeGitRepository>): Promise<readonly string[]> {
  const log = join(repository.path, "kanshi-git-invocations.log");
  writeFileSync(log, "");
  await withGitShim(
    'printf \'%s\\n\' "$*" >> "$KEIYAKU_KANSHI_GIT_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_KANSHI_GIT_LOG: log },
    async (gitPath) => observe(repository.path, await Repo.at({ path: repository.path, gitPath })),
  );
  return gitInvocations(log);
}

function deleteLooseObject(repository: ReturnType<typeof makeGitRepository>, oid: string): void {
  unlinkSync(join(repository.path, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
}

test("one-target Kanshi observation has an eight-process Git topology", async () => {
  const { repository } = await populatedWorld();
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
  const secondContract = await bound.keiyaku.state();
  const secondAkuma = await bornAkuma(repository.path, "a0000009");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akuId: secondAkuma,
        contractId: secondContract.id,
      })
    ).kind,
    "dispatched",
  );
  const invocations = await observedGitInvocations(repository);

  assert.equal(invocations.filter((command) => command === "worktree list --porcelain -z").length, 1);
  assert.equal(
    invocations.filter((command) => command === "rev-parse --path-format=absolute --git-common-dir").length,
    1,
  );
  assert.equal(invocations.filter((command) => command === "symbolic-ref --quiet HEAD").length, 1);
  assert.equal(invocations.filter((command) => command === `rev-parse --verify --quiet ${GIT_REF}`).length, 1);
  assert.equal(
    invocations.some((command) => command.startsWith("ls-tree ")),
    false,
  );
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(
    invocations.some((command) => command.startsWith("cat-file blob ")),
    false,
  );
  assert.equal(invocations.filter((command) => command.includes("status --porcelain=v2")).length, 2);
  assert.equal(invocations.filter((command) => /rev-list --count HEAD\.\.[0-9a-f]{40}$/u.test(command)).length, 2);
  assert.equal(
    invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)),
    false,
  );
});

test("named status resolves its address from the initial observation before the selected read", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
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

test("canonical and Contract-alias status both assemble selected-only current physical issues", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
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
  const id = bound.keiyaku.id;
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

test("complete Contract status exposes a corrupt active dependency as a Contract section diagnostic", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const selected = await Keiyaku.bind({ repo, markdown: document("Selected"), workspace: "worktree" });
  const unrelated = await Keiyaku.bind({ repo, markdown: document("Unrelated"), workspace: "worktree" });
  const selectedId = selected.keiyaku.id;
  const unrelatedId = unrelated.keiyaku.id;
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

test("same-target lag counts each workspace HEAD against the one frozen target head", async () => {
  const { repository, contract } = await populatedWorld();
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
  const rows = [contract.id, second.id].map((id) => report.contracts.value.rows.find((row) => row.id === id));
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

test("Kanshi Git topology adds one ref read per distinct Contract target", async () => {
  const { repository } = await populatedWorld();
  repository.run(["branch", "other"]);
  await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document("Other target contract"),
    workspace: "worktree",
    target: "other",
  });

  const invocations = await observedGitInvocations(repository);

  assert.equal(
    invocations.filter((command) => command === "rev-parse --path-format=absolute --git-common-dir").length,
    1,
  );
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/other").length, 1);
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.includes("status --porcelain=v2")).length, 2);
  assert.equal(invocations.filter((command) => /rev-list --count HEAD\.\.[0-9a-f]{40}$/u.test(command)).length, 2);
  assert.equal(
    invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)),
    false,
  );
});

test("a dead shared Kanshi batch fails every Git-backed owner without restarting", async () => {
  const { repository } = await populatedWorld();
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

test("a missing Contract object fails only the Contract-dependent section", async () => {
  const { repository, contract } = await populatedWorld();
  const snapshot = await readGit(await repositoryAt(repository.path));
  deleteLooseObject(repository, snapshot.paths.get(contractJournalPath(contract.id))!.oid);

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
});

test("a missing TaskHolder object fails only the TaskHolder-dependent section", async () => {
  const { repository } = await populatedWorld();
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
      report.contracts.value.rows.every((row) => row.namespaceTasks.kind === "present"),
      true,
    );
  }
});

test("a missing Dispatch object fails only the Dispatch-dependent section", async () => {
  const { repository } = await populatedWorld();
  const snapshot = await readGit(await repositoryAt(repository.path));
  const dispatch = [...snapshot.paths].find(([path]) => path.startsWith("dispatch/"));
  assert.notEqual(dispatch, undefined);
  deleteLooseObject(repository, dispatch![1].oid);

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("a corrupt shared Git format fails every state-backed Kanshi section", async () => {
  const { repository } = await populatedWorld();
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

test("kanshi joins TaskHolder, Dispatch, and Alias without moving their authorities", async () => {
  const { repository, contract, taskId, akumaId } = await populatedWorld();
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
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

test("kanshi keeps absent Contract and Task worlds explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-no-git-"));
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
    assert.equal("lastActivityAt" in (row ?? {}) ? row.lastActivityAt : undefined, null);
    assert.equal(row === undefined ? false : "contract" in row, false);
  }
});

test("a Task world without Git has no invented Contract endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-task-only-"));
  const tasks = Tasks.of(await World.at(root));
  const added = await tasks.add({ title: "Standalone Task" });
  assert.equal(added.kind, "accepted");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  if (report.tasks.kind !== "present" || added.kind !== "accepted") return;
  assert.equal(report.tasks.value.rows.find((row) => row.id === added.value.id)?.contract, undefined);
});

test("kanshi reports malformed Task authority as a failed section", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-bad-task-"));
  mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "tasks", "bad.md"), "not a task document\n");
  const report = await observe(root);
  assert.equal(report.tasks.kind, "failed");
  if (report.tasks.kind === "failed") assert.match(report.tasks.failure.message, /front matter/u);
  assert.deepEqual(report.contracts, { kind: "absent" });
});

test("a malformed TaskHolder root fails only the Kanshi Task section", async () => {
  const { repository } = await populatedWorld();
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
      report.contracts.value.rows.every((row) => row.namespaceTasks.kind === "present"),
      true,
    );
  }
});

test("a malformed Contract journal fails only the Kanshi Contract section", async () => {
  const { repository, contract } = await populatedWorld();
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

test("kanshi samples observedAt before section reads", async () => {
  const { repository } = await populatedWorld();
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

test("a failed branch observation does not suppress readable Contract state", async () => {
  const { repository } = await populatedWorld();
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

test("blocked Kanshi rows preserve ordered structured Task blocker refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-blockers-"));
  const tasks = Tasks.of(await World.at(root));
  const first = await tasks.add({ title: "First blocker" });
  const second = await tasks.add({ title: "Second blocker", state: "in_progress" });
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  if (first.kind !== "accepted" || second.kind !== "accepted") return;
  const blocked = await tasks.add({ title: "Blocked work", needs: [second.value.id, first.value.id] });
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind !== "accepted") return;
  unlinkSync(authorityPath(root, first.value.id));

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

test("malformed Alias fails only the Kanshi Akuma section", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-bad-alias-"));
  await bornAkuma(root, "a0000003");
  mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "akuma", "alias.json"), "not alias authority\n");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("malformed Dispatch fails only the Kanshi Akuma section", async () => {
  const { repository } = await populatedWorld();
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

function zeros() {
  return { staged: 0, unstaged: 0, untracked: 0, submodules: 0 };
}

function worktreeObservation(path: string, kind: "clean" | "dirty" | "unavailable" = "clean", counts = zeros()) {
  return kind === "unavailable"
    ? { kind, location: { kind: "worktree" as const, path } }
    : { kind, location: { kind: "worktree" as const, path }, counts, merge: null };
}

function contractRow(
  input: Partial<Extract<KanshiReport["contracts"], { kind: "present" }>["value"]["rows"][number]> & { id: string },
) {
  const workspace = input.workspace ?? "worktree";
  const path = input.worktreePath ?? `/repo/.keiyaku/wt/${input.id.slice("kei/".length)}`;
  return {
    title: input.title ?? input.id.slice("kei/".length),
    phase: "waiting" as const,
    phaseAt: "2026-08-11T23:59:30.000Z",
    lastJournalAt: "2026-08-11T23:59:30.000Z",
    disposition: "active" as const,
    workspace,
    worktreePath: workspace === "worktree" ? path : null,
    workspaceObservation: worktreeObservation(path),
    target: "refs/heads/main",
    targetLag: { kind: "counted" as const, behind: 0 },
    delivery: null,
    targetObservation: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drift: false },
    holder: { kind: "none" as const },
    fleet: [],
    namespaceTasks: { kind: "present" as const, value: [] },
    gates: { satisfied: true, reports: [] },
    after: [],
    dependents: [],
    ...input,
  };
}

function attentionReport(): KanshiReport {
  const dirtyPath = "/repo/.keiyaku/wt/active-contract";
  return {
    root: "/repo",
    observedAt: "2026-08-12T00:00:00.000Z",
    branch: "refs/heads/main",
    contracts: {
      kind: "present",
      value: {
        root: "/repo",
        state: "cccccccccccccccccccccccccccccccccccccccc",
        observedAt: "2026-08-12T00:00:00.000Z",
        rows: [
          contractRow({
            id: "kei/terminal-contract",
            title: "Terminal Contract",
            phase: "claimed",
            phaseAt: "2026-08-10T00:00:00.000Z",
            disposition: "terminal",
            worktreePath: "/repo/.keiyaku/wt/terminal-contract",
            workspaceObservation: worktreeObservation("/repo/.keiyaku/wt/terminal-contract"),
            gates: {
              satisfied: true,
              reports: [
                {
                  gate: "reviewed",
                  current: {
                    kind: "attested",
                    verdict: "satisfied",
                    summary: "terminal review summary",
                    at: "2026-08-10T00:00:00.000Z",
                  },
                },
              ],
            },
          }),
          contractRow({
            id: "kei/active-contract",
            title: "Active Contract",
            phase: "tendered",
            phaseAt: "2026-08-11T23:57:00.000Z",
            worktreePath: dirtyPath,
            workspaceObservation: worktreeObservation(dirtyPath, "dirty", {
              staged: 1,
              unstaged: 3,
              untracked: 2,
              submodules: 0,
            }),
            targetLag: { kind: "counted", behind: 7 },
            targetObservation: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drift: true },
            holder: { kind: "held", taskId: "task/running" },
            fleet: [{ id: "aku/worker/a0000001", aliases: ["@lead"] }],
            gates: {
              satisfied: false,
              reports: [
                {
                  gate: "reviewed",
                  current: {
                    kind: "attested",
                    verdict: "satisfied",
                    summary: "world summary should stay hidden",
                    at: "2026-08-11T23:58:00.000Z",
                  },
                },
                {
                  gate: "verified",
                  current: {
                    kind: "attested",
                    verdict: "unsatisfied",
                    summary: "tests failed",
                    at: "2026-08-11T22:00:00.000Z",
                  },
                },
                { gate: "security", current: { kind: "stale", priorVerdict: "satisfied" } },
                { gate: "manual", current: { kind: "missing" } },
              ],
            },
          }),
          contractRow({
            id: "kei/cold-contract",
            title: "Cold Contract",
            phase: "bound",
            phaseAt: "2026-08-11T22:00:00.000Z",
            lastJournalAt: "2026-08-11T22:00:00.000Z",
          }),
          contractRow({
            id: "kei/target-unknown",
            title: "Target Unknown",
            phaseAt: "2026-08-12T00:00:01.000Z",
            lastJournalAt: "2026-08-12T00:00:01.000Z",
            target: "refs/heads/release",
            targetLag: { kind: "unknown" },
            targetObservation: { head: null, drift: true },
          }),
          contractRow({
            id: "kei/no-target",
            title: "No Target Contract",
            target: null,
            targetLag: { kind: "none" },
            targetObservation: null,
          }),
          contractRow({
            id: "kei/unavailable-contract",
            title: "Unavailable Contract",
            worktreePath: "/repo/.keiyaku/wt/unavailable-contract",
            workspaceObservation: worktreeObservation("/repo/.keiyaku/wt/unavailable-contract", "unavailable"),
          }),
        ],
      },
    },
    tasks: {
      kind: "present",
      value: {
        root: "/repo",
        rows: [
          {
            id: "task/blocked",
            title: "Blocked by release evidence",
            state: "open",
            priority: 0,
            disposition: "blocked",
            contract: { id: "kei/active-contract", observed: "active" },
            blockers: [
              { id: "task/release", title: "Release", state: "in_progress" },
              { id: "task/missing", title: null, state: "missing" },
            ],
          },
          {
            id: "task/running",
            title: "Investigate failed Linux verification",
            state: "in_progress",
            priority: 0,
            disposition: "in_progress",
            contract: { id: "kei/active-contract", observed: "active" },
          },
          { id: "task/held", title: "Held", state: "on_hold", priority: 1, disposition: "on_hold" },
          { id: "task/ready", title: "Ready", state: "open", priority: 1, disposition: "ready" },
          { id: "task/done", title: "Done", state: "done", priority: 2, disposition: "done" },
          { id: "task/dropped", title: "Dropped", state: "drop", priority: 2, disposition: "drop" },
        ],
      },
    },
    akuma: {
      kind: "present",
      value: {
        observedAt: "2026-08-12T00:00:00.000Z",
        searched: ["/repo/.keiyaku/akuma/run"],
        hasMore: false,
        rows: [
          {
            id: "aku/worker/a0000001",
            archetype: "worker",
            life: "running",
            lifeAt: "2026-08-11T23:56:00.000Z",
            lastActivityAt: "2026-08-11T23:55:00.000Z",
            pending: [],
            aliases: ["@lead"],
            contract: { id: "kei/active-contract", observed: "active" },
          },
          {
            id: "aku/worker/a0000002",
            archetype: "worker",
            life: "asleep",
            lifeAt: "2026-08-11T00:00:00.000Z",
            lastActivityAt: null,
            pending: [],
            aliases: [],
          },
          {
            id: "aku/worker/a0000003",
            archetype: "worker",
            life: "killed",
            lifeAt: "2026-08-11T23:59:30.000Z",
            lastActivityAt: "2026-08-11T23:59:00.000Z",
            pending: [],
            aliases: [],
          },
          {
            id: "aku/worker/a0000004",
            life: "stillborn",
            seal: { at: "2026-08-10T00:00:00.000Z", evidence: "stillborn" },
            aliases: [],
          },
          { id: "aku/worker/a0000005", life: "unborn", aliases: [] },
          {
            id: "aku/worker/a0000006",
            archetype: "worker",
            life: "stranded",
            lifeAt: "2026-08-11T22:00:00.000Z",
            lastActivityAt: "2026-08-11T22:30:00.000Z",
            strandedReason: "resume-unsupported",
            pending: ["pending"],
            aliases: [],
            contract: { id: "kei/missing-contract", observed: "missing" },
          },
          {
            id: "aku/worker/a0000007",
            archetype: "worker",
            life: "hung",
            lifeAt: null,
            lastActivityAt: null,
            pending: [],
            aliases: [],
          },
        ],
      },
    },
  } as KanshiReport;
}

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

test("Kanshi text keeps complete identities in the aperture grammar", async () => {
  const { repository, contract, taskId, akumaId } = await populatedWorld();
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  const text = renderKanshiText(report, { columns: 20, color: false });
  const world = await World.at(repository.path);
  const signature = text.split("\n", 1)[0]!;
  assert.equal(signature, "契 KEIYAKU // WORLD");
  assert.equal(text.includes(world), false);
  assert.equal(report.contracts.kind, "present");
  assert.equal(text.includes(contract.id), true);
  assert.equal(text.includes(taskId), true);
  assert.equal(text.includes(akumaId), true);
  assert.match(text, /CONTRACTS \/\/ 1 recent · 0 candidates/u);
  assert.match(text, /TASKS \/\/ 1 recent/u);
  assert.match(text, /AKUMA \/\/ 1 recent/u);
  assert.ok(text.indexOf("CONTRACTS //") < text.indexOf("AKUMA //"));
  assert.ok(text.indexOf("AKUMA //") < text.indexOf("TASKS //"));
  assert.doesNotMatch(text, /\bFLEET \d/u);
  assert.doesNotMatch(signature, / fleet /u);
  const json = JSON.stringify(report);
  assert.match(json, /"phaseAt":/u);
  assert.match(json, /"lastJournalAt":/u);
  assert.match(json, /"lifeAt":/u);
  assert.match(json, /"lastActivityAt":/u);
  assert.doesNotMatch(json, /"(?:age|lifeSince)":|\u001b/u);
});

test("Contract phase timestamps select the owning journal entry", () => {
  const bindAt = "2026-08-12T00:00:00.000Z";
  const boundAt = "2026-08-12T00:01:00.000Z";
  const deliveryAt = "2026-08-12T00:02:00.000Z";
  const claimedAt = "2026-08-12T00:03:00.000Z";
  assert.equal(phaseAtFor({ terminal: null, delivery: null, bound: null }, bindAt), bindAt);
  assert.equal(phaseAtFor({ terminal: null, delivery: null, bound: { at: boundAt } as never }, bindAt), boundAt);
  assert.equal(
    phaseAtFor({ terminal: null, delivery: { at: deliveryAt } as never, bound: { at: boundAt } as never }, bindAt),
    deliveryAt,
  );
  assert.equal(
    phaseAtFor(
      { terminal: { at: claimedAt } as never, delivery: { at: deliveryAt } as never, bound: { at: boundAt } as never },
      bindAt,
    ),
    claimedAt,
  );
  assert.equal(
    phaseAtFor(
      {
        terminal: { at: "2026-08-12T00:04:00.000Z" } as never,
        delivery: { at: deliveryAt } as never,
        bound: { at: boundAt } as never,
      },
      bindAt,
    ),
    "2026-08-12T00:04:00.000Z",
  );
});

test("Contract journal recency selects the final frozen journal entry", () => {
  const journal = [
    { at: "2026-08-12T00:00:00.000Z" },
    { at: "2026-08-12T00:01:00.000Z" },
    { at: "2026-08-12T00:02:00.000Z" },
  ] as const;
  assert.equal(lastJournalAtFor(journal), "2026-08-12T00:02:00.000Z");
});

test("Kanshi Contract journal recency moves after a terms amendment", async () => {
  const { repository, contract, keiyaku } = await populatedWorld();
  const before = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.equal(before.contracts.kind, "present");
  if (before.contracts.kind !== "present") return;
  const initial = before.contracts.value.rows.find((row) => row.id === contract.id);
  const amended = await keiyaku.amend({ gates: [] });
  const after = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.equal(after.contracts.kind, "present");
  if (after.contracts.kind !== "present") return;
  const row = after.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.equal(row?.lastJournalAt, amended.facts.at(-1)?.at);
  assert.equal(row?.phaseAt, initial?.phaseAt);
});

test("bare Contract ages keep every unit boundary, future, and absent evidence distinct", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const sources = [
    ["59s", "2026-08-11T23:59:01.000Z"],
    ["1m", "2026-08-11T23:59:00.000Z"],
    ["59m", "2026-08-11T23:01:00.000Z"],
    ["1h", "2026-08-11T23:00:00.000Z"],
    ["23h", "2026-08-11T01:00:00.000Z"],
    ["1d", "2026-08-11T00:00:00.000Z"],
    ["future", "2026-08-12T00:00:01.000Z"],
  ] as const;
  const timedRows = sources.map(([label, lastJournalAt]) =>
    contractRow({
      id: `kei/age-${label}`,
      phaseAt: "2026-08-10T00:00:00.000Z",
      lastJournalAt,
    }),
  );
  const text = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows: timedRows } },
    },
    { columns: 120, color: false },
  );
  for (const [label] of sources) assert.match(text, new RegExp(`waiting · ${label === "future" ? "now" : label}`, "u"));
  assert.match(text, /stillborn · —/u);
});

test("Kanshi ANSI tones follow status and age while no-color bytes stay exact", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const reviewRows = [
    contractRow({
      id: "kei/review-fresh",
      phase: "tendered",
      phaseAt: "2026-08-11T23:45:01.000Z",
      lastJournalAt: "2026-08-11T23:45:01.000Z",
    }),
    contractRow({
      id: "kei/review-aged",
      phase: "tendered",
      phaseAt: "2026-08-11T23:45:00.000Z",
      lastJournalAt: "2026-08-11T23:45:00.000Z",
    }),
    contractRow({
      id: "kei/pending-aged",
      phase: "bound",
      phaseAt: "2026-08-11T23:00:00.000Z",
      lastJournalAt: "2026-08-11T23:00:00.000Z",
    }),
    contractRow({
      id: "kei/recent",
      phase: "bound",
      phaseAt: "2026-08-11T23:59:00.000Z",
      lastJournalAt: "2026-08-11T23:55:00.000Z",
    }),
  ];
  const policyReport = {
    ...report,
    contracts: { ...report.contracts, value: { ...report.contracts.value, rows: reviewRows } },
  };
  const plain = renderKanshiText(policyReport, { columns: 120, color: false });
  const colored = renderKanshiText(policyReport, { columns: 120, color: true });
  assert.equal(colored.replaceAll(/\u001b\[[0-9]+m/gu, ""), plain);
  assert.match(colored, /● kei\/review-fresh/u);
  assert.match(colored, /\u001b\[33m●\u001b\[0m kei\/review-aged/u);
  assert.match(colored, /\u001b\[33m●\u001b\[0m kei\/pending-aged/u);
  assert.match(colored, /\u001b\[32m●\u001b\[0m kei\/recent/u);

  const attentionPlain = renderKanshiText(report, { columns: 120, color: false });
  const attentionColored = renderKanshiText(report, { columns: 120, color: true });
  assert.equal(attentionColored.replaceAll(/\u001b\[[0-9]+m/gu, ""), attentionPlain);
  assert.match(attentionColored, /\u001b\[31m!\u001b\[0m kei\/active-contract/u);
  assert.match(attentionColored, /\u001b\[33m●\u001b\[0m kei\/cold-contract/u);
  assert.match(attentionColored, /\u001b\[32m●\u001b\[0m aku\/worker\/a0000001/u);
  assert.match(attentionColored, /\u001b\[2m○\u001b\[0m aku\/worker\/a0000002/u);
  assert.match(attentionColored, /\u001b\[2m×\u001b\[0m aku\/worker\/a0000003/u);
  assert.match(attentionColored, /\u001b\[31m!\u001b\[0m aku\/worker\/a0000004/u);

  if (report.akuma.kind !== "present") throw new Error("fixture Akuma must be present");
  const boundaryReport = {
    ...report,
    akuma: {
      ...report.akuma,
      value: {
        ...report.akuma.value,
        rows: report.akuma.value.rows.map((row) =>
          row.id === "aku/worker/a0000002" ? { ...row, lifeAt: "2026-08-11T23:55:00.000Z" } : row,
        ),
      },
    },
  };
  assert.match(
    renderKanshiText(boundaryReport, { columns: 120, color: true }),
    /\u001b\[32m○\u001b\[0m aku\/worker\/a0000002/u,
  );
});

test("Kanshi text uses live sections, preserves important facts, and omits terminal Contract and Task rows", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 120, color: false });

  assert.equal(text.split("\n", 1)[0], "契 KEIYAKU // WORLD");
  assert.match(text, /\n\nAKUMA \/\/ 7 recent/u);
  assert.match(text, /\n\nTASKS \/\/ 4 recent/u);
  assert.doesNotMatch(text, /attention|kanshi ───|──\[/u);
  assert.doesNotMatch(text, /^ {2}↳ /mu);
  assert.ok(text.indexOf("CONTRACTS //") < text.indexOf("AKUMA //"));
  assert.ok(text.indexOf("AKUMA //") < text.indexOf("TASKS //"));

  if (report.contracts.kind !== "present" || report.tasks.kind !== "present" || report.akuma.kind !== "present") {
    throw new Error("fixture sections must be present");
  }
  for (const row of report.contracts.value.rows.filter(
    (candidate) => candidate.phase !== "claimed" && candidate.phase !== "abandoned",
  ))
    assert.equal(text.includes(row.id), true);
  for (const row of report.tasks.value.rows.filter(
    (candidate) => candidate.disposition !== "done" && candidate.disposition !== "drop",
  ))
    assert.equal(text.includes(row.id), true);
  for (const row of report.akuma.value.rows) assert.equal(text.includes(row.id), true);

  const contracts = sectionBody(text, "KEIYAKU");
  assert.match(contracts, /^! kei\/active-contract · tendered · 30s · Active Contract$/mu);
  assert.match(contracts, /Active Contract/u);
  assert.match(contracts, /tendered/u);
  assert.match(contracts, /│ no candidate · target main/u);
  assert.match(contracts, /target main/u);
  assert.match(contracts, /7 commits behind main/u);
  assert.match(contracts, /target moved/u);
  assert.match(contracts, /tendered · 30s/u);
  assert.match(contracts, /\[✓\] reviewed/u);
  assert.match(contracts, /\[✗\] verified/u);
  assert.match(contracts, /\[~\] security \(stale\)/u);
  assert.match(contracts, /akuma 1 · 1 live/u);
  assert.doesNotMatch(contracts, /Investigate failed Linux verification|P0|activity/u);
  assert.doesNotMatch(contracts, /world summary should stay hidden/u);
  const cold = contracts.split("kei/cold-contract")[1]!;
  const nextCold = cold.search(/^[!●○✓?×] /mu);
  const coldBlock = nextCold === -1 ? cold : cold.slice(0, nextCold);
  assert.match(coldBlock, /Cold Contract/u);
  assert.match(coldBlock, /bound · 2h/u);
  assert.match(coldBlock, /target main/u);
  assert.doesNotMatch(contracts, /Terminal Contract/u);
  const unknown = contracts.split("kei/target-unknown")[1]!;
  const nextUnknown = unknown.search(/^[!●○✓?×] /mu);
  const unknownBlock = nextUnknown === -1 ? unknown : unknown.slice(0, nextUnknown);
  assert.match(unknownBlock, /Target Unknown/u);
  assert.match(unknownBlock, /commits behind release unknown/u);
  assert.doesNotMatch(unknownBlock, /commits behind main unknown/u);
  assert.doesNotMatch(contracts, /target unknown/u);
  assert.match(contracts, /no target/u);
  assert.doesNotMatch(contracts, /worktree |merge |\/repo\/\.keiyaku\/wt\//u);
  const selected = renderKanshiText(
    selectKanshi({ report, contract: "kei/active-contract" }),
    { columns: 120, color: false },
    "contract",
  );
  assert.match(selected, /tendered · 3m/u);
  assert.match(selected, /  candidate\/integration\n    no candidate/u);
  const active = report.contracts.value.rows.find((row) => row.id === "kei/active-contract");
  assert.equal(active?.phase, "tendered");
  assert.equal(JSON.parse(JSON.stringify(active)).phase, "tendered");

  const tasks = sectionBody(text, "TASK");
  assert.match(tasks, /^‖ task\/blocked · blocked · P0/mu);
  assert.match(tasks, /^● task\/running · in_progress · P0/mu);
  assert.match(tasks, /^⧗ task\/held(?: |$)/mu);
  assert.match(tasks, /^○ task\/ready(?: |$)/mu);
  assert.doesNotMatch(tasks, /^✓ task\/done$/mu);
  assert.doesNotMatch(tasks, /^× task\/dropped$/mu);
  assert.doesNotMatch(tasks, /^= /mu);
  assert.match(tasks, /blocked task\/release/u);
  assert.match(tasks, /blocked task\/missing/u);
  assert.match(tasks, /-> kei\/active-contract/u);
  assert.match(tasks, /Ready · unbound/u);
  assert.match(tasks, /Held · unbound/u);
  assert.doesNotMatch(tasks, /next:/u);

  const fleet = sectionBody(text, "FLEET");
  assert.match(fleet, /^● aku\/worker\/a0000001 \(@lead\) · running · 4m/mu);
  assert.match(fleet, /running · 4m/u);
  assert.match(fleet, /activity 5m/u);
  assert.doesNotMatch(fleet, /ACTIVITYactivity/u);
  const stranded = fleet.split("aku/worker/a0000006")[1]!;
  const nextStranded = stranded.search(/^[!●○✓?×] /mu);
  const strandedBlock = nextStranded === -1 ? stranded : stranded.slice(0, nextStranded);
  assert.match(strandedBlock, /stranded/u);
  assert.match(strandedBlock, /stranded · 2h/u);
  assert.match(strandedBlock, /activity 1h/u);
  assert.match(strandedBlock, /resume unsupported/u);
  assert.match(fleet, /-> kei\/missing-contract \(missing\)/u);
  assert.match(fleet, /asleep · 1d · unbound/u);
  assert.doesNotMatch(fleet, /asleep · 1d · activity/u);
  assert.match(fleet, /killed · 30s/u);
  assert.match(fleet, /hung · —/u);
  assert.match(fleet, /stillborn · —/u);
  assert.match(fleet, /unborn · —/u);
  assert.deepEqual(report, before);
});

test("world Contract rows make candidate facts self-describing", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const row = report.contracts.value.rows.find((candidate) => candidate.id === "kei/active-contract");
  if (row === undefined) throw new Error("fixture Contract must be present");
  const delivered = {
    ...row,
    delivery: {
      tenderSnapshot: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      integration: {
        predecessor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        snapshot: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        changeId: "chg-active-contract",
      },
      method: "squash" as const,
      policy: { requireBranchesToBeUpToDate: false },
    },
  };
  const deliveredReport = {
    ...report,
    contracts: { ...report.contracts, value: { ...report.contracts.value, rows: [delivered] } },
  };
  const text = renderKanshiText(deliveredReport, { columns: 120, color: false });
  assert.match(text, /CONTRACTS \/\/ 1 recent · 1 candidates/u);
  assert.doesNotMatch(text, /○ no candidate · ● candidate|satisfied  \[✗\] unsatisfied/u);
  const body = sectionBody(text, "KEIYAKU");
  assert.match(body, /│ candidate · target main/u);
  const selected = renderKanshiText(deliveredReport, { columns: 120, color: false }, "contract");
  assert.match(selected, /  candidate\/integration\n    tender /u);
  assert.doesNotMatch(selected, /candidate\/integration\n    candidate\n/u);
});

test("Contract LINKED entries stay compact and preserve endpoint disposition", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present" || report.akuma.kind !== "present") {
    throw new Error("fixture sections must be present");
  }
  const row = report.contracts.value.rows.find((candidate) => candidate.id === "kei/active-contract");
  if (row === undefined) throw new Error("fixture Contract must be present");
  const linkedRow = {
    ...row,
    fleet: [...row.fleet, { id: "aku/worker/missing", aliases: ["@missing"] }],
  };
  const compact = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows: [linkedRow] } },
    },
    { columns: 120, color: false },
  );
  const selected = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows: [linkedRow] } },
    },
    { columns: 120, color: false },
    "contract",
  );
  assert.match(sectionBody(compact, "KEIYAKU"), /akuma 2 · 1 live/u);
  assert.doesNotMatch(sectionBody(compact, "KEIYAKU"), /aku\/worker\//u);
  for (const text of [selected]) {
    assert.match(text, /● task\/running · in_progress/u);
    assert.match(text, /● aku\/worker\/a0000001 \(@lead\) · running/u);
    assert.match(text, /! aku\/worker\/missing \(@missing\) · missing/u);
    const linked = text
      .split("\n")
      .filter((line) => /task\/running|aku\/worker\/a0000001|aku\/worker\/missing/u.test(line))
      .join("\n");
    assert.doesNotMatch(linked, /Investigate failed Linux verification|P0|activity/u);
  }
  const missingTask = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows: [linkedRow] } },
      tasks: {
        ...report.tasks,
        value: { ...report.tasks.value, rows: report.tasks.value.rows.filter((task) => task.id !== "task/running") },
      },
    },
    { columns: 120, color: false },
    "contract",
  );
  assert.match(missingTask, /! task\/running · missing/u);

  const unavailable = renderKanshiText(
    {
      ...report,
      contracts: {
        ...report.contracts,
        value: { ...report.contracts.value, rows: [{ ...linkedRow, holder: { kind: "unavailable" } }] },
      },
      tasks: { kind: "failed", failure: { message: "task board unavailable" } },
      akuma: { kind: "failed", failure: { message: "fleet unavailable" } },
    },
    { columns: 120, color: false },
    "contract",
  );
  assert.match(unavailable, /! task · unavailable/u);
  assert.match(unavailable, /! aku\/worker\/a0000001 \(@lead\) · unavailable/u);
  assert.match(unavailable, /! aku\/worker\/missing \(@missing\) · unavailable/u);
});

test("world Contract attachments keep non-terminal Akuma and omit terminal retry history", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present")
    throw new Error("fixture sections must be present");
  const row = report.contracts.value.rows.find((candidate) => candidate.id === "kei/active-contract");
  if (row === undefined) throw new Error("fixture Contract must be present");
  const linkedRow = {
    ...row,
    fleet: [
      { id: "aku/worker/a0000001", aliases: ["@lead"] },
      { id: "aku/worker/a0000002", aliases: [] },
      { id: "aku/worker/a0000003", aliases: [] },
    ],
  };
  const text = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows: [linkedRow] } },
    },
    { columns: 120, color: false },
  );
  const body = sectionBody(text, "KEIYAKU");
  assert.match(body, /akuma 3 · 2 live · 1 terminal/u);
  assert.doesNotMatch(body, /aku\/worker\//u);
});

test("world Contract attachments keep one latest terminal Akuma when no executor is live", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present")
    throw new Error("fixture sections must be present");
  const row = report.contracts.value.rows.find((candidate) => candidate.id === "kei/active-contract");
  if (row === undefined) throw new Error("fixture Contract must be present");
  const older = { ...report.akuma.value.rows[2]!, id: "aku/worker/a0000008", lifeAt: "2026-08-11T23:00:00.000Z" };
  const text = renderKanshiText(
    {
      ...report,
      contracts: {
        ...report.contracts,
        value: {
          ...report.contracts.value,
          rows: [
            {
              ...row,
              fleet: [
                { id: older.id, aliases: [] },
                { id: "aku/worker/a0000003", aliases: [] },
              ],
            },
          ],
        },
      },
      akuma: { ...report.akuma, value: { ...report.akuma.value, rows: [...report.akuma.value.rows, older] } },
    },
    { columns: 120, color: false },
  );
  const body = sectionBody(text, "KEIYAKU");
  assert.match(body, /akuma 2 · 2 terminal/u);
  assert.doesNotMatch(body, /aku\/worker\//u);
});

test("selected Contract attachments retain terminal retry history", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present")
    throw new Error("fixture sections must be present");
  const row = report.contracts.value.rows.find((candidate) => candidate.id === "kei/active-contract");
  if (row === undefined) throw new Error("fixture Contract must be present");
  const older = { ...report.akuma.value.rows[2]!, id: "aku/worker/a0000008", lifeAt: "2026-08-11T23:00:00.000Z" };
  const selected = renderKanshiText(
    {
      ...report,
      contracts: {
        ...report.contracts,
        value: {
          ...report.contracts.value,
          rows: [
            {
              ...row,
              fleet: [
                { id: older.id, aliases: [] },
                { id: "aku/worker/a0000003", aliases: [] },
              ],
            },
          ],
        },
      },
      akuma: { ...report.akuma, value: { ...report.akuma.value, rows: [...report.akuma.value.rows, older] } },
    },
    { columns: 120, color: false },
    "contract",
  );
  assert.match(selected, /aku\/worker\/a0000008 · killed/u);
  assert.match(selected, /aku\/worker\/a0000003 · killed/u);
});

test("attachment projection leaves Task holder and report facts unchanged", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 120, color: false });
  assert.match(sectionBody(text, "KEIYAKU"), /● task\/running · in_progress/u);
  assert.deepEqual(report, before);
  assert.match(JSON.stringify(report), /"lifeAt":"2026-08-11T23:59:30.000Z"/u);
  assert.equal(JSON.stringify(report).includes('"fleet":[{"id":"aku/worker/a0000001"'), true);
});

test("Kanshi preserves the Akuma bounded aperture with one compact marker", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present" || report.akuma.kind !== "present")
    throw new Error("fixture sections must be present");
  const empty = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows: [] } },
      tasks: { ...report.tasks, value: { ...report.tasks.value, rows: [] } },
      akuma: { ...report.akuma, value: { ...report.akuma.value, rows: [] } },
    },
    { columns: 120, color: false },
  );
  assert.match(empty, /CONTRACTS \/\/ 0 recent · 0 candidates/u);
  assert.match(empty, /AKUMA \/\/ 0 recent/u);
  assert.match(empty, /TASKS \/\/ 0 recent/u);
  for (const section of ["KEIYAKU", "FLEET", "TASK"] as const) {
    assert.doesNotMatch(sectionBody(empty, section), /…|next:/u);
  }

  const oldAt = "2026-08-11T23:00:00.000Z";
  const newAt = "2026-08-11T23:59:00.000Z";
  const hotContracts = Array.from({ length: 11 }, (_, index) =>
    contractRow({
      id: `kei/hot-${index}`,
      phase: "tendered",
      lastJournalAt: oldAt,
    }),
  );
  const hotTasks = Array.from({ length: 11 }, (_, index) => ({
    ...report.tasks.value.rows[1]!,
    id: `task/hot-${index}`,
    updatedAt: oldAt,
  }));
  const hotAkuma = Array.from({ length: 11 }, (_, index) => ({
    ...report.akuma.value.rows[0]!,
    id: `aku/worker/hot${String(index).padStart(4, "0")}`,
    lifeAt: oldAt,
    lastActivityAt: oldAt,
  }));
  const partial = renderKanshiText(
    {
      ...report,
      contracts: {
        ...report.contracts,
        value: {
          ...report.contracts.value,
          rows: [...hotContracts, contractRow({ id: "kei/new-cold", lastJournalAt: newAt })],
        },
      },
      tasks: {
        ...report.tasks,
        value: {
          ...report.tasks.value,
          rows: [...hotTasks, { ...report.tasks.value.rows[3]!, id: "task/new-cold", updatedAt: newAt }],
        },
      },
      akuma: {
        ...report.akuma,
        value: {
          ...report.akuma.value,
          rows: hotAkuma.slice(0, 10),
          hasMore: true,
        },
      },
    },
    { columns: 120, color: false },
  );

  assert.match(partial, /AKUMA \/\/ 10 recent/u);
  assert.match(sectionBody(partial, "KEIYAKU"), /^○ kei\/new-cold · waiting · 1m/mu);
  assert.doesNotMatch(sectionBody(partial, "FLEET"), /new-cold/u);
  assert.match(sectionBody(partial, "TASK"), /^○ task\/new-cold · ready/mu);
  assert.doesNotMatch(partial, /hot-09|hot-10/u);
  assert.deepEqual(sectionBody(partial, "FLEET").match(/^…$/gmu), ["…"]);
  assert.doesNotMatch(partial, /all .* shown|not shown|\bfull\b|more available|next:/u);
});

test("Fleet ranks max owner timestamps and aligns snapshots with its recent-first display", () => {
  const report = attentionReport();
  if (report.akuma.kind !== "present") throw new Error("fixture Fleet must be present");
  const source = report.akuma.value.rows[0]!;
  const rows = [
    { ...source, id: "aku/worker/no-coordinate-first", life: "asleep" as const, lifeAt: null, lastActivityAt: null },
    {
      ...source,
      id: "aku/worker/tie-second",
      life: "asleep" as const,
      lifeAt: null,
      lastActivityAt: "2026-08-11T23:57:00.000Z",
    },
    {
      ...source,
      id: "aku/worker/life-next",
      life: "killed" as const,
      lifeAt: "2026-08-11T23:58:00.000Z",
      lastActivityAt: "2026-08-11T21:00:00.000Z",
    },
    { ...source, id: "aku/worker/no-coordinate-second", life: "asleep" as const, lifeAt: null, lastActivityAt: null },
    {
      ...source,
      id: "aku/worker/activity-newest",
      life: "asleep" as const,
      lifeAt: "2026-08-11T22:00:00.000Z",
      lastActivityAt: "2026-08-11T23:59:00.000Z",
    },
    {
      ...source,
      id: "aku/worker/tie-first",
      life: "asleep" as const,
      lifeAt: "2026-08-11T23:57:00.000Z",
      lastActivityAt: null,
    },
  ];
  const visible = visibleFleetRows(rows);
  assert.deepEqual(
    visible.map((row) => row.id),
    [
      "aku/worker/activity-newest",
      "aku/worker/life-next",
      "aku/worker/tie-first",
      "aku/worker/tie-second",
      "aku/worker/no-coordinate-first",
      "aku/worker/no-coordinate-second",
    ],
  );
  const snapshotRows = new Set(visible.slice(0, 3).map((row) => row.id));
  const decorated = visible.map((row) =>
    snapshotRows.has(row.id)
      ? {
          ...row,
          snapshot: {
            kind: "idle",
            entries: [],
            omitted: 0,
            outcome: {
              outcome: {
                kind: "answered",
                answer:
                  row === visible[0]
                    ? `snapshot ${row.id}\n${"long provider diagnostic ".repeat(20)}`
                    : `snapshot ${row.id}`,
              },
            },
          } as never,
        }
      : row,
  );
  const text = renderKanshiText(
    {
      ...report,
      akuma: { ...report.akuma, value: { ...report.akuma.value, rows: decorated } },
    },
    { columns: 120, color: false },
  );
  assert.match(text, /AKUMA \/\/ 6 recent/u);
  assert.doesNotMatch(text, /SNAPSHOT/u);
  assert.ok(
    text
      .split("\n")
      .filter((line) => line.includes('activity "'))
      .every((line) => displayColumns(line) <= 120),
  );
  for (const row of visible.slice(0, 3)) assert.match(text, new RegExp(`snapshot ${row.id.slice(0, 12)}`, "u"));
  for (const row of visible.slice(3)) assert.doesNotMatch(text, new RegExp(`snapshot ${row.id}`, "u"));
  const fleet = sectionBody(text, "FLEET");
  for (const [index, row] of visible.entries()) {
    const before = visible[index - 1];
    if (before !== undefined) assert.ok(fleet.indexOf(before.id) < fleet.indexOf(row.id));
  }
  assert.match(text, /no-coordinate-second/u);
});

test("Kanshi reads ActivitySnapshots for the first three final Fleet display rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-fleet-snapshots-"));
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

test("Fleet keeps a complete long Akuma identity beside narrow activity text", () => {
  const report = attentionReport();
  if (report.akuma.kind !== "present") throw new Error("fixture Fleet must be present");
  const id = `aku/worker/${"long-complete-id-".repeat(6)}`;
  const row = {
    ...report.akuma.value.rows[1]!,
    id,
    snapshot: {
      kind: "idle" as const,
      entries: [],
      omitted: 0,
      outcome: { outcome: { kind: "answered" as const, answer: "long semantic activity" } },
    },
  };
  const text = renderKanshiText(
    {
      ...report,
      akuma: { ...report.akuma, value: { ...report.akuma.value, rows: [row] } },
    },
    { columns: 24, color: false },
  );
  assert.match(text, new RegExp(id, "u"));
  assert.match(text, /activity "long sem/u);
  const activity = text.split("\n").find((line) => line.includes('activity "'));
  assert.notEqual(activity, undefined);
  assert.ok(displayColumns(activity!) <= 24);
});

test("unappointed managed Contracts render without a worktree path", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const rows = report.contracts.value.rows.map((row) =>
    row.id === "kei/cold-contract"
      ? {
          ...row,
          worktreePath: null,
          workspaceObservation: { kind: "unappointed" as const },
        }
      : row,
  );
  const text = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows } },
    },
    { columns: 120, color: false },
  );
  assert.match(text, /● kei\/cold-contract · bound · 2h · Cold Contract/u);
  assert.doesNotMatch(text, /DIR\s+.*cold-contract/u);
  assert.doesNotMatch(text, /kei\/cold-contract[\s\S]*↳ /u);
});

test("exact Contract Kanshi text keeps terminal gates and testimony summaries", () => {
  const selected = selectKanshi({ report: attentionReport(), contract: "kei/terminal-contract" });
  const text = renderKanshiText(selected, { columns: 80, color: false }, "contract");

  assert.match(text, /^✓ kei\/terminal-contract · claimed · 2d · Terminal Contract$/mu);
  assert.match(text, /  gates\n    \[✓\] reviewed/u);
  assert.match(text, /reviewed: terminal review summary/u);
  assert.doesNotMatch(text, /kei\/active-contract/u);
  assert.doesNotMatch(text, /^kanshi /u);
  assert.doesNotMatch(text, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
  assert.doesNotMatch(text, /\d+ (?:keiyaku|task|akuma) · \d+ attention/u);
});

test("Kanshi wraps titles without dropping coordinates or gates", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 20, color: false });
  assert.ok(text.split("\n").every((line) => !line.includes("…") && !line.includes("...")));
  assert.match(text, /Active Contract/u);
  assert.doesNotMatch(text, /\b(?:TITLE|STATE|GIT|DIR|GATES|LINKED|LIFE|ACTIVITY)\b/u);
  assert.equal(text.includes("kei/active-contract"), true);
  assert.equal(text.includes("/repo/.keiyaku/wt/active-contract"), false);
  assert.match(text, /verified/u);
  assert.match(text, /7 commits behind main/u);
  assert.match(text, /target moved/u);
  assert.equal(text.includes("\u001b"), false);
  assert.deepEqual(report, before);
});

test("Kanshi target movement names expected and observed heads, including a disappeared target", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const expected = snapshotId("b".repeat(40));
  const observed = snapshotId("d".repeat(40));
  const rows = report.contracts.value.rows.map((row) =>
    row.id === "kei/active-contract"
      ? {
          ...row,
          delivery: {
            tenderSnapshot: expected,
            integration: { predecessor: expected, snapshot: expected, changeId: changeId("chg-kanshi-moved") },
            method: "squash" as const,
            policy: { requireBranchesToBeUpToDate: false },
          },
          targetObservation: { head: observed, drift: true },
        }
      : row,
  );
  const movedReport = { ...report, contracts: { ...report.contracts, value: { ...report.contracts.value, rows } } };
  const world = renderKanshiText(movedReport, { columns: 120, color: false });
  assert.match(world, /target moved · bbbbbbb -> ddddddd/u);
  const selected = renderKanshiText(
    {
      ...movedReport,
      contracts: { ...movedReport.contracts, value: { ...movedReport.contracts.value, rows: [rows[1]!] } },
    },
    { columns: 120, color: false },
    "contract",
  );
  assert.match(selected, /target moved\n    bbbbbbb -> ddddddd/u);

  const disappearedRows = rows.map((row) =>
    row.id === "kei/active-contract" ? { ...row, targetObservation: { head: null, drift: true } } : row,
  );
  const disappeared = renderKanshiText(
    {
      ...movedReport,
      contracts: { ...movedReport.contracts, value: { ...movedReport.contracts.value, rows: disappearedRows } },
    },
    { columns: 120, color: false },
  );
  assert.match(disappeared, /target moved · bbbbbbb -> null/u);
});

test("Kanshi retains a Contract whose title is unavailable", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const rows = report.contracts.value.rows.map((row) => (row.id === "kei/no-target" ? { ...row, title: null } : row));
  const text = renderKanshiText(
    {
      ...report,
      contracts: { ...report.contracts, value: { ...report.contracts.value, rows } },
    },
    { columns: 80, color: false },
  );
  const contracts = sectionBody(text, "KEIYAKU");
  assert.match(contracts, /^\? kei\/no-target · waiting · 30s · title unavailable$/mu);
  assert.match(contracts, /title unavailable/u);
  assert.match(text, /CONTRACTS \/\/ 5 recent · 0 candidates/u);
});

test("Kanshi wraps complete Task titles on the plumb line", () => {
  const report = attentionReport();
  if (report.tasks.kind !== "present") throw new Error("fixture tasks must be present");
  const title = "Trace narrow title wrapping exactly";
  const narrowReport: KanshiReport = {
    ...report,
    tasks: {
      ...report.tasks,
      value: {
        ...report.tasks.value,
        rows: report.tasks.value.rows.map((row) => (row.id === "task/running" ? { ...row, title } : row)),
      },
    },
  };
  const text = renderKanshiText(narrowReport, { columns: 20, color: false });
  assert.equal(text.includes("Trace"), true);
  assert.equal(text.includes("wrapping"), true);
  assert.equal(text.includes("exactly"), true);
  assert.equal(text.includes("task/running"), true);
  assert.match(text, /-> kei\/active-contract/u);
});

test("Kanshi has no Contract gate-block cap", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const gates = Array.from({ length: 24 }, (_, index) => ({
    gate: `gate-${String(index).padStart(2, "0")}`,
    current: { kind: "missing" as const },
  }));
  const cappedReport: KanshiReport = {
    ...report,
    contracts: {
      ...report.contracts,
      value: {
        ...report.contracts.value,
        rows: report.contracts.value.rows.map((row) =>
          row.id === "kei/active-contract" ? { ...row, gates: { ...row.gates, reports: gates } } : row,
        ),
      },
    },
  };
  const text = renderKanshiText(cappedReport, { columns: 20, color: false });
  for (const gate of gates) assert.match(text, new RegExp(`\\[ \\] ${gate.gate}`, "u"));
});

test("absent and failed Kanshi sections stay typed and distinct from empty present sections", () => {
  const failed = renderKanshiText(
    {
      root: "/repo",
      observedAt: "2026-08-12T00:00:00.000Z",
      branch: null,
      contracts: { kind: "failed", failure: { message: "broken board" } },
      tasks: { kind: "absent" },
      akuma: { kind: "present", value: { observedAt: "2026-08-12T00:00:00.000Z", searched: [], rows: [], hasMore: false } },
    },
    { columns: 80, color: false },
  );
  assert.match(failed, /^CONTRACTS \/\/ unavailable/mu);
  assert.match(failed, /! broken board/u);
  assert.match(failed, /TASKS \/\/ absent/u);
  assert.match(failed, /tasks absent/u);
  assert.match(failed, /AKUMA \/\/ 0 recent/u);
  assert.doesNotMatch(failed, /next:/u);

  const absent = renderKanshiText(
    {
      root: "/repo",
      observedAt: "2026-08-12T00:00:00.000Z",
      branch: null,
      contracts: { kind: "absent" },
      tasks: { kind: "absent" },
      akuma: { kind: "absent" },
    },
    { columns: 80, color: false },
  );
  assert.match(absent, /CONTRACTS \/\/ absent/u);
  assert.match(absent, /AKUMA \/\/ absent/u);
  assert.match(absent, /TASKS \/\/ absent/u);
  assert.doesNotMatch(absent, /(?:CONTRACTS|AKUMA|TASKS) \/\/ 0/u);
});

test("selected Contract text uses deliberate entity rows at 72 columns", () => {
  const report = attentionReport();
  const selected = renderKanshiText(
    selectKanshi({ report, contract: "kei/active-contract" }),
    { columns: 72, color: false },
    "contract",
  );
  assert.match(selected, /^! tendered · 3m\n  kei\/active-contract\n  Active Contract$/mu);
  assert.doesNotMatch(selected, /^! kei\/active-contract · tendered/mu);
});

test("Kanshi selection is a projection that preserves source presence", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  const selected = selectKanshi({ report, contract: contract.id });
  assert.equal(selected.contracts.kind, "present");
  assert.equal(selected.tasks.kind, "present");
  assert.equal(selected.akuma.kind, "present");
  if (selected.contracts.kind !== "present" || selected.tasks.kind !== "present" || selected.akuma.kind !== "present")
    return;
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

test("Kanshi text neutralizes control characters from source diagnostics", () => {
  const text = renderKanshiText(
    {
      root: "/repo\u001b[31m\nforged",
      observedAt: "2026-08-12T00:00:00.000Z",
      branch: null,
      contracts: { kind: "failed", failure: { message: "broken\u001b[2J\nforged\u2028again\u2029end" } },
      tasks: { kind: "absent" },
      akuma: { kind: "absent" },
    },
    { columns: 40, color: false },
  );
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("\nforged"), false);
  assert.equal(text.includes("\u2028"), false);
  assert.equal(text.includes("\u2029"), false);
  assert.match(text, /broken.*forged/u);
});

test("target lag counts the frozen targetObservation head after the live ref moves", async () => {
  const { repository, contract } = await populatedWorld();
  const frozen = repository.run(["rev-parse", "refs/heads/main"]).trim();
  repository.run(["checkout", "--quiet", "-b", "stay"]);
  const log = join(repository.path, "kanshi-target-race.log");
  writeFileSync(log, "");
  const first = join(tmpdir(), `keiyaku-target-first-${process.pid}`);
  const moved = join(tmpdir(), `keiyaku-target-moved-${process.pid}`);

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
  assert.deepEqual(row?.targetLag, { kind: "counted", behind: 0 });
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
});

test("Kanshi Task marks follow the kanshi.md disposition vocabulary", () => {
  const report = attentionReport();
  if (report.tasks.kind !== "present") throw new Error("fixture tasks must be present");
  const expected = {
    "task/blocked": "‖",
    "task/running": "●",
    "task/held": "⧗",
    "task/ready": "○",
    "task/done": "✓",
    "task/dropped": "×",
  } as const;
  const text = renderKanshiText(report, { columns: 80, color: false });
  const tasks = sectionBody(text, "TASK");
  for (const [id, mark] of Object.entries(expected).filter(([id]) => id !== "task/done" && id !== "task/dropped")) {
    assert.match(tasks, new RegExp(`^${mark} ${id}(?: |$)`, "mu"));
  }
  assert.doesNotMatch(tasks, /^= /mu);
});

test("default CLI status returns the Kanshi report instead of a generic observation", async () => {
  const { repository } = await populatedWorld();
  const result = await invoke(parseArgv(["-C", repository.path, "status"]));
  assert.equal((result as { kind: string }).kind, "status");
  if ("kind" in result && result.kind === "status") {
    assert.equal(result.selection, "world");
    assert.equal(result.report.contracts.kind, "present");
    if (result.report.contracts.kind === "present") assert.equal(result.report.contracts.value.state?.length, 40);
    assert.equal("state" in result.report, false);
    assert.equal(new Date(result.report.observedAt).toISOString(), result.report.observedAt);
    assert.doesNotThrow(() => JSON.stringify(result.report));
  }
});

function taskDocument(
  input: Readonly<{
    id: TaskId;
    title: string;
    state?: TaskDocument["state"];
    priority?: TaskDocument["priority"];
    createdBy?: string;
  }>,
): TaskDocument {
  return {
    id: input.id,
    title: input.title,
    body: "",
    note: "",
    state: input.state ?? "open",
    priority: input.priority ?? 2,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

test("Contract namespace Tasks come from one Task board observation", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const world = await World.at(repository.path);
  const segment = contractSegment(contract.id);
  assert.deepEqual(contractNamespace(contract.id), ["kei", segment]);
  const sibling = contractId("kei/other-contract");
  const writeTask = (document: TaskDocument): void => {
    const path = authorityPath(world, document.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeTaskDocument(document));
  };
  writeTask(taskDocument({ id: "task/root-unbound", title: "Root unbound", priority: 0 }));
  writeTask(
    taskDocument({
      id: `task/kei/${segment}/alpha`,
      title: "Namespace alpha",
      state: "done",
      priority: 3,
    }),
  );
  writeTask(
    taskDocument({
      id: `task/kei/${segment}/zeta`,
      title: "Namespace zeta",
      state: "on_hold",
      priority: 0,
    }),
  );
  writeTask(
    taskDocument({
      id: `task/kei/${segment}/child/nested`,
      title: "Nested descendant",
      priority: 0,
    }),
  );
  writeTask(
    taskDocument({
      id: `task/kei/${contractSegment(sibling)}/sibling`,
      title: "Sibling namespace",
      priority: 0,
    }),
  );

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  const board = projectTaskBoardObservation((await readBoard(world)).board);
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present") return;
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.equal(row?.namespaceTasks.kind, "present");
  if (row?.namespaceTasks.kind !== "present") return;
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
    board.statusRows.map((task) => ({
      id: task.id,
      disposition: task.disposition,
      blockers: task.blockers,
    })),
  );

  const selected = selectKanshi({ report, contract: contract.id });
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
  assert.match(selectedText, new RegExp(String.raw`⧗ task/kei/${segment}/zeta · P0 on_hold — Namespace zeta`, "u"));
  assert.match(selectedText, new RegExp(String.raw`✓ task/kei/${segment}/alpha · P3 done — Namespace alpha`, "u"));
  assert.doesNotMatch(selectedText, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
});

test("Task board failure fails namespace context without suppressing Contract or Akuma", async () => {
  const { repository, contract, akumaId } = await populatedWorld();
  writeFileSync(join(repository.path, ".keiyaku", "tasks", "bad.md"), "not a task document\n");
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present") return;
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.equal(row?.namespaceTasks.kind, "failed");
  if (row?.namespaceTasks.kind === "failed") assert.match(row.namespaceTasks.failure.message, /front matter/u);
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
