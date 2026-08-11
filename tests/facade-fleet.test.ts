import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveAlias } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { appendActivity, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { Keiyaku, Repo } from "../src/index.js";
import { settings } from "../src/settings.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";
import { matchesAkumaGlob, parseAkumaGlob } from "../src/identity/selector.js";
import { addressAkumaSet } from "../src/library/address.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { akuId } from "../src/akuma/identity.js";
import { contractId } from "../src/core/facts/types.js";
import { selectCatalog, type Catalog } from "../src/library/catalog.js";

const provider: ProviderAdapter = {
  confinement: () => ({ kind: "unconfined" }),
  admitOptions(options) { return { kind: "admitted", options }; },
  async start() {
    return {
      events: { async *[Symbol.asyncIterator]() { yield { type: "session" as const, coordinate: { sessionId: "fixture" } }; } },
      completion: Promise.resolve({ kind: "answered", answer: "done", historyId: "history" }),
      async abort() {},
    };
  },
};

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

    assert.equal(Keiyaku.status({ path: root, akuma: "@review" }).id, reviewer.id);
    const waited = await Keiyaku.wait({
      path: root,
      akuma: ["aku/*/*", "@review", worker.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.deepEqual(waited.statuses.map((status) => status.id), [reviewer.id, worker.id]);

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

test("facade ls is a shallow failure-isolated four-product catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-home-"));
  try {
    const source = await answered(root, "worker", "00000001");
    await moveAlias({ world: root, alias: "@worker", akuId: source.id });
    const task = await Tasks.of(World.at(root)).add({ title: "Catalog task" });
    assert.equal(task.kind, "accepted");
    const configuration = settings({ root, home });
    const catalog = await Keiyaku.ls({ path: root, settings: configuration });
    assert.equal(catalog.contracts.kind, "absent");
    assert.equal(catalog.tasks.kind, "present");
    assert.equal(catalog.archetypes.kind, "present");
    assert.equal(catalog.akuma.kind, "present");
    const selected = await Keiyaku.ls({ path: root, settings: configuration, selector: "@worker" });
    assert.deepEqual(selected.akuma.kind === "present" ? selected.akuma.value.rows.map((row) => row.id) : [], [source.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("facade ls refuses an @name shared by a Contract short-id and Alias", async () => {
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
  await assert.rejects(
    Keiyaku.ls({ path: World.at(repository.path), repo, settings: settings({ root: repository.path }), selector: "@review" }),
    /ambiguous selector matches Contract and Akuma/u,
  );
});

test("history last bypasses activity and glob grammar follows normalized archetypes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-facade-last-"));
  try {
    const source = await answered(root, "worker", "00000001");
    appendActivity(source.paths, {
      bodySequence: 1,
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

test("Contract selector preserves Dispatch membership skipped by compact fleet", () => {
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
  assert.deepEqual(addressAkumaSet({
    path: repository.path,
    akuma: ["kei/review"],
    repo: Repo.at({ path: repository.path }),
  }).ids, [missing]);
});

test("exact AkuId catalog selection survives an unrelated Contract failure", () => {
  const id = akuId({ archetype: "worker", suffix: "deadbeef" });
  const catalog: Catalog = {
    root: "/world",
    contracts: { kind: "failed", failure: { message: "broken journal" } },
    tasks: { kind: "absent" },
    archetypes: { kind: "present", value: { rows: [] } },
    akuma: { kind: "present", value: { rows: [{ id, life: "unborn" }], searched: [] } },
  };
  const selected = selectCatalog(catalog, id);
  assert.deepEqual(selected.contracts, catalog.contracts);
  assert.deepEqual(selected.akuma.kind === "present" ? selected.akuma.value.rows.map((row) => row.id) : [], [id]);
});

test("exact set selection does not read unrelated Alias authority", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-exact-address-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
    writeFileSync(join(root, ".keiyaku", "akuma", "alias.json"), "broken\n");
    const id = akuId({ archetype: "worker", suffix: "deadbeef" });
    assert.deepEqual(addressAkumaSet({ path: root, akuma: [id] }).ids, [id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
