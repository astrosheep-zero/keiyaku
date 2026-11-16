import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Akumas, Keis, Keiyaku, Repo, World } from "../src/index.js";
import { akumaLifecycle } from "../src/akuma/heart/facts.js";
import { HeldAkumaLeash } from "../src/akuma/heart/index.js";
import { allocatedHeart, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { withGitShim } from "./support/git.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("Contract catalogues select terminal journals under one order without retired-workspace reads", async (t) => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const claimed = accepted(await contracts.bind({ markdown: document(), target: null, gates: [] }));
  accepted(await claimed.kei.deliver({}));
  assert.equal(present(await claimed.kei.state()).terminal?.kind, "claimed");
  const abandoned = accepted(await contracts.bind({ markdown: document(), target: null, gates: [] }));
  accepted(await abandoned.kei.abandon({}));
  const active = accepted(await contracts.bind({ markdown: document(), target: null, gates: [] }));
  assert.deepEqual((await contracts.list()).rows?.map(row => row.id), [active.contractId]);

  const trace = join(repository.path, ".git", "catalogue-selection-trace");
  await withGitShim(
    'printf "%s\\n" "$*" >> "$KEIYAKU_SELECTION_TRACE"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_SELECTION_TRACE: trace },
    async (gitPath) => {
      const traced = Keis.of(await Repo.at({ path: repository.path, gitPath }));
      writeFileSync(trace, "");
      const settled = await traced.list({ selection: "settled" });
      assert.deepEqual(new Map(settled.rows?.map(row => [row.id, row.phase])), new Map([
        [claimed.contractId, "claimed"], [abandoned.contractId, "abandoned"],
      ]));
      assert.ok(settled.rows?.every(row => row.attention === undefined));
      assert.doesNotMatch(readFileSync(trace, "utf8"), /status --porcelain|rev-list|worktree list/u);
      const all = await traced.list({ selection: "all" });
      assert.equal(all.rows?.length, 3);
      for (const selection of ["active", "settled", "all"] as const) {
        const complete = await traced.list({ selection });
        const bounded = await traced.list({ selection, limit: 1 });
        assert.deepEqual(bounded.rows, complete.rows?.slice(0, 1));
        assert.equal(bounded.more, selection === "active" ? undefined : true);
        const facet = await Keiyaku.for({ cwd: repository.path, environment: {}, home: temporaryDirectory(t, "selection-home-") })
          .ls({ selector: "kei/", selection, limit: 1 });
        assert.ok(facet.kind === "contract-catalogue");
        assert.deepEqual(facet.rows, bounded.rows);
      }
      const settledIds = new Set(settled.rows?.map(row => row.id));
      assert.deepEqual(all.rows?.filter(row => settledIds.has(row.id)), settled.rows);
    },
  );
  const json = await cliJson<{ rows: { id: string; phase: string }[] }>(["-C", repository.path, "ls", "kei/", "--settled"], { environment: {} });
  assert.equal(json.exit, 0, json.stderr);
  assert.deepEqual(new Set(json.value.rows.map(row => row.phase)), new Set(["claimed", "abandoned"]));
  const text = await runCli(["-C", repository.path, "ls", "kei/", "--settled"], { environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /accepted/u);
  assert.match(text.stdout, /abandoned/u);
  await assert.rejects(contracts.list({ selection: "closed" } as never), /selection must be active, settled, or all/u);
});

test("Akuma lifecycle selection filters before the bound and intersects caller descendants", async (t) => {
  const root = await World.at(temporaryDirectory(t, "akuma-lifecycle-selection-"));
  const world = Akumas.of(root);
  const caller = { kind: "external", integration: "selection-test", id: "root" } as const;
  const asleep = await bornLineageAkuma({ root, akumaName: "worker", draw: "00000001", createdAt: "2026-08-10T00:00:00.000Z", caller });
  const newerAsleep = await bornLineageAkuma({ root, akumaName: "worker", draw: "00000002", createdAt: "2026-08-11T00:00:00.000Z", caller });
  const untidy = await allocatedHeart(root, "worker", "00000003");
  const leash = (await HeldAkumaLeash.try(untidy.paths))!;
  await leash.birth(untidy.paths, {
    ...asleep.soul, id: untidy.id, createdAt: "2026-08-09T00:00:00.000Z",
    caller: { kind: "akuma", world: root, akumaId: asleep.id },
  });
  await leash.recordBody(untidy.paths, { leashTakenAt: "2026-08-09T00:00:00.000Z" });
  leash.release();
  const unborn = await allocatedHeart(root, "worker", "00000004");
  const stillborn = await allocatedHeart(root, "worker", "00000005");
  const seal = (await HeldAkumaLeash.try(stillborn.paths))!;
  await seal.sealIfUnborn(stillborn.paths, { evidence: "fixture birth failed", at: "2026-08-09T00:00:00.000Z" });
  seal.release();

  const active = await world.list({ limit: 1 });
  assert.deepEqual(active.rows?.map(row => [row.id, row.life]), [[untidy.id, "untidy"]]);
  assert.equal(active.more, true, "the remaining unborn allocation is active");
  assert.deepEqual((await world.list()).rows?.map(row => row.id), [untidy.id, unborn.id]);
  const mine = await world.list({ caller, limit: 1 });
  assert.deepEqual(mine.rows?.map(row => row.id), [untidy.id], "a settled ancestor does not hide an active descendant");
  assert.equal(mine.more, undefined, "settled caller descendants do not count as more active work");
  const settled = await world.list({ selection: "settled", limit: 2 });
  assert.deepEqual(settled.rows?.map(row => row.id), [newerAsleep.id, asleep.id]);
  assert.equal(settled.more, true, "stillborn is also settled");
  const settledMine = await world.list({ caller, selection: "settled" });
  assert.deepEqual(settledMine.rows?.map(row => row.id), [newerAsleep.id, asleep.id]);
  assert.equal(settledMine.more, undefined);
  assert.equal((await world.list({ selection: "all" })).rows?.length, 5);

  const facet = Keiyaku.for({ cwd: root, environment: { KEIYAKU_EXTERNAL_CALLER: `${caller.integration}:${caller.id}` } });
  const selected = await facet.ls({ selector: "aku/*", mine: true, selection: "settled", limit: 1 });
  assert.ok(selected.kind === "akuma-catalogue");
  assert.deepEqual(selected.rows, settledMine.rows?.slice(0, 1));
  assert.equal(selected.more, true);
  const cli = await cliJson<{ rows: { id: string }[] }>(["-C", root, "ls", "aku/*", "--settled", "--limit", "2"], { environment: {} });
  assert.equal(cli.exit, 0, cli.stderr);
  assert.deepEqual(cli.value.rows.map(row => row.id), [newerAsleep.id, asleep.id]);
  await assert.rejects(world.list({ selection: "closed" } as never), /selection must be active, settled, or all/u);
  for (const life of ["running", "unborn", "stranded", "hung", "untidy"] as const) assert.equal(akumaLifecycle(life), "active");
  for (const life of ["asleep", "killed", "stillborn"] as const) assert.equal(akumaLifecycle(life), "settled");
});
