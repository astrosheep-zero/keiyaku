import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { Keiyaku, Repo } from "../src/index.js";
import {
  GIT_REF,
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { kanshi, selectKanshi } from "../src/kanshi/index.js";
import { Tasks } from "../src/task/index.js";
import { makeGitRepository } from "./support/git.js";

function document(): string {
  return [
    "# Kanshi contract", "", "## Context", "status", "", "## Objective", "render", "",
    "## Design", "project public values", "", "## Region", "```", "src/**", "```", "",
    "## Criteria", "### Visible", "The status row is visible.", "",
  ].join("\n");
}

function bornAkuma(root: string, suffix: string): string {
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
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const tasks = Tasks.at({ path: repository.path });
  const added = await tasks.add({ title: "Render status", priority: 0 });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") throw new Error("task add failed");
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), task: added.value.id, markdown: document(), workspace: "here" });
  const contract = await bound.keiyaku.state();
  await tasks.task({ id: added.value.id }).start();
  const akumaId = bornAkuma(repository.path, "a0000001");
  return { repository, contract, taskId: added.value.id, akumaId };
}

test("kanshi joins Task endpoints and independently copies Akuma public rows", async () => {
  const { repository, contract, taskId, akumaId } = await populatedWorld();
  const report = await kanshi({ path: repository.path });
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.akuma.kind === "present") {
    const row = report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
    assert.equal(row?.id, akumaId);
    assert.equal(row === undefined ? false : "contract" in row, false);
  }
  if (report.contracts.kind !== "present" || report.tasks.kind !== "present") return;
  assert.equal(report.contracts.value.rows.some((row) => row.id === contract.id), true);
  assert.deepEqual(report.tasks.value.rows.find((row) => row.id === taskId)?.contract, {
    id: contract.id,
    observed: "active",
  });
});

test("kanshi keeps absent Contract and Task worlds explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-no-git-"));
  const akumaId = bornAkuma(root, "a0000002");
  const report = await kanshi({ path: root });
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
  const tasks = Tasks.at({ path: root });
  const added = await tasks.add({ title: "Standalone Task" });
  assert.equal(added.kind, "accepted");
  const report = await kanshi({ path: root });
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.equal(report.tasks.kind, "present");
  if (report.tasks.kind !== "present" || added.kind !== "accepted") return;
  assert.equal(report.tasks.value.rows.find((row) => row.id === added.value.id)?.contract, undefined);
});

test("kanshi reports malformed Task authority as a failed section", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-kanshi-bad-task-"));
  mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "tasks", "bad.md"), "not a task document\n");
  const report = await kanshi({ path: root });
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

  const report = await kanshi({ path: repository.path });

  assert.equal(report.contracts.kind, "present");
  assert.equal(report.tasks.kind, "failed");
  assert.equal(report.akuma.kind, "present");
  if (report.tasks.kind === "failed") assert.match(report.tasks.failure.message, /TaskHolder authority root is not a tree/u);
});

test("Kanshi text retains the v3 ruler, marks, dense facts, and complete identities", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const report = await kanshi({ path: repository.path });
  const text = renderKanshiText(report, { columns: 20, color: false });
  assert.match(text, /^kanshi ─+ 現世$/mu);
  assert.match(text, /marks ● active · ○ idle · \? lost · ‖ paused/u);
  assert.equal(text.includes(contract.id), true);
  assert.equal(text.includes(taskId), true);
  assert.match(text, /● P0 .*task\/render-status/u);
  assert.match(text, /in progress/u);
  assert.match(text, /keiyaku kei\/.*\(active\)/u);
  assert.match(text, /akuma 1/u);
  assert.match(text, /aku\/watcher\/a0000001/u);
  assert.match(text, /keiyaku kei\/kanshi-contract \(active\)/u);
});

test("Kanshi selection is a projection that preserves source presence", async () => {
  const { repository, contract, taskId } = await populatedWorld();
  const report = await kanshi({ path: repository.path });
  const selected = selectKanshi({ report, contract: contract.id });
  assert.equal(selected.contracts.kind, "present");
  assert.equal(selected.tasks.kind, "present");
  assert.equal(selected.akuma.kind, "present");
  if (selected.contracts.kind !== "present" || selected.tasks.kind !== "present" || selected.akuma.kind !== "present") return;
  assert.deepEqual(selected.contracts.value.rows.map((row) => row.id), [contract.id]);
  assert.deepEqual(selected.tasks.value.rows.map((row) => row.id), [taskId]);
  assert.deepEqual(selected.akuma.value.rows, []);
});

test("Kanshi text neutralizes control characters from source diagnostics", () => {
  const text = renderKanshiText({
    root: "/repo\u001b[31m\nforged",
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
    assert.equal(result.report.contracts.kind, "present");
    assert.doesNotThrow(() => JSON.stringify(result.report));
  }
});
