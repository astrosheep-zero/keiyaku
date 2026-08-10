import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { readNamespaceContext } from "../src/task/context.js";
import { Tasks } from "../src/task/index.js";
import { makeGitRepository } from "./support/git.js";

function repository() {
  const value = makeGitRepository();
  value.run(["config", "user.name", "Test User"]);
  value.run(["config", "user.email", "test@example.com"]);
  value.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  value.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return value;
}

function document(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise cross-product settlement.",
    "",
    "## Objective",
    "Keep Contract and Task authority independent.",
    "",
    "## Design",
    "Project accepted facts through settlement.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Settlement",
    "The expected Task state is visible.",
  ].join("\n");
}

async function associatedTask(path: string, contractId: string, state: "open" | "done" = "open") {
  const result = await Tasks.at({ path }).add({ title: `Associated ${state}`, contractId, state });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("Task creation was not accepted");
  return result.value.id;
}

async function taskState(path: string, id: string) {
  const detail = await Tasks.at({ path }).task({ id }).read();
  assert.ok(detail);
  return detail.task.state;
}

test("accepted claim synchronously settles every associated Task", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const bound = await Keiyaku.bind({ repo, markdown: document("Synchronous settlement"), workspace: "here", gates: [] });
  const state = await bound.keiyaku.state();
  const taskId = await associatedTask(world.path, state.id);
  writeFileSync(`${world.path}/candidate.txt`, "candidate\n");

  const delivered = await bound.keiyaku.deliver();

  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(delivered.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(delivered.settlement.lags, []);
});

test("accepted abandonment reopens every associated done Task", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const bound = await Keiyaku.bind({ repo, markdown: document("Reopen settlement"), workspace: "here" });
  const state = await bound.keiyaku.state();
  const taskId = await associatedTask(world.path, state.id, "done");

  const abandoned = await bound.keiyaku.abandon();

  assert.equal(await taskState(world.path, taskId), "open");
  assert.deepEqual(abandoned.settlement.actions, [{ kind: "task", taskId, action: "reopened" }]);
  assert.deepEqual(abandoned.settlement.lags, []);
});

test("contract and world reconcile replay settlement from current authority", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const first = await Keiyaku.bind({ repo, markdown: document("Contract replay"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/first.txt`, "first\n");
  await first.keiyaku.deliver();
  const firstId = (await first.keiyaku.state()).id;
  const firstTask = await associatedTask(world.path, firstId);

  const local = await first.keiyaku.reconcile();
  assert.deepEqual(local.settlement.actions, [{ kind: "task", taskId: firstTask, action: "done" }]);

  const second = await Keiyaku.bind({ repo, markdown: document("World replay"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/second.txt`, "second\n");
  await second.keiyaku.deliver();
  const secondId = (await second.keiyaku.state()).id;
  const secondTask = await associatedTask(world.path, secondId);

  const report = await repo.reconcile();
  const settled = report.contracts.find((item) => item.contractId === secondId);
  assert.deepEqual(settled?.report.settlement.actions, [{ kind: "task", taskId: secondTask, action: "done" }]);
  assert.equal(await taskState(world.path, secondTask), "done");
});

test("managed bind installs Task namespace only after worktree materialization", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const bound = await Keiyaku.bind({ repo, markdown: document("Namespace settlement"), workspace: "worktree" });
  const action = bound.settlement.actions.find((item) => item.kind === "namespace-context");
  assert.ok(action && action.kind === "namespace-context");
  const state = await bound.keiyaku.state();
  assert.deepEqual(readNamespaceContext(action.path), [state.id.slice("kei/".length)]);
  assert.equal(bound.effects.some((effect) => effect.kind === "namespace-context"), false);
});
