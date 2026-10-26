import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { breakBody } from "../src/akuma/heart/index.js";
import { moveAlias } from "../src/alias/index.js";
import { contractId } from "../src/core/facts/types.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { publishDispatch } from "../src/dispatch/index.js";
import {
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
  repositoryAt,
} from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { Akumas, kanshiCategory, Keiyaku, Repo, World } from "../src/index.js";
import type { KanshiCategoryInput, KanshiCategoryReport } from "../src/index.js";
import type { WorldRoot } from "../src/world.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { cliJson } from "./support/cli-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";

async function worldWithAkuma(context: TestContext, count: number): Promise<WorldRoot> {
  const world = await World.at(realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-public-category-"))));
  context.after(() => rmSync(world, { recursive: true, force: true }));
  for (let index = 0; index < count; index += 1) {
    const born = await bornDirectAkuma({
      root: world,
      archetype: "worker",
      draw: index.toString(16).padStart(8, "0"),
      createdAt: `2026-08-09T00:00:0${index}.000Z`,
    });
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: born.soul.createdAt });
    await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at: born.soul.createdAt });
    born.leash.release();
  }
  return world;
}

test("the package root exposes the bounded category observation with its crossing types", async () => {
  const input: KanshiCategoryInput = { world: null, category: "akuma" };
  const report: KanshiCategoryReport = await kanshiCategory(input);
  assert.equal(report.category, "akuma");
  if (report.category !== "akuma") return;
  assert.equal(report.akuma.kind, "absent");
  assert.equal(report.root, null);
});

test("category observation reuses owner rows and is the operation the CLI runs", async (context) => {
  const world = await worldWithAkuma(context, 3);
  const owner = await Akumas.of(world).list({ limit: 3 });
  await moveAlias({ world, alias: parseAkumaAlias("@watch"), akuId: owner.rows[0]!.id });

  const report = await kanshiCategory({ world, category: "akuma", limit: 2 });
  assert.equal(report.category, "akuma");
  if (report.category !== "akuma" || report.akuma.kind !== "present") assert.fail(JSON.stringify(report));
  assert.equal(report.akuma.value.hasMore, true);
  assert.deepEqual(
    report.akuma.value.rows.map((row) => row.id),
    owner.rows.slice(0, 2).map((row) => row.id),
  );
  assert.deepEqual(report.akuma.value.rows[0]!.aliases, ["@watch"]);
  assert.equal(report.akuma.value.rows[0]!.contractAssociationUnavailable, undefined);
  assert.equal("contracts" in report, false);
  assert.equal("debts" in report, false);

  const cli = await cliJson<KanshiCategoryReport>(["-C", world, "status", "aku", "--limit", "2"], { environment: {} });
  assert.equal(cli.exit, 0, cli.stderr);
  const withoutObservationTime = (category: KanshiCategoryReport): KanshiCategoryReport =>
    category.category === "akuma" && category.akuma.kind === "present"
      ? {
          ...category,
          observedAt: "",
          akuma: { ...category.akuma, value: { ...category.akuma.value, observedAt: "" } },
        }
      : category;
  assert.deepEqual(withoutObservationTime(cli.value), withoutObservationTime(report));

  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keiyaku.with().bind({
      repo,
      target: "main",
      markdown: contractMarkdown("Public category contract", {
        Context: "public category",
        Objective: "observe",
        Design: "one owner operation",
        Region: "src/**",
        Criteria: "### Visible\nThe owner row is visible.",
      }),
      gates: ["reviewed"],
    }),
  );
  const contract = present(await bound.value.keiyaku.state());
  const contracts = await kanshiCategory({ world, repo, category: "contract", limit: 1 });
  assert.equal(contracts.category, "contract");
  if (contracts.category !== "contract" || contracts.contracts.kind !== "present")
    assert.fail(JSON.stringify(contracts));
  assert.deepEqual(
    contracts.contracts.value.rows.map((row) => row.id),
    [contract.id],
  );
  assert.equal(contracts.contracts.value.rows[0]!.rosterUnavailable, undefined);
  assert.equal("akuma" in contracts, false);
});

test("failed Dispatch leaves the bounded Akuma category and Alias rows readable", async (context) => {
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const born = await bornDirectAkuma({
    root: world,
    archetype: "worker",
    draw: "a0000001",
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  const body = await born.leash.recordBody(born.paths, { leashTakenAt: born.soul.createdAt });
  await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at: born.soul.createdAt });
  born.leash.release();
  await moveAlias({ world, alias: parseAkumaAlias("@watch"), akuId: born.id });
  const git = await repositoryAt(repository.path);
  assert.equal(
    (
      await publishDispatch({
        repository: git,
        akuId: born.id,
        contractId: contractId("kei/category-dispatch"),
      })
    ).kind,
    "dispatched",
  );
  const snapshot = await withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, (observation) => observation.snapshot),
  );
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([["dispatch", { oid: await writeBlob(git, "not a Dispatch tree\\n") }]]),
  );
  const commit = await writeStateCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (
      await updateRefsAtomically(git, [
        { ref: "refs/heads/keiyaku-state", newOid: commit, expectedOid: snapshot.commit },
      ])
    ).kind,
    "published",
  );

  const report = await kanshiCategory({
    world,
    repo: await Repo.at({ path: repository.path }),
    category: "akuma",
    limit: 1,
  });
  assert.equal(report.category, "akuma");
  if (report.category !== "akuma" || report.akuma.kind !== "present") assert.fail(JSON.stringify(report));
  assert.deepEqual(
    report.akuma.value.rows.map((row) => row.id),
    [born.id],
  );
  assert.deepEqual(report.akuma.value.rows[0]!.aliases, ["@watch"]);
  assert.equal(report.akuma.value.rows[0]!.contractAssociationUnavailable, true);
});

test("malformed category input is refused before owner observation", async () => {
  const call = (input: unknown): Promise<KanshiCategoryReport> => kanshiCategory(input as KanshiCategoryInput);
  await assert.rejects(call(null), TypeError);
  await assert.rejects(call([]), TypeError);
  await assert.rejects(call({ world: null, category: "people" }), TypeError);
  await assert.rejects(call({ world: null, category: "akuma", extra: true }), TypeError);
  await assert.rejects(call({ world: "", category: "akuma" }), TypeError);
  await assert.rejects(call({ world: null, category: "akuma", repo: {} }), TypeError);
  await assert.rejects(call({ world: null, category: "akuma", limit: 0 }), TypeError);
  await assert.rejects(call({ world: null, category: "akuma", limit: 1.5 }), TypeError);
  await assert.rejects(call({ world: null, category: "contract" }), TypeError);
});
