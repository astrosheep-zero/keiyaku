import { accepted, present } from "./support/library-verbs.js";
import { isolateUserHome } from "./support/user-home.js";
isolateUserHome();
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  breakBody,
  beginTurn,
  endTurn,
  appendActivity,
  HeldAkumaLeash,
  initializeHeart,
} from "../src/akuma/heart/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { bornBody, bornDirectAkuma, bornLineageAkuma, allocatedHeart } from "./support/akuma-fixtures.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import {
  GIT_FORMAT_PATH,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
  repositoryAt,
} from "../src/git/repository.js";
import { executeGit, withPrivateGitIndex } from "../src/git/process.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import { KeiyakuError } from "../src/errors.js";
import { Akumas, Keis, Repo } from "../src/index.js";
import { akumaCatalogueSchema } from "../src/akuma/selection-observation.js";
import { Kanshi } from "../src/kanshi/index.js";
import { observeKanshi } from "../src/kanshi/read.js";
import { kanshiReportSchema } from "../src/kanshi/report.js";
import type { AkumaKanshiRow, ContractKanshiDetail, KanshiContractReport, KanshiReport } from "../src/kanshi/index.js";

function worldReport(report: KanshiReport | KanshiContractReport): KanshiReport {
  if (!("contracts" in report)) throw new Error("expected a World report");
  return report;
}

function contractReport(report: KanshiReport | KanshiContractReport): ContractKanshiDetail {
  if (!("kind" in report) || report.kind !== "contract") throw new Error("expected an exact Contract report");
  return report;
}
import { Debts } from "../src/debt/index.js";
import type { WorldRoot } from "../src/world.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function document(title = "Kanshi contract"): string {
  return contractMarkdown(title, {
    Context: "status",
    Objective: "render",
    Design: "project public values",
    Region: "```\nsrc/**\n```",
    Criteria: "### Visible\nThe status row is visible.\n",
  });
}

async function bornAkuma(root: string, suffix: string, createdAt = "2026-08-09T00:00:00.000Z", settle = false) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "watcher", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, {
    id: allocated.id,
    akumaName: "watcher",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    createdAt,
  });
  if (settle) {
    const body = await leash.recordBody(allocated.paths, { leashTakenAt: createdAt });
    await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: createdAt });
  }
  leash.release();
  return allocated.id;
}

test("Kanshi captures immutable coordinates without observation and reads fresh owner state", async (t) => {
  const unobserved = Kanshi.of({ world: "/missing-kanshi-world" as WorldRoot, repo: null });
  assert.ok(Object.isFrozen(unobserved));
  for (const input of [null, [], { world: " " }, { repo: {} }, { extra: true }])
    assert.throws(
      () => Kanshi.of(input as never),
      (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
    );

  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const scope: { world: WorldRoot | null; repo: Repo | null } = { world, repo };
  const view = Kanshi.of(scope);
  scope.world = null;
  scope.repo = null;
  assert.equal((await view.counts()).contracts, 0);
  assert.deepEqual(await view.region(), { kind: "present" });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), gates: [] }));
  const id = present(await bound.kei.state()).id;
  const debts = Debts.of(world);
  accepted(await debts.add({ title: "Fresh debt" }));
  const board = await view.board();
  assert.ok(!("kind" in board.contracts) && !("kind" in board.debts));
  assert.deepEqual(board.contracts.rows?.map(row => row.id), [id]);
  assert.equal(board.debts.rows?.length, 1);
  assert.equal((await view.counts()).contracts, 1);
  assert.equal((await view.contract(id)).kind, "contract");
  await assert.rejects(
    view.board({ akumaLimit: 0 }),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
});

function fixtureRepository(t: TestContext) {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  return repository;
}

async function replacePrivateState(
  repository: ReturnType<typeof makeGitRepository>,
  replacements: ReadonlyMap<string, string>,
) {
  const git = await repositoryAt(repository.path);
  const snapshot = await withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, (observation) => observation.snapshot),
  );
  // Corruption fixtures deliberately replace whole authority subtrees. Native Git
  // constructs those invalid trees without weakening production leaf-write guards.
  const tree = await withPrivateGitIndex(async (environment) => {
    const config = ["-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "-c", "index.sparse=false"];
    await executeGit(git, [...config, "read-tree", snapshot.tree ?? "--empty"], undefined, environment);
    for (const [path, bytes] of replacements) {
      const descendants = await executeGit(git, [...config, "ls-files", "-z", "--", `:(literal)${path}`], undefined, environment);
      await executeGit(git, [...config, "update-index", "--force-remove", "-z", "--stdin"], descendants, environment);
      const oid = await writeBlob(git, bytes);
      await executeGit(git, [...config, "update-index", "-z", "--index-info"], `100644 ${oid}\t${path}\0`, environment);
    }
    return (await executeGit(git, [...config, "write-tree"], undefined, environment)).toString("ascii").trim();
  });
  const commit = await writeStateCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (
      await updateRefsAtomically(git, [
        { ref: "refs/heads/keiyaku-state", newOid: commit, expectedOid: snapshot.commit },
      ])
    ).kind,
    "published",
  );
}

async function populatedWorld(t: TestContext) {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const debts = Debts.of(await World.at(repository.path));
  const added = await debts.add({ title: "Render status", priority: 0 });
  assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      debt: added.id,
      terms: document(),
      target: "main",
    }),
  );
  const contract = present(await bound.kei.state());
  const renamed = await debts.debt({ id: added.id }).update({ title: "Investigate status rendering" });
  assert.equal(renamed.kind, "accepted");
  const akumaId = await bornAkuma(repository.path, "a0000001");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akumaId: akumaId,
        contractId: contract.id,
      })
    ).kind,
    "dispatched",
  );
  await moveAlias({ world: repository.path as WorldRoot, alias: "@watch" as AkumaAlias, akumaId: akumaId });
  return { repository, contract, keiyaku: bound.kei, debtId: added.id, akumaId };
}

test("World selects active Akumas before bounding and exposes native work under its Contract", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const held = accepted(await Debts.of(world).add({ title: "Dispatch holder" }));
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), gates: [], debt: held.id }));
  await bornLineageAkuma({ root: world, akumaName: "watcher", draw: "cafe0010", createdAt: "2026-10-31T00:00:00.000Z" });
  const workers: Awaited<ReturnType<typeof bornBody>>[] = [];
  try {
    for (const [suffix, command] of [["cafe0011", "npm test"], ["cafe0012", "square perceive"]] as const) {
      const born = await bornBody(world, suffix, "2026-10-30T00:00:00.000Z");
      workers.push(born);
      const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: "2026-10-30T00:00:01.000Z" });
      await appendActivity(born.allocated.paths, {
        turnSequence: turn.sequence, at: "2026-10-30T00:00:02.000Z",
        event: { type: "tool", phase: "started", id: command, name: "bash", call: { kind: "run", command } },
      });
    }
    const child = workers[0]!.allocated.id;
    const missingContract = contractId("kei/not-observed");
    assert.equal((await publishDispatch({ repository: await repositoryAt(world), akumaId: child, contractId: bound.contractId })).kind, "dispatched");
    assert.equal((await publishDispatch({ repository: await repositoryAt(world), akumaId: workers[1]!.allocated.id, contractId: missingContract })).kind, "dispatched");
    const view = Kanshi.of({ world, repo });
    const limited = await view.board({ akumaLimit: 1 });
    assert.ok(!("kind" in limited.akumas));
    assert.deepEqual(limited.akumas.rows?.map(row => row.id), [child]);
    assert.equal(limited.akumas.more, true);
    const report = await view.board();
    assert.ok(!("kind" in report.akumas));
    assert.deepEqual(report.akumas.rows?.map(row => row.id), workers.map(worker => worker.allocated.id));
    for (const [index, command] of ["npm test", "square perceive"].entries()) {
      const row: AkumaKanshiRow | undefined = report.akumas.rows?.find(row => row.id === workers[index]!.allocated.id);
      assert.ok(row?.work && row.work.kind !== "unavailable");
      assert.equal(row.work.summary?.text, `run $ ${command}`);
      const exact = await Akumas.of(world).status({ akuma: row.id });
      const { outcome, ...sharedWork } = exact.work;
      assert.deepEqual(sharedWork, row.work);
      assert.deepEqual(outcome, { state: "running", turn: `turn/${row.work.turn!.sequence}` });
      const retained = await Akumas.of(world).history({ akuma: row.id, id: String(row.work.summary!.id) });
      assert.ok(retained.kind === "akuma-activity" && retained.row.kind === "tool");
      assert.equal(retained.row.toolId, command);
    }
    assert.deepEqual(
      report.akumas.rows?.find(row => row.id === workers[1]!.allocated.id)?.contract,
      { kind: "associated", contractId: missingContract },
      "a Dispatch to an unobserved Contract keeps its observed association",
    );
    await moveAlias({ world: repository.path as WorldRoot, alias: "@watch" as AkumaAlias, akumaId: child });
    assertWireRoundTrip(akumaCatalogueSchema, await Akumas.of(world).list());

    await replacePrivateState(repository, new Map([["dispatch", "not a Dispatch tree\n"]]));
    const failed = worldReport(await view.board());
    assert.ok(!("kind" in failed.contracts) && !("kind" in failed.akumas) && !("kind" in failed.debts));
    const boardLinks = failed.contracts.rows?.find(row => row.id === bound.contractId)?.associations;
    assert.deepEqual(boardLinks?.[0], { kind: "debt", debtId: held.id });
    const roster = boardLinks?.find(link => "kind" in link && link.kind === "unavailable" && link.source === "roster");
    assert.ok(roster && "diagnostic" in roster && roster.diagnostic.length > 0);
    const heldRow = "kind" in failed.debts ? undefined : failed.debts.rows?.find(row => row.id === held.id);
    assert.deepEqual(heldRow?.contract, {
      kind: "associated",
      contractId: bound.contractId,
    });
    assert.deepEqual(contractReport(await view.contract(bound.contractId)).associations, boardLinks);
    const failedChild = failed.akumas.rows?.find(row => row.id === child);
    assert.deepEqual(failedChild?.contract, { kind: "unavailable" });
    assert.deepEqual(failedChild?.aliases, ["@watch"]);
    const failedText = renderKanshiText(failed, { columns: 100, color: false });
    assert.match(failedText, /roster association unavailable/u);
    assert.match(failedText, /contract association unavailable/u);
  } finally { for (const worker of workers) worker.holder.release(); }
});

test("Kanshi keeps independent sections and associations across Debt and Git format failures", async (t) => {
  const { repository, contract, debtId, akumaId } = await populatedWorld(t);
  const view = Kanshi.of({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }) });
  const selected = contractReport(await view.contract(contract.id));
  const { contracts } = await view.board();
  assert.ok(!("kind" in contracts));
  assert.equal(selected.id, contract.id);
  assert.deepEqual(selected.associations, [{ kind: "debt", debtId }, { akumaId, aliases: ["@watch"] }]);
  assert.deepEqual(contracts.rows?.find((row) => row.id === contract.id)?.associations, selected.associations);
  assert.match(renderKanshiText(selected, { columns: 100, color: false }), new RegExp(`holder  ${debtId}`, "u"));
  assert.match(renderKanshiText(selected, { columns: 60, color: false }), new RegExp(debtId, "u"));

  writeFileSync(join(repository.path, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  const debtFailed = worldReport(await view.board());
  const debtSelected = contractReport(await view.contract(contract.id));
  assert.ok(!("kind" in debtFailed.contracts) && !("kind" in debtFailed.akumas));
  assert.ok("kind" in debtFailed.debts && debtFailed.debts.kind === "failed");
  assert.deepEqual(debtSelected.associations?.[0], { kind: "debt", debtId }, "the holder remains independent of Debt board failure");
  assert.equal("issue" in debtSelected, false);
  assert.equal(debtFailed.akumas.rows?.some((row) => row.id === akumaId), true);
  const debtText = renderKanshiText(debtFailed, { columns: 80, color: false });
  assert.equal(
    (debtText.match(/debt\/bad · failed debt document must begin with YAML front matter/gu) ?? []).length,
    1,
  );
  rmSync(join(repository.path, ".keiyaku", "debts", "bad.md"));

  const changedAkuma = await bornAkuma(repository.path, "a0000002");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akumaId: changedAkuma,
        contractId: contract.id,
      })
    ).kind,
    "dispatched",
  );
  await replacePrivateState(repository, new Map([[GIT_FORMAT_PATH, "not the current format\n"]]));

  const observation = await observeKanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });
  const report = worldReport(observation.report);
  assert.ok("kind" in report.contracts && report.contracts.kind === "failed");
  assert.match(report.contracts.diagnostic, /Git format is not current: meta\/format\.json/u);
  assert.equal(observation.aliases.kind, "present");
  assert.ok(!("kind" in report.debts) && !("kind" in report.akumas));

  assert.equal(
    report.debts.rows?.some((row) => row.id === debtId),
    true,
  );
  const ordinary = report.akumas.rows?.find((row) => row.id === akumaId);
  assert.deepEqual(ordinary?.aliases, ["@watch"]);
  const changed = report.akumas.rows?.find((row) => row.id === changedAkuma);
  assert.deepEqual(changed?.contract, { kind: "unavailable" });
  const exact = await Kanshi.of({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }) }).contract(contract.id);
  assert.equal(exact.kind, "contract-failed", "the Contract's own decode failure stays on its exact report");
  if (exact.kind === "contract-failed") assert.match(exact.diagnostic, /Git format is not current/u);
  const text = renderKanshiText(report, { columns: 100, color: false });
  assert.match(text, /contract association unavailable/u);
  assert.match(text, /@watch/u);
});

test("exact target movement names only the owner-witnessed predecessor", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const bound = accepted(
    await Keis.of(repo).bind({
      terms: document("Target movement"),
      target: "main",
      gates: ["reviewed"],
    }),
  );
  const id = present(await bound.kei.state()).id;
  const worktree = bound.worktreePath!;
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const placed = accepted(await bound.kei.deliver());
  assert.equal(
    placed.placement?.kind,
    "gates-unsatisfied",
    "the delivery is admitted and placed, but the missing reviewed gate blocks completion",
  );
  const integration = present(await bound.kei.state()).currentIntegration;
  assert.ok(integration !== null, "the blocked delivery retains its admitted integration");
  const unchanged = repository.run(["rev-parse", "refs/heads/main"]).trim();
  assert.equal(integration.predecessor, unchanged, "the admitted candidate integrated against the main head");

  const still = contractReport(await Kanshi.of({ world, repo }).contract(id));
  assert.equal(
    still.targetObservation,
    undefined,
    "an unchanged target is not drift merely because a candidate integrated against it",
  );
  assert.doesNotMatch(renderKanshiText(still, { columns: 100, color: false }), /target moved/u);

  writeFileSync(join(repository.path, "advance.txt"), "advance\n");
  repository.run(["add", "advance.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance main"]);
  const movedHead = repository.run(["rev-parse", "refs/heads/main"]).trim();

  const moved = contractReport(await Kanshi.of({ world, repo }).contract(id));
  assert.deepEqual(moved.targetObservation, {
    kind: "moved",
    before: integration.predecessor,
    after: movedHead,
  });
  assert.equal(moved.workspace.kind, "present");
  assert.equal(moved.targetLag, 1);
  assert.equal(moved.targetLagUnavailable, undefined);
  const movement = new RegExp(`^  target moved  ${integration.predecessor.slice(0, 7)} -> ${movedHead.slice(0, 7)}$`, "mu");
  assert.match(renderKanshiText(moved), movement);
});

test("thin catalogue reads no current frontiers while World keeps its original aperture", async (t) => {
  const repository = fixtureRepository(t);
  const world = await World.at(repository.path);
  const status = t.mock.method(AkumaOwner.prototype, "status", async () => assert.fail("full status read"));
  for (let index = 0; index < 11; index += 1) {
    const at = `2026-08-09T00:00:${String(index).padStart(2, "0")}.000Z`;
    const born = await bornDirectAkuma({ root: world, akumaName: "worker", draw: index.toString(16).padStart(8, "0"), createdAt: at });
    try {
      const body = await born.leash.recordBody(born.paths, { leashTakenAt: at });
      const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: at });
      await endTurn(born.paths, { turnSequence: turn.sequence, completedAt: at, outcome: { kind: "answered", session: { sessionId: `session-${index}` }, answer: `answer ${index}` } });
    } finally { born.leash.release(); }
  }
  const catalogue = await Akumas.of(world).list({ limit: 10 });
  assertWireRoundTrip(akumaCatalogueSchema, catalogue);
  assert.equal(catalogue.more, true);
  assert.ok(catalogue.rows!.every(row => !("work" in row)));
  const view = Kanshi.of({ world });
  const report = await view.board();
  assert.ok(!("kind" in report.akumas), JSON.stringify(report));
  const rows = report.akumas.rows!;
  assert.deepEqual(rows.map(row => row.id), catalogue.rows!.map(row => row.id));
  assert.deepEqual(rows.flatMap(row => row.work === undefined ? [] : [row.id]), rows.slice(0, 3).map(row => row.id));
  assert.ok(rows.slice(0, 3).every(row => row.work?.kind === "idle" && row.work.outcome?.verdict === "answered"));
  const bounded = await view.board({ akumaLimit: 2 });
  assert.ok(!("kind" in bounded.akumas));
  assert.deepEqual(bounded.akumas.rows, rows.slice(0, 2));
  assert.equal(bounded.akumas.more, true);
  assert.equal(report.akumas.more, true);
  assert.equal(status.mock.callCount(), 0);
});

test("birthless members retain associations without timelines and born snapshot failure preserves peers", async (t) => {
  const repository = fixtureRepository(t);
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const unborn = await allocatedHeart(world, "worker", "a0000000");
  const stillborn = await allocatedHeart(world, "worker", "a0000002");
  const born = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "a0000001", createdAt: "2026-08-09T00:00:00.000Z" });
  const at = born.soul.createdAt;
  const body = await born.leash.recordBody(born.paths, { leashTakenAt: at });
  const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: at });
  await appendActivity(born.paths, { turnSequence: turn.sequence, at, event: { type: "assistant", text: "work" } });
  born.leash.release();
  using heart = new DatabaseSync(born.paths.heart);
  heart.exec("UPDATE activity SET event_json = '{}'");
  const peer = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "a0000003", createdAt: "2026-08-09T00:00:01.000Z" });
  peer.leash.release();
  // A failed birth seal is native allocation evidence, not a failed status snapshot.
  const claim = (await HeldAkumaLeash.try(stillborn.paths))!;
  await claim.sealIfUnborn(stillborn.paths, { evidence: "birth failed", at: "2026-08-09T00:00:00.000Z" });
  claim.release();
  for (const id of [unborn.id, stillborn.id]) assert.equal((await publishDispatch({ repository: await repositoryAt(repository.path), akumaId: id, contractId: contractId("kei/catalogue") })).kind, "dispatched");
  const catalogue = await Akumas.of(world).list({ repo });
  assertWireRoundTrip(akumaCatalogueSchema, catalogue);
  assert.deepEqual(catalogue.rows!.map(row => row.id), [born.id, unborn.id, peer.id]);
  const all = await Akumas.of(world).list({ repo, selection: "all" });
  assert.deepEqual(all.rows!.map(row => row.id), [born.id, unborn.id, stillborn.id, peer.id]);
  for (const row of all.rows!.filter(row => row.life === "unborn" || row.life === "stillborn"))
    assert.deepEqual(row.contract, { kind: "associated", contractId: "kei/catalogue" });
  const report = await Kanshi.of({ world, repo }).board();
  assert.ok(!("kind" in report.akumas));
  const rows = report.akumas.rows!;
  assert.deepEqual(rows.map(row => row.id), catalogue.rows!.map(row => row.id));
  assert.deepEqual(rows.map(row => row.work?.kind), ["unavailable", undefined, "idle"]);
  const work = rows[0]!.work;
  assert.match(work?.kind === "unavailable" ? work.diagnostic : "", /invalid_union/u);
});

test("catalogue Alias failures survive empty and readable membership; source failures stay hard", async (t) => {
  const repository = fixtureRepository(t);
  const world = await World.at(repository.path);
  const directory = join(world, ".keiyaku", "akuma");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "alias.json"), "invalid Alias\n");
  const empty = await Akumas.of(world).list();
  assert.equal(empty.rows, undefined);
  assert.ok(empty.aliasesError);
  const emptyReport = worldReport(await Kanshi.of({ world }).board());
  assert.ok(!("kind" in emptyReport.akumas) && emptyReport.akumas.aliasesError);
  assert.equal(emptyReport.akumas.rows, undefined, "an empty roster omits rows");
  const emptyText = renderKanshiText(emptyReport, { columns: 100, color: false });
  assert.match(emptyText, /^AKUMA$/mu);
  assert.match(emptyText, /aliases unavailable/u);
  assert.doesNotMatch(emptyText, /AKUMA \/\/ unavailable|world empty/u);
  const born = await bornAkuma(world, "a0000001");
  const nonempty = await Akumas.of(world).list();
  assert.equal(nonempty.rows![0]!.id, born);
  assert.ok(nonempty.aliasesError);
  assert.equal(nonempty.rows![0]!.aliases, undefined);
  const readableReport = worldReport(await Kanshi.of({ world }).board());
  assert.ok(!("kind" in readableReport.akumas) && readableReport.akumas.aliasesError);
  assert.equal(readableReport.akumas.rows?.find(row => row.id === born)?.aliases, undefined);
  // The actual roster root is replaced with a file, making enumeration fail.
  const { akumaRunRoot } = await import("../src/akuma/identity.js");
  const root = akumaRunRoot(world);
  renameSync(root, `${root}-saved`);
  writeFileSync(root, "not a roster directory\n");
  await assert.rejects(Akumas.of(world).list(), /ENOTDIR/u);
  const report = await Kanshi.of({ world }).board();
  assert.ok("kind" in report.akumas && report.akumas.kind === "failed");
  assert.match(report.akumas.diagnostic, /ENOTDIR/u);
  assert.equal(report.akumas.aliasesError, nonempty.aliasesError);
  assert.deepEqual(report.contracts, { kind: "absent" });
  assert.deepEqual(report.debts, {});
  assertWireRoundTrip(kanshiReportSchema, report);
  const text = renderKanshiText(report);
  assert.ok(text.includes(report.akumas.diagnostic));
  assert.ok(text.includes(nonempty.aliasesError));
  assert.equal(text.match(/aliases unavailable/gu)?.length, 1);
});
