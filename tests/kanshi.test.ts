import { accepted, present } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { bornBody, bornDirectAkuma, allocatedHeart } from "./support/akuma-fixtures.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { renderAkuma } from "../src/cli/render/kanshi-akuma.js";
import { contractId, type ContractId } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import {
  GIT_FORMAT_PATH,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
  repositoryAt,
} from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import { KeiyakuError } from "../src/errors.js";
import { Akumas, Keis, Repo } from "../src/index.js";
import { contractSummarySchema } from "../src/protocol/read/status.js";
import { akumaCatalogueSchema } from "../src/akuma/selection-observation.js";
import { Kanshi } from "../src/kanshi/index.js";
import { observeKanshi } from "../src/kanshi/read.js";
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
import { makeGitRepository, withGitShim } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import {
  activityAkumaRow,
  akumaWorldReport,
  openAkumaSnapshot,
  snapshotRow,
  AKUMA_ACTIVITY_AT,
} from "./support/kanshi-activity.js";

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
  assert.deepEqual((await view.counts()).contracts, { kind: "present", value: 0 });
  assert.deepEqual(await view.region(), { kind: "present" });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), gates: [] }));
  const id = present(await bound.kei.state()).id;
  accepted(await Debts.of(world).add({ title: "Fresh debt" }));
  const board = await view.board();
  if (board.contracts.kind !== "present") assert.fail("captured Repo unavailable");
  if (board.debts.kind !== "present") assert.fail("captured World unavailable");
  assert.deepEqual(board.contracts.rows?.map(row => row.id), [id]);
  assert.equal(board.debts.rows?.length, 1);
  assert.deepEqual((await view.counts()).contracts, { kind: "present", value: 1 });
  assert.equal((await view.contract(id)).kind, "contract");
  assert.deepEqual(await view.region({}), { kind: "present", declarations: [{ id, patterns: ["src/**"] }] });
  await bound.kei.abandon();
  assert.deepEqual((await view.counts()).contracts, { kind: "present", value: 0 });
  assert.deepEqual(await view.region(), { kind: "present" });
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
  const changes = new Map(
    await Promise.all(
      [...replacements].map(async ([path, bytes]) => [path, { oid: await writeBlob(git, bytes) }] as const),
    ),
  );
  const tree = await updateGitTree(git, snapshot.tree, changes);
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
      markdown: document(),
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

test("World exposes native current work for running peers while catalogues stay thin", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
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
    const report = await Kanshi.of({ world, repo: await Repo.at({ path: repository.path }) }).board();
    assert.equal(report.akumas.kind, "present");
    assert.ok(report.akumas.kind === "present");
    for (const [index, command] of ["npm test", "square perceive"].entries()) {
      const row: AkumaKanshiRow | undefined = report.akumas.rows?.find(row => row.id === workers[index]!.allocated.id);
      assert.ok(row?.work && row.work.kind !== "unavailable");
      assert.equal(row.work.summary?.text, `run $ ${command}`);
      const exact = await Akumas.of(world).status({ akuma: row.id });
      assert.deepEqual(exact.work, row.work);
      const retained = await Akumas.of(world).history({ akuma: row.id, id: String(row.work.summary!.id) });
      assert.ok(retained.kind === "akuma" && retained.events[0]?.kind === "tool");
      assert.equal(retained.events[0].toolId, command);
    }
    assertWireRoundTrip(akumaCatalogueSchema, await Akumas.of(world).list());
  } finally { for (const worker of workers) worker.holder.release(); }
});

test("Contract Git format failure preserves independently readable Debt, Akuma, and Alias observations", async (t) => {
  const { repository, contract, debtId, akumaId } = await populatedWorld(t);
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
  assert.equal(report.contracts.kind, "failed");
  if (report.contracts.kind === "failed") {
    assert.match(report.contracts.diagnostic, /Git format is not current: meta\/format\.json/u);
  }
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akumas.kind, "present");
  assert.equal(observation.aliases.kind, "present");
  if (report.debts.kind !== "present" || report.akumas.kind !== "present") return;

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

test("unattempted associations without a Repo are not marked unavailable", async (t) => {
  const { repository, contract, debtId, akumaId } = await populatedWorld(t);
  const report = worldReport(await Kanshi.of({ world: await World.at(repository.path) }).board());
  assert.equal(report.contracts.kind, "absent");
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akumas.kind, "present");
  if (report.debts.kind !== "present" || report.akumas.kind !== "present") return;
  assert.equal(report.debts.rows?.find((row) => row.id === debtId)?.contract, undefined);
  const akuma = report.akumas.rows?.find((row) => row.id === akumaId);
  assert.equal(akuma?.contract, undefined);
  assert.equal(report.akumas.aliasesError, undefined);

  const contractOnly = worldReport(
    await Kanshi.of({ world: null, repo: await Repo.at({ path: repository.path }) }).board(),
  );
  assert.equal(contractOnly.contracts.kind, "present");
  if (contractOnly.contracts.kind === "present") {
    const row = contractOnly.contracts.rows?.find((candidate) => candidate.id === contract.id);
    assert.deepEqual(row?.associations, [{ kind: "debt", debtId }, { kind: "akuma", akumaId }]);
  }
});

test("selected Contract shows associated Akuma identity, alias, and life", async (t) => {
  const { repository, contract, akumaId, debtId } = await populatedWorld(t);
  const selected = contractReport(
    await Kanshi.of({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }) }).contract(contract.id),
  );
  assert.equal(selected.id, contract.id);
  assert.deepEqual(selected.roster, [{ id: akumaId, aliases: ["@watch"] }]);
  assert.equal(selected.holder, debtId);
  assert.match(renderKanshiText(selected, { columns: 100, color: false }), new RegExp(`debt  ${debtId}`, "u"));
  assert.match(renderKanshiText(selected, { columns: 60, color: false }), new RegExp(debtId, "u"));
});

test("exact target movement names only the owner-witnessed predecessor", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const bound = accepted(
    await Keis.of(repo).bind({
      markdown: document("Target movement"),
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
  assert.match(
    renderKanshiText(moved, { columns: 100, color: false }),
    new RegExp(`^  target moved  ${integration.predecessor.slice(0, 7)} -> ${movedHead.slice(0, 7)}$`, "mu"),
  );
});

test("selected Contract failure names its identity and bounded cause without a replayable partial value", async (t) => {
  const { repository, contract } = await populatedWorld(t);
  const shim = [
    'if [ "$1 $2" = "cat-file --batch" ]; then',
    '  "$KEIYAKU_REAL_GIT" "$@"',
    "  exit 73",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  await withGitShim(shim, {}, async (gitPath) => {
    const world = await World.at(repository.path);
    const repo = await Repo.at({ path: repository.path, gitPath });
    const report = await Kanshi.of({ world, repo }).contract(contract.id);
    assert.equal(report.kind, "contract-failed");
    if (report.kind !== "contract-failed") return;
    assert.equal(report.id, contract.id);
    assert.match(report.diagnostic, /git cat-file --batch: git cat-file --batch did not close cleanly/u);
    assert.equal("workspace" in report, false, "a failed exact read carries no replayable partial detail");
  });
});

test("DebtHolder failure preserves Debt rows and marks Contract links unavailable", async (t) => {
  const { repository, contract, debtId } = await populatedWorld(t);
  await replacePrivateState(repository, new Map([["settlement/task-holders", "not a DebtHolder tree\n"]]));

  const report = worldReport(
    await Kanshi.of({
      world: await World.at(repository.path),
      repo: await Repo.at({ path: repository.path }),
    }).board(),
  );
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akumas.kind, "present");
  if (report.contracts.kind !== "present" || report.debts.kind !== "present") return;
  assert.equal(
    report.contracts.rows
      ?.find((row) => row.id === contract.id)
      ?.associations?.find((association) => association.kind === "unavailable")?.kind,
    "unavailable",
  );
  const debt = report.debts.rows?.find((row) => row.id === debtId);
  assert.deepEqual(debt?.contract, { kind: "unavailable" });
  assert.match(renderKanshiText(report, { columns: 100, color: false }), /contract association unavailable/u);
  const selected = contractReport(await Kanshi.of({ world: await World.at(repository.path), repo: await Repo.at({ path: repository.path }) }).contract(contract.id));
  assert.deepEqual(selected.holder, { kind: "unavailable" });
  assert.match(renderKanshiText(selected, { columns: 100, color: false }), /debt association unavailable/u);
});

test("Dispatch failure preserves Akuma rows and explicitly marks both association views unavailable", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  await replacePrivateState(repository, new Map([["dispatch", "not a Dispatch tree\n"]]));

  const report = worldReport(
    await Kanshi.of({
      world: await World.at(repository.path),
      repo: await Repo.at({ path: repository.path }),
    }).board(),
  );
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akumas.kind, "present");
  if (report.contracts.kind !== "present" || report.akumas.kind !== "present") return;
  const contractRow = report.contracts.rows?.find((row) => row.id === contract.id);
  assert.ok(
    contractRow?.associations?.some(
      (association) => association.kind === "unavailable" && association.source === "roster",
    ),
    "a failed Dispatch read is explicit roster unavailability",
  );
  const akuma = report.akumas.rows?.find((row) => row.id === akumaId);
  assert.deepEqual(akuma?.contract, { kind: "unavailable" });
  assert.deepEqual(akuma?.aliases, ["@watch"]);
  const text = renderKanshiText(report, { columns: 100, color: false });
  assert.match(text, /roster association unavailable/u);
  assert.match(text, /contract association unavailable/u);
});

test("a Dispatch to an unobserved Contract keeps its observed association", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const akumaId = await bornAkuma(repository.path, "a0000003");
  const missingContract = contractId("kei/not-observed");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akumaId: akumaId,
        contractId: missingContract,
      })
    ).kind,
    "dispatched",
  );
  const report = worldReport(
    await Kanshi.of({
      world: await World.at(repository.path),
      repo: await Repo.at({ path: repository.path }),
    }).board(),
  );
  assert.equal(report.akumas.kind, "present");
  if (report.akumas.kind !== "present") return;
  const row = report.akumas.rows?.find((candidate) => candidate.id === akumaId);
  assert.deepEqual(row?.contract, {
    kind: "associated",
    contractId: missingContract,
  });
});

test("Alias failure leaves Akuma rows readable and marks the section's aliases unavailable", async (t) => {
  const repository = fixtureRepository(t);
  const akumaId = await bornAkuma(repository.path, "a0000004");
  await moveAlias({ world: repository.path as WorldRoot, alias: "@watch" as AkumaAlias, akumaId: akumaId });
  writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "not Alias authority\n");

  const observation = await observeKanshi({ world: await World.at(repository.path) });
  assert.equal(observation.aliases.kind, "failed");
  const report = worldReport(observation.report);
  assert.equal(report.akumas.kind, "present");
  if (report.akumas.kind !== "present") return;
  assert.equal(report.akumas.aliasesError === undefined, false);
  const row = report.akumas.rows?.find((candidate) => candidate.id === akumaId);
  assert.ok(row !== undefined);
  assert.equal("aliasesUnavailable" in row, false);
  assert.equal("aliases" in row, false, "no readable alias binding is invented");
  assert.match(renderKanshiText(report, { columns: 100, color: false }), /aliases unavailable/u);
});

test("an empty Akuma roster retains a failed Alias observation as section evidence", async (t) => {
  const repository = fixtureRepository(t);
  mkdirSync(join(repository.path, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "not Alias authority\n");

  const report = worldReport(await Kanshi.of({ world: await World.at(repository.path) }).board());
  assert.equal(report.akumas.kind, "present");
  if (report.akumas.kind !== "present") return;
  assert.equal(report.akumas.aliasesError === undefined, false);
  assert.equal(report.akumas.rows, undefined, "an empty roster omits rows");
  const text = renderKanshiText(report, { columns: 100, color: false });
  assert.match(text, /akuma  none/u);
  assert.match(text, /aliases unavailable/u);
  assert.doesNotMatch(text, /AKUMA \/\/ unavailable|world empty/u);
});

test("an attached Contract roster derives Alias availability from the Akuma section", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "not Alias authority\n");

  const report = worldReport(
    await Kanshi.of({
      world: await World.at(repository.path),
      repo: await Repo.at({ path: repository.path }),
    }).board(),
  );
  assert.equal(report.akumas.kind, "present");
  assert.equal(report.contracts.kind, "present");
  if (report.akumas.kind !== "present" || report.contracts.kind !== "present") return;
  assert.equal(report.akumas.aliasesError === undefined, false);
  const akuma = report.akumas.rows?.find((candidate) => candidate.id === akumaId);
  assert.ok(akuma !== undefined);
  assert.equal("aliasesUnavailable" in akuma, false);
  const contractRow = report.contracts.rows?.find((candidate) => candidate.id === contract.id);
  const attachment = contractRow?.associations?.find((association) => association.kind === "akuma");
  assert.equal(attachment?.kind === "akuma" && attachment.aliasesUnavailable, true);
  assert.equal(attachment?.kind === "akuma" && attachment.aliases, undefined);
});

test("Debt board failure names the malformed document once without suppressing Contract or Akuma", async (t) => {
  const { repository, contract, akumaId, debtId } = await populatedWorld(t);
  writeFileSync(join(repository.path, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const report = worldReport(await Kanshi.of({ world, repo }).board());
  const selected = contractReport(await Kanshi.of({ world, repo }).contract(contract.id));
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.akumas.kind, "present");
  assert.equal(report.debts.kind, "failed");
  if (report.contracts.kind !== "present" || report.akumas.kind !== "present") return;
  assert.equal(selected.holder, debtId, "the explicit holder remains independent of Debt board failure");
  assert.equal("issue" in selected, false);
  assert.equal(
    report.akumas.rows?.some((candidate) => candidate.id === akumaId),
    true,
  );
  const worldText = renderKanshiText(report, { columns: 80, color: false });
  assert.equal(
    (worldText.match(/debt\/bad · failed debt document must begin with YAML front matter/gu) ?? []).length,
    1,
  );
});

async function traceGit<T>(path: string, action: () => Promise<T>) {
  writeFileSync(path, "");
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = path;
  const start = performance.now();
  try {
    const value = await action();
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const commands: string[][] = events.filter((event) => event.event === "start").map((event) => event.argv.slice(1));
    return { value, commands, wallMs: Math.round(performance.now() - start) };
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
}

test("World status bounds worktree detail before observation and shares repeated target reads", async (t) => {
  const raw = fixtureRepository(t);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: raw.path });
  const world = await World.at(raw.path);
  const contracts = Keis.of(repo);
  const rows: { id: ContractId; path: string }[] = [];
  for (let index = 0; index < 20; index += 1) {
    const bound = accepted(await contracts.bind({
      markdown: document(`Status ${index}`),
      target: index < 16 ? "main" : rows[0]!.id,
      gates: ["reviewed"],
    }));
    rows.push({ id: present(await bound.kei.state()).id, path: bound.worktreePath! });
  }
  const tracePath = join(raw.path, ".git", "status-trace.jsonl");
  const expected = (await contracts.list({ limit: 20 })).rows;
  assert.ok(expected !== undefined);
  const observed = await traceGit(tracePath, () => Kanshi.of({ world, repo }).board());
  const report = worldReport(observed.value);
  if (report.contracts.kind !== "present") assert.fail(JSON.stringify(report.contracts));
  const board = report.contracts;
  assert.equal(board.more, true);
  assert.deepEqual(board.rows, expected.slice(0, 10), "world rows are the same owner summaries");
  const status = observed.commands.filter((args) => args.includes("--porcelain=v2"));
  const lag = observed.commands.filter((args) => args.includes("rev-list"));
  assert.equal(status.length, 10, "only the ten selected catalogue workspaces are observed");
  assert.equal(lag.length, 10, "target lag is observed only for selected rows");
  const selectedPaths = new Set(board.rows!.map(row => rows.find(candidate => candidate.id === row.id)!.path));
  assert.ok(status.every(args => selectedPaths.has(args[args.indexOf("-C") + 1]!)));
  t.diagnostic(JSON.stringify({
    stage: "bare", worktrees: rows.length, processes: observed.commands.length,
    status: status.length, lag: lag.length, wallMs: observed.wallMs,
  }));

  const selected = rows.at(-1)!;
  const exact = await traceGit(tracePath, () => Kanshi.of({ world, repo }).contract(selected.id));
  const selectedReport = contractReport(exact.value);
  assert.equal(selectedReport.id, selected.id);
  assert.equal(selectedReport.workspace.kind, "present");
  assert.equal(selectedReport.workspace.kind === "present" && selectedReport.workspace.counts, undefined);
  assert.equal(exact.commands.filter((args) => args.includes("--porcelain=v2")).length, 1);
  assert.ok(
    exact.commands.filter((args) => args[0] === "-C").every((args) => args[1] === selected.path || args[1] === rows[0]!.path),
  );
  t.diagnostic(JSON.stringify({
    stage: "selected", processes: exact.commands.length,
    status: exact.commands.filter((args) => args.includes("--porcelain=v2")).length, wallMs: exact.wallMs,
  }));

  renameSync(selected.path, `${selected.path}-missing`);
  const unavailable = contractReport(await Kanshi.of({ world, repo }).contract(selected.id));
  assert.equal(unavailable.workspace.kind, "unavailable");
  assert.equal(unavailable.workspace.kind === "unavailable" && unavailable.workspace.path, selected.path);
  assert.equal(unavailable.targetLag?.kind, "unknown");
  const missingRow = (await contracts.list({ limit: 10 })).rows!.find(row => row.id === selected.id)!;
  assert.deepEqual(contractSummarySchema.parse(JSON.parse(JSON.stringify(missingRow))), missingRow);
  assert.deepEqual(missingRow.attention, [
    { kind: "workspace-unavailable", path: selected.path },
    { kind: "target-unknown", subject: selected.path },
  ]);
  const missingWorld = worldReport(await Kanshi.of({ world, repo }).board());
  assert.equal(missingWorld.contracts.kind, "present");
  if (missingWorld.contracts.kind === "present")
    assert.deepEqual(missingWorld.contracts.rows!.find(row => row.id === selected.id)?.attention, missingRow.attention);
  assert.ok(renderKanshiText(missingWorld, { columns: 120, color: false }).includes("workspace unavailable"));
  renameSync(`${selected.path}-missing`, selected.path);

  const indexPath = raw.run(["-C", selected.path, "rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const indexBytes = readFileSync(indexPath);
  try {
    writeFileSync(indexPath, "unreadable index");
    assert.ok((await contracts.list({ limit: 10 })).rows!.find(row => row.id === selected.id)?.attention?.some(issue => issue.kind === "workspace-unavailable"));
  } finally { writeFileSync(indexPath, indexBytes); }

  const parent = rows[0]!;
  renameSync(parent.path, `${parent.path}-missing`);
  for (const dependent of rows.slice(16)) {
    const missingTarget = contractReport(await Kanshi.of({ world, repo }).contract(dependent.id));
    assert.deepEqual(missingTarget.targetObservation, { kind: "unknown" });
    assert.equal(missingTarget.targetLag?.kind, "unknown");
  }
  const unknownTargets = (await contracts.list({})).rows!;
  for (const dependent of rows.slice(16))
    assert.ok(unknownTargets.find(row => row.id === dependent.id)?.attention?.some(issue => issue.kind === "target-unknown"));
  renameSync(`${parent.path}-missing`, parent.path);
  const recovered = worldReport(await Kanshi.of({ world, repo }).board());
  if (recovered.contracts.kind !== "present") assert.fail(JSON.stringify(recovered.contracts));
  assert.deepEqual(recovered.contracts.rows, board.rows);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "advance target"]);
  const lagged = (await contracts.list({})).rows!.find(row => row.id === rows[1]!.id)!;
  assert.deepEqual(lagged.attention, [{ kind: "target-behind", behind: 1, subject: rows[1]!.path }]);
});

test("World running rows keep only one bounded latest activity line through the shared renderer", () => {
  const row = activityAkumaRow("aku/worker/1234abcd", "running", openAkumaSnapshot([
    snapshotRow({ kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "first paragraph\nsecond paragraph".repeat(30) }),
  ]));
  for (const columns of [48, 100]) {
    const board = renderAkuma(akumaWorldReport([row]), { columns, color: false });
    assert.ok(board.some((line) => line.includes(row.id)), "the board keeps the complete identity");
    assert.ok(board.some(line => line.includes("2 first paragraph")));
  }
});

test("thin catalogue reads no current frontiers while World keeps its original aperture", async (t) => {
  const repository = fixtureRepository(t);
  const world = await World.at(repository.path);
  const reads: string[] = [];
  const original = AkumaOwner.prototype.status;
  t.mock.method(AkumaOwner.prototype, "status", async function(this: AkumaOwner) {
    reads.push(this.id);
    return original.call(this);
  });
  for (let index = 0; index < 11; index += 1) {
    const at = `2026-08-09T00:00:${String(index).padStart(2, "0")}.000Z`;
    const born = await bornDirectAkuma({ root: world, akumaName: "worker", draw: index.toString(16).padStart(8, "0"), createdAt: at });
    try {
      const body = await born.leash.recordBody(born.paths, { leashTakenAt: at });
      const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: at });
      await endTurn(born.paths, { turnSequence: turn.sequence, completedAt: at, outcome: { kind: "answered", session: { sessionId: `session-${index}` }, answer: `answer ${index}` } });
      await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at });
    } finally { born.leash.release(); }
  }
  const catalogue = await Akumas.of(world).list({ limit: 10 });
  assertWireRoundTrip(akumaCatalogueSchema, catalogue);
  assert.equal(catalogue.more, true);
  assert.deepEqual(reads, []);
  assert.equal(catalogue.rows![3]!.id, "aku/worker/00000007");
  reads.length = 0;
  const view = Kanshi.of({ world });
  const report = await view.board();
  assert.equal(report.akumas.kind, "present");
  if (report.akumas.kind !== "present") assert.fail(JSON.stringify(report));
  assert.deepEqual(report.akumas.rows!.map(row => row.id), catalogue.rows!.map(row => row.id));
  assert.deepEqual(reads, catalogue.rows!.slice(0, 3).map(row => row.id));
  const bounded = await view.board({ akumaLimit: 2 });
  if (bounded.akumas.kind !== "present") assert.fail("bounded Akuma observation failed");
  assert.deepEqual(bounded.akumas.rows!.map(row => row.id), catalogue.rows!.slice(0, 2).map(row => row.id));
  assert.equal(bounded.akumas.more, true);
  assert.equal(report.akumas.more, true);
  assert.ok(report.akumas.rows!.slice(0, 3).every(row => row.work !== undefined && row.work.kind !== "unavailable" && row.work.outcome?.verdict === "answered"));
});

test("birthless members retain associations without timelines and born snapshot failure preserves peers", async (t) => {
  const repository = fixtureRepository(t);
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const unborn = await allocatedHeart(world, "worker", "a0000000");
  const stillborn = await allocatedHeart(world, "worker", "a0000002");
  const born = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "a0000001", createdAt: "2026-08-09T00:00:00.000Z" });
  born.leash.release();
  const peer = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "a0000003", createdAt: "2026-08-09T00:00:01.000Z" });
  peer.leash.release();
  // A failed birth seal is native allocation evidence, not a failed status snapshot.
  const claim = (await HeldAkumaLeash.try(stillborn.paths))!;
  await claim.sealIfUnborn(stillborn.paths, { evidence: "birth failed", at: "2026-08-09T00:00:00.000Z" });
  claim.release();
  for (const id of [unborn.id, stillborn.id]) assert.equal((await publishDispatch({ repository: await repositoryAt(repository.path), akumaId: id, contractId: contractId("kei/catalogue") })).kind, "dispatched");
  const reads: string[] = [];
  const original = AkumaOwner.prototype.status;
  t.mock.method(AkumaOwner.prototype, "status", async function(this: AkumaOwner) {
    reads.push(this.id);
    if (this.id === born.id) throw new Error("selected Heart became unreadable");
    return original.call(this);
  });
  const catalogue = await Akumas.of(world).list({ repo });
  assertWireRoundTrip(akumaCatalogueSchema, catalogue);
  assert.deepEqual(reads, []);
  assert.deepEqual(catalogue.rows!.map(row => row.id), [unborn.id, born.id, stillborn.id, peer.id]);
  for (const row of catalogue.rows!.filter(row => row.life === "unborn" || row.life === "stillborn"))
    assert.deepEqual(row.contract, { kind: "associated", contractId: "kei/catalogue" });
  reads.length = 0;
  const report = await Kanshi.of({ world, repo }).board();
  assert.equal(report.akumas.kind, "present");
  if (report.akumas.kind !== "present") assert.fail("missing Akumas");
  assert.deepEqual(report.akumas.rows!.find(row => row.id === born.id)?.work, { kind: "unavailable", diagnostic: "selected Heart became unreadable" });
  assert.deepEqual(reads, [born.id], "birthless leading positions never backfill from the fourth row");
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
  const born = await bornAkuma(world, "a0000001");
  const nonempty = await Akumas.of(world).list();
  assert.equal(nonempty.rows![0]!.id, born);
  assert.ok(nonempty.aliasesError);
  assert.equal(nonempty.rows![0]!.aliases, undefined);
  // The actual roster root is replaced with a file, making enumeration fail.
  const { akumaRunRoot } = await import("../src/akuma/identity.js");
  const root = akumaRunRoot(world);
  renameSync(root, `${root}-saved`);
  writeFileSync(root, "not a roster directory\n");
  await assert.rejects(Akumas.of(world).list(), /ENOTDIR/u);
  const report = await Kanshi.of({ world }).board();
  assert.equal(report.akumas.kind, "failed");
  assert.equal(report.debts.kind, "present");
});

test("catalogue Dispatch failure degrades links while whole Git failure remains exceptional", async (t) => {
  const { repository, akumaId } = await populatedWorld(t);
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  await replacePrivateState(repository, new Map([["dispatch", "invalid Dispatch root\n"]]));
  const catalogue = await Akumas.of(world).list({ repo });
  assert.equal(catalogue.rows![0]!.id, akumaId);
  assert.deepEqual(catalogue.rows![0]!.aliases, ["@watch"]);
  assert.deepEqual(catalogue.rows![0]!.contract, { kind: "unavailable" });
  await replacePrivateState(repository, new Map([[GIT_FORMAT_PATH, "invalid format\n"]]));
  await assert.rejects(Akumas.of(world).list({ repo }), /Git format is not current/u);
});
