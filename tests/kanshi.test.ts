import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
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
import { kanshi, selectKanshi, type KanshiReport } from "../src/kanshi/index.js";
import { Tasks } from "../src/task/index.js";
import { authorityPath } from "../src/task/store.js";
import { World } from "../src/world.js";
import { moveAlias } from "../src/alias/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function observe(path: string, repo?: Repo) {
  return kanshi({ world: World.at(path), ...(repo === undefined ? {} : { repo }) });
}

function document(title = "Kanshi contract"): string {
  return [
    `# ${title}`, "", "## Context", "status", "", "## Objective", "render", "",
    "## Design", "project public values", "", "## Region", "```", "src/**", "```", "",
    "## Criteria", "### Visible", "The status row is visible.", "",
  ].join("\n");
}

function bornAkuma(root: string, suffix: string) {
  const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "watcher", draw: () => suffix });
  initializeHeart(allocated.paths);
  const leash = HeldAkumaLeash.try(allocated.paths)!;
  leash.birth(allocated.paths, {
    id: allocated.id,
    archetype: "watcher",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "unconfined" },
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  leash.release();
  return allocated.id;
}

async function populatedWorld() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const tasks = Tasks.of(World.at(repository.path));
  const added = await tasks.add({ title: "Render status", priority: 0 });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") throw new Error("task add failed");
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    task: added.value.id,
    markdown: document(),
    workspace: "here",
    target: "main",
  });
  const contract = await bound.keiyaku.state();
  const renamed = await tasks.task({ id: added.value.id }).update({ title: "Investigate status rendering" });
  assert.equal(renamed.kind, "accepted");
  await tasks.task({ id: added.value.id }).start();
  const akumaId = bornAkuma(repository.path, "a0000001");
  assert.equal(publishDispatch({ repository: repositoryAt(repository.path), akuId: akumaId, contractId: contract.id }).kind, "dispatched");
  await moveAlias({ world: repository.path, alias: "@watch", akuId: akumaId });
  return { repository, contract, taskId: added.value.id, akumaId };
}

function gitInvocations(path: string): readonly string[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

async function observedGitInvocations(repository: ReturnType<typeof makeGitRepository>): Promise<readonly string[]> {
  const log = join(repository.path, "kanshi-git-invocations.log");
  writeFileSync(log, "");
  await withGitShim(
    "printf '%s\\n' \"$*\" >> \"$KEIYAKU_KANSHI_GIT_LOG\"\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_KANSHI_GIT_LOG: log },
    () => observe(repository.path, Repo.at({ path: repository.path })),
  );
  return gitInvocations(log);
}

function deleteLooseObject(repository: ReturnType<typeof makeGitRepository>, oid: string): void {
  unlinkSync(join(repository.path, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
}

test("one-target Kanshi observation has a seven-process Git topology", async () => {
  const { repository } = await populatedWorld();
  const tasks = Tasks.of(World.at(repository.path));
  const added = await tasks.add({ title: "Second status row" });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") return;
  const bound = await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    task: added.value.id,
    markdown: document("Second Kanshi contract"),
    workspace: "worktree",
    target: "main",
  });
  const secondContract = await bound.keiyaku.state();
  const secondAkuma = bornAkuma(repository.path, "a0000009");
  assert.equal(publishDispatch({
    repository: repositoryAt(repository.path),
    akuId: secondAkuma,
    contractId: secondContract.id,
  }).kind, "dispatched");
  const invocations = await observedGitInvocations(repository);

  assert.equal(invocations.length, 6);
  assert.equal(invocations.filter((command) => command === "worktree list --porcelain -z").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --path-format=absolute --git-common-dir").length, 1);
  assert.equal(invocations.filter((command) => command === "symbolic-ref --quiet HEAD").length, 1);
  assert.equal(invocations.filter((command) => command === `rev-parse --verify --quiet ${GIT_REF}`).length, 1);
  assert.equal(invocations.some((command) => command.startsWith("ls-tree ")), false);
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.some((command) => command.startsWith("cat-file blob ")), false);
});

test("Kanshi Git topology adds one ref read per distinct Contract target", async () => {
  const { repository } = await populatedWorld();
  repository.run(["branch", "other"]);
  await Keiyaku.bind({
    repo: Repo.at({ path: repository.path }),
    markdown: document("Other target contract"),
    workspace: "worktree",
    target: "other",
  });

  const invocations = await observedGitInvocations(repository);

  assert.equal(invocations.length, 7);
  assert.equal(invocations.filter((command) => command === "rev-parse --path-format=absolute --git-common-dir").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/other").length, 1);
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
});

test("a dead shared Kanshi batch fails every Git-backed owner without restarting", async () => {
  const { repository } = await populatedWorld();
  const log = join(repository.path, "kanshi-dead-batch.log");
  writeFileSync(log, "");

  const report = await withGitShim(
    [
      "printf '%s\\n' \"$*\" >> \"$KEIYAKU_KANSHI_GIT_LOG\"",
      "if [ \"$1 $2\" = \"cat-file --batch\" ]; then exit 74; fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_KANSHI_GIT_LOG: log },
    () => observe(repository.path, Repo.at({ path: repository.path })),
  );

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "failed");
  assert.equal(gitInvocations(log).filter((command) => command === "cat-file --batch").length, 1);
});

test("a missing Contract object fails only the Contract-dependent section", async () => {
  const { repository, contract } = await populatedWorld();
  const snapshot = readGit(repositoryAt(repository.path));
  deleteLooseObject(repository, snapshot.paths.get(contractJournalPath(contract.id))!.oid);

  const report = await observe(repository.path, Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
});

test("a missing TaskHolder object fails only the TaskHolder-dependent section", async () => {
  const { repository } = await populatedWorld();
  const snapshot = readGit(repositoryAt(repository.path));
  const holder = [...snapshot.paths].find(([path]) => path.startsWith("settlement/task-holders/"));
  assert.notEqual(holder, undefined);
  deleteLooseObject(repository, holder![1].oid);

  const report = await observe(repository.path, Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "present");
  if (report.contracts.kind === "present") {
    assert.equal(report.contracts.value.rows.every((row) => row.holder.kind === "unavailable"), true);
  }
});

test("a missing Dispatch object fails only the Dispatch-dependent section", async () => {
  const { repository } = await populatedWorld();
  const snapshot = readGit(repositoryAt(repository.path));
  const dispatch = [...snapshot.paths].find(([path]) => path.startsWith("dispatch/"));
  assert.notEqual(dispatch, undefined);
  deleteLooseObject(repository, dispatch![1].oid);

  const report = await observe(repository.path, Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("a corrupt shared Git format fails every state-backed Kanshi section", async () => {
  const { repository } = await populatedWorld();
  const git = repositoryAt(repository.path);
  const snapshot = readGit(git);
  const tree = updateGitTree(git, snapshot.tree, new Map([
    [GIT_FORMAT_PATH, { oid: writeBlob(git, "not the current format\n") }],
  ]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");

  const report = await observe(repository.path, Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "failed");
});

test("kanshi joins TaskHolder, Dispatch, and Alias without moving their authorities", async () => {
  const { repository, contract, taskId, akumaId } = await populatedWorld();
  const report = await observe(repository.path, Repo.at({ path: repository.path }));
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
  assert.equal(report.contracts.value.state, readGit(repositoryAt(repository.path)).commit);
  assert.equal("state" in report, false);
  assert.equal(new Date(report.observedAt).toISOString(), report.observedAt);
  assert.deepEqual(report.contracts.value.rows.find((row) => row.id === contract.id)?.holder, {
    kind: "held",
    taskId,
  });
  assert.deepEqual(report.tasks.value.rows.find((row) => row.id === taskId)?.contract, {
    id: contract.id,
    observed: "active",
  });
});

test("kanshi keeps absent Contract and Task worlds explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-no-git-"));
  const akumaId = bornAkuma(root, "a0000002");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.tasks.kind === "present") assert.deepEqual(report.tasks.value.rows, []);
  if (report.akuma.kind === "present") {
    const row = report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
    assert.equal(row?.id, akumaId);
    assert.equal(row === undefined ? false : "contract" in row, false);
  }
});

test("a Task world without Git has no invented Contract endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-task-only-"));
  const tasks = Tasks.of(World.at(root));
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
});

test("a malformed TaskHolder root fails only the Kanshi Task section", async () => {
  const { repository } = await populatedWorld();
  const git = repositoryAt(repository.path);
  const snapshot = readGit(git);
  const tree = updateGitTree(git, snapshot.tree, new Map([
    ["settlement/task-holders", { oid: writeBlob(git, "not holder authority\n") }],
  ]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");

  const report = await observe(repository.path, Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "present");
  if (report.tasks.kind === "failed") assert.match(report.tasks.failure.message, /TaskHolder authority root is not a tree/u);
  if (report.contracts.kind === "present") {
    assert.equal(report.contracts.value.rows.every((row) => row.holder.kind === "unavailable"), true);
  }
});

test("a malformed Contract journal fails only the Kanshi Contract section", async () => {
  const { repository, contract } = await populatedWorld();
  const git = repositoryAt(repository.path);
  const snapshot = readGit(git);
  const tree = updateGitTree(git, snapshot.tree, new Map([
    [contractJournalPath(contract.id), { oid: writeBlob(git, "not a Contract journal\n") }],
  ]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");

  const report = await observe(repository.path, Repo.at({ path: repository.path }));

  assert.equal(report.contracts.kind, "failed");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
});

test("kanshi samples observedAt before section reads", async () => {
  const { repository } = await populatedWorld();
  const original = Date.prototype.toISOString;
  const currentBranch = Repo.prototype.currentBranch;
  let sampled = false;
  Date.prototype.toISOString = function() { sampled = true; return original.call(this); };
  Repo.prototype.currentBranch = async function() {
    assert.equal(sampled, true);
    return currentBranch.call(this);
  };
  try {
    await observe(repository.path, Repo.at({ path: repository.path }));
  } finally {
    Date.prototype.toISOString = original;
    Repo.prototype.currentBranch = currentBranch;
  }
});

test("a failed branch observation does not suppress readable Contract state", async () => {
  const { repository } = await populatedWorld();
  const currentBranch = Repo.prototype.currentBranch;
  Repo.prototype.currentBranch = async function() { throw new Error("branch unavailable"); };
  try {
    const report = await observe(repository.path, Repo.at({ path: repository.path }));
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
  const tasks = Tasks.of(World.at(root));
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
  bornAkuma(root, "a0000003");
  mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "akuma", "alias.json"), "not alias authority\n");
  const report = await observe(root);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("malformed Dispatch fails only the Kanshi Akuma section", async () => {
  const { repository } = await populatedWorld();
  const git = repositoryAt(repository.path);
  const snapshot = readGit(git);
  const tree = updateGitTree(git, snapshot.tree, new Map([
    ["dispatch", { oid: writeBlob(git, "not dispatch authority\n") }],
  ]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");
  const report = await observe(repository.path, Repo.at({ path: repository.path }));
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

test("Kanshi text keeps complete identities in the new fixed section grammar", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const report = await observe(repository.path, Repo.at({ path: repository.path }));
  const text = renderKanshiText(report, { columns: 20, color: false });
  const world = World.at(repository.path);
  assert.match(text, new RegExp(`^kanshi ${world.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  assert.doesNotMatch(text, /marks |root |─/u);
  assert.equal(text.includes(contract.id), true);
  assert.equal(text.includes(taskId), true);
  assert.match(text, new RegExp(`^● ${taskId} in_progress$`, "mu"));
  assert.match(text, /Investigate status\s+rendering/u);
  assert.match(text, /keiyaku kei\/.*\(active\)/u);
  assert.match(text, /akuma 1/u);
  assert.match(text, /\? aku\/watcher\/a0000001 stranded/u);
});

function attentionReport(): KanshiReport {
  return {
    root: "/repo",
    observedAt: "2026-08-12T00:00:00.000Z",
    branch: "refs/heads/main",
    contracts: {
      kind: "present",
      value: {
        root: "/repo",
        state: "cccccccccccccccccccccccccccccccccccccccc",
        rows: [
          {
            id: "kei/terminal-contract",
            phase: "claimed",
            disposition: "terminal",
            workspace: "worktree",
            worktreePath: "/repo/.keiyaku/worktrees/terminal-contract",
            target: "refs/heads/main",
            delivery: { tenderSnapshot: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", integration: { predecessor: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", snapshot: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", changeId: "patch-b" }, method: "squash", policy: { requireBranchesToBeUpToDate: false } },
            targetObservation: { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", drift: false },
            holder: { kind: "none" },
            gates: {
              satisfied: true,
              reports: [
                { gate: "reviewed", current: { kind: "attested", verdict: "satisfied", summary: "terminal review summary" } },
              ],
            },
          },
          {
            id: "kei/active-contract",
            phase: "pending-delivery",
            disposition: "active",
            workspace: "worktree",
            worktreePath: "/repo/.keiyaku/worktrees/active-contract",
            target: "refs/heads/main",
            delivery: { tenderSnapshot: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", integration: { predecessor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", snapshot: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", changeId: "patch-a" }, method: "squash", policy: { requireBranchesToBeUpToDate: false } },
            targetObservation: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drift: false },
            holder: { kind: "held", taskId: "task/running" },
            gates: {
              satisfied: false,
              reports: [
                { gate: "reviewed", current: { kind: "attested", verdict: "satisfied", summary: "world summary should stay hidden" } },
                { gate: "verified", current: { kind: "attested", verdict: "unsatisfied", summary: "tests failed" } },
                { gate: "security", current: { kind: "stale", priorVerdict: "satisfied" } },
                { gate: "manual", current: { kind: "missing" } },
              ],
            },
          },
        ],
      },
    },
    tasks: {
      kind: "present",
      value: {
        root: "/repo",
        rows: [
          { id: "task/blocked", title: "Blocked by release evidence", state: "open", priority: 0, disposition: "blocked", blockers: [
            { id: "task/release", title: "Release", state: "in_progress" },
            { id: "task/missing", title: null, state: "missing" },
          ] },
          { id: "task/running", title: "Investigate failed Linux verification", state: "in_progress", priority: 0, disposition: "in_progress" },
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
        searched: ["/repo/.keiyaku/akuma/run"],
        rows: [
          { id: "aku/worker/a0000001", archetype: "worker", life: "running", collar: { kind: "gone", end: null }, confinement: { kind: "unconfined" }, pending: [] },
          { id: "aku/worker/a0000002", archetype: "worker", life: "asleep", collar: { kind: "gone", end: null }, confinement: { kind: "unconfined" }, pending: [] },
          { id: "aku/worker/a0000003", archetype: "worker", life: "killed", collar: { kind: "gone", end: null }, confinement: { kind: "unconfined" }, pending: [] },
          { id: "aku/worker/a0000004", life: "stillborn", seal: { at: "2026-08-10T00:00:00.000Z", evidence: "\u001b[31mstillborn seal evidence is deliberately much longer than a narrow terminal\nsecond line must not render" } },
          { id: "aku/worker/a0000005", life: "unborn" },
          { id: "aku/worker/a0000006", archetype: "worker", life: "stranded", collar: { kind: "gone", end: null }, confinement: { kind: "unconfined" }, pending: ["pending"] },
          { id: "aku/worker/a0000007", archetype: "worker", life: "headless", collar: { kind: "alive" }, confinement: { kind: "unconfined" }, pending: [] },
        ],
      },
    },
  } as unknown as KanshiReport;
}

test("bare Kanshi text triages every section without changing its report", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 120, color: false });

  assert.match(text, /^kanshi \/repo$/mu);
  assert.match(text, /^state cccccccc · main · observed 2026-08-12T00:00:00\.000Z$/mu);
  assert.doesNotMatch(text, /marks |root |─/u);
  assert.match(text, /keiyaku 2/u);
  assert.match(text, /^⧗ kei\/active-contract pending-delivery$/mu);
  assert.match(text, /^  worktree · integration aaaaaaaa · -> refs\/heads\/main$/mu);
  assert.match(text, /^  ✓ reviewed · ! verified · \? security · \? manual$/mu);
  assert.match(text, /^  held by task\/running$/mu);
  assert.ok(text.indexOf("kei/active-contract") < text.indexOf("kei/terminal-contract"));
  assert.doesNotMatch(text, /integration a{9}/u);
  assert.doesNotMatch(text, /stale/u);
  assert.doesNotMatch(text, /world summary should stay hidden/u);
  assert.doesNotMatch(text, /terminal review summary/u);

  assert.match(text, /^task 4 · 1 ready · 1 held$/mu);
  assert.match(text, /^⧗ task\/blocked blocked$/mu);
  assert.match(text, /^● task\/running in_progress$/mu);
  assert.ok(text.indexOf("⧗ task/blocked") < text.indexOf("● task/running"));
  assert.match(text, /Investigate failed Linux verification/u);
  assert.match(text, /Blocked by release evidence/u);
  assert.match(text, /^  blocked by task\/release \(in_progress\)$/mu);
  assert.match(text, /^  blocked by task\/missing \(missing\)$/mu);
  assert.doesNotMatch(text, /^\+ /mu);
  assert.doesNotMatch(text, /task\/held/u);
  assert.doesNotMatch(text, /task\/ready/u);
  assert.doesNotMatch(text, /task\/done/u);
  assert.doesNotMatch(text, /task\/dropped/u);

  assert.match(text, /akuma 7/u);
  assert.match(text, /^! aku\/worker\/a0000004 stillborn$/mu);
  assert.match(text, /^\? aku\/worker\/a0000006 stranded$/mu);
  assert.match(text, /^\? aku\/worker\/a0000007 headless$/mu);
  assert.match(text, /^● aku\/worker\/a0000001 running$/mu);
  assert.match(text, /^○ aku\/worker\/a0000002 asleep$/mu);
  assert.match(text, /^× aku\/worker\/a0000003 killed$/mu);
  assert.ok(text.indexOf("a0000004") < text.indexOf("a0000006"));
  assert.ok(text.indexOf("a0000006") < text.indexOf("a0000007"));
  assert.ok(text.indexOf("a0000007") < text.indexOf("a0000001"));
  assert.match(text, /^  pending 1 · unconfined$/mu);
  assert.match(text, /^  unconfined$/mu);
  assert.match(text, /\? aku\/worker\/a0000005\s+unborn/u);
  assert.doesNotMatch(text, /searched \/repo/u);
  assert.deepEqual(report, before);
});

test("exact Contract Kanshi text keeps terminal gates and testimony summaries", () => {
  const selected = selectKanshi({ report: attentionReport(), contract: "kei/terminal-contract" });
  const text = renderKanshiText(selected, { columns: 80, color: false }, "contract");

  assert.match(text, /^✓ kei\/terminal-contract claimed$/mu);
  assert.match(text, /^  ✓ reviewed$/mu);
  assert.match(text, /^  reviewed: terminal review summary$/mu);
  assert.doesNotMatch(text, /kei\/active-contract/u);
});

test("Kanshi wraps gates and bounded stillborn evidence by display columns", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 20, color: false });
  const lines = text.split("\n");
  const seal = lines.find((line) => line.startsWith("  seal "));

  assert.match(text, /^  ✓ reviewed$/mu);
  assert.match(text, /^  ! verified$/mu);
  assert.match(text, /^  \? security$/mu);
  assert.match(text, /^  \? manual$/mu);
  assert.notEqual(seal, undefined);
  assert.ok(displayColumns(seal!) <= 20);
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("second line must not render"), false);
  assert.deepEqual(report, before);
});

test("Kanshi wraps complete Task titles and neutralizes continuation facts", () => {
  const report = attentionReport();
  if (report.tasks.kind !== "present" || report.akuma.kind !== "present") throw new Error("fixture sections must be present");
  const title = "Trace narrow title wrapping exactly";
  const narrowReport: KanshiReport = {
    ...report,
    tasks: {
      ...report.tasks,
      value: {
        ...report.tasks.value,
        rows: report.tasks.value.rows.map((row) => row.id === "task/running" ? { ...row, title } : row),
      },
    },
    akuma: {
      ...report.akuma,
      value: {
        ...report.akuma.value,
        rows: report.akuma.value.rows.map((row) => row.life === "headless"
          ? { ...row, confinement: { kind: "declared", writableRoots: ["/one/12345", "/two/12345", "/repo/\u001b[31m\nforged"] } }
          : row),
      },
    },
  } as KanshiReport;
  const before = structuredClone(narrowReport);
  const text = renderKanshiText(narrowReport, { columns: 20, color: false });
  const lines = text.split("\n");
  const task = lines.indexOf("● task/running in_progress");
  const priority = lines.indexOf("  P0", task + 1);
  const titleLines = lines.slice(task + 1, priority);

  assert.match(text, /^task 4 · 1 ready$/mu);
  assert.match(text, /^  1 held$/mu);
  assert.deepEqual(titleLines, ["  Trace narrow title", "  wrapping exactly"]);
  assert.ok(titleLines.every((line) => displayColumns(line) <= 20));
  assert.equal(titleLines.map((line) => line.trim()).join(" "), title);
  assert.match(text, /^  writes \/one\/12345$/mu);
  assert.match(text, /^  \/two\/12345$/mu);
  assert.match(text, /^  \/repo\/�\[31m forged$/mu);
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("\nforged"), false);
  assert.deepEqual(narrowReport, before);
});

test("Kanshi narrow wrapping exceeds columns only for indivisible scan and coordinate units", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const longId = "kei/a-very-long-contract-identity";
  const longRef = "refs/heads/a-very-long-target-name";
  const longGate = "a-very-long-gate-name";
  const narrowReport: KanshiReport = {
    ...report,
    root: "/repository/with/a/long/root",
    contracts: {
      ...report.contracts,
      value: {
        ...report.contracts.value,
        rows: report.contracts.value.rows.map((row) => row.id === "kei/active-contract"
          ? { ...row, id: longId, target: longRef, gates: { ...row.gates, reports: [{ gate: longGate, current: { kind: "missing" } }] } }
          : row),
      },
    },
  } as KanshiReport;
  const before = structuredClone(narrowReport);
  const text = renderKanshiText(narrowReport, { columns: 20, color: false });
  const overflow = text.split("\n").filter((line) => displayColumns(line) > 20);

  assert.match(text, /^task 4 · 1 ready$/mu);
  assert.match(text, /^  1 held$/mu);
  assert.ok(overflow.length > 0);
  assert.ok(overflow.every((line) =>
    /^kanshi \/repository/u.test(line)
    || /^state /u.test(line)
    || /^[●○⧗✓!?×] /u.test(line)
    || line.includes(longRef)
    || line.includes(longGate)
    || line.includes("integration")
    || line.includes("blocked by")
    || line.includes("held by")
    || /keiyaku kei\//u.test(line)));
  assert.equal(text.includes(longId), true);
  assert.equal(text.includes(longRef), true);
  assert.equal(text.includes(longGate), true);
  assert.deepEqual(narrowReport, before);
});

test("Kanshi has no Contract gate-block cap", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const gates = Array.from({ length: 24 }, (_, index) => ({
    gate: `gate-${String(index).padStart(2, "0")}`,
    current: { kind: "missing" as const },
  }));
  const active = report.contracts.value.rows.find((row) => row.id === "kei/active-contract");
  if (active === undefined) throw new Error("fixture Contract must be present");
  const cappedReport: KanshiReport = {
    ...report,
    contracts: {
      ...report.contracts,
      value: {
        ...report.contracts.value,
        rows: report.contracts.value.rows.map((row) => row === active
          ? { ...row, gates: { ...row.gates, reports: gates } }
          : row),
      },
    },
  } as KanshiReport;
  const before = structuredClone(cappedReport);
  const text = renderKanshiText(cappedReport, { columns: 20, color: false });

  for (const gate of gates) assert.match(text, new RegExp(`\\? ${gate.gate}`, "u"));
  assert.deepEqual(cappedReport, before);
});

test("Kanshi selection is a projection that preserves source presence", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const report = await observe(repository.path, Repo.at({ path: repository.path }));
  const selected = selectKanshi({ report, contract: contract.id });
  assert.equal(selected.contracts.kind, "present");
  assert.equal(selected.tasks.kind, "present");
  assert.equal(selected.akuma.kind, "present");
  if (selected.contracts.kind !== "present" || selected.tasks.kind !== "present" || selected.akuma.kind !== "present") return;
  assert.deepEqual(selected.contracts.value.rows.map((row) => row.id), [contract.id]);
  assert.deepEqual(selected.tasks.value.rows.map((row) => row.id), [taskId]);
  assert.deepEqual(selected.akuma.value.rows.map((row) => row.id), [report.akuma.value.rows[0]!.id]);
});

test("Kanshi text neutralizes control characters from source diagnostics", () => {
  const text = renderKanshiText({
    root: "/repo\u001b[31m\nforged",
    observedAt: "2026-08-12T00:00:00.000Z",
    branch: null,
    contracts: { kind: "failed", failure: { message: "broken\u001b[2J\nforged\u2028again\u2029end" } },
    tasks: { kind: "absent" },
    akuma: { kind: "absent" },
  }, { columns: 40, color: false });
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("\nforged"), false);
  assert.equal(text.includes("\u2028"), false);
  assert.equal(text.includes("\u2029"), false);
  assert.match(text, /broken.*forged/u);
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
