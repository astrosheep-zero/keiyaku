import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { appendActivity, beginTurn, endTurn, initializeHeart, recordBody, recordSession, recordTell } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { Keiyaku, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { parseArgv } from "../src/cli/parse.js";
import { settings } from "../src/settings.js";
import { Tasks, type TaskId } from "../src/task/index.js";
import { serializeTaskDocument } from "../src/task/document.js";
import { authorityPath } from "../src/task/store.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";
import { matchesAkumaGlob, parseAkumaGlob } from "../src/identity/selector.js";
import { addressAkumaSet, resolveNamedAddress } from "../src/library/address.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { akuId } from "../src/akuma/identity.js";
import { contractId } from "../src/core/facts/types.js";

const provider: ProviderAdapter = {
  confinement: () => ({ kind: "unconfined" }),
  admitOptions(options) { return { kind: "admitted", options }; },
  async start() {
    return {
      admission: { fence: "fleet-fixture-turn" },
      events: { async *[Symbol.asyncIterator]() { yield { type: "session" as const, coordinate: { sessionId: "fixture" } }; } },
      completion: Promise.resolve({ kind: "answered", answer: "done", historyId: "history" }),
      async abort() {},
    };
  },
};

function completeTurn(paths: Parameters<typeof beginTurn>[0], bodySequence: number, outcome: Parameters<typeof endTurn>[1]["outcome"], completedAt: string): void {
  const turn = beginTurn(paths, { bodySequence, startedAt: completedAt });
  endTurn(paths, { turnSequence: turn.sequence, outcome, completedAt });
}

async function answered(root: string, archetype: string, suffix: string) {
  const allocated = allocateAkumaDirectory({ worldRoot: root, archetype, draw: () => suffix });
  initializeHeart(allocated.paths);
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype,
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: root,
    },
    initialBody: "work",
  }, provider, {
    collar: { pid: 999_970, processGroup: 999_970, spawnedAt: suffix },
    now: () => "2026-08-11T00:00:00.000Z",
    async putDownOwnTree() {},
  });
  return allocated;
}

test("facade snapshots aliases and globs with stable dedupe for wait and kill", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-fleet-"));
  try {
    const worker = await answered(root, "worker", "00000002");
    const reviewer = await answered(root, "reviewer", "00000001");
    await moveAlias({ world: root, alias: "@review", akuId: reviewer.id });

    assert.equal(Keiyaku.status({ path: root, akuma: "@review" }).status.id, reviewer.id);
    const waited = await Keiyaku.wait({
      path: root,
      akuma: ["aku/*/*", "@review", worker.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.deepEqual(waited.statuses.map((view) => view.status.id), [reviewer.id, worker.id]);

    const killed = await Keiyaku.kill({ path: root, akuma: ["@review", worker.id] });
    assert.deepEqual(killed.results.map((member) => member.id), [reviewer.id, worker.id]);
    assert.deepEqual(killed.results.map((member) => member.evidence), ["killed", "killed"]);
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

test("plural wait shares one detail budget without dropping pinned rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-wait-budget-"));
  try {
    const sources = [];
    for (let member = 1; member <= 5; member += 1) {
      const source = await answered(root, "worker", String(member).padStart(8, "0"));
      for (let index = 0; index < 5; index += 1) {
        appendActivity(source.paths, {
          turnSequence: 1,
          event: { type: "assistant", text: `member-${member}-voice-${index}` },
          at: `2026-08-11T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        });
      }
      for (let index = 0; index < (member === 5 ? 3 : 2); index += 1) {
        appendActivity(source.paths, {
          turnSequence: 1,
          event: { type: "note", text: `member-${member}-note-${index}` },
          at: `2026-08-11T00:00:${String(index + 6).padStart(2, "0")}.000Z`,
        });
      }
      sources.push(source);
    }
    appendActivity(sources[4]!.paths, {
      turnSequence: 1,
      event: { type: "tool", phase: "started", id: "running", name: "Bash", call: { kind: "run", command: "npm test" } },
      at: "2026-08-11T00:01:00.000Z",
    });
    recordTell(sources[4]!.paths, { id: "pending", body: "continue", recordedAt: "2026-08-11T00:01:01.000Z" });
    const exhausted = await answered(root, "worker", "00000006");
    for (let index = 0; index < 2; index += 1) {
      appendActivity(exhausted.paths, {
        turnSequence: 1,
        event: { type: "note", text: `exhausted-${index}` },
        at: `2026-08-11T00:02:0${index}.000Z`,
      });
    }
    appendActivity(exhausted.paths, {
      turnSequence: 1,
      event: { type: "tool", phase: "started", id: "running", name: "Bash", call: { kind: "run", command: "npm test" } },
      at: "2026-08-11T00:02:02.000Z",
    });
    sources.push(exhausted);

    const waited = await Keiyaku.wait({
      path: root,
      akuma: sources.map((source) => source.id),
      completion: "all",
      timeoutMs: 0,
    });
    const fifth = waited.statuses[4]!;
    const ordinary = waited.statuses.flatMap((view) => view.status.timeline.entries.filter((entry) =>
      entry.kind === "row"
        && !((entry.row.kind === "tool" && entry.row.state === "running")
          || (entry.row.kind === "tell" && entry.row.state === "pending"))));
    assert.equal(ordinary.length, 32);
    assert.deepEqual(fifth.status.timeline.entries.map((entry) => entry.kind === "gap"
      ? `gap:${entry.count}`
      : entry.row.kind === "said" || entry.row.kind === "note" ? entry.row.text : entry.row.kind), [
      "gap:11",
      "tool",
      "tell",
    ]);
    assert.equal(fifth.status.timeline.entries.some((entry) => entry.kind === "row"
      && entry.row.kind === "tool" && entry.row.state === "running"), true);
    assert.equal(fifth.status.timeline.entries.some((entry) => entry.kind === "row"
      && entry.row.kind === "tell" && entry.row.state === "pending"), true);
    assert.deepEqual(waited.statuses[5]!.status.timeline.entries.map((entry) =>
      entry.kind === "gap" ? `gap:${entry.count}` : entry.row.kind), ["gap:5", "tool"]);
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
    const task = await Tasks.of(World.at(root)).add({ title: "Catalog task" });
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
    }]);
    assert.deepEqual(await Keiyaku.ls({ query: { kind: "archetypes" }, settings: settings({ root, home }) }), {
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
    const first = await Tasks.of(World.at(root)).add({ title: "Catalog 000" });
    assert.equal(first.kind, "accepted");
    for (let index = 1; index <= 100; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const id = `task/catalog-${suffix}` as TaskId;
      writeFileSync(authorityPath(World.at(root), id), serializeTaskDocument({
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
  const repo = Repo.at({ path: repository.path });
  const home = mkdtempSync(join(tmpdir(), "keiyaku-cli-ls-home-"));
  try {
    repository.run(["config", "user.name", "Test User"]);
    repository.run(["config", "user.email", "test@example.com"]);
    repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const world = World.at(repository.path);
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
    const worker = allocateAkumaDirectory({ worldRoot: world, archetype: "worker", draw: () => "00000001" });
    const reviewer = allocateAkumaDirectory({ worldRoot: world, archetype: "reviewer", draw: () => "00000002" });
    initializeHeart(worker.paths);
    initializeHeart(reviewer.paths);

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
  const repo = Repo.at({ path: repository.path });
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
  const contracts = (await Keiyaku.list({ repo })).rows;
  assert.throws(
    () => resolveNamedAddress({ path: World.at(repository.path), selector: "@review", contracts }),
    /ambiguous selector matches Contract and Akuma/u,
  );
});

test("history last bypasses activity and glob grammar follows normalized archetypes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-last-"));
  try {
    const source = await answered(root, "worker", "00000001");
    appendActivity(source.paths, {
      turnSequence: 1,
      event: { type: "activity", event: { provider: "legacy" } },
      at: "2026-08-11T00:00:01.000Z",
    });
    assert.deepEqual(Keiyaku.history({ path: root, akuma: source.id, last: true }), {
      kind: "last",
      id: source.id,
      answer: "done",
    });
    assert.throws(() => Keiyaku.history({ path: root, akuma: source.id }), /invalid event shape/u);

    const glob = parseAkumaGlob("aku/审查-👁️*/1234*");
    assert.equal(matchesAkumaGlob(glob, "aku/审查-👁️/1234abcd"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history last selects exactly one latest answered TurnFact by durable sequence", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-last-sequence-"));
  try {
    const source = allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => "00000001" });
    initializeHeart(source.paths);
    const body = recordBody(source.paths, {
      collar: { pid: 999_969, processGroup: 999_969, spawnedAt: "fixture" },
      leashTakenAt: "2026-08-11T00:00:00.000Z",
    });
    for (const sessionId of ["session-1", "session-2", "session-3"]) {
      recordSession(source.paths, {
        provider: "claude",
        coordinate: { sessionId },
        cwd: root,
        options: {},
        admittedAt: "2026-08-11T00:00:00.000Z",
      });
    }
    const last = () => Keiyaku.history({ path: root, akuma: source.id, last: true });

    assert.deepEqual(last(), { kind: "no-answer", id: source.id });
    completeTurn(source.paths, body.sequence, { kind: "failed", diagnostic: "first failure" }, "2026-08-11T00:00:01.000Z");
    assert.deepEqual(last(), { kind: "no-answer", id: source.id });
    completeTurn(source.paths, body.sequence, { kind: "answered", answer: "first", historyId: "history-1", session: { sessionId: "session-1" } }, "2026-08-11T00:00:02.000Z");
    assert.deepEqual(last(), { kind: "last", id: source.id, answer: "first" });
    completeTurn(source.paths, body.sequence, { kind: "answered", answer: "second", historyId: "history-2", session: { sessionId: "session-2" } }, "2026-08-11T00:00:03.000Z");
    assert.deepEqual(last(), { kind: "last", id: source.id, answer: "second" });
    completeTurn(source.paths, body.sequence, { kind: "failed", diagnostic: "later failure" }, "2026-08-11T00:00:04.000Z");
    assert.deepEqual(last(), { kind: "last", id: source.id, answer: "second" });
    completeTurn(source.paths, body.sequence, { kind: "answered", answer: "", historyId: "history-3", session: { sessionId: "session-3" } }, "2026-08-11T00:00:05.000Z");
    assert.deepEqual(last(), { kind: "last", id: source.id, answer: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract selector preserves Dispatch membership skipped by compact fleet", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const missing = akuId({ archetype: "worker", suffix: "deadbeef" });
  assert.equal(publishDispatch({
    repository: repositoryAt(repository.path),
    akuId: missing,
    contractId: contractId("kei/review"),
  }).kind, "dispatched");
  assert.deepEqual((await addressAkumaSet({
    path: repository.path,
    akuma: ["kei/review"],
    repo: Repo.at({ path: repository.path }),
  })).ids, [missing]);
});

test("fleet status projects Dispatch association without changing Akuma core", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const source = await answered(repository.path, "worker", "deadbeef");
  const owner = contractId("kei/provider-core");
  assert.equal(publishDispatch({ repository: repositoryAt(repository.path), akuId: source.id, contractId: owner }).kind, "dispatched");

  const plain = Keiyaku.status({ path: repository.path, akuma: source.id });
  assert.equal("contractId" in plain, false);
  assert.equal(plain.status.id, source.id);
  const projected = Keiyaku.status({ path: repository.path, akuma: source.id, repo: Repo.at({ path: repository.path }) });
  assert.equal(projected.contractId, owner);
  assert.equal(projected.status.id, source.id);
  const waited = await Keiyaku.wait({
    path: repository.path,
    akuma: [source.id],
    repo: Repo.at({ path: repository.path }),
    timeoutMs: 0,
  });
  assert.equal(waited.statuses[0]!.contractId, owner);
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
