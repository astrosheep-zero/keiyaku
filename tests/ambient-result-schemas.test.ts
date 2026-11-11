import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Debts as DebtCollection,
  debtAbsentSchema,
  World as WorldValue,
  settings as loadSettings,
  selectRegion as selectRegionValue,
  nuke as nukeWorld,
  kanshiCounts as countsWorld,
  kanshiCountsReportSchema as countsSchema,
  debtMutationResultSchema as mutationSchema,
  debtLifecycleResultSchema as lifecycleSchema,
  debtListSchema as listSchema,
  debtReadyListSchema as readySchema,
  blockedDebtListSchema as blockedSchema,
  debtQueryResultSchema as querySchema,
  debtDoctorReportSchema as doctorSchema,
  debtBatchResultSchema as batchSchema,
  debtReadResultSchema as readSchema,
  debtTreeResultSchema as treeSchema,
  debtUpdateResultSchema as updateSchema,
  settingsSchema as settingsResultSchema,
  settingsNamespaceViewSchema as namespaceSchema,
  worldResolutionSchema as resolutionSchema,
  worldLocationSchema as locationSchema,
  worldRootSchema as rootSchema,
  worldEstablishedSchema as establishedSchema,
  regionReadSchema as regionSchema,
  nukeResultSchema as resetSchema,
} from "../src/index.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { breakBody } from "../src/akuma/heart/index.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import {
  Keis,
  Repo,
  kanshi as observeWorld,
  observeKanshi as observeComposite,
  kanshiReportSchema as reportSchema,
  kanshiContractReportSchema as contractReportSchema,
  kanshiResultSchema as resultSchema,
  kanshiObservationSchema as observationSchema,
} from "../src/index.js";

test("Debt missing-world value has one strict owner schema", () => {
  assertWireRoundTrip(debtAbsentSchema, { kind: "absent" });
  assert.equal(debtAbsentSchema.safeParse({ kind: "absent", extra: true }).success, false);
});

test("Debt, Settings, World, region and reset schemas describe real wire results", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ambient-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project"),
    home = join(dir, "home");
  mkdirSync(project);
  mkdirSync(home);
  const resolution = await WorldValue.resolve(project);
  assertWireRoundTrip(resolutionSchema, resolution);
  assertWireRoundTrip(locationSchema, await WorldValue.locate(project));
  const world = await resolution.establish();
  assertWireRoundTrip(rootSchema, world);
  assertWireRoundTrip(rootSchema, await WorldValue.prove(world));
  assertWireRoundTrip(establishedSchema, await WorldValue.established(world));
  assertWireRoundTrip(resolutionSchema, await WorldValue.resolve(project));
  const emptySettings = await loadSettings({ root: world, home });
  assertWireRoundTrip(settingsResultSchema, emptySettings);
  assertWireRoundTrip(namespaceSchema, emptySettings.namespace("agents"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ agents: { one: { model: "x" } } }));
  const loaded = await loadSettings({ root: world, home });
  assertWireRoundTrip(settingsResultSchema, loaded);
  assertWireRoundTrip(namespaceSchema, loaded.namespace("agents"));
  writeFileSync(join(world, ".keiyaku", "settings.json"), "{");
  assertWireRoundTrip(namespaceSchema, (await loadSettings({ root: world, home })).namespace("agents"));
  assertWireRoundTrip(countsSchema, await countsWorld({ world: null }));
  assertWireRoundTrip(countsSchema, await countsWorld({ world }));
  const debts = DebtCollection.of(world);
  const first = await debts.add({ title: "First" });
  assert.equal(first.kind, "accepted");
  assertWireRoundTrip(mutationSchema, first);
  if (first.kind !== "accepted") throw new Error("creation failed");
  const second = await debts.addDocument({ markdown: "---\ntitle: Second\n---\n" });
  assertWireRoundTrip(mutationSchema, second);
  assert.equal(second.kind, "accepted");
  if (second.kind !== "accepted") throw new Error("document creation failed");
  const refused = await debts.add({ title: "Blocked by absent debt", needs: ["debt/missing"] });
  assert.equal(refused.kind, "refused");
  assertWireRoundTrip(mutationSchema, refused);
  const dependent = await debts.add({ title: "Dependent", needs: [first.id] });
  assert.equal(dependent.kind, "accepted");
  assertWireRoundTrip(mutationSchema, dependent);
  const debt = debts.debt({ id: first.id });
  const missing = debts.debt({ id: "debt/missing" });
  assertWireRoundTrip(readSchema, await debt.read());
  assertWireRoundTrip(readSchema, await missing.read());
  assertWireRoundTrip(treeSchema, await debt.tree());
  assertWireRoundTrip(treeSchema, await missing.tree());
  assertWireRoundTrip(updateSchema, await debt.update({ note: "updated" }));
  assertWireRoundTrip(updateSchema, await missing.update({ note: "missing" }));
  assertWireRoundTrip(listSchema, await debts.list());
  assertWireRoundTrip(readySchema, await debts.ready());
  assertWireRoundTrip(blockedSchema, await debts.blocked());
  assertWireRoundTrip(querySchema, await debts.query());
  assertWireRoundTrip(doctorSchema, await debts.doctor());
  assertWireRoundTrip(lifecycleSchema, await debt.done());
  assertWireRoundTrip(lifecycleSchema, await debt.drop());
  assertWireRoundTrip(lifecycleSchema, await debts.debt({ id: second.id }).drop());
  assertWireRoundTrip(batchSchema, await debts.batch({ verb: "done", ids: ["debt/missing"] }));
  assertWireRoundTrip(regionSchema, selectRegionValue({ declarations: [], selection: { kind: "declarations" } }));
  assertWireRoundTrip(
    regionSchema,
    selectRegionValue({ declarations: [], selection: { kind: "path", patterns: ["src/**"] } }),
  );
  assertWireRoundTrip(resetSchema, await nukeWorld({ world }));
  assertWireRoundTrip(resetSchema, await nukeWorld({ world, confirm: world }));
});

test("Kanshi schemas cover live Contract, Debt, Akuma, Alias, region and absent sections", async (t) => {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await WorldValue.at(repository.path);
  const bound = await Keis.of(repo).bind({
    target: "main",
    gates: [],
    markdown: contractMarkdown("Wire contract", {
      Context: "context",
      Objective: "observe",
      Design: "wire",
      Region: "src/**",
      Criteria: "### Visible\nVisible.",
    }),
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind failed");
  const added = await DebtCollection.of(world).add({ title: "Wire debt" });
  assert.equal(added.kind, "accepted");
  const born = await bornDirectAkuma({
    root: world,
    akumaName: "worker",
    draw: "a0000001",
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  const body = await born.leash.recordBody(born.paths, { leashTakenAt: born.soul.createdAt });
  await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at: born.soul.createdAt });
  born.leash.release();
  await moveAlias({ world, alias: parseAkumaAlias("@wire"), akumaId: born.id });
  const empty = await observeWorld({ world: null });
  assertWireRoundTrip(reportSchema, empty);
  assertWireRoundTrip(observationSchema, await observeComposite({ world: null }));
  const report = await observeWorld({ world, repo });
  assertWireRoundTrip(resultSchema, report);
  assertWireRoundTrip(reportSchema, report);
  assertWireRoundTrip(contractReportSchema, await observeWorld({ world, repo, contract: bound.contractId }));
  assertWireRoundTrip(observationSchema, await observeComposite({ world, repo }));
  const declarations = [{ id: bound.contractId, patterns: ["src/**"] }];
  assertWireRoundTrip(
    regionSchema,
    selectRegionValue({ declarations, selection: { kind: "contract", contract: bound.contractId } }),
  );
  assertWireRoundTrip(
    regionSchema,
    selectRegionValue({ declarations, selection: { kind: "path", patterns: ["src/file.ts"] } }),
  );
});
