import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectRegion as selectRegionValue } from "../src/kanshi/select.js";
import { observeKanshi as observeComposite } from "../src/kanshi/read.js";
import {
  Debts as DebtCollection,
  World as WorldValue,
  Settings,
  nuke as nukeWorld,
  Kanshi,
} from "../src/index.js";
import {
  debtAbsentSchema,
  debtMutationResultSchema as mutationSchema,
  debtListSchema as listSchema,
  debtReadyListSchema as readySchema,
  blockedDebtListSchema as blockedSchema,
  debtDoctorReportSchema as doctorSchema,
  debtReadResultSchema as readSchema,
  debtTreeResultSchema as treeSchema,
  debtUpdateResultSchema as updateSchema,
} from "../src/debt/index.js";
import { kanshiCountsReportSchema as countsSchema } from "../src/kanshi/counts.js";
import {
  settingsSchema as settingsResultSchema,
  settingsNamespaceViewSchema as namespaceSchema,
} from "../src/settings.js";
import {
  worldResolutionSchema as resolutionSchema,
  worldLocationSchema as locationSchema,
  worldRootSchema as rootSchema,
  worldEstablishedSchema as establishedSchema,
} from "../src/world.js";
import { regionReadSchema as regionSchema } from "../src/kanshi/report.js";
import { nukeResultSchema as resetSchema } from "../src/library/nuke.js";
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
} from "../src/index.js";
import {
  kanshiReportSchema as reportSchema,
  kanshiContractReportSchema as contractReportSchema,
  kanshiResultSchema as resultSchema,
  kanshiObservationSchema as observationSchema,
} from "../src/kanshi/index.js";

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
  const emptySettings = await Settings.load({ cwd: world, home });
  assertWireRoundTrip(settingsResultSchema, emptySettings);
  assertWireRoundTrip(namespaceSchema, emptySettings.namespace("agents"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ agents: { one: { model: "x" } } }));
  const loaded = await Settings.load({ cwd: world, home });
  assertWireRoundTrip(settingsResultSchema, loaded);
  assertWireRoundTrip(namespaceSchema, loaded.namespace("agents"));
  writeFileSync(join(world, ".keiyaku", "settings.json"), "{");
  assertWireRoundTrip(namespaceSchema, (await Settings.load({ cwd: world, home })).namespace("agents"));
  assertWireRoundTrip(countsSchema, await Kanshi.of({ world: null }).counts());
  assertWireRoundTrip(countsSchema, await Kanshi.of({ world }).counts());
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
  assertWireRoundTrip(doctorSchema, await debts.doctor());
  assertWireRoundTrip(updateSchema, await debt.update({ state: "done" }));
  assertWireRoundTrip(updateSchema, await debt.update({ state: "drop" }));
  assertWireRoundTrip(updateSchema, await debts.debt({ id: second.id }).update({ state: "drop" }));
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
  const empty = await Kanshi.of({ world: null }).board();
  assertWireRoundTrip(reportSchema, empty);
  assertWireRoundTrip(observationSchema, await observeComposite({ world: null }));
  const report = await Kanshi.of({ world, repo }).board();
  assertWireRoundTrip(resultSchema, report);
  assertWireRoundTrip(reportSchema, report);
  assertWireRoundTrip(contractReportSchema, await Kanshi.of({ world, repo }).contract(bound.contractId));
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
