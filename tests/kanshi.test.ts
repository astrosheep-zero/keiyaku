import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { breakBody, HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { parseArgv as parseInvocation, type ParsedExecution } from "../src/cli/parse.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
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
import { kanshi, selectKanshi, type KanshiReport } from "../src/kanshi/index.js";
import { Tasks } from "../src/task/index.js";
import { authorityPath } from "../src/task/store.js";
import type { WorldRoot } from "../src/world.js";
import { World } from "../src/world.js";
import { appointedWorktreePath, cachedRepositoryAt, makeGitRepository, withGitShim } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

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
  assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
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
  assert.ok(result.kind === "status-set", 'expected result.kind = "status-set"');
  return result;
}

async function singleStatusReport(repositoryPath: string, selector: string) {
  const result = await invoke(parseArgv(["-C", repositoryPath, "status", selector]));
  assert.ok(result.kind === "status", 'expected result.kind = "status"');
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

function gitInvocations(path: string): readonly string[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

function deleteLooseObject(repository: ReturnType<typeof makeGitRepository>, oid: string): void {
  unlinkSync(join(repository.path, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
}

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
  assert.ok(unselected.contracts.kind === "present", 'expected unselected.contracts.kind = "present"');
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
  assert.ok(blocked.kind === "accepted", 'expected blocked.kind = "accepted"');
  unlinkSync(authorityPath(root as WorldRoot, first.value.id));

  const report = await observe(root);

  assert.ok(report.tasks.kind === "present", 'expected report.tasks.kind = "present"');
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

test("target lag counts the frozen targetObservation head after the live ref moves", async (t) => {
  const { repository, contract } = await populatedWorld(t);
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), contract.id);
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

  assert.ok(report.contracts.kind === "present", 'expected report.contracts.kind = "present"');
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.deepEqual(row?.targetObservation, { head: frozen, drift: false });
  assert.deepEqual(row?.targetLag, {
    kind: "counted",
    behind: 0,
    subject: { kind: "worktree", path: worktree },
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
  assert.equal(
    (worldText.match(/task\/bad · failed task document must begin with YAML front matter/gu) ?? []).length,
    1,
  );
  assert.doesNotMatch(selected, /──\[ (?:KEIYAKU|TASK|FLEET) \]/u);
});
