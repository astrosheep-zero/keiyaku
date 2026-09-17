import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import { appendActivity, beginTurn, breakBody, endTurn, HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { parseArgv as parseInvocation, type ParsedExecution } from "../src/cli/parse.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { snapshotText } from "../src/cli/render/akuma-activity.js";
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
import type { AkumaAlias } from "../src/identity/selector.js";
import { Keiyaku, Repo } from "../src/index.js";
import { kanshi, selectKanshi, type KanshiReport } from "../src/kanshi/index.js";
import { projectTaskBoardObservation } from "../src/task/board.js";
import { contractNamespace } from "../src/task/identity.js";
import { Tasks } from "../src/task/index.js";
import { authorityPath, readBoard } from "../src/task/store.js";
import type { WorldRoot } from "../src/world.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import { taskDocument, writeTaskAuthority } from "./support/task.js";

function parseArgv(argv: readonly string[]): ParsedExecution {
  const parsed = parseInvocation(argv);
  if (!("command" in parsed)) throw new Error("expected executable command");
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
  assert.ok(added.kind === "accepted", "expected added.kind = \"accepted\"");
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

/** Compare only the observation that a selected status entry answers for, not read clocks. */
function selectedContractSection(report: KanshiReport) {
  const section = report.contracts;
  if (section.kind !== "present") return section;
  const { observedAt, ...value } = section.value;
  return { kind: "present" as const, value };
}

async function pluralStatusReport(repositoryPath: string, selectors: readonly string[]) {
  const result = await invoke(parseArgv(["-C", repositoryPath, "status", ...selectors]));
  assert.ok(result.kind === "status-set", "expected result.kind = \"status-set\"");
  return result;
}

async function singleStatusReport(repositoryPath: string, selector: string) {
  const result = await invoke(parseArgv(["-C", repositoryPath, "status", selector]));
  assert.ok(result.kind === "status", "expected result.kind = \"status\"");
  return result;
}



test("plural status preserves mixed Contract/Akuma and alias selections", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  const segment = contract.id.slice("kei/".length);
  const plural = await pluralStatusReport(repository.path, [contract.id, `@${segment}`, "@watch"]);
  assert.equal(plural.entries.length, 3);
  const [canonical, aliased, akuma] = plural.entries;
  assert.equal(canonical?.kind, "contract");
  assert.equal(aliased?.kind, "contract");
  assert.equal(akuma?.kind, "akuma");
  if (canonical?.kind !== "contract" || aliased?.kind !== "contract" || akuma?.kind !== "akuma") return;
  assert.deepEqual(
    selectedContractSection(canonical.report),
    selectedContractSection((await singleStatusReport(repository.path, contract.id)).report),
  );
  assert.deepEqual(selectedContractSection(aliased.report), selectedContractSection(canonical.report));
  assert.equal(aliased.selector, `@${segment}`);
  assert.equal(akuma.alias, "@watch");
  assert.equal(akuma.status.status.id, akumaId);
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

  assert.ok(result.kind === "status", "expected result.kind = \"status\"");
  assert.equal(result.selection, "contract");
  assert.equal(result.report.contracts.kind, "failed");
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
  assert.ok(blocked.kind === "accepted", "expected blocked.kind = \"accepted\"");
  unlinkSync(authorityPath(root as WorldRoot, first.value.id));

  const report = await observe(root);

  assert.ok(report.tasks.kind === "present", "expected report.tasks.kind = \"present\"");
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
    assert.ok(report.akuma.kind === "present", "expected report.akuma.kind = \"present\"");
    const fleet = sectionBody(renderKanshiText(report, { columns: 120, color: false }), "FLEET");
    const displayed = [...ids].sort((left, right) => fleet.indexOf(left) - fleet.indexOf(right));
    assert.deepEqual(displayed, [ids[1], ids[3], ids[2], ids[0]]);
    assert.equal(statusReads.length, 3);
    assert.deepEqual([...statusReads].sort(), [...displayed.slice(0, 3)].sort());
  } finally {
    AkumaHandle.prototype.status = originalStatus;
  }
});

test("Contract namespace Tasks come from one Task board observation", async (t) => {
  const { repository, contract, taskId } = await populatedWorld(t);
  const world = await World.at(repository.path);
  const segment = contractSegment(contract.id);
  assert.deepEqual(contractNamespace(contract.id), ["kei", segment]);
  const sibling = contractId("kei/other-contract");
  writeTaskAuthority(world, taskDocument({ id: "task/root-standalone", title: "Root standalone", priority: 0 }));
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
  assert.ok(row.namespaceTasks.kind === "present", "expected row.namespaceTasks.kind = \"present\"");
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
    expected.some((task) => task.id === "task/root-standalone"),
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
  assert.match(selectedText, new RegExp(String.raw`● ${taskId} · in progress`, "u"));
  assert.match(selectedText, new RegExp(String.raw`⧗ task/kei/${segment}/zeta · on hold · P0 · Namespace zeta`, "u"));
  assert.match(selectedText, new RegExp(String.raw`✓ task/kei/${segment}/alpha · done · P3 · Namespace alpha`, "u"));
  assert.doesNotMatch(selectedText, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
});

test("Task board failure names the malformed document once without suppressing Contract or Akuma", async (t) => {
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
  assert.equal(row?.namespaceTasks, undefined);
  assert.equal(
    report.akuma.value.rows.some((candidate) => candidate.id === akumaId),
    true,
  );
  const selected = renderKanshiText(
    selectKanshi({ report, contract: contract.id }),
    { columns: 80, color: false },
    "contract",
  );
  assert.doesNotMatch(selected, /failed task document must begin with YAML front matter/u);
  const worldText = renderKanshiText(report, { columns: 80, color: false });
  assert.equal((worldText.match(/task\/bad · failed task document must begin with YAML front matter/gu) ?? []).length, 1);
  assert.doesNotMatch(selected, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
});

async function akumaWithReportedChanges(root: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "watcher", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const createdAt = "2026-08-09T00:00:00.000Z";
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
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: createdAt });
  const turn = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: createdAt });
  const call = {
    kind: "fileChange" as const,
    changes: [{ op: "update" as const, path: "src/placed.ts", diffstat: { added: 10, removed: 1 } }],
  };
  await appendActivity(allocated.paths, {
    turnSequence: turn.sequence,
    at: "2026-08-09T00:00:01.000Z",
    event: { type: "tool", phase: "started", id: "write", name: "Write", call },
  });
  await appendActivity(allocated.paths, {
    turnSequence: turn.sequence,
    at: "2026-08-09T00:00:02.000Z",
    event: { type: "tool", phase: "completed", id: "write", name: "Write", call, result: { status: "ok" } },
  });
  await endTurn(allocated.paths, {
    turnSequence: turn.sequence,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "placed-session" } },
    completedAt: "2026-08-09T00:00:03.000Z",
  });
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-09T00:00:04.000Z" });
  leash.release();
  return allocated.id;
}

function fleetSnapshotPaths(report: KanshiReport, akuId: string): readonly string[] | undefined {
  if (report.akuma.kind !== "present") throw new Error("expected a present Akuma section");
  const row = report.akuma.value.rows.find((candidate) => candidate.id === akuId);
  return row?.snapshot?.reportedChanges.map((change) => change.path);
}

test("placement discharges an associated Akuma's reported changes in status and fleet observation", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);

  const bound = await Keiyaku.bind({
    repo,
    markdown: document("Discharge placement"),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const contract = await bound.keiyaku.state();
  const placed = await akumaWithReportedChanges(repository.path, "a0000011");
  const stray = await akumaWithReportedChanges(repository.path, "a0000012");
  assert.equal(
    (await publishDispatch({ repository: await repositoryAt(repository.path), akuId: placed, contractId: contract.id }))
      .kind,
    "dispatched",
  );

  // While the associated Contract is active, status (text and JSON) and the
  // Kanshi fleet snapshot keep the reported changes.
  const active = await Keiyaku.status({ path: world, akuma: placed, repo });
  assert.deepEqual(
    active.status.timeline.reportedChanges.map((change) => change.path),
    ["src/placed.ts"],
  );
  const activeText = snapshotText(active, { columns: 120, color: false });
  assert.match(activeText, /changes 1/u);
  assert.match(activeText, /\+10 -1 {2}src\/placed\.ts/u);
  const before = await observe(repository.path, repo);
  assert.deepEqual(fleetSnapshotPaths(before, placed), ["src/placed.ts"]);

  const worktree = bound.workspace?.path;
  if (worktree === undefined) throw new Error("Contract workspace was not appointed");
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  assert.equal((await bound.keiyaku.deliver()).kind, "accepted");
  assert.equal((await bound.keiyaku.review({ verdict: "satisfied" })).kind, "accepted");
  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");

  // Once the Contract is claimed, the same projections present no reported
  // changes: the candidate they described is placed and preserved in Git.
  const settled = await Keiyaku.status({ path: world, akuma: placed, repo });
  assert.deepEqual(settled.status.timeline.reportedChanges, []);
  assert.equal(settled.status.timeline.reportedChangesOmitted, 0);
  assert.deepEqual(settled.contract, { kind: "associated", contractId: contract.id });
  assert.doesNotMatch(snapshotText(settled, { columns: 120, color: false }), /changes/u);
  const after = await observe(repository.path, repo);
  assert.deepEqual(fleetSnapshotPaths(after, placed), []);

  // An unassociated Akuma and a dropped Contract's Akuma keep their reported
  // changes: unplaced work still matters.
  const strayObservation = await Keiyaku.status({ path: world, akuma: stray, repo });
  assert.deepEqual(
    strayObservation.status.timeline.reportedChanges.map((change) => change.path),
    ["src/placed.ts"],
  );
  const dropped = await Keiyaku.bind({ repo, markdown: document("Dropped discharge"), workspace: "worktree" });
  const droppedId = (await dropped.keiyaku.state()).id;
  const orphan = await akumaWithReportedChanges(repository.path, "a0000013");
  assert.equal(
    (await publishDispatch({ repository: await repositoryAt(repository.path), akuId: orphan, contractId: droppedId }))
      .kind,
    "dispatched",
  );
  await dropped.keiyaku.abandon();
  assert.equal((await dropped.keiyaku.state()).terminal?.kind, "abandoned");
  const orphanObservation = await Keiyaku.status({ path: world, akuma: orphan, repo });
  assert.deepEqual(
    orphanObservation.status.timeline.reportedChanges.map((change) => change.path),
    ["src/placed.ts"],
  );
  const terminal = await observe(repository.path, repo);
  assert.deepEqual(fleetSnapshotPaths(terminal, orphan), ["src/placed.ts"]);
});
