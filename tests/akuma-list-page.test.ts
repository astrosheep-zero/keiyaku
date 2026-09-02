import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Akuma } from "../src/akuma/akuma.js";
import { PAGE_POOL_SIZE } from "../src/akuma/akuma-product.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, akuId, akumaPaths, akumaRunRoot } from "../src/akuma/identity.js";
import { addressAkumaSet } from "../src/library/address.js";
import { World, type WorldRoot } from "../src/world.js";

function fixtureRoot(): WorldRoot {
  return realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-akuma-list-page-"))) as WorldRoot;
}

async function emptyHeartTemplate(root: WorldRoot) {
  const directory = join(root, ".keiyaku", "fixtures", "empty-heart");
  mkdirSync(directory, { recursive: true });
  const paths = {
    directory,
    heart: join(directory, "heart.db"),
    leash: join(directory, "leash.db"),
    log: join(directory, "stdio.log"),
    requests: join(directory, "requests"),
  };
  await initializeHeart(paths);
  return paths;
}

async function recentAkuma(root: WorldRoot, index: number) {
  const suffix = `a00000${index.toString(16).padStart(2, "0")}`;
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const leash = await HeldAkumaLeash.try(allocated.paths);
  assert.ok(leash);
  try {
    assert.equal(
      await leash.birth(allocated.paths, {
        id: allocated.id,
        archetype: "worker",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        cwd: root,
        origin: { kind: "direct" },
        allowed: ALLOWED_ACTIONS,
        createdAt: `2099-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }),
      "born",
    );
  } finally {
    leash.release();
  }
  return allocated;
}

test("recent Akuma paging prunes old custody bounds without a thousand-Heart fixture", async () => {
  const root = fixtureRoot();
  const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const template = await emptyHeartTemplate(root);
    const runRoot = akumaRunRoot(root);
    mkdirSync(runRoot, { recursive: true });
    const old = new Date("2000-01-01T00:00:00.000Z");
    const oldIds = Array.from({ length: 40 }, (_, index) => {
      const suffix = index.toString(16).padStart(8, "0");
      const paths = akumaPaths({ runRoot, archetype: "worker", suffix });
      mkdirSync(paths.directory);
      copyFileSync(template.heart, paths.heart);
      copyFileSync(template.leash, paths.leash);
      utimesSync(paths.heart, old, old);
      return akuId({ archetype: "worker", suffix });
    });
    const recent = await Promise.all(Array.from({ length: 11 }, async (_, index) => await recentAkuma(root, index)));

    const preparedDatabases = new WeakSet<object>();
    let databaseReads = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      if (!preparedDatabases.has(this)) {
        preparedDatabases.add(this);
        databaseReads += 1;
      }
      return originalPrepare.apply(this, args);
    };
    const world = Akuma.of(await World.at(root));
    const page = await world.list({ limit: 10 });
    DatabaseSync.prototype.prepare = originalPrepare;

    const recentIds = [...recent]
      .reverse()
      .map((source) => source.id);
    assert.deepEqual(
      page.rows.map((row) => row.id),
      recentIds.slice(0, 10),
    );
    assert.equal(page.hasMore, true);
    assert.ok(
      databaseReads <= PAGE_POOL_SIZE * 3,
      `expected one bounded Heart batch, opened ${databaseReads} database handles`,
    );

    const defaultPage = await world.list();
    assert.equal(defaultPage.rows.length, 50);
    assert.equal(defaultPage.hasMore, true);

    const complete = await world.listComplete();
    assert.equal("hasMore" in complete, false);
    const reference = complete.rows.map((row) => row.id);
    assert.deepEqual(reference, recentIds.concat(oldIds));

    const completeGlob = await addressAkumaSet({ path: root, akuma: ["aku/*/*"] });
    assert.deepEqual(completeGlob.ids, [...oldIds, ...recent.map((source) => source.id)].sort());
    await assert.rejects(() => world.list({ limit: 501 }), /integer from 1 to 500/u);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true });
  }
});
