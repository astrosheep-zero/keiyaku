import { accepted, present } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { appendActivity, beginTurn, breakBody, HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { contractId } from "../src/core/facts/types.js";
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
import { Keiyaku, Repo } from "../src/index.js";
import { kanshi, observeKanshi, selectKanshi } from "../src/kanshi/index.js";
import { Debts } from "../src/debt/index.js";
import { contractNamespace, debtAuthorityPath, parseDebtId } from "../src/debt/identity.js";
import type { WorldRoot } from "../src/world.js";
import { World } from "../src/world.js";
import { makeGitRepository, withGitShim } from "./support/git.js";
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
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "watcher", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, {
    id: allocated.id,
    archetype: "watcher",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    allowed: [],
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

async function akumaWithReportedChange(root: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "watcher", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const at = "2026-08-09T00:00:00.000Z";
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, {
    id: allocated.id,
    archetype: "watcher",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    allowed: [],
    cwd: root,
    origin: { kind: "direct" },
    createdAt: at,
  });
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: at });
  const turn = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: at, call: "edit files" });
  await appendActivity(allocated.paths, {
    turnSequence: turn.sequence,
    at,
    event: {
      type: "tool",
      phase: "completed",
      id: "file-change-1",
      name: "edit",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/observed.ts" }] },
      result: { status: "ok" },
    },
  });
  leash.release();
  return allocated.id;
}

async function populatedWorld(t: TestContext) {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const debts = Debts.of(await World.at(repository.path));
  const added = await debts.add({ title: "Render status", priority: 0 });
  assert.ok(added.kind === "accepted", 'expected added.kind = "accepted"');
  const bound = accepted(
    await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      debt: added.value.id,
      markdown: document(),
      workspace: "worktree",
      target: "main",
    }),
  );
  const contract = present(await bound.value.keiyaku.state());
  const renamed = await debts.debt({ id: added.value.id }).update({ title: "Investigate status rendering" });
  assert.equal(renamed.kind, "accepted");
  const akumaId = await bornAkuma(repository.path, "a0000001");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akuId: akumaId,
        contractId: contract.id,
      })
    ).kind,
    "dispatched",
  );
  await moveAlias({ world: repository.path as WorldRoot, alias: "@watch" as AkumaAlias, akuId: akumaId });
  return { repository, contract, keiyaku: bound.value.keiyaku, debtId: added.value.id, akumaId };
}

test("Contract Git format failure preserves independently readable Debt, Akuma, and Alias observations", async (t) => {
  const { repository, contract, debtId, akumaId } = await populatedWorld(t);
  const changedAkuma = await akumaWithReportedChange(repository.path, "a0000002");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akuId: changedAkuma,
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
  const { report } = observation;
  assert.equal(report.contracts.kind, "failed");
  if (report.contracts.kind === "failed") {
    assert.match(report.contracts.failure.message, /Git format is not current: meta\/format\.json/u);
  }
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  assert.equal(observation.aliases.kind, "present");
  if (report.debts.kind !== "present" || report.akuma.kind !== "present") return;

  assert.equal(
    report.debts.value.rows.some((row) => row.id === debtId),
    true,
  );
  const ordinary = report.akuma.value.rows.find((row) => row.id === akumaId);
  assert.deepEqual(ordinary?.aliases, ["@watch"]);
  const changed = report.akuma.value.rows.find((row) => row.id === changedAkuma);
  assert.equal(changed?.contractAssociationUnavailable, true);
  assert.deepEqual(
    changed?.snapshot?.reportedChanges.map((change) => change.path),
    ["src/observed.ts"],
  );
  const selected = selectKanshi({ report, contract: contract.id });
  assert.equal(selected.debts.kind, "present");
  assert.equal(selected.akuma.kind, "present");
  if (selected.debts.kind === "present" && selected.akuma.kind === "present") {
    assert.equal(
      selected.debts.value.rows.some((row) => row.id === debtId),
      false,
    );
    assert.equal(
      selected.akuma.value.rows.some((row) => row.id === changedAkuma),
      false,
    );
  }
  const text = renderKanshiText(report, { columns: 100, color: false });
  assert.match(text, /contract association unavailable/u);
  assert.match(text, /@watch/u);
});

test("unattempted associations without a Repo are not marked unavailable", async (t) => {
  const { repository, contract, debtId, akumaId } = await populatedWorld(t);
  const report = await kanshi({ world: await World.at(repository.path) });
  assert.equal(report.contracts.kind, "absent");
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.debts.kind !== "present" || report.akuma.kind !== "present") return;
  assert.equal(report.debts.value.rows.find((row) => row.id === debtId)?.contractAssociationUnavailable, undefined);
  const akuma = report.akuma.value.rows.find((row) => row.id === akumaId);
  assert.equal(akuma?.contractAssociationUnavailable, undefined);
  assert.equal(report.akuma.value.aliasesUnavailable, undefined);

  const contractOnly = await kanshi({ world: null, repo: await Repo.at({ path: repository.path }) });
  assert.equal(contractOnly.contracts.kind, "present");
  if (contractOnly.contracts.kind === "present") {
    const row = contractOnly.contracts.value.rows.find((candidate) => candidate.id === contract.id);
    assert.deepEqual(row?.roster, []);
    assert.equal(row?.rosterUnavailable, undefined);
  }
});

test("selected Contract shares one Debt observation across its bounded and owned views", async (t) => {
  const { repository, contract, debtId } = await populatedWorld(t);
  const world = await World.at(repository.path);
  const scoped = await Debts.of(world).add({
    title: "Scoped finding",
    namespace: contractNamespace(contract.id),
  });
  assert.ok(scoped.kind === "accepted");
  const repo = await Repo.at({ path: repository.path });
  const worldReport = await kanshi({ world, repo });
  const selectedReport = await kanshi({ world, repo, contract: contract.id });
  assert.equal(worldReport.debts.kind, "present");
  assert.equal(selectedReport.debts.kind, "present");
  assert.equal(selectedReport.contracts.kind, "present");
  if (
    worldReport.debts.kind !== "present" ||
    selectedReport.debts.kind !== "present" ||
    selectedReport.contracts.kind !== "present"
  )
    return;
  assert.deepEqual(
    selectedReport.debts.value.rows,
    worldReport.debts.value.rows.filter((row) => row.contract?.id === contract.id),
  );
  const row = selectedReport.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.equal(row?.namespaceDebts?.kind, "present");
  if (row?.namespaceDebts?.kind === "present")
    assert.equal(
      row.namespaceDebts.value.some((debt) => debt.id === scoped.value.id),
      true,
    );
  assert.equal(
    selectedReport.debts.value.rows.some((debt) => debt.id === debtId),
    true,
  );
});

test("selected Contract preserves its Debt board after a later Git observation failure", async (t) => {
  const { repository, contract, debtId } = await populatedWorld(t);
  const debtPath = debtAuthorityPath(join(repository.path, ".keiyaku", "debts"), parseDebtId(debtId));
  const shim = [
    'if [ "$1 $2" = "cat-file --batch" ]; then',
    '  "$KEIYAKU_REAL_GIT" "$@"',
    '  printf "not a debt document\\n" > "$KEIYAKU_DEBT_FILE"',
    "  exit 73",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  await withGitShim(shim, { KEIYAKU_DEBT_FILE: debtPath }, async (gitPath) => {
    const report = await kanshi({
      world: await World.at(repository.path),
      repo: await Repo.at({ path: repository.path, gitPath }),
      contract: contract.id,
    });
    assert.equal(report.contracts.kind, "failed");
    if (report.contracts.kind === "failed")
      assert.match(
        report.contracts.failure.message,
        /git cat-file --batch: git cat-file --batch did not close cleanly/u,
      );
    assert.equal(report.debts.kind, "present");
    if (report.debts.kind !== "present") return;
    assert.equal(
      report.debts.value.rows.some((row) => row.id === debtId),
      true,
    );
  });
});

test("DebtHolder failure preserves Debt rows and marks Contract links unavailable", async (t) => {
  const { repository, contract, debtId } = await populatedWorld(t);
  await replacePrivateState(repository, new Map([["settlement/task-holders", "not a DebtHolder tree\n"]]));

  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.contracts.kind !== "present" || report.debts.kind !== "present") return;
  assert.equal(report.contracts.value.rows.find((row) => row.id === contract.id)?.holder.kind, "unavailable");
  const debt = report.debts.value.rows.find((row) => row.id === debtId);
  assert.equal(debt?.contractAssociationUnavailable, true);
  assert.match(renderKanshiText(report, { columns: 100, color: false }), /contract association unavailable/u);
});

test("Dispatch failure preserves Akuma rows and explicitly marks both association views unavailable", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  await replacePrivateState(repository, new Map([["dispatch", "not a Dispatch tree\n"]]));

  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.debts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present") return;
  const contractRow = report.contracts.value.rows.find((row) => row.id === contract.id);
  assert.equal(contractRow?.rosterUnavailable, true);
  const akuma = report.akuma.value.rows.find((row) => row.id === akumaId);
  assert.equal(akuma?.contractAssociationUnavailable, true);
  assert.deepEqual(akuma?.aliases, ["@watch"]);
  const text = renderKanshiText(report, { columns: 100, color: false });
  assert.match(text, /akuma  unavailable/u);
  assert.match(text, /contract association unavailable/u);
});

test("missing placement proof retains the Akuma's reported changes", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const akumaId = await akumaWithReportedChange(repository.path, "a0000003");
  const missingContract = contractId("kei/not-observed");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(repository.path),
        akuId: akumaId,
        contractId: missingContract,
      })
    ).kind,
    "dispatched",
  );
  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });
  assert.equal(report.akuma.kind, "present");
  if (report.akuma.kind !== "present") return;
  const row = report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
  assert.equal(row?.contract?.id, missingContract);
  assert.equal(row?.contract?.observed, "unavailable");
  assert.deepEqual(
    row?.snapshot?.reportedChanges.map((change) => change.path),
    ["src/observed.ts"],
  );
});

test("Alias failure leaves Akuma rows readable and marks the section's aliases unavailable", async (t) => {
  const repository = fixtureRepository(t);
  const akumaId = await bornAkuma(repository.path, "a0000004");
  await moveAlias({ world: repository.path as WorldRoot, alias: "@watch" as AkumaAlias, akuId: akumaId });
  writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "not Alias authority\n");

  const observation = await observeKanshi({ world: await World.at(repository.path) });
  assert.equal(observation.aliases.kind, "failed");
  assert.equal(observation.report.akuma.kind, "present");
  if (observation.report.akuma.kind !== "present") return;
  assert.equal(observation.report.akuma.value.aliasesUnavailable, true);
  const row = observation.report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
  assert.ok(row !== undefined);
  assert.equal("aliasesUnavailable" in row, false);
  assert.deepEqual(row.aliases, []);
  assert.match(renderKanshiText(observation.report, { columns: 100, color: false }), /aliases unavailable/u);
});

test("an empty Akuma roster retains a failed Alias observation as section evidence", async (t) => {
  const repository = fixtureRepository(t);
  mkdirSync(join(repository.path, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "not Alias authority\n");

  const report = await kanshi({ world: await World.at(repository.path) });
  assert.equal(report.akuma.kind, "present");
  if (report.akuma.kind !== "present") return;
  assert.equal(report.akuma.value.aliasesUnavailable, true);
  assert.deepEqual(report.akuma.value.rows, []);
  const text = renderKanshiText(report, { columns: 100, color: false });
  assert.match(text, /akuma  none/u);
  assert.match(text, /aliases unavailable/u);
  assert.doesNotMatch(text, /AKUMA \/\/ unavailable|world empty/u);
});

test("an attached Contract roster derives Alias availability from the Akuma section", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  writeFileSync(join(repository.path, ".keiyaku", "akuma", "alias.json"), "not Alias authority\n");

  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
  });
  assert.equal(report.akuma.kind, "present");
  assert.equal(report.contracts.kind, "present");
  if (report.akuma.kind !== "present" || report.contracts.kind !== "present") return;
  assert.equal(report.akuma.value.aliasesUnavailable, true);
  const akuma = report.akuma.value.rows.find((candidate) => candidate.id === akumaId);
  assert.ok(akuma !== undefined);
  assert.equal("aliasesUnavailable" in akuma, false);
  const contractRow = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.equal(contractRow?.roster[0]?.aliasesUnavailable, true);
  assert.deepEqual(contractRow?.roster[0]?.aliases, []);
});

test("Debt board failure names the malformed document once without suppressing Contract or Akuma", async (t) => {
  const { repository, contract, akumaId } = await populatedWorld(t);
  writeFileSync(join(repository.path, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  const report = await kanshi({
    world: await World.at(repository.path),
    repo: await Repo.at({ path: repository.path }),
    contract: contract.id,
  });
  assert.equal(report.contracts.kind, "present");
  assert.equal(report.akuma.kind, "present");
  assert.equal(report.debts.kind, "failed");
  if (report.contracts.kind !== "present" || report.akuma.kind !== "present") return;
  const row = report.contracts.value.rows.find((candidate) => candidate.id === contract.id);
  assert.equal(row?.namespaceDebts, undefined);
  assert.equal(
    report.akuma.value.rows.some((candidate) => candidate.id === akumaId),
    true,
  );
  const selected = renderKanshiText(
    selectKanshi({ report, contract: contract.id }),
    { columns: 80, color: false },
    "contract",
  );
  assert.doesNotMatch(selected, /failed debt document must begin with YAML front matter/u);
  const worldText = renderKanshiText(report, { columns: 80, color: false });
  assert.equal(
    (worldText.match(/debt\/bad · failed debt document must begin with YAML front matter/gu) ?? []).length,
    1,
  );
});
