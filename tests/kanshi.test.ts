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
import { phaseAtFor } from "../src/protocol/read/status.js";
import { kanshi, selectKanshi, type KanshiReport } from "../src/kanshi/index.js";
import { Tasks } from "../src/task/index.js";
import { authorityPath } from "../src/task/store.js";
import { World } from "../src/world.js";
import { moveAlias } from "../src/alias/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

async function observe(path: string, repo?: Repo) {
  return kanshi({ world: await World.at(path), ...(repo === undefined ? {} : { repo }) });
}

function document(title = "Kanshi contract"): string {
  return [
    `# ${title}`, "", "## Context", "status", "", "## Objective", "render", "",
    "## Design", "project public values", "", "## Region", "```", "src/**", "```", "",
    "## Criteria", "### Visible", "The status row is visible.", "",
  ].join("\n");
}

async function bornAkuma(root: string, suffix: string) {
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
  const tasks = Tasks.of(await World.at(repository.path));
  const added = await tasks.add({ title: "Render status", priority: 0 });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") throw new Error("task add failed");
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    task: added.value.id,
    markdown: document(),
    workspace: "here",
    target: "main",
  });
  const contract = await bound.keiyaku.state();
  const renamed = await tasks.task({ id: added.value.id }).update({ title: "Investigate status rendering" });
  assert.equal(renamed.kind, "accepted");
  await tasks.task({ id: added.value.id }).start();
  const akumaId = await bornAkuma(repository.path, "a0000001");
  assert.equal((await publishDispatch({ repository: await repositoryAt(repository.path), akuId: akumaId, contractId: contract.id })).kind, "dispatched");
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
    async () => observe(repository.path, await Repo.at({ path: repository.path })),
  );
  return gitInvocations(log);
}

function deleteLooseObject(repository: ReturnType<typeof makeGitRepository>, oid: string): void {
  unlinkSync(join(repository.path, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
}

test("one-target Kanshi observation has a seven-process Git topology", async () => {
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
  assert.equal((await publishDispatch({
    repository: await repositoryAt(repository.path),
    akuId: secondAkuma,
    contractId: secondContract.id,
  })).kind, "dispatched");
  const invocations = await observedGitInvocations(repository);

  assert.equal(invocations.filter((command) => command === "worktree list --porcelain -z").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --path-format=absolute --git-common-dir").length, 1);
  assert.equal(invocations.filter((command) => command === "symbolic-ref --quiet HEAD").length, 1);
  assert.equal(invocations.filter((command) => command === `rev-parse --verify --quiet ${GIT_REF}`).length, 1);
  assert.equal(invocations.some((command) => command.startsWith("ls-tree ")), false);
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.some((command) => command.startsWith("cat-file blob ")), false);
  assert.equal(invocations.filter((command) => command.includes("status --porcelain=v2")).length, 2);
  assert.equal(invocations.filter((command) => /rev-list --count HEAD\.\.[0-9a-f]{40}$/u.test(command)).length, 2);
  assert.equal(invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)), false);
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
    "printf '%s\\n' \"$*\" >> \"$KEIYAKU_KANSHI_GIT_LOG\"\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_KANSHI_GIT_LOG: log },
    async () => observe(repository.path, await Repo.at({ path: repository.path })),
  );

  assert.equal(report.contracts.kind, "present");
  if (report.contracts.kind !== "present") return;
  const rows = [contract.id, second.id].map((id) => report.contracts.value.rows.find((row) => row.id === id));
  const head = rows[0]?.targetObservation?.head;
  assert.equal(typeof head, "string");
  assert.equal(rows.every((row) => row?.target === "refs/heads/main" && row.targetObservation?.head === head), true);
  const invocations = gitInvocations(log);
  const lagReads = invocations.filter((command) => /rev-list --count HEAD\.\.[0-9a-f]{40}$/u.test(command));
  assert.equal(lagReads.length, 2);
  assert.equal(lagReads.every((command) => command.endsWith(`HEAD..${head}`)), true);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)), false);
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

  assert.equal(invocations.filter((command) => command === "rev-parse --path-format=absolute --git-common-dir").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/other").length, 1);
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.includes("status --porcelain=v2")).length, 2);
  assert.equal(invocations.filter((command) => /rev-list --count HEAD\.\.[0-9a-f]{40}$/u.test(command)).length, 2);
  assert.equal(invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)), false);
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
    async () => observe(repository.path, await Repo.at({ path: repository.path })),
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
    assert.equal(report.contracts.value.rows.every((row) => row.holder.kind === "unavailable"), true);
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
  const tree = await updateGitTree(git, snapshot.tree, new Map([
    [GIT_FORMAT_PATH, { oid: await writeBlob(git, "not the current format\n") }],
  ]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");

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
});

test("a malformed TaskHolder root fails only the Kanshi Task section", async () => {
  const { repository } = await populatedWorld();
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(git, snapshot.tree, new Map([
    ["settlement/task-holders", { oid: await writeBlob(git, "not holder authority\n") }],
  ]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");

  const report = await observe(repository.path, await Repo.at({ path: repository.path }));

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
  const git = await repositoryAt(repository.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(git, snapshot.tree, new Map([
    [contractJournalPath(contract.id), { oid: await writeBlob(git, "not a Contract journal\n") }],
  ]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");

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
  Date.prototype.toISOString = function() { sampled = true; return original.call(this); };
  Repo.prototype.currentBranch = async function() {
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
  Repo.prototype.currentBranch = async function() { throw new Error("branch unavailable"); };
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
  const tree = await updateGitTree(git, snapshot.tree, new Map([
    ["dispatch", { oid: await writeBlob(git, "not dispatch authority\n") }],
  ]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "failed");
});

function zeros() {
  return { staged: 0, unstaged: 0, untracked: 0, submodules: 0 };
}

function worktreeObservation(
  path: string,
  kind: "clean" | "dirty" | "unavailable" = "clean",
  counts = zeros(),
) {
  return kind === "unavailable"
    ? { kind, location: { kind: "worktree" as const, path } }
    : { kind, location: { kind: "worktree" as const, path }, counts };
}

function hereObservation(kind: "clean" | "dirty" | "unavailable" = "clean", counts = zeros()) {
  return kind === "unavailable"
    ? { kind, location: { kind: "here" as const } }
    : { kind, location: { kind: "here" as const }, counts };
}

function contractRow(input: Partial<Extract<KanshiReport["contracts"], { kind: "present" }>["value"]["rows"][number]> & { id: string }) {
  const workspace = input.workspace ?? "worktree";
  const path = input.worktreePath ?? `/repo/.git/keiyaku/wt/${input.id.slice("kei/".length)}`;
  return {
    title: input.title ?? input.id.slice("kei/".length),
    phase: "waiting" as const,
    phaseAt: "2026-08-11T23:59:30.000Z",
    disposition: "active" as const,
    workspace,
    worktreePath: workspace === "worktree" ? path : null,
    workspaceObservation: workspace === "here" ? hereObservation() : worktreeObservation(path),
    target: "refs/heads/main",
    targetLag: { kind: "counted" as const, behind: 0 },
    delivery: null,
    targetObservation: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drift: false },
    holder: { kind: "none" as const },
    fleet: [],
    gates: { satisfied: true, reports: [] },
    ...input,
  };
}

function attentionReport(): KanshiReport {
  const dirtyPath = "/repo/.git/keiyaku/wt/active-contract";
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
          contractRow({
            id: "kei/terminal-contract",
            title: "Terminal Contract",
            phase: "claimed",
            phaseAt: "2026-08-10T00:00:00.000Z",
            disposition: "terminal",
            worktreePath: "/repo/.git/keiyaku/wt/terminal-contract",
            workspaceObservation: worktreeObservation("/repo/.git/keiyaku/wt/terminal-contract"),
            gates: {
              satisfied: true,
              reports: [
                { gate: "reviewed", current: { kind: "attested", verdict: "satisfied", summary: "terminal review summary", at: "2026-08-10T00:00:00.000Z" } },
              ],
            },
          }),
          contractRow({
            id: "kei/active-contract",
            title: "Active Contract",
            phase: "pending-delivery",
            phaseAt: "2026-08-11T23:57:00.000Z",
            worktreePath: dirtyPath,
            workspaceObservation: worktreeObservation(dirtyPath, "dirty", { staged: 1, unstaged: 3, untracked: 2, submodules: 0 }),
            targetLag: { kind: "counted", behind: 7 },
            targetObservation: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", drift: true },
            holder: { kind: "held", taskId: "task/running" },
            fleet: [{ id: "aku/worker/a0000001", aliases: ["@lead"] }],
            gates: {
              satisfied: false,
              reports: [
                { gate: "reviewed", current: { kind: "attested", verdict: "satisfied", summary: "world summary should stay hidden", at: "2026-08-11T23:58:00.000Z" } },
                { gate: "verified", current: { kind: "attested", verdict: "unsatisfied", summary: "tests failed", at: "2026-08-11T22:00:00.000Z" } },
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
          }),
          contractRow({
            id: "kei/target-unknown",
            title: "Target Unknown",
            phaseAt: "2026-08-12T00:00:01.000Z",
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
            id: "kei/here-contract",
            title: "Here Contract",
            workspace: "here",
            worktreePath: null,
            workspaceObservation: hereObservation("dirty", { staged: 0, unstaged: 1, untracked: 0, submodules: 0 }),
          }),
          contractRow({
            id: "kei/unavailable-contract",
            title: "Unavailable Contract",
            worktreePath: "/repo/.git/keiyaku/wt/unavailable-contract",
            workspaceObservation: worktreeObservation("/repo/.git/keiyaku/wt/unavailable-contract", "unavailable"),
          }),
        ],
      },
    },
    tasks: {
      kind: "present",
      value: {
        root: "/repo",
        rows: [
          { id: "task/blocked", title: "Blocked by release evidence", state: "open", priority: 0, disposition: "blocked", contract: { id: "kei/active-contract", observed: "active" }, blockers: [
            { id: "task/release", title: "Release", state: "in_progress" },
            { id: "task/missing", title: null, state: "missing" },
          ] },
          { id: "task/running", title: "Investigate failed Linux verification", state: "in_progress", priority: 0, disposition: "in_progress", contract: { id: "kei/active-contract", observed: "active" } },
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
          { id: "aku/worker/a0000001", archetype: "worker", life: "running", lifeAt: "2026-08-11T23:56:00.000Z", confinement: { kind: "unconfined" }, pending: [], aliases: ["@lead"], contract: { id: "kei/active-contract", observed: "active" } },
          { id: "aku/worker/a0000002", archetype: "worker", life: "asleep", lifeAt: "2026-08-11T00:00:00.000Z", confinement: { kind: "unconfined" }, pending: [], aliases: [] },
          { id: "aku/worker/a0000003", archetype: "worker", life: "killed", lifeAt: "2026-08-11T23:59:30.000Z", confinement: { kind: "unconfined" }, pending: [], aliases: [] },
          { id: "aku/worker/a0000004", life: "stillborn", seal: { at: "2026-08-10T00:00:00.000Z", evidence: "stillborn" }, aliases: [] },
          { id: "aku/worker/a0000005", life: "unborn", aliases: [] },
          { id: "aku/worker/a0000006", archetype: "worker", life: "stranded", lifeAt: "2026-08-11T22:00:00.000Z", strandedReason: "resume-unsupported", confinement: { kind: "unconfined" }, pending: ["pending"], aliases: [], contract: { id: "kei/missing-contract", observed: "missing" } },
          { id: "aku/worker/a0000007", archetype: "worker", life: "hung", lifeAt: null, confinement: { kind: "unconfined" }, pending: [], aliases: [] },
        ],
      },
    },
  } as KanshiReport;
}

function sectionBody(text: string, name: string): string {
  const open = `──[ ${name} ]`;
  const start = text.indexOf(open);
  assert.notEqual(start, -1, `missing ${name} aperture`);
  const after = text.indexOf("\n", start);
  const rest = text.slice(after + 1);
  const close = rest.search(/^──\[ /mu);
  return close === -1 ? rest : rest.slice(0, close);
}

test("Kanshi text keeps complete identities in the aperture grammar", async () => {
  const { repository, contract, taskId, akumaId } = await populatedWorld();
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
  const text = renderKanshiText(report, { columns: 20, color: false });
  const world = await World.at(repository.path);
  const signature = text.split("\n", 1)[0]!;
  assert.match(signature, /^kanshi ───+ 1 keiyaku · 1 akuma · 1 task ───+ /u);
  assert.equal(signature.includes(world), true);
  assert.equal(report.contracts.kind, "present");
  if (report.contracts.kind === "present") assert.equal(signature.includes(report.contracts.value.state!), true);
  assert.equal(text.includes(contract.id), true);
  assert.equal(text.includes(taskId), true);
  assert.equal(text.includes(akumaId), true);
  assert.match(text, /──\[ KEIYAKU \]/u);
  assert.match(text, /──\[ TASK \]/u);
  assert.match(text, /──\[ FLEET \]/u);
  assert.doesNotMatch(text, /\bFLEET \d/u);
  assert.doesNotMatch(signature, / fleet /u);
  const json = JSON.stringify(report);
  assert.match(json, /"phaseAt":/u);
  assert.match(json, /"lifeAt":/u);
  assert.doesNotMatch(json, /"(?:age|lifeSince)":|\u001b/u);
});

test("Contract phase timestamps select the owning journal entry", () => {
  const bindAt = "2026-08-12T00:00:00.000Z";
  const boundAt = "2026-08-12T00:01:00.000Z";
  const deliveryAt = "2026-08-12T00:02:00.000Z";
  const claimedAt = "2026-08-12T00:03:00.000Z";
  assert.equal(phaseAtFor({ terminal: null, delivery: null, bound: null }, bindAt), bindAt);
  assert.equal(phaseAtFor({ terminal: null, delivery: null, bound: { at: boundAt } as never }, bindAt), boundAt);
  assert.equal(phaseAtFor({ terminal: null, delivery: { at: deliveryAt } as never, bound: { at: boundAt } as never }, bindAt), deliveryAt);
  assert.equal(phaseAtFor({ terminal: { at: claimedAt } as never, delivery: { at: deliveryAt } as never, bound: { at: boundAt } as never }, bindAt), claimedAt);
  assert.equal(phaseAtFor({ terminal: { at: "2026-08-12T00:04:00.000Z" } as never, delivery: { at: deliveryAt } as never, bound: { at: boundAt } as never }, bindAt), "2026-08-12T00:04:00.000Z");
});

test("Kanshi ages keep every unit boundary, future, and absent evidence distinct", () => {
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
  const timedRows = sources.map(([label, phaseAt]) => contractRow({ id: `kei/age-${label}`, phaseAt }));
  const text = renderKanshiText({
    ...report,
    contracts: { ...report.contracts, value: { ...report.contracts.value, rows: timedRows } },
  }, { columns: 120, color: false });
  for (const [label] of sources) assert.match(text, new RegExp(`waiting · ${label}`, "u"));
  assert.match(text, /stillborn · —/u);
});

test("Kanshi text retains every entity and the aperture hierarchy", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 120, color: false });
  const signature = text.split("\n", 1)[0]!;

  assert.equal(displayColumns(signature), 120);
  assert.match(signature, /^kanshi ───+ 7 keiyaku · 7 akuma · 6 task ───+ \/repo main c{40}$/u);
  assert.match(text, /\n\n──\[ KEIYAKU \]/u);
  assert.match(text, /attention \]─+\n\n──\[ TASK \]/u);
  assert.match(text, /attention \]─+\n\n──\[ FLEET \]/u);
  assert.doesNotMatch(text, /^ {2}↳ /mu);
  assert.match(text, /──\[ KEIYAKU \]/u);
  assert.match(text, /──\[ TASK \]/u);
  assert.match(text, /──\[ FLEET \]/u);
  assert.match(text, /──\[ 7 keiyaku · \d+ attention \]/u);
  assert.match(text, /──\[ 6 task · 2 attention \]/u);
  assert.match(text, /──\[ 7 akuma · \d+ attention \]/u);
  assert.ok(text.indexOf("──[ KEIYAKU ]") < text.indexOf("──[ TASK ]"));
  assert.ok(text.indexOf("──[ TASK ]") < text.indexOf("──[ FLEET ]"));
  assert.doesNotMatch(text, /\bFLEET \d/u);
  assert.doesNotMatch(text, /^\+ /mu);
  assert.doesNotMatch(text, /\.\.\./u);

  if (report.contracts.kind !== "present" || report.tasks.kind !== "present" || report.akuma.kind !== "present") {
    throw new Error("fixture sections must be present");
  }
  for (const row of report.contracts.value.rows) assert.equal(text.includes(row.id), true);
  for (const row of report.tasks.value.rows) assert.equal(text.includes(row.id), true);
  for (const row of report.akuma.value.rows) assert.equal(text.includes(row.id), true);

  const contracts = sectionBody(text, "KEIYAKU");
  assert.match(contracts, /^! kei\/active-contract$/mu);
  assert.match(contracts, /Active Contract/u);
  assert.match(contracts, /pending-delivery/u);
  assert.match(contracts, /target main/u);
  assert.match(contracts, /behind 7/u);
  assert.match(contracts, /drift/u);
  assert.match(contracts, /worktree dirty · staged 1 · unstaged 3 · untracked 2/u);
  assert.match(contracts, /^ {2}│ ↳ \/repo\/\.git\/keiyaku\/wt\/active-contract$/mu);
  assert.match(contracts, /pending-delivery · 3m/u);
  assert.match(contracts, /gates: ✓ reviewed 2m · ! verified 2h · \? security — · \? manual —/u);
  assert.match(contracts, /task task\/running/u);
  assert.match(contracts, /akuma aku\/worker\/a0000001 \(@lead\)/u);
  assert.doesNotMatch(contracts, /world summary should stay hidden/u);
  assert.match(contracts, /Cold Contract · bound · 2h · target main · behind 0/u);
  assert.match(contracts, /Terminal Contract · claimed · 2d/u);
  assert.match(contracts, /Target Unknown · waiting · future/u);
  assert.match(contracts, /target main · behind unknown · drift/u);
  assert.doesNotMatch(contracts, /target unknown/u);
  assert.match(contracts, /no target/u);
  assert.match(contracts, /workspace here · dirty/u);
  const hereBlock = contracts.split("kei/here-contract")[1]!.split(/^[!●○✓?×] /mu)[0]!;
  assert.doesNotMatch(hereBlock, /↳ /u);
  assert.match(contracts, /worktree unavailable/u);
  assert.match(contracts, /^ {2}│ ↳ \/repo\/\.git\/keiyaku\/wt\/unavailable-contract$/mu);
  assert.match(contracts, /worktree clean/u);
  const cold = contracts.split("kei/cold-contract")[1]!;
  const nextCold = cold.search(/^[!●○✓?×] /mu);
  assert.doesNotMatch((nextCold === -1 ? cold : cold.slice(0, nextCold)), /↳ /u);

  const tasks = sectionBody(text, "TASK");
  assert.match(tasks, /^‖ task\/blocked$/mu);
  assert.match(tasks, /^● task\/running$/mu);
  assert.match(tasks, /^⧗ task\/held$/mu);
  assert.match(tasks, /^○ task\/ready$/mu);
  assert.match(tasks, /^✓ task\/done$/mu);
  assert.match(tasks, /^× task\/dropped$/mu);
  assert.doesNotMatch(tasks, /^= /mu);
  assert.match(tasks, /blocked by task\/release/u);
  assert.match(tasks, /blocked by task\/missing/u);
  assert.match(tasks, /-> kei\/active-contract/u);
  assert.match(tasks, /Ready · ready · P1 · unbound/u);
  assert.match(tasks, /Held · on_hold · P1 · unbound/u);
  assert.match(tasks, /Done · done · P2 · unbound/u);
  assert.match(tasks, /Dropped · drop · P2 · unbound/u);

  const fleet = sectionBody(text, "FLEET");
  assert.match(fleet, /^● aku\/worker\/a0000001 \(@lead\)$/mu);
  assert.match(fleet, /running · 4m/u);
  assert.match(fleet, /stranded · 2h · resume unsupported/u);
  assert.match(fleet, /-> kei\/missing-contract \(missing\)/u);
  assert.match(fleet, /asleep · 1d · unbound/u);
  assert.match(fleet, /killed · 30s/u);
  assert.match(fleet, /hung · —/u);
  assert.deepEqual(report, before);
});

test("Kanshi Split Horizon stays one line at standard widths", () => {
  const report = attentionReport();
  for (const columns of [80, 120]) {
    const text = renderKanshiText(report, { columns, color: false });
    const signature = text.split("\n", 1)[0]!;
    assert.ok(displayColumns(signature) >= columns);
    assert.match(signature, /^kanshi ───+ 7 keiyaku · 7 akuma · 6 task ───+ \/repo main c{40}$/u);
  }
});

test("exact Contract Kanshi text keeps terminal gates and testimony summaries", () => {
  const selected = selectKanshi({ report: attentionReport(), contract: "kei/terminal-contract" });
  const text = renderKanshiText(selected, { columns: 80, color: false }, "contract");

  assert.match(text, /^✓ kei\/terminal-contract$/mu);
  assert.match(text, /gates: ✓ reviewed/u);
  assert.match(text, /reviewed: terminal review summary/u);
  assert.doesNotMatch(text, /kei\/active-contract/u);
});

test("Kanshi wraps titles without dropping coordinates or gates", () => {
  const report = attentionReport();
  const before = structuredClone(report);
  const text = renderKanshiText(report, { columns: 20, color: false });
  const paths = text.split("\n").filter((line) => line.startsWith("  │ ↳ "));
  assert.ok(paths.every((line) => !line.includes("…") && !line.includes("...")));
  assert.ok(text.split("\n").some((line) => line.startsWith("  │ ") && displayColumns(line) <= 20));
  assert.equal(text.includes("kei/active-contract"), true);
  assert.equal(text.includes("/repo/.git/keiyaku/wt/active-contract"), true);
  assert.match(text, /verified/u);
  assert.match(text, /behind 7/u);
  assert.match(text, /drift/u);
  assert.equal(text.includes("\u001b"), false);
  assert.deepEqual(report, before);
});

test("Kanshi retains a Contract whose title is unavailable", () => {
  const report = attentionReport();
  if (report.contracts.kind !== "present") throw new Error("fixture contracts must be present");
  const rows = report.contracts.value.rows.map((row) => row.id === "kei/no-target"
    ? { ...row, title: null }
    : row);
  const text = renderKanshiText({
    ...report,
    contracts: { ...report.contracts, value: { ...report.contracts.value, rows } },
  }, { columns: 80, color: false });
  const contracts = sectionBody(text, "KEIYAKU");
  assert.match(contracts, /^\? kei\/no-target$/mu);
  assert.match(contracts, /title unavailable/u);
  assert.match(text, /7 keiyaku · 4 attention/u);
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
        rows: report.tasks.value.rows.map((row) => row.id === "task/running" ? { ...row, title } : row),
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
        rows: report.contracts.value.rows.map((row) => row.id === "kei/active-contract"
          ? { ...row, gates: { ...row.gates, reports: gates } }
          : row),
      },
    },
  };
  const text = renderKanshiText(cappedReport, { columns: 20, color: false });
  for (const gate of gates) assert.match(text, new RegExp(`\\? ${gate.gate}`, "u"));
});

test("absent and failed Kanshi sections stay typed and distinct from empty present sections", () => {
  const failed = renderKanshiText({
    root: "/repo",
    observedAt: "2026-08-12T00:00:00.000Z",
    branch: null,
    contracts: { kind: "failed", failure: { message: "broken board" } },
    tasks: { kind: "absent" },
    akuma: { kind: "present", value: { searched: [], rows: [] } },
  }, { columns: 80, color: false });
  assert.match(failed, /^kanshi ───+ failed keiyaku · 0 akuma · absent task ───+ \/repo$/mu);
  assert.match(failed, /──\[ KEIYAKU \]/u);
  assert.match(failed, /! broken board/u);
  assert.match(failed, /──\[ TASK \]/u);
  assert.match(failed, /task absent/u);
  assert.match(failed, /──\[ FLEET \]/u);
  assert.match(failed, /──\[ 0 akuma · 0 attention \]/u);
});

test("Kanshi selection is a projection that preserves source presence", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const report = await observe(repository.path, await Repo.at({ path: repository.path }));
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
      "printf '%s\\n' \"$*\" >> \"$KEIYAKU_KANSHI_GIT_LOG\"",
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
    async () => observe(repository.path, await Repo.at({ path: repository.path })),
  );

  assert.equal(report.contracts.kind, "present");
  if (report.contracts.kind !== "present") return;
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.deepEqual(row?.targetObservation, { head: frozen, drift: false });
  assert.deepEqual(row?.targetLag, { kind: "counted", behind: 0 });
  const invocations = gitInvocations(log);
  assert.equal(invocations.filter((command) => command === "rev-parse --verify --quiet refs/heads/main").length, 1);
  assert.equal(invocations.some((command) => command.endsWith(`rev-list --count HEAD..${frozen}`)), true);
  assert.equal(invocations.some((command) => /rev-list --count HEAD\.\.refs\//u.test(command)), false);
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
  for (const [id, mark] of Object.entries(expected)) {
    assert.match(tasks, new RegExp(`^${mark} ${id}$`, "mu"));
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
