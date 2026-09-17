import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { boundedMap, PAGE_POOL_SIZE } from "../src/akuma/akuma-product.js";
import { AkumaNotBornError, akumaStatusSchema, type AkumaStatus } from "../src/akuma/akuma.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { appendActivity, beginTurn, initializeHeart, readHeart, recordTell } from "../src/akuma/heart/index.js";
import { akuId, allocateAkumaDirectory } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { moveAlias } from "../src/alias/index.js";
import { contractId, contractSegment } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { AkumaWorldScopeError, Keiyaku, Repo, type Catalog, type WorldRoot } from "../src/index.js";
import { observeKanshi } from "../src/kanshi/read.js";
import { addressAkumaSet, resolveNamedAddress } from "../src/library/address.js";
import { waitAkuma } from "../src/library/fleet.js";
import type { WaitObservedAkuma, WaitSelectedAkuma } from "../src/akuma/fleet-execution.js";
import { projectTaskBoardObservation, taskRowsSchema, type TaskRow } from "../src/task/board.js";
import { serializeTaskDocument, type TaskDocument } from "../src/task/document.js";
import { Tasks, type TaskId } from "../src/task/index.js";
import { formatTaskId } from "../src/task/identity.js";
import { authorityPath, readBoard } from "../src/task/store.js";
import { World } from "../src/world.js";
import { AkumaComposition as Akuma } from "./support/akuma-composition.js";
import { makeGitRepository } from "./support/git.js";
import { taskDocument as creatorTask, writeTaskAuthority as writeCreatorTask } from "./support/task.js";

let fixtureHistory = 0;

function fixtureSession(input: Readonly<{ signal: AbortSignal }>) {
  return createProviderAttempt(input.signal, async (custody) => {
    const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
    const completion = eventsFinished.then(() => ({
      kind: "answered" as const,
      answer: "done",
      historyId: `fleet-history-${fixtureHistory++}`,
    }));
    const session = {
      admission: { fence: "fleet-fixture-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "fixture" } };
          finishEvents();
        },
      },
      completion,
      async abort() {},
      async forceDispose() {},
    };
    custody.own({
      closed: completion.then(() => undefined),
      abort: session.abort,
      forceDispose: session.forceDispose,
    });
    return session;
  });
}

const provider: ProviderAdapter = {
  admitOptions(options) {
    return { kind: "admitted", options };
  },
  start: fixtureSession,
  resume: fixtureSession,
};

function fixtureRoot(t: TestContext, prefix: string): WorldRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))) as WorldRoot;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The template is a closed, unborn database pair: no Soul or identity-bound facts.
// Copy bytes, never hard-link them, so every catalog member keeps independent custody.
async function initializeUnbornFixture(
  paths: Parameters<typeof initializeHeart>[0],
  template: Parameters<typeof initializeHeart>[0] | undefined,
): Promise<void> {
  if (template === undefined) return initializeHeart(paths);
  copyFileSync(template.heart, paths.heart, constants.COPYFILE_EXCL);
  copyFileSync(template.leash, paths.leash, constants.COPYFILE_EXCL);
}

function catalogOf<K extends Catalog["kind"]>(catalog: Catalog, kind: K): Extract<Catalog, { kind: K }> {
  if (catalog.kind !== kind) throw new Error(`expected ${kind} catalogue`);
  return catalog as Extract<Catalog, { kind: K }>;
}

function taskCatalogDocument(id: TaskId, updatedAt: string): TaskDocument {
  return {
    id,
    title: id,
    body: "",
    note: "",
    state: "open",
    priority: 2,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

test("Akuma and Task owner schemas strictly decode Fleet projections", () => {
  const status: AkumaStatus = {
    id: akuId({ archetype: "worker", suffix: "00000001" }),
    life: "running",
    allowed: ["akuma.call"],
    timeline: { kind: "unborn", entries: [], omitted: 0, reportedChanges: [], reportedChangesOmitted: 0 },
  };
  const row: TaskRow = {
    id: formatTaskId({ namespace: [], localId: "fleet-row" }),
    title: "Fleet row",
    state: "open",
    priority: 2,
    disposition: "ready",
    updatedAt: "2026-08-29T00:00:00.000Z",
    bodyPresent: false,
  };

  assert.deepEqual(akumaStatusSchema.parse(status), status);
  assert.deepEqual(akumaStatusSchema.parse({ ...status, allowed: ["task.add", "akuma.call"] }).allowed, [
    "akuma.call",
    "task.add",
  ]);
  assert.equal(akumaStatusSchema.safeParse({ ...status, allowed: ["akuma.call", "akuma.call"] }).success, false);
  assert.equal(
    akumaStatusSchema.safeParse({ id: status.id, life: status.life, timeline: status.timeline }).success,
    false,
  );
  assert.deepEqual(taskRowsSchema.parse([row]), [row]);
  assert.equal(akumaStatusSchema.safeParse({ ...status, undeclared: true }).success, false);
  assert.equal(taskRowsSchema.safeParse([{ ...row, undeclared: true }]).success, false);
});

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
      event: {
        type: "tool",
        phase: "started",
        id: "running",
        name: "Bash",
        call: { kind: "run", command: "npm test" },
      },
      at: `${second}${String(voices + notes + 1).padStart(2, "0")}.000Z`,
    });
  }
  if (spec.tellId !== undefined) {
    await recordTell(paths, { kind: "tell", id: spec.tellId, body: "continue", recordedAt: `${second}59.000Z` });
  }
}

async function answered(root: string, archetype: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype, draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype,
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: root,
        allowed: ALLOWED_ACTIONS,
      },
      initialBody: "work",
    },
    provider,
    {
      now: () => "2026-08-11T00:00:00.000Z",
    },
  );
  return allocated;
}

function corruptHeart(root: string, suffix: string) {
  const id = akuId({ archetype: "worker", suffix });
  const directory = join(root, ".keiyaku", "akuma", "run", `worker-${suffix}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "heart.db"), "broken\n");
  return id;
}

test("facade snapshots aliases and globs with stable dedupe for wait and kill", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-fleet-");
  const worker = await answered(root, "worker", "00000002");
  const reviewer = await answered(root, "reviewer", "00000001");
  await moveAlias({ world: root, alias: parseAkumaAlias("@review"), akuId: reviewer.id });

  assert.equal((await Keiyaku.status({ path: root, akuma: "@review" })).status.id, reviewer.id);
  const waited = await Keiyaku.wait({
    path: root,
    akuma: ["aku/*/*", "@review", worker.id],
    completion: "all",
    timeoutMs: 0,
  });
  assert.deepEqual(
    waited.observations.map((view) => view.status.id),
    [reviewer.id, worker.id],
  );

  const killed = await Keiyaku.kill({ path: root, akuma: ["@review", worker.id] });
  assert.deepEqual(
    killed.results.map((member) => member.id),
    [reviewer.id, worker.id],
  );
  assert.deepEqual(
    killed.results.map((member) => member.evidence),
    ["already-stopped", "already-stopped"],
  );
});

test("a wait's live observation carries each observed Akuma's alias and Dispatch association", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const worker = await answered(world, "worker", "dddddddd");
  const owner = contractId("kei/observed");
  assert.equal(
    (await publishDispatch({ repository: await repositoryAt(world), akuId: worker.id, contractId: owner })).kind,
    "dispatched",
  );
  await moveAlias({ world, alias: parseAkumaAlias("@observed"), akuId: worker.id });
  const rounds: (readonly WaitObservedAkuma[])[] = [];
  const selected: (readonly WaitSelectedAkuma[])[] = [];
  await waitAkuma(
    {
      path: world,
      akuma: [worker.id],
      repo: await Repo.at({ path: world }),
      completion: "all",
      timeoutMs: 0,
    },
    undefined,
    {
      selected: (members) => selected.push(members),
      observe: (observed) => rounds.push(observed),
    },
  );
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0], [
    { id: worker.id, alias: "@observed", contract: { kind: "associated", contractId: owner } },
  ]);
  assert.equal(rounds.length, 1);
  const [single] = rounds[0]!;
  assert.equal(single?.status.id, worker.id);
  assert.equal(single?.alias, "@observed");
  assert.deepEqual(single?.contract, { kind: "associated", contractId: owner });
});

test("a facade wait defaults an omitted completion mode to any and counts an already complete member", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-mode-");
  const complete = await answered(root, "worker", "00000001");
  const running = await answered(root, "worker", "00000002");
  await openOrdinary(running.paths, "2026-08-11T00:01:00.000Z", { prefix: "runner", tellId: "pending" });

  // The completed member satisfies any on the first round, so this does not wait for the runner.
  const waited = await Keiyaku.wait({ path: root, akuma: [complete.id, running.id], timeoutMs: 2_000 });
  assert.equal(waited.completion, "any");
  assert.deepEqual(
    waited.observations.map((view) => view.status.id),
    [complete.id, running.id],
  );

  // A glob resolving to the same plural set takes the same default.
  const globbed = await Keiyaku.wait({ path: root, akuma: ["aku/worker/*"], timeoutMs: 0 });
  assert.equal(globbed.completion, "any");
  assert.deepEqual(
    globbed.observations.map((view) => view.status.id),
    [complete.id, running.id],
  );

  // The already completed member still counts, so waiting again can return at once.
  const again = await Keiyaku.wait({ path: root, akuma: [complete.id, running.id], timeoutMs: 0 });
  assert.equal(again.completion, "any");
  assert.deepEqual(
    again.observations.map((view) => view.status.id),
    [complete.id, running.id],
  );
});

test("a facade wait still refuses an invalid completion mode", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-invalid-mode-");
  const one = await answered(root, "worker", "00000001");
  const two = await answered(root, "worker", "00000002");
  await assert.rejects(
    Keiyaku.wait({ path: root, akuma: [one.id, two.id], completion: "service" as never, timeoutMs: 0 }),
    /completion must be any or all/u,
  );
});

test("facade ls reads exactly one selected identity directory", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-catalog-");
  const home = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-home-"));
  try {
    const source = await answered(root, "worker", "00000001");
    const task = await Tasks.of(await World.at(root)).add({ title: "Catalog task" });
    assert.equal(task.kind, "accepted");
    mkdirSync(join(home, "akuma"));
    writeFileSync(
      join(home, "akuma", "reviewer.md"),
      [
        "---",
        "provider: missing",
        "model: review-model",
        "description: Complete catalog description.",
        "---",
        "prompt",
        "",
      ].join("\n"),
    );
    const tasks = await Keiyaku.ls({ query: { kind: "tasks" }, path: root });
    assert.equal(tasks.kind, "tasks");
    assert.deepEqual(tasks.rows, [
      {
        id: task.value.id,
        title: "Catalog task",
        state: "open",
        priority: 2,
        disposition: "ready",
        updatedAt: task.value.updatedAt,
        bodyPresent: false,
      },
    ]);
    assert.deepEqual(await Keiyaku.ls({ query: { kind: "archetypes" }, home }), {
      kind: "archetypes",
      rows: [{ name: "reviewer", model: "review-model", description: "Complete catalog description." }],
    });
    const workers = catalogOf(await Keiyaku.ls({ query: { kind: "akuma", archetype: "worker" }, path: root }), "akuma");
    assert.deepEqual(
      workers.rows.map((row) => row.id),
      [source.id],
    );
    assert.deepEqual((await Keiyaku.ls({ query: { kind: "akuma", archetype: "reviewer" }, path: root })).rows, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("facade Akuma catalog returns bounded Heart activity in semantic order", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-page-");
  const first = await answered(root, "worker", "00000003");
  const tiedFirst = await answered(root, "worker", "00000001");
  const tiedSecond = await answered(root, "worker", "00000002");
  const reviewer = await answered(root, "reviewer", "00000001");
  await appendActivity(first.paths, {
    turnSequence: 1,
    event: { type: "activity", event: { provider: "fixture" } },
    at: "2026-08-11T00:00:01.000Z",
  });
  for (const source of [tiedFirst, tiedSecond]) {
    await appendActivity(source.paths, {
      turnSequence: 1,
      event: { type: "activity", event: { provider: "fixture" } },
      at: "2026-08-11T00:00:02.000Z",
    });
  }
  await appendActivity(reviewer.paths, {
    turnSequence: 1,
    event: { type: "activity", event: { provider: "fixture" } },
    at: "2026-08-11T00:00:03.000Z",
  });

  const page = await Keiyaku.ls({ query: { kind: "akuma", archetype: "worker", limit: 2 }, path: root });
  assert.equal(page.kind, "akuma");
  assert.deepEqual(
    page.rows.map((row) => row.id),
    [tiedFirst.id, tiedSecond.id],
  );
  assert.equal(page.hasMore, true);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let custodyReads = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    custodyReads += 1;
    return originalPrepare.apply(this, args);
  };
  try {
    await assert.rejects(
      Keiyaku.ls({ query: { kind: "akuma", limit: 501 }, path: root }),
      /limit must be an integer from 1 to 500/u,
    );
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  assert.equal(custodyReads, 0);
});

test("recent Akuma page prunes old custody bounds without changing Heart membership", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-page-scale-");
  const old = new Date("2000-01-01T00:00:00.000Z");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let template: Parameters<typeof initializeHeart>[0] | undefined;
  // Fifty-one members cross the default page boundary without a 501-database stress fixture.
  const oldCount = 40;
  try {
    const oldIds = [];
    for (let index = 0; index < oldCount; index += 1) {
      const suffix = index.toString(16).padStart(8, "0");
      const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => suffix });
      await initializeUnbornFixture(allocated.paths, template);
      template ??= allocated.paths;
      oldIds.push(allocated.id);
      utimesSync(allocated.paths.heart, old, old);
      try {
        utimesSync(`${allocated.paths.heart}-wal`, old, old);
      } catch {}
    }
    const recent = await Promise.all(
      Array.from({ length: 11 }, async (_, index) => {
        const source = await answered(root, "worker", `a00000${index.toString(16).padStart(2, "0")}`);
        await appendActivity(source.paths, {
          turnSequence: 1,
          event: { type: "activity", event: { provider: "fixture" } },
          at: `2099-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
        return source;
      }),
    );
    let prepareCalls = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      prepareCalls += 1;
      return originalPrepare.apply(this, args);
    };
    const world = Akuma.of(await World.at(root));
    const page = await world.list({ limit: 10 });
    const pageReads = prepareCalls;
    prepareCalls = 0;
    const complete = await world.listComplete();
    const completeReads = prepareCalls;
    DatabaseSync.prototype.prepare = originalPrepare;
    const defaultPage = await world.list();
    const maximumPage = await world.list({ limit: 500 });
    const reference = complete.rows.map((row) => row.id);
    const completeGlob = await addressAkumaSet({ path: root, akuma: ["aku/*/*"] });

    assert.equal(typeof world.listComplete, "function");
    assert.equal("hasMore" in complete, false);
    assert.deepEqual(
      reference,
      [...recent]
        .reverse()
        .map((source) => source.id)
        .concat(oldIds),
    );
    assert.deepEqual(completeGlob.ids, [...oldIds, ...recent.map((source) => source.id)].sort());
    assert.deepEqual(
      page.rows.map((row) => row.id),
      reference.slice(0, 10),
    );
    assert.equal(page.hasMore, true);
    assert.deepEqual(
      page.rows.map((row) => row.id),
      recent
        .slice()
        .reverse()
        .slice(0, 10)
        .map((row) => row.id),
    );
    assert.ok(pageReads > 0, "the page must read actual Hearts");
    assert.ok(pageReads < completeReads, `page reads ${pageReads} must prune the full ${completeReads} reads`);
    assert.equal(defaultPage.rows.length, 50);
    assert.equal(defaultPage.hasMore, true);
    assert.deepEqual(
      maximumPage.rows.map((row) => row.id),
      reference.slice(0, 500),
    );
    assert.equal(maximumPage.hasMore, false);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true });
  }
});

test("all-null Akuma fallback retains exact membership through the fixed Heart read pool", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-page-null-");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let template: Parameters<typeof initializeHeart>[0] | undefined;
  try {
    const allocated = [];
    for (let index = 0; index < PAGE_POOL_SIZE * 2 + 1; index += 1) {
      const suffix = index.toString(16).padStart(8, "0");
      const value = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => suffix });
      await initializeUnbornFixture(value.paths, template);
      template ??= value.paths;
      allocated.push(value);
    }

    let custodyReads = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      custodyReads += 1;
      return originalPrepare.apply(this, args);
    };
    const world = Akuma.of(await World.at(root));
    const page = await world.list({ limit: 7 });
    DatabaseSync.prototype.prepare = originalPrepare;

    const expected = allocated.map((value) => value.id).sort();
    assert.deepEqual(
      page.rows.map((row) => row.id),
      expected.slice(0, 7),
    );
    assert.equal(page.hasMore, true);
    assert.ok(
      custodyReads >= expected.length,
      `expected every null activity Heart to be read, received ${custodyReads}`,
    );

    let active = 0;
    let maximum = 0;
    await boundedMap(Array.from({ length: PAGE_POOL_SIZE * 3 }), async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    });
    assert.equal(maximum, PAGE_POOL_SIZE);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true });
  }
});

test("recent Task catalog does not skip older-mtime malformed authority", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-task-catalog-malformed-");
  mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
  const world = await World.at(root);
  const older = authorityPath(world, "task/older-malformed");
  const newer = taskCatalogDocument("task/newer-valid", "2026-08-31T00:00:00.000Z");
  writeFileSync(older, "not a task document\n");
  utimesSync(older, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  writeFileSync(authorityPath(world, newer.id), serializeTaskDocument(newer));
  utimesSync(
    authorityPath(world, newer.id),
    new Date("2099-01-01T00:00:00.000Z"),
    new Date("2099-01-01T00:00:00.000Z"),
  );

  await assert.rejects(Keiyaku.ls({ query: { kind: "tasks", limit: 1 }, path: root }), /front matter/u);
});

test("Task catalog namespace queries distinguish omitted, root, and named scope", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-catalog-namespace-");
  const tasks = Tasks.of(await World.at(root));
  const rootTask = await tasks.add({ title: "Catalog root", namespace: [] });
  const featureTask = await tasks.add({ title: "Catalog feature", namespace: ["feature"] });
  const nestedTask = await tasks.add({ title: "Catalog nested", namespace: ["feature", "ui"] });
  assert.equal(rootTask.kind, "accepted");
  assert.equal(featureTask.kind, "accepted");
  assert.equal(nestedTask.kind, "accepted");
  if (rootTask.kind !== "accepted" || featureTask.kind !== "accepted" || nestedTask.kind !== "accepted") return;
  const rootId = rootTask.value.id;
  const featureId = featureTask.value.id;
  const nestedId = nestedTask.value.id;
  const all = catalogOf(await Keiyaku.ls({ query: { kind: "tasks" }, path: root }), "tasks");
  const rootOnly = catalogOf(await Keiyaku.ls({ query: { kind: "tasks", namespace: [] }, path: root }), "tasks");
  const featureOnly = catalogOf(
    await Keiyaku.ls({ query: { kind: "tasks", namespace: ["feature"] }, path: root }),
    "tasks",
  );
  assert.deepEqual(
    all.rows.map((row) => row.id),
    [nestedId, featureId, rootId],
  );
  assert.equal(all.hasMore, false);
  assert.deepEqual(
    rootOnly.rows.map((row) => row.id),
    [rootId],
  );
  assert.deepEqual(
    featureOnly.rows.map((row) => row.id),
    [featureId],
  );
  await assert.rejects(
    () => Keiyaku.ls({ query: { kind: "tasks", namespace: ["bad/segment"] }, path: root }),
    /canonical segments/u,
  );
});

test("named Address resolution refuses a Contract short-id shared with an Alias", async (t) => {
  const repository = fixtureRepository(t);
  const repo = await Repo.at({ path: repository.path });

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = await Keiyaku.bind({
    repo,
    markdown: [
      "# Review",
      "",
      "## Context",
      "ambiguity",
      "",
      "## Objective",
      "refuse",
      "",
      "## Design",
      "one selector judge",
      "",
      "## Region",
      "```",
      "src/**",
      "```",
      "",
      "## Criteria",
      "### Visible",
      "Ambiguity is explicit.",
      "",
    ].join("\n"),
  });
  const boundId = (await bound.keiyaku.state()).id;
  assert.match(boundId, /^kei\/review-[0-9a-f]{4}$/u);
  const alias = parseAkumaAlias(`@${contractSegment(boundId)}`);
  const source = await answered(repository.path, "worker", "00000001");
  const path = await World.at(repository.path);
  await moveAlias({ world: path, alias, akuId: source.id });
  const observation = await observeKanshi({ world: path, repo });
  assert.throws(
    () => resolveNamedAddress({ selector: alias, report: observation.report, aliases: observation.aliases }),
    /ambiguous selector matches Contract and Akuma/u,
  );
});

test("named Address refuses failed Kanshi Contract and Alias observations", async (t) => {
  const root = fixtureRoot(t, "keiyaku-named-kanshi-failed-");
  const observation = await observeKanshi({ world: root });
  const failure = { kind: "failed" as const, failure: { message: "unavailable" } };
  assert.throws(
    () =>
      resolveNamedAddress({
        selector: "@missing",
        report: { ...observation.report, contracts: failure },
        aliases: observation.aliases,
      }),
    /Contract world is failed/u,
  );
  assert.throws(
    () => resolveNamedAddress({ selector: "@missing", report: observation.report, aliases: failure }),
    /Alias authority is failed/u,
  );
});

test("named Address resolves a retained Alias outside Kanshi fleet rows", async (t) => {
  const root = fixtureRoot(t, "keiyaku-named-kanshi-alias-");
  const id = akuId({ archetype: "worker", suffix: "deadbeef" });
  await moveAlias({ world: root, alias: parseAkumaAlias("@outside"), akuId: id });
  const observation = await observeKanshi({ world: root });
  assert.equal(observation.report.akuma.kind, "present");
  assert.equal(
    observation.report.akuma.kind === "present" && observation.report.akuma.value.rows.some((row) => row.id === id),
    false,
  );
  assert.deepEqual(
    resolveNamedAddress({ selector: "@outside", report: observation.report, aliases: observation.aliases }),
    {
      kind: "akuma",
      id,
    },
  );
});

test("cross-World Contract selector wait and kill refuse before operating", async (t) => {
  const rawA = fixtureRepository(t);
  const rawB = fixtureRepository(t);
  for (const repository of [rawA, rawB]) {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  const worldA = await World.at(rawA.path);
  const worldB = await World.at(rawB.path);
  const born = await answered(worldA, "worker", "deadbeef");
  const owner = contractId("kei/foreign");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(worldB),
        akuId: born.id,
        contractId: owner,
      })
    ).kind,
    "dispatched",
  );
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

test("plural wait preserves a missing direct AkuId error", async (t) => {
  const root = fixtureRoot(t, "keiyaku-plural-direct-missing-");
  const missing = akuId({ archetype: "worker", suffix: "00000001" });
  const readable = await answered(root, "worker", "00000002");
  await assert.rejects(
    Keiyaku.wait({ path: root, akuma: [missing, readable.id], completion: "all", timeoutMs: 0 }),
    (error: unknown) => error instanceof AkumaNotBornError && error.id === missing,
  );
});

test("one-member Contract selector retains a corrupt Heart diagnostic", async (t) => {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const unreadable = corruptHeart(world, "deadbeef");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(world),
        akuId: unreadable,
        contractId: contractId("kei/review"),
      })
    ).kind,
    "dispatched",
  );
  const repo = await Repo.at({ path: world });
  assert.deepEqual((await addressAkumaSet({ path: world, akuma: ["kei/review"], repo })).ids, [unreadable]);
  const corruptDiagnostic = (error: unknown) =>
    error instanceof Error && /schema version|SQLITE|database|file is not a database/iu.test(error.message);
  await assert.rejects(Keiyaku.wait({ path: world, akuma: [unreadable], timeoutMs: 0 }), corruptDiagnostic);
  await assert.rejects(Keiyaku.wait({ path: world, akuma: ["kei/review"], repo, timeoutMs: 0 }), corruptDiagnostic);
});

test("plural wait returns no observations when every status is unreadable", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-unreadable-");
  const earlier = corruptHeart(root, "00000001");
  const later = corruptHeart(root, "00000002");
  for (const completion of ["all", "any"] as const) {
    assert.deepEqual(
      await Keiyaku.wait({
        path: root,
        akuma: [earlier, later],
        completion,
        timeoutMs: 0,
      }),
      {
        completion,
        observations: [],
        unobserved: [
          { id: earlier, diagnostic: "file is not a database" },
          { id: later, diagnostic: "file is not a database" },
        ],
      },
    );
  }
});

test("fleet status projects Dispatch association without changing Akuma core", async (t) => {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const source = await answered(repository.path, "worker", "deadbeef");
  const owner = contractId("kei/provider-core");
  assert.equal(
    (await publishDispatch({ repository: await repositoryAt(repository.path), akuId: source.id, contractId: owner }))
      .kind,
    "dispatched",
  );

  const world = await World.at(repository.path);
  const plain = await Keiyaku.status({ path: world, akuma: source.id });
  assert.equal("contractId" in plain, false);
  assert.equal(plain.status.id, source.id);
  const projected = await Keiyaku.status({
    path: world,
    akuma: source.id,
    repo: await Repo.at({ path: repository.path }),
  });
  assert.deepEqual(projected.contract, { kind: "associated", contractId: owner });
  assert.equal(projected.status.id, source.id);
  const waited = await Keiyaku.wait({
    path: world,
    akuma: [source.id],
    repo: await Repo.at({ path: repository.path }),
    timeoutMs: 0,
  });
  assert.deepEqual(waited.observations[0]!.contract, { kind: "associated", contractId: owner });
});

test("multi-member wait and kill project every member from one Task board snapshot", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-created-set-");
  const worker = await answered(root, "worker", "00000001");
  const reviewer = await answered(root, "reviewer", "00000002");
  const world = await World.at(root);
  writeCreatorTask(
    world,
    creatorTask({
      id: "task/from-worker",
      title: "From worker",
      createdBy: worker.id,
      priority: 1,
    }),
  );
  writeCreatorTask(
    world,
    creatorTask({
      id: "task/from-reviewer",
      title: "From reviewer",
      createdBy: reviewer.id,
      priority: 0,
      state: "drop",
    }),
  );
  const expected = projectTaskBoardObservation((await readBoard(world)).board);
  const waited = await Keiyaku.wait({
    path: root,
    akuma: [worker.id, reviewer.id],
    completion: "all",
    timeoutMs: 0,
  });
  assert.deepEqual(
    waited.observations.map((observation) => observation.status.id),
    [reviewer.id, worker.id],
  );
  assert.deepEqual(
    waited.observations.map((observation) => observation.createdTasks),
    [
      { kind: "present", rows: expected.selectCreatedBy(reviewer.id) },
      { kind: "present", rows: expected.selectCreatedBy(worker.id) },
    ],
  );
  const killed = await Keiyaku.kill({ path: root, akuma: [worker.id, reviewer.id] });
  assert.deepEqual(
    killed.results.map((member) => member.id),
    [reviewer.id, worker.id],
  );
  assert.equal(
    killed.results.every((member) => !("observation" in member)),
    true,
  );
});

function fixtureRepository(t: TestContext) {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  return repository;
}

test("failed Task associations do not hide readable Fleet members or kill evidence", async (t) => {
  const root = fixtureRoot(t, "keiyaku-fleet-task-failure-");
  const a = await answered(root, "worker", "a0000001");
  const b = await answered(root, "worker", "a0000002");
  mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "tasks", "bad.md"), "not Task authority\n");
  const status = await Keiyaku.status({ path: root, akuma: a.id });
  assert.equal(status.status.id, a.id);
  assert.equal(status.createdTasks.kind, "failed");
  const waited = await Keiyaku.wait({ path: root, akuma: [a.id, b.id], completion: "all", timeoutMs: 0 });
  assert.deepEqual(waited.observations.map((view) => view.status.id).sort(), [a.id, b.id]);
  assert.deepEqual(
    waited.observations.map((view) => view.createdTasks),
    [status.createdTasks, status.createdTasks],
  );
  const killed = await Keiyaku.kill({ path: root, akuma: [a.id, b.id] });
  assert.deepEqual(killed.results.map((member) => member.id).sort(), [a.id, b.id]);
  assert.ok(killed.results.every((member) => member.evidence === "already-stopped" && !("observation" in member)));
});
