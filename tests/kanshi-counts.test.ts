import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { breakBody, finishBodyIfIdle, readSoul, recordTell } from "../src/akuma/heart/index.js";
import { Debts, Kanshi, Keis, Keiyaku, KeiyakuError, Repo, World } from "../src/index.js";
import type { AkumaCaller, BindOutcome, KanshiCountsOptions, KanshiScopeInput } from "../src/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";
import { runCli } from "./support/cli-fixtures.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

async function traceGit<T>(path: string, action: () => Promise<T>) {
  writeFileSync(path, "");
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = path;
  const start = performance.now();
  try {
    const value = await action();
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const commands: string[][] = events.filter((event) => event.event === "start").map((event) => event.argv.slice(1));
    return { value, commands, wallMs: Math.round(performance.now() - start) };
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
}

test("exact counts observe complete independent owners and isolate corrupt Hearts", async (context) => {
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const empty = await Kanshi.of({ world, repo }).counts();
  assert.deepEqual([empty.akuma, empty.contracts, empty.debts], [0, 0, 0]);
  const debts = Debts.of(world);
  const ready = accepted(await debts.add({ title: "Pioneer" })).id;
  accepted(await debts.add({ title: "Waiting", needs: [ready] }));
  for (let i = 0; i < 10; i++) accepted(await debts.add({ title: `Open ${i}` }));
  const done = accepted(await debts.add({ title: "Done" })).id;
  const drop = accepted(await debts.add({ title: "Drop" })).id;
  accepted(await debts.debt({ id: done }).update({ state: "done" }));
  accepted(await debts.debt({ id: drop }).update({ state: "drop" }));
  const active: Extract<BindOutcome, { kind: "accepted" }>[] = [];
  for (let i = 0; i < 12; i++) {
    // Keep the shared Contract target's workspace unchanged for the exact lag witness.
    const target = i < 8 ? "main" : active[2]!.contractId;
    active.push(accepted(await Keis.of(repo).bind({ target, terms: contractMarkdown(`Count ${i}`, {
      Context: "counts", Objective: "observe", Design: "owner", Region: "src/**", Criteria: "### Count\nCorrect.",
    }), gates: ["reviewed"] })));
  }
  const waiting = active[0]!;
  assert.ok(waiting.worktreePath);
  commitCandidate(repository, waiting.worktreePath);
  accepted(await waiting.kei.deliver());
  const terminal = accepted(await Keis.of(repo).bind({ target: "main", terms: contractMarkdown("Terminal", {
    Context: "counts", Objective: "observe", Design: "owner", Region: "src/**", Criteria: "### Count\nCorrect.",
  }), gates: [] }));
  await terminal.kei.abandon();
  for (let i = 1; i <= 12; i++) {
    const running = await bornDirectAkuma({ root: world, akumaName: "worker", draw: i.toString(16).padStart(8, "0"), createdAt: "2026-08-09T00:00:00.000Z" });
    context.after(() => running.leash.release());
    await running.leash.recordBody(running.paths, { leashTakenAt: running.soul.createdAt });
  }
  const stopped = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "000000ff", createdAt: "2026-08-09T00:00:00.000Z" });
  const body = await stopped.leash.recordBody(stopped.paths, { leashTakenAt: stopped.soul.createdAt });
  await breakBody(stopped.paths, { sequence: body.sequence, end: "put-down", at: stopped.soul.createdAt });
  stopped.leash.release();
  const sleeping = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "000000fe", createdAt: stopped.soul.createdAt });
  const sleepingBody = await sleeping.leash.recordBody(sleeping.paths, { leashTakenAt: sleeping.soul.createdAt });
  await finishBodyIfIdle(sleeping.paths, { sequence: sleepingBody.sequence, at: sleeping.soul.createdAt });
  sleeping.leash.release();
  const summaryAt = (cwd: string, repo?: string) => Keiyaku.for({
    cwd,
    environment: { KEIYAKU_ACTOR_ID: stopped.id, KEIYAKU_ACTOR_WORLD: world },
    ...(repo === undefined ? {} : { repo }),
  }).status();
  const summary = await summaryAt(world);
  assert.deepEqual(summary, {
    kind: "active-work-summary",
    contracts: { total: 12, awaitingReview: 1, conflicts: { known: 0, unavailable: 0 } },
    akumas: { total: 13, byLife: { running: 12, stranded: 1 } },
    debts: { total: 12, ready: 11, blocked: 1 },
  });
  const worktree = waiting.worktreePath;
  assert.ok(worktree);
  const child = join(worktree, "child");
  mkdirSync(child);
  const contextual = { ...summary, currentContract: { id: waiting.contractId, state: "awaiting-review" } };
  assert.deepEqual(await summaryAt(child, world), contextual);
  const report = await Kanshi.of({ world, repo }).counts();
  assert.deepEqual([report.akuma, report.contracts, report.debts], [12, 12, 12]);

  await context.test("World observation bounds physical worktree reads before detail", async (t) => {
    const view = Kanshi.of({ world, repo });
    const tracePath = join(repository.path, ".git", "status-trace.jsonl");
    const observed = await traceGit(tracePath, () => view.board());
    const board = observed.value.contracts;
    assert.ok(!("kind" in board), JSON.stringify(board));
    assert.equal(board.more, true);
    const status = observed.commands.filter((args) => args.includes("--porcelain=v2"));
    const lag = observed.commands.filter((args) => args.includes("rev-list"));
    assert.equal(status.length, 10, "only the ten selected catalogue workspaces are observed");
    assert.equal(lag.length, 10, "target lag is observed only for selected rows");
    const selectedPaths = new Set(board.rows!.map(row => active.find(candidate => candidate.contractId === row.id)!.worktreePath));
    assert.ok(status.every(args => selectedPaths.has(args[args.indexOf("-C") + 1]!)));
    t.diagnostic(JSON.stringify({
      stage: "bare", worktrees: active.length, processes: observed.commands.length,
      status: status.length, lag: lag.length, wallMs: observed.wallMs,
    }));

    const selected = active.at(-1)!;
    const path = selected.worktreePath!;
    const targetPath = active[2]!.worktreePath;
    const exact = await traceGit(tracePath, () => view.contract(selected.contractId));
    const detail = exact.value;
    assert.ok(detail.kind === "contract");
    assert.equal(detail.id, selected.contractId);
    assert.equal(detail.workspace.kind, "present");
    assert.equal(detail.workspace.counts, undefined);
    assert.equal(detail.targetLag, 0);
    assert.equal(exact.commands.filter((args) => args.includes("--porcelain=v2")).length, 1);
    assert.ok(exact.commands.filter((args) => args[0] === "-C").every((args) => args[1] === path || args[1] === targetPath));
    t.diagnostic(JSON.stringify({
      stage: "selected", processes: exact.commands.length,
      status: exact.commands.filter((args) => args.includes("--porcelain=v2")).length, wallMs: exact.wallMs,
    }));

    renameSync(path, `${path}-missing`);
    try {
      const missing = await view.contract(selected.contractId);
      assert.ok(missing.kind === "contract" && missing.workspace.kind === "unavailable");
      assert.equal(missing.workspace.path, path);
      assert.equal(missing.targetLag, undefined);
    } finally {
      renameSync(`${path}-missing`, path);
    }
  });

  writeFileSync(stopped.paths.heart, "corrupt");
  const broken = await Kanshi.of({ world, repo }).counts();
  assert.ok(typeof broken.akuma !== "number" && broken.akuma.kind === "failed");
  assert.deepEqual(broken.contracts, report.contracts);
  assert.deepEqual(broken.debts, report.debts);
});

test("absence, explicit Repo and crossing validation remain independent", async (context) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "counts-world-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = await World.prove(directory);
  const absent = await Kanshi.of({ world }).counts();
  assert.deepEqual([absent.akuma, absent.contracts, absent.debts], Array(3).fill({ kind: "absent" }));
  const invocation = Keiyaku.for({ cwd: directory, environment: {} });
  assert.deepEqual(await invocation.status(), {
    kind: "active-work-summary",
    contracts: { kind: "absent" },
    akumas: { kind: "absent" },
    debts: { kind: "absent" },
  });
  assert.equal(existsSync(join(directory, ".keiyaku")), false);
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const independent = await Kanshi.of({ world: null, repo }).counts();
  assert.equal(independent.contracts, 0);
  assert.deepEqual(independent.akuma, { kind: "absent" });
  const call = (value: unknown) => Kanshi.of(value as KanshiScopeInput).counts();
  assert.throws(
    () => call({ world: directory, repo: {} }),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
  assert.throws(
    () => call({ world: directory, extra: true }),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
  await assert.rejects(call({ world: `${directory}/.` }));
  assert.deepEqual((await Kanshi.of({ world }).counts()).debts, { kind: "absent" });
  const selection = { akumaCaller: { kind: "external", integration: "pi", id: "S" } } as const;
  assert.deepEqual((await Kanshi.of({ world }).counts(selection)).akuma, { kind: "absent" });
  await assert.rejects(Kanshi.of({ world }).counts({ akumaCaller: {} } as KanshiCountsOptions),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input");
  await World.at(world);
  assert.deepEqual(await Keiyaku.for({ cwd: world, repo: repository.path, environment: {} }).status(), {
    kind: "active-work-summary",
    contracts: { total: 0, awaitingReview: 0, conflicts: { known: 0, unavailable: 0 } },
    akumas: { total: 0, byLife: {} },
    debts: { total: 0, ready: 0, blocked: 0 },
  });
  assert.equal(existsSync(join(repository.path, ".keiyaku")), false);
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "run"), "not a directory");
  const unavailable = await Kanshi.of({ world }).counts(selection);
  assert.ok(typeof unavailable.akuma !== "number" && unavailable.akuma.kind === "failed");
  assert.equal(unavailable.debts, 0);
});

async function divergentFixture() {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bind = () => contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }).then(accepted);
  const conflicting = await bind();
  const lagging = await bind();
  const conflictPath = conflicting.worktreePath;
  const lagPath = lagging.worktreePath;
  assert.ok(conflictPath && lagPath);
  writeFileSync(join(conflictPath, "shared.txt"), "candidate\n");
  repository.run(["-C", conflictPath, "commit", "-qam", "candidate"]);
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["commit", "-qam", "target"]);
  const invocation = Keiyaku.for({ cwd: repository.path, environment: {} });
  const admin = repository.run(["-C", conflictPath, "rev-parse", "--path-format=absolute", "--git-dir"]).trim();
  return { repository, invocation, conflicting, conflictPath, lagPath, admin };
}

test("active status counts a relative linked-worktree conflict, not target drift or unavailable workspaces", async () => {
  const { repository, invocation, conflicting, conflictPath, lagPath, admin } = await divergentFixture();
  const before = await invocation.status();
  assert.equal(before.kind, "active-work-summary");
  assert.deepEqual(before.contracts, {
    total: 2, awaitingReview: 0, conflicts: { known: 0, unavailable: 0 },
  });
  assert.equal((await conflicting.kei.deliver({ materializeConflict: true })).kind, "handoff");
  repository.run(["-c", "worktree.useRelativePaths=true", "worktree", "repair", conflictPath]);
  const backlinkPath = join(admin, "gitdir");
  if (isAbsolute(readFileSync(backlinkPath, "utf8").trim())) {
    // Older Git accepts the real linked index but does not produce a relative backlink.
    writeFileSync(backlinkPath, `${relative(admin, join(conflictPath, ".git"))}\n`);
  }
  const backlink = readFileSync(backlinkPath, "utf8").trim();
  assert.equal(isAbsolute(backlink), false);
  assert.equal(resolve(admin, backlink), join(conflictPath, ".git"));
  repository.run(["-C", conflictPath, "merge", "--quit"]);
  // Preserve the unmerged index without MERGE_HEAD, and an unusable appointment
  // directory that Git must not silently replace with the enclosing checkout.
  repository.run(["worktree", "remove", lagPath]);
  mkdirSync(lagPath);
  const refs = repository.run(["show-ref"]);
  const index = repository.run(["-C", conflictPath, "ls-files", "-u"]);
  assert.notEqual(index, "");
  const observed = await invocation.status();
  assert.equal(observed.kind, "active-work-summary");
  assert.deepEqual(observed.contracts, {
    total: 2, awaitingReview: 0, conflicts: { known: 1, unavailable: 1 },
  });
  const text = await runCli(["-C", repository.path, "status"], { environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /1 known conflict · conflict evidence unavailable for 1/u);
  assert.equal(repository.run(["show-ref"]), refs);
  assert.equal(repository.run(["-C", conflictPath, "ls-files", "-u"]), index);
});

test("active status cannot turn a missing index during a real merge into a zero conflict total", async () => {
  const { repository, invocation, conflicting, conflictPath, admin } = await divergentFixture();
  assert.equal((await conflicting.kei.deliver({ materializeConflict: true })).kind, "handoff");
  const index = join(admin, "index");
  const displaced = join(admin, "index.fixture");
  renameSync(index, displaced);
  try {
    assert.notEqual(repository.run(["-C", conflictPath, "rev-parse", "--verify", "MERGE_HEAD"]).trim(), "");
    assert.equal(repository.run(["-C", conflictPath, "ls-files", "--unmerged"]), "");
    const observed = await invocation.status();
    assert.equal(observed.kind, "active-work-summary");
    assert.deepEqual(observed.contracts, {
      total: 2, awaitingReview: 0, conflicts: { known: 0, unavailable: 1 },
    });
    assert.equal(existsSync(index), false);
  } finally {
    renameSync(displaced, index);
  }
});

test("caller running count preserves readable ancestry beyond the display bound", async (context) => {
  const world = await World.at(temporaryDirectory(context, "counts-caller-"));
  const root: AkumaCaller = { kind: "external", integration: "pi", id: "flagship" };
  const kanshi = Kanshi.of({ world });
  const selected = () => kanshi.counts({ akumaCaller: root });
  assert.equal((await selected()).akuma, 0);
  let draw = 0;
  const born = async (akumaName: string, caller?: AkumaCaller) => {
    const child = await bornDirectAkuma({
      root: world,
      akumaName,
      draw: (++draw).toString(16).padStart(8, "0"),
      createdAt: "2026-08-09T00:00:00.000Z",
      ...(caller === undefined ? {} : { caller }),
    });
    context.after(() => child.leash.release());
    const body = await child.leash.recordBody(child.paths, { leashTakenAt: child.soul.createdAt });
    return { ...child, body, caller: { kind: "akuma", world, akumaId: child.id } as const };
  };
  const ancestor = await born("worker", root);
  await finishBodyIfIdle(ancestor.paths, { sequence: ancestor.body.sequence, at: ancestor.soul.createdAt });
  ancestor.leash.release();
  const branch = await born("child", ancestor.caller);
  await born("grandchild", branch.caller);
  for (let i = 0; i < 11; i++) await born("peer", ancestor.caller);
  const unrelated = await born("outside");
  await recordTell(unrelated.paths, {
    kind: "tell",
    id: "not-a-parent",
    body: "hello",
    recordedAt: unrelated.soul.createdAt,
    initiator: "pi:flagship",
  });
  const hung = await born("hung", ancestor.caller);
  await hung.leash.recordBodyHung(hung.paths, {
    sequence: hung.body.sequence,
    diagnostic: "cannot retire",
    at: hung.soul.createdAt,
  });
  assert.equal((await selected()).akuma, 13);
  assert.equal((await kanshi.counts({ akumaCaller: ancestor.caller })).akuma, 13);
  // A life failure must not erase the readable Soul edge to its descendants.
  const database = new DatabaseSync(ancestor.paths.heart);
  try {
    database.exec("DROP TABLE bodies");
  } finally {
    database.close();
  }
  assert.equal((await readSoul(ancestor.paths))?.id, ancestor.id);
  assert.equal((await selected()).akuma, 13);
  const total = (await kanshi.counts()).akuma;
  assert.ok(typeof total !== "number" && total.kind === "failed");
  writeFileSync(ancestor.paths.heart, "corrupt");
  unrelated.leash.release();
  writeFileSync(unrelated.paths.heart, "corrupt");
  assert.equal((await selected()).akuma, 0);
  await born("direct", root);
  assert.equal((await selected()).akuma, 1);
});
