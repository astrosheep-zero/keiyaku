import { accepted, present } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { breakBody, HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import { Keiyaku, Repo } from "../src/index.js";
import { kanshi, selectKanshi } from "../src/kanshi/index.js";
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
