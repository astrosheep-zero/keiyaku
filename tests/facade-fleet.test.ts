import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { HeldAkumaLeash, appendActivity, beginTurn, endTurn, initializeHeart, readHeart, recordSession, recordTell } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { AkumaNotBornError } from "../src/akuma/akuma.js";
import { AkumaWorldScopeError, Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { parseArgv } from "../src/cli/parse.js";
import { projectTaskBoardObservation } from "../src/task/board.js";
import { Tasks, type TaskId } from "../src/task/index.js";
import { serializeTaskDocument, type TaskDocument } from "../src/task/document.js";
import { authorityPath, readBoard } from "../src/task/store.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";
import { matchesAkumaGlob, parseAkumaGlob } from "../src/identity/selector.js";
import { addressAkumaSet, resolveNamedAddress } from "../src/library/address.js";
import { observeKanshi } from "../src/kanshi/read.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { akuId } from "../src/akuma/identity.js";
import { contractId } from "../src/core/facts/types.js";

const provider: ProviderAdapter = {
  admitOptions(options) { return { kind: "admitted", options }; },
  async start() {
    let finishEvents!: () => void;
    const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
    return {
      admission: { fence: "fleet-fixture-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "fixture" } };
          finishEvents();
        },
      },
      completion: eventsFinished.then(() => ({
        kind: "answered" as const,
        answer: "done",
        historyId: "history",
      })),
      async abort() {},
    };
  },
};

async function completeTurn(paths: Parameters<typeof beginTurn>[0], bodySequence: number, outcome: Parameters<typeof endTurn>[1]["outcome"], completedAt: string): Promise<void> {
  const turn = await beginTurn(paths, { bodySequence, startedAt: completedAt });
  await endTurn(paths, { turnSequence: turn.sequence, outcome, completedAt });
}

async function openOrdinary(
  paths: Parameters<typeof beginTurn>[0],
  stamp: string,
  spec: Readonly<{
    prefix: string;
    voices?: number;
    notes?: number;
    tool?: boolean;
    tellId?: string;
  }>,
): Promise<void> {
  const bodySequence = (await readHeart(paths)).latestBody?.sequence;
  assert.equal(typeof bodySequence, "number");
  const turn = await beginTurn(paths, { bodySequence: bodySequence!, startedAt: stamp });
  const second = stamp.slice(0, 17);
  const voices = spec.voices ?? 0;
  for (let index = 0; index < voices; index += 1) {
    await appendActivity(paths, {
      turnSequence: turn.sequence,
      event: { type: "assistant", text: `${spec.prefix}-voice-${index}` },
      at: `${second}${String(index + 1).padStart(2, "0")}.000Z`,
    });
  }
  const notes = spec.notes ?? 0;
  for (let index = 0; index < notes; index += 1) {
    await appendActivity(paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: `${spec.prefix}-note-${index}` },
      at: `${second}${String(voices + index + 1).padStart(2, "0")}.000Z`,
    });
  }
  if (spec.tool === true) {
    await appendActivity(paths, {
      turnSequence: turn.sequence,
      event: { type: "tool", phase: "started", id: "running", name: "Bash", call: { kind: "run", command: "npm test" } },
      at: `${second}${String(voices + notes + 1).padStart(2, "0")}.000Z`,
    });
  }
  if (spec.tellId !== undefined) {
    await recordTell(paths, { id: spec.tellId, body: "continue", recordedAt: `${second}59.000Z` });
  }
}

function ordinaryEntries(view: Awaited<ReturnType<typeof Keiyaku.wait>>["observations"][number]) {
  return view.status.timeline.entries.filter((entry) =>
    entry.kind === "row"
      && !(entry.row.kind === "tool" && entry.row.state === "active")
      && !(entry.row.kind === "tell" && entry.row.state === "pending"));
}

function hasPinned(view: Awaited<ReturnType<typeof Keiyaku.wait>>["observations"][number]): boolean {
  return view.status.timeline.entries.some((entry) =>
    entry.kind === "row" && entry.row.kind === "tool" && entry.row.state === "active")
    && view.status.timeline.entries.some((entry) =>
      entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending");
}

async function answered(root: string, archetype: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype, draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype,
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      cwd: root,
    },
    initialBody: "work",
  }, provider, {
    now: () => "2026-08-11T00:00:00.000Z",
  });
  return allocated;
}

function corruptHeart(root: string, suffix: string) {
  const id = akuId({ archetype: "worker", suffix });
  const directory = join(root, ".keiyaku", "akuma", "run", `worker-${suffix}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "heart.db"), "broken\n");
  return id;
}

test("facade snapshots aliases and globs with stable dedupe for wait and kill", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-fleet-"));
  try {
    const worker = await answered(root, "worker", "00000002");
    const reviewer = await answered(root, "reviewer", "00000001");
    await moveAlias({ world: root, alias: "@review", akuId: reviewer.id });

    assert.equal((await Keiyaku.status({ path: root, akuma: "@review" })).status.id, reviewer.id);
    const waited = await Keiyaku.wait({
      path: root,
      akuma: ["aku/*/*", "@review", worker.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.deepEqual(waited.observations.map((view) => view.status.id), [reviewer.id, worker.id]);

    const killed = await Keiyaku.kill({ path: root, akuma: ["@review", worker.id] });
    assert.deepEqual(killed.results.map((member) => member.id), [reviewer.id, worker.id]);
    assert.deepEqual(killed.results.map((member) => member.evidence), ["already-stopped", "already-stopped"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("facade requires an explicit completion mode for a plural wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-wait-mode-"));
  try {
    const one = await answered(root, "worker", "00000001");
    const two = await answered(root, "worker", "00000002");
    await assert.rejects(
      Keiyaku.wait({ path: root, akuma: [one.id, two.id], timeoutMs: 0 }),
      /completion must be any or all/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plural wait skips an earlier unreadable member without spending its shared budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-wait-budget-"));
  try {
    const unreadable = corruptHeart(root, "00000000");
    const sources = [];
    for (let member = 1; member <= 5; member += 1) {
      const source = await answered(root, "worker", String(member).padStart(8, "0"));
      await openOrdinary(source.paths, `2026-08-11T00:0${member}:00.000Z`, {
        prefix: `member-${member}`,
        voices: 5,
        notes: 2,
        ...(member === 5 ? { tool: true, tellId: "complete-pending" } : {}),
      });
      sources.push(source);
    }
    const exhausted = await answered(root, "worker", "00000006");
    await openOrdinary(exhausted.paths, "2026-08-11T00:06:00.000Z", {
      prefix: "exhausted",
      notes: 2,
      tool: true,
      tellId: "pending",
    });
    sources.push(exhausted);

    const waited = await Keiyaku.wait({
      path: root,
      akuma: [unreadable, ...sources.map((source) => source.id)],
      completion: "all",
      timeoutMs: 0,
    });
    const ordinary = waited.observations.flatMap(ordinaryEntries);
    assert.equal(ordinary.length, 30);
    assert.deepEqual(waited.observations.slice(0, 5).map((view) => ordinaryEntries(view).length), [6, 6, 6, 6, 6]);
    assert.equal(hasPinned(waited.observations[4]!), true);
    assert.equal(waited.observations[5]!.status.timeline.kind, "open");
    assert.equal(ordinaryEntries(waited.observations[5]!).length, 0);
    assert.equal(hasPinned(waited.observations[5]!), true);
    assert.deepEqual(waited.observations[5]!.status.timeline.entries.map((entry) =>
      entry.kind === "gap" ? `gap:${entry.count}` : entry.row.kind), ["gap:2", "tool", "tell"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plural wait carries unused allowance and keeps pins after exhaustion", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-wait-budget-flow-"));
  try {
    const sparse = await answered(root, "worker", "00000001");
    await openOrdinary(sparse.paths, "2026-08-11T00:01:00.000Z", { prefix: "sparse", notes: 2 });
    const complete = [];
    for (let member = 2; member <= 5; member += 1) {
      const source = await answered(root, "worker", String(member).padStart(8, "0"));
      await openOrdinary(source.paths, `2026-08-11T00:0${member}:00.000Z`, {
        prefix: `member-${member}`,
        voices: 5,
        notes: 2,
      });
      complete.push(source);
    }
    const partial = await answered(root, "worker", "00000006");
    await openOrdinary(partial.paths, "2026-08-11T00:06:00.000Z", {
      prefix: "partial",
      voices: 5,
      notes: 2,
      tool: true,
      tellId: "partial-pending",
    });
    const exhausted = await answered(root, "worker", "00000007");
    await openOrdinary(exhausted.paths, "2026-08-11T00:07:00.000Z", {
      prefix: "exhausted",
      voices: 5,
      notes: 2,
      tool: true,
      tellId: "exhausted-pending",
    });

    const waited = await Keiyaku.wait({
      path: root,
      akuma: [sparse.id, ...complete.map((source) => source.id), partial.id, exhausted.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.equal(waited.observations.flatMap(ordinaryEntries).length, 30);
    assert.equal(ordinaryEntries(waited.observations[0]!).length, 2);
    assert.deepEqual(waited.observations.slice(1, 5).map((view) => ordinaryEntries(view).length), [6, 6, 6, 6]);
    const later = waited.observations[5]!;
    assert.deepEqual(
      ordinaryEntries(later).map((entry) => entry.kind === "row" && (entry.row.kind === "said" || entry.row.kind === "note")
        ? entry.row.text
        : entry.kind),
      ["partial-voice-3", "partial-voice-4", "partial-note-0", "partial-note-1"],
    );
    assert.equal(hasPinned(later), true);
    assert.equal(ordinaryEntries(waited.observations[6]!).length, 0);
    assert.equal(hasPinned(waited.observations[6]!), true);
    assert.equal(waited.observations[6]!.status.timeline.kind, "open");
    assert.deepEqual(waited.observations[6]!.status.timeline.entries.map((entry) =>
      entry.kind === "gap" ? `gap:${entry.count}` : entry.row.kind), ["gap:7", "tool", "tell"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("facade tell preserves mutation authority beside a separate observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-tell-"));
  try {
    const source = await answered(root, "worker", "00000001");
    const result = await Keiyaku.tell({ path: root, akuma: source.id, body: "continue" });
    assert.equal(result.akuma, source.id);
    assert.equal(result.tell.admission.fact, "recorded");
    assert.equal(typeof result.tell.admission.tellId, "string");
    assert.equal(result.observation.status.id, source.id);
    assert.ok(result.observation.status.timeline.entries.some((entry) => entry.kind === "row"
      && entry.row.kind === "tell" && entry.row.tellId === result.tell.admission.tellId));
    assert.equal("receipt" in result, false);
    assert.equal("status" in result, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("facade ls reads exactly one selected identity directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-home-"));
  try {
    const source = await answered(root, "worker", "00000001");
    const task = await Tasks.of(await World.at(root)).add({ title: "Catalog task" });
    assert.equal(task.kind, "accepted");
    mkdirSync(join(home, "akuma"));
    writeFileSync(join(home, "akuma", "reviewer.md"), [
      "---", "provider: missing", "model: review-model", "description: Complete catalog description.", "---", "prompt", "",
    ].join("\n"));
    const tasks = await Keiyaku.ls({ query: { kind: "tasks" }, path: root });
    assert.equal(tasks.kind, "tasks");
    assert.deepEqual(tasks.rows, [{
      id: task.value.id,
      title: "Catalog task",
      state: "open",
      priority: 2,
      disposition: "ready",
      updatedAt: task.value.updatedAt,
      bodyPresent: false,
    }]);
    assert.deepEqual(await Keiyaku.ls({ query: { kind: "archetypes" }, home }), {
      kind: "archetypes",
      rows: [{ name: "reviewer", model: "review-model", description: "Complete catalog description." }],
    });
    assert.deepEqual((await Keiyaku.ls({ query: { kind: "akuma", archetype: "worker" }, path: root })).rows.map((row) => row.id), [source.id]);
    assert.deepEqual((await Keiyaku.ls({ query: { kind: "akuma", archetype: "reviewer" }, path: root })).rows, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Task catalog does not inherit the Task list default page limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-page-"));
  try {
    const first = await Tasks.of(await World.at(root)).add({ title: "Catalog 000" });
    assert.equal(first.kind, "accepted");
    for (let index = 1; index <= 100; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const id = `task/catalog-${suffix}` as TaskId;
      writeFileSync(authorityPath(await World.at(root), id), serializeTaskDocument({
        id,
        title: `Catalog ${suffix}`,
        body: "",
        note: "",
        state: "open",
        priority: 2,
        needs: [],
        parent: null,
        supersedes: [],
        relates: [],
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }));
    }

    const catalog = await Keiyaku.ls({ query: { kind: "tasks" }, path: root });
    assert.equal(catalog.kind, "tasks");
    assert.equal(catalog.rows.length, 101);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI ls invokes each selected identity directory and emits selected JSON", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const home = mkdtempSync(join(tmpdir(), "keiyaku-cli-ls-home-"));
  try {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
    repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const world = await World.at(repository.path);
    const task = await Tasks.of(world).add({ title: "Listed task" });
    assert.equal(task.kind, "accepted");
    const bound = await Keiyaku.bind({
      repo,
      workspace: "here",
      markdown: [
        "# Listed Contract", "", "## Context", "List it.", "", "## Objective", "Expose it.", "",
        "## Design", "Use the selected Contract board.", "", "## Region", "```", "src/**", "```", "",
        "## Criteria", "### Visible", "The identity is listed.", "",
      ].join("\n"),
    });
    const contract = (await bound.keiyaku.state()).id;
    mkdirSync(join(home, "akuma"));
    writeFileSync(join(home, "akuma", "reviewer.md"), [
      "---", "provider: codex", "model: review-model", "description: Full review description.", "---", "Review.", "",
    ].join("\n"));
    const worker = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker", draw: () => "00000001" });
    const reviewer = await allocateAkumaDirectory({ worldRoot: world, archetype: "reviewer", draw: () => "00000002" });
    await initializeHeart(worker.paths);
    await initializeHeart(reviewer.paths);

    const command = (path: string) => invoke(parseArgv(["-C", repository.path, "ls", path]), {
      environment: { KEIYAKU_HOME: home },
    });
    const tasks = await command("task/");
    const contracts = await command("kei/");
    const archetypes = await command("aku/");
    const reviewers = await command("aku/reviewer/");
    const allAkuma = await command("aku/*/*");
    assert.equal(tasks.kind === "catalog" && tasks.catalog.kind === "tasks" && tasks.catalog.rows[0]?.id,
      task.kind === "accepted" ? task.value.id : null);
    assert.equal(contracts.kind === "catalog" && contracts.catalog.kind === "contracts"
      && contracts.catalog.rows.some((row) => row.id === contract), true);
    assert.deepEqual(archetypes.kind === "catalog" ? archetypes.catalog : null, {
      kind: "archetypes",
      rows: [{ name: "reviewer", model: "review-model", description: "Full review description." }],
    });
    assert.deepEqual(reviewers.kind === "catalog" && reviewers.catalog.kind === "akuma"
      ? reviewers.catalog.rows.map((row) => row.id) : [], [reviewer.id]);
    assert.deepEqual(allAkuma.kind === "catalog" && allAkuma.catalog.kind === "akuma"
      ? allAkuma.catalog.rows.map((row) => row.id) : [], [reviewer.id, worker.id]);

    let stdout = "";
    const writeStdout = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    try { assert.equal(await main(["-C", repository.path, "ls", "aku/reviewer/", "--json"]), 0); }
    finally { process.stdout.write = writeStdout; }
    const json = JSON.parse(stdout) as { kind: string; archetype: string | null; rows: readonly { id: string }[] };
    assert.deepEqual({ kind: json.kind, archetype: json.archetype, rows: json.rows.map((row) => row.id) }, {
      kind: "akuma", archetype: "reviewer", rows: [reviewer.id],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("named Address resolution refuses a Contract short-id shared with an Alias", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo,
    markdown: [
      "# Review", "", "## Context", "ambiguity", "", "## Objective", "refuse", "",
      "## Design", "one selector judge", "", "## Region", "```", "src/**", "```", "",
      "## Criteria", "### Visible", "Ambiguity is explicit.", "",
    ].join("\n"),
  });
  assert.equal((await bound.keiyaku.state()).id, "kei/review");
  const source = await answered(repository.path, "worker", "00000001");
  await moveAlias({ world: repository.path, alias: "@review", akuId: source.id });
  const path = await World.at(repository.path);
  const observation = await observeKanshi({ world: path, repo });
  assert.throws(
    () => resolveNamedAddress({ selector: "@review", report: observation.report, aliases: observation.aliases }),
    /ambiguous selector matches Contract and Akuma/u,
  );
});

test("named Address refuses failed Kanshi Contract and Alias observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-named-kanshi-failed-"));
  try {
    const observation = await observeKanshi({ world: root as import("../src/index.js").WorldRoot });
    const failure = { kind: "failed" as const, failure: { message: "unavailable" } };
    assert.throws(
      () => resolveNamedAddress({ selector: "@missing", report: { ...observation.report, contracts: failure }, aliases: observation.aliases }),
      /Contract world is failed/u,
    );
    assert.throws(
      () => resolveNamedAddress({ selector: "@missing", report: observation.report, aliases: failure }),
      /Alias authority is failed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named Address resolves a retained Alias outside Kanshi fleet rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-named-kanshi-alias-"));
  try {
    const id = akuId({ archetype: "worker", suffix: "deadbeef" });
    await moveAlias({ world: root, alias: "@outside", akuId: id });
    const observation = await observeKanshi({ world: root as import("../src/index.js").WorldRoot });
    assert.equal(observation.report.akuma.kind, "present");
    assert.equal(observation.report.akuma.kind === "present" && observation.report.akuma.value.rows.some((row) => row.id === id), false);
    assert.deepEqual(resolveNamedAddress({ selector: "@outside", report: observation.report, aliases: observation.aliases }), {
      kind: "akuma",
      id,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history last bypasses activity and glob grammar follows normalized archetypes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-last-"));
  try {
    const source = await answered(root, "worker", "00000001");
    await appendActivity(source.paths, {
      turnSequence: 1,
      event: { type: "activity", event: { provider: "legacy" } },
      at: "2026-08-11T00:00:01.000Z",
    });
    assert.deepEqual(await Keiyaku.history({ path: root, akuma: source.id, last: true }), {
      kind: "last",
      id: source.id,
      answer: "done",
      contract: { kind: "none" },
    });
    await assert.rejects(() => Keiyaku.history({ path: root, akuma: source.id }), /invalid event shape/u);

    const glob = parseAkumaGlob("aku/审查-👁️*/1234*");
    assert.equal(matchesAkumaGlob(glob, "aku/审查-👁️/1234abcd"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history last selects exactly one latest answered TurnFact by durable sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-last-sequence-"));
  try {
    const source = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => "00000001" });
    await initializeHeart(source.paths);
    const bodyLeash = (await HeldAkumaLeash.try(source.paths))!;
    const body = await bodyLeash.recordBody(source.paths, {
      leashTakenAt: "2026-08-11T00:00:00.000Z",
    });
    bodyLeash.release();
    for (const sessionId of ["session-1", "session-2", "session-3"]) {
      await recordSession(source.paths, {
        provider: "claude",
        coordinate: { sessionId },
        cwd: root,
        options: {},
        admittedAt: "2026-08-11T00:00:00.000Z",
      });
    }
    const last = async () => Keiyaku.history({ path: root, akuma: source.id, last: true });

    assert.deepEqual(await last(), { kind: "no-answer", id: source.id, contract: { kind: "none" } });
    await completeTurn(source.paths, body.sequence, { kind: "failed", diagnostic: "first failure" }, "2026-08-11T00:00:01.000Z");
    assert.deepEqual(await last(), { kind: "no-answer", id: source.id, contract: { kind: "none" } });
    await completeTurn(source.paths, body.sequence, { kind: "answered", answer: "first", historyId: "history-1", session: { sessionId: "session-1" } }, "2026-08-11T00:00:02.000Z");
    assert.deepEqual(await last(), { kind: "last", id: source.id, answer: "first", contract: { kind: "none" } });
    await completeTurn(source.paths, body.sequence, { kind: "answered", answer: "second", historyId: "history-2", session: { sessionId: "session-2" } }, "2026-08-11T00:00:03.000Z");
    assert.deepEqual(await last(), { kind: "last", id: source.id, answer: "second", contract: { kind: "none" } });
    await completeTurn(source.paths, body.sequence, { kind: "failed", diagnostic: "later failure" }, "2026-08-11T00:00:04.000Z");
    assert.deepEqual(await last(), { kind: "last", id: source.id, answer: "second", contract: { kind: "none" } });
    await completeTurn(source.paths, body.sequence, { kind: "answered", answer: "", historyId: "history-3", session: { sessionId: "session-3" } }, "2026-08-11T00:00:05.000Z");
    assert.deepEqual(await last(), { kind: "last", id: source.id, answer: "", contract: { kind: "none" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-World Contract selector wait keeps Dispatch order and completion", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const later = await answered(world, "worker", "bbbbbbbb");
  const earlier = await answered(world, "worker", "aaaaaaaa");
  const owner = contractId("kei/same-world");
  const repo = await Repo.at({ path: world });
  const git = await repositoryAt(world);
  assert.equal((await publishDispatch({ repository: git, akuId: later.id, contractId: owner })).kind, "dispatched");
  assert.equal((await publishDispatch({ repository: git, akuId: earlier.id, contractId: owner })).kind, "dispatched");
  const waited = await Keiyaku.wait({
    path: world,
    akuma: ["kei/same-world", later.id],
    repo,
    completion: "all",
    timeoutMs: 0,
  });
  assert.deepEqual(waited.observations.map((view) => view.status.id), [earlier.id, later.id]);
  assert.equal(waited.completion, "all");
  const any = await Keiyaku.wait({
    path: world,
    akuma: ["kei/same-world"],
    repo,
    completion: "any",
    timeoutMs: 0,
  });
  assert.equal(any.completion, "any");
  assert.equal(any.observations.length, 2);
});

test("cross-World Contract selector wait and kill refuse before operating", async () => {
  const rawA = makeGitRepository();
  const rawB = makeGitRepository();
  for (const repository of [rawA, rawB]) {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  const worldA = await World.at(rawA.path);
  const worldB = await World.at(rawB.path);
  const born = await answered(worldA, "worker", "deadbeef");
  const owner = contractId("kei/foreign");
  assert.equal((await publishDispatch({
    repository: await repositoryAt(worldB),
    akuId: born.id,
    contractId: owner,
  })).kind, "dispatched");
  const repoB = await Repo.at({ path: worldB });
  const wait = Keiyaku.wait({
    path: worldB,
    akuma: ["kei/foreign"],
    repo: repoB,
    timeoutMs: 0,
  });
  await assert.rejects(wait, (error: unknown) => {
    assert.ok(error instanceof AkumaWorldScopeError);
    assert.deepEqual(error.refusal, { kind: "akuma-not-in-world", ids: [born.id], world: worldB });
    assert.doesNotMatch(error.message, /is not born/u);
    return true;
  });
  await assert.rejects(
    Keiyaku.kill({ path: worldB, akuma: ["kei/foreign"], repo: repoB }),
    (error: unknown) => error instanceof AkumaWorldScopeError && error.refusal.kind === "akuma-not-in-world",
  );
});

test("direct missing Aku remains AkumaNotBornError", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-direct-missing-"));
  try {
    const missing = akuId({ archetype: "worker", suffix: "deadbeef" });
    await assert.rejects(Keiyaku.status({ path: root, akuma: missing }), AkumaNotBornError);
    await assert.rejects(Keiyaku.wait({ path: root, akuma: [missing], timeoutMs: 0 }), AkumaNotBornError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plural wait preserves a missing direct AkuId error", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-plural-direct-missing-"));
  try {
    const missing = akuId({ archetype: "worker", suffix: "00000001" });
    const readable = await answered(root, "worker", "00000002");
    await assert.rejects(
      Keiyaku.wait({ path: root, akuma: [missing, readable.id], completion: "all", timeoutMs: 0 }),
      (error: unknown) => error instanceof AkumaNotBornError && error.id === missing,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract selector preserves Dispatch membership skipped by compact fleet", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const missing = akuId({ archetype: "worker", suffix: "deadbeef" });
  assert.equal((await publishDispatch({
    repository: await repositoryAt(world),
    akuId: missing,
    contractId: contractId("kei/review"),
  })).kind, "dispatched");
  await assert.rejects(
    addressAkumaSet({
      path: world,
      akuma: ["kei/review"],
      repo: await Repo.at({ path: world }),
    }),
    (error: unknown) => error instanceof AkumaWorldScopeError
      && error.refusal.ids.length === 1
      && error.refusal.ids[0] === missing
      && error.refusal.world === world,
  );
});

test("one-member Contract selector retains a corrupt Heart diagnostic", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const unreadable = corruptHeart(world, "deadbeef");
  assert.equal((await publishDispatch({
    repository: await repositoryAt(world),
    akuId: unreadable,
    contractId: contractId("kei/review"),
  })).kind, "dispatched");
  const repo = await Repo.at({ path: world });
  assert.deepEqual((await addressAkumaSet({ path: world, akuma: ["kei/review"], repo })).ids, [unreadable]);
  const corruptDiagnostic = (error: unknown) => error instanceof Error
    && /schema version|SQLITE|database|file is not a database/iu.test(error.message);
  await assert.rejects(Keiyaku.wait({ path: world, akuma: [unreadable], timeoutMs: 0 }), corruptDiagnostic);
  await assert.rejects(Keiyaku.wait({ path: world, akuma: ["kei/review"], repo, timeoutMs: 0 }), corruptDiagnostic);
});

test("Contract plural wait omits unreadable Heart observations for all and any", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const unreadable = corruptHeart(world, "aaaaaaaa");
  const readable = await answered(world, "worker", "bbbbbbbb");
  const owner = contractId("kei/plural-corrupt");
  const git = await repositoryAt(world);
  for (const akuId of [unreadable, readable.id]) {
    assert.equal((await publishDispatch({ repository: git, akuId, contractId: owner })).kind, "dispatched");
  }
  const repo = await Repo.at({ path: world });
  for (const completion of ["all", "any"] as const) {
    const waited = await Keiyaku.wait({
      path: world,
      akuma: [owner],
      repo,
      completion,
      timeoutMs: 0,
    });
    assert.deepEqual(waited.observations.map((observation) => observation.status.id), [readable.id]);
  }
});

test("plural wait returns no observations when every status is unreadable", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-wait-unreadable-"));
  try {
    const earlier = corruptHeart(root, "00000001");
    const later = corruptHeart(root, "00000002");
    for (const completion of ["all", "any"] as const) {
      assert.deepEqual(await Keiyaku.wait({
        path: root,
        akuma: [earlier, later],
        completion,
        timeoutMs: 0,
      }), {
        completion,
        observations: [],
        unobserved: [
          { id: earlier, diagnostic: "file is not a database" },
          { id: later, diagnostic: "file is not a database" },
        ],
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fleet status projects Dispatch association without changing Akuma core", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const source = await answered(repository.path, "worker", "deadbeef");
  const owner = contractId("kei/provider-core");
  assert.equal((await publishDispatch({ repository: await repositoryAt(repository.path), akuId: source.id, contractId: owner })).kind, "dispatched");

  const plain = await Keiyaku.status({ path: repository.path, akuma: source.id });
  assert.equal("contractId" in plain, false);
  assert.equal(plain.status.id, source.id);
  const projected = await Keiyaku.status({ path: repository.path, akuma: source.id, repo: await Repo.at({ path: repository.path }) });
  assert.deepEqual(projected.contract, { kind: "associated", contractId: owner });
  assert.equal(projected.status.id, source.id);
  const waited = await Keiyaku.wait({
    path: repository.path,
    akuma: [source.id],
    repo: await Repo.at({ path: repository.path }),
    timeoutMs: 0,
  });
  assert.deepEqual(waited.observations[0]!.contract, { kind: "associated", contractId: owner });
});

test("CLI wait and kill expose Contract selector world refusal as typed usage", async () => {
  const rawA = makeGitRepository();
  const rawB = makeGitRepository();
  for (const repository of [rawA, rawB]) {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  const worldA = await World.at(rawA.path);
  const worldB = await World.at(rawB.path);
  const born = await answered(worldA, "worker", "deadbeef");
  assert.equal((await publishDispatch({
    repository: await repositoryAt(worldB),
    akuId: born.id,
    contractId: contractId("kei/foreign"),
  })).kind, "dispatched");
  const argv = ["-C", worldB, "--repo", worldB, "wait", "kei/foreign", "--timeout", "0ms"];
  await assert.rejects(
    () => invoke(parseArgv(argv), { cwd: worldB, environment: {} }),
    (error: unknown) => {
      assert.ok(error instanceof AkumaWorldScopeError);
      assert.deepEqual(error.refusal, { kind: "akuma-not-in-world", ids: [born.id], world: worldB });
      return true;
    },
  );
  await assert.rejects(
    () => invoke(parseArgv(["-C", worldB, "--repo", worldB, "kill", "kei/foreign"]), { cwd: worldB, environment: {} }),
    AkumaWorldScopeError,
  );

  const capture = async (args: readonly string[]) => {
    const child = spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `import { main } from ${JSON.stringify(new URL("../src/cli/main.ts", import.meta.url).href)}; process.exitCode = await main(JSON.parse(process.env.KEIYAKU_TEST_ARGS));`,
    ], {
      cwd: worldB,
      env: { ...process.env, KEIYAKU_TEST_ARGS: JSON.stringify(args) },
      encoding: "utf8",
    });
    return { code: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
  };
  const text = await capture(["-C", worldB, "--repo", worldB, "wait", "kei/foreign", "--timeout", "0ms"]);
  assert.equal(text.code, 1);
  assert.equal(text.stdout, "");
  assert.equal(text.stderr, `akuma-not-in-world ${worldB} ${born.id}\n`);
  assert.doesNotMatch(text.stderr, /is not born/u);
  const json = await capture(["-C", worldB, "--repo", worldB, "wait", "kei/foreign", "--json", "--timeout", "0ms"]);
  assert.equal(json.code, 1);
  assert.equal(json.stdout, "");
  assert.deepEqual(JSON.parse(json.stderr), { kind: "akuma-not-in-world", ids: [born.id], world: worldB });
  assert.doesNotMatch(json.stderr, /is not born/u);
  const killText = await capture(["-C", worldB, "--repo", worldB, "kill", "kei/foreign"]);
  assert.equal(killText.code, 1);
  assert.equal(killText.stdout, "");
  assert.equal(killText.stderr, `akuma-not-in-world ${worldB} ${born.id}\n`);
  assert.doesNotMatch(killText.stderr, /is not born/u);
  const killJson = await capture(["-C", worldB, "--repo", worldB, "kill", "kei/foreign", "--json"]);
  assert.equal(killJson.code, 1);
  assert.equal(killJson.stdout, "");
  assert.deepEqual(JSON.parse(killJson.stderr), { kind: "akuma-not-in-world", ids: [born.id], world: worldB });
  assert.doesNotMatch(killJson.stderr, /is not born/u);
});

test("exact set selection does not read unrelated Alias authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-exact-address-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
    writeFileSync(join(root, ".keiyaku", "akuma", "alias.json"), "broken\n");
    const id = akuId({ archetype: "worker", suffix: "deadbeef" });
    assert.deepEqual((await addressAkumaSet({ path: root, akuma: [id] })).ids, [id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function creatorTask(input: Readonly<{
  id: TaskId;
  title: string;
  createdBy?: string;
  state?: TaskDocument["state"];
  priority?: TaskDocument["priority"];
}>): TaskDocument {
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

function writeCreatorTask(world: string, document: TaskDocument): void {
  const path = authorityPath(world, document.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTaskDocument(document));
}

test("creator testimony appears on every Fleet observation carrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-created-tasks-"));
  try {
    const worker = await answered(root, "worker", "00000001");
    const reviewer = await answered(root, "reviewer", "00000002");
    const world = await World.at(root);
    writeCreatorTask(world, creatorTask({
      id: "task/match-high", title: "Match high", createdBy: worker.id, priority: 0, state: "done",
    }));
    writeCreatorTask(world, creatorTask({
      id: "task/match-low", title: "Match low", createdBy: worker.id, priority: 3, state: "open",
    }));
    writeCreatorTask(world, creatorTask({
      id: "task/reviewer-only", title: "Reviewer only", createdBy: reviewer.id, priority: 1,
    }));
    writeCreatorTask(world, creatorTask({
      id: "task/unsigned", title: "Unsigned",
    }));
    writeCreatorTask(world, creatorTask({
      id: "task/near-miss", title: "Near miss", createdBy: `${worker.id} `,
    }));
    const expected = projectTaskBoardObservation((await readBoard(world)).board);
    const workerRows = expected.selectCreatedBy(worker.id);
    const reviewerRows = expected.selectCreatedBy(reviewer.id);
    assert.deepEqual(workerRows.map((row) => row.id), ["task/match-high", "task/match-low"]);
    assert.deepEqual(reviewerRows.map((row) => row.id), ["task/reviewer-only"]);

    const status = await Keiyaku.status({ path: root, akuma: worker.id });
    assert.deepEqual(status.createdTasks, { kind: "present", rows: workerRows });
    const waited = await Keiyaku.wait({ path: root, akuma: [worker.id], timeoutMs: 0 });
    assert.deepEqual(waited.observations[0]!.createdTasks, { kind: "present", rows: workerRows });
    const told = await Keiyaku.tell({ path: root, akuma: worker.id, body: "continue" });
    assert.deepEqual(told.observation.createdTasks, { kind: "present", rows: workerRows });
    const interrupted = await Keiyaku.interrupt({ path: root, akuma: worker.id, body: "stop" });
    assert.deepEqual(interrupted.observation.createdTasks, { kind: "present", rows: workerRows });
    const killed = await Keiyaku.kill({ path: root, akuma: [worker.id] });
    assert.deepEqual(killed.results[0]!.observation.createdTasks, { kind: "present", rows: workerRows });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-member wait and kill project every member from one Task board snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-created-set-"));
  try {
    const worker = await answered(root, "worker", "00000001");
    const reviewer = await answered(root, "reviewer", "00000002");
    const world = await World.at(root);
    writeCreatorTask(world, creatorTask({
      id: "task/from-worker", title: "From worker", createdBy: worker.id, priority: 1,
    }));
    writeCreatorTask(world, creatorTask({
      id: "task/from-reviewer", title: "From reviewer", createdBy: reviewer.id, priority: 0, state: "drop",
    }));
    const expected = projectTaskBoardObservation((await readBoard(world)).board);
    const waited = await Keiyaku.wait({
      path: root,
      akuma: [worker.id, reviewer.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.deepEqual(waited.observations.map((observation) => observation.status.id), [reviewer.id, worker.id]);
    assert.deepEqual(waited.observations.map((observation) => observation.createdTasks), [
      { kind: "present", rows: expected.selectCreatedBy(reviewer.id) },
      { kind: "present", rows: expected.selectCreatedBy(worker.id) },
    ]);
    const killed = await Keiyaku.kill({ path: root, akuma: [worker.id, reviewer.id] });
    assert.deepEqual(killed.results.map((member) => member.id), [reviewer.id, worker.id]);
    assert.deepEqual(killed.results.map((member) => member.observation.createdTasks), [
      { kind: "present", rows: expected.selectCreatedBy(reviewer.id) },
      { kind: "present", rows: expected.selectCreatedBy(worker.id) },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task board failure keeps Fleet status and aggregate members", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-created-failed-"));
  try {
    const worker = await answered(root, "worker", "00000001");
    const reviewer = await answered(root, "reviewer", "00000002");
    mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
    writeFileSync(join(root, ".keiyaku", "tasks", "bad.md"), "not a task document\n");
    const status = await Keiyaku.status({ path: root, akuma: worker.id });
    assert.equal(status.status.id, worker.id);
    assert.equal(status.createdTasks.kind, "failed");
    if (status.createdTasks.kind === "failed") assert.match(status.createdTasks.diagnostic, /front matter/u);
    const waited = await Keiyaku.wait({
      path: root,
      akuma: [worker.id, reviewer.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.deepEqual(waited.observations.map((observation) => observation.status.id), [reviewer.id, worker.id]);
    assert.equal(waited.observations.every((observation) => observation.createdTasks.kind === "failed"), true);
    assert.deepEqual(
      waited.observations.map((observation) => observation.createdTasks),
      [status.createdTasks, status.createdTasks],
    );
    const told = await Keiyaku.tell({ path: root, akuma: worker.id, body: "continue" });
    assert.equal(told.akuma, worker.id);
    assert.equal(told.tell.admission.fact, "recorded");
    assert.equal(typeof told.tell.admission.tellId, "string");
    assert.deepEqual(told.observation.createdTasks, status.createdTasks);
    const killed = await Keiyaku.kill({ path: root, akuma: [reviewer.id] });
    assert.equal(killed.results[0]!.id, reviewer.id);
    assert.equal(killed.results[0]!.evidence, "already-stopped");
    assert.deepEqual(killed.results[0]!.observation.createdTasks, status.createdTasks);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
