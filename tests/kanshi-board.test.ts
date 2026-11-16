import assert from "node:assert/strict";
import test from "node:test";
import { Kanshi, Keis, Repo, World } from "../src/index.js";
import { Debts } from "../src/debt/index.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { beginTurn, appendActivity, finishBodyIfIdle } from "../src/akuma/heart/index.js";
import { renderKanshiText } from "../src/cli/render/kanshi.js";
import { kanshiReportSchema } from "../src/kanshi/report.js";
import { allocatedHeart, bornBody } from "./support/akuma-fixtures.js";
import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { makeGitRepository } from "./support/git.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

function document(title: string): string {
  return contractMarkdown(title, {
    Context: "Observe independent active owners",
    Objective: "Render board",
    Design: "Compose catalogue facts",
    Region: "src/kanshi/**",
    Criteria: "### Visible\nSelected members stay visible.\n",
  });
}

test("active World board filters before bounding, nests native work, and retains terminal and missing associations", async (t) => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const contracts = Keis.of(repo);
  const bound = accepted(await contracts.bind({ markdown: document("Active board"), gates: [] }));
  const id = present(await bound.kei.state()).id;
  const terminal = accepted(await contracts.bind({ markdown: document("Terminal board"), gates: [] }));
  const terminalId = present(await terminal.kei.state()).id;
  accepted(await terminal.kei.abandon());
  const debts = Debts.of(world);
  const openDebt = accepted(await debts.add({ title: "Active debt" }));
  const doneDebt = accepted(await debts.add({ title: "Settled debt" }));
  accepted(await debts.debt({ id: doneDebt.id }).update({ state: "done" }));

  const at = "2026-01-01T00:00:00.000Z";
  const settled = await bornBody(world, "00000000", at);
  try {
    assert.equal(
      (await finishBodyIfIdle(settled.allocated.paths, { sequence: settled.body.sequence, at })).kind,
      "finished",
    );
  } finally {
    settled.holder.release();
  }
  const running = await bornBody(world, "00000001", at);
  t.after(() => running.holder.release());
  const turn = await beginTurn(running.allocated.paths, { bodySequence: running.body.sequence, startedAt: at });
  await appendActivity(running.allocated.paths, {
    turnSequence: turn.sequence,
    at,
    event: { type: "tool", phase: "started", id: "tool-1", name: "bash", call: { kind: "run", command: "npm test" } },
  });
  const outside = await allocatedHeart(world, "claude", "00000002");
  const missing = await allocatedHeart(world, "claude", "00000003");
  const free = await allocatedHeart(world, "claude", "00000004");
  for (const [akumaId, contract] of [
    [running.allocated.id, id],
    [outside.id, terminalId],
    [missing.id, contractId("kei/missing")],
  ] as const) {
    assert.equal(
      (await publishDispatch({ repository: await repositoryAt(repository.path), akumaId, contractId: contract })).kind,
      "dispatched",
    );
  }
  await moveAlias({ world, alias: parseAkumaAlias("@working"), akumaId: running.allocated.id });
  const view = Kanshi.of({ world, repo });
  const limited = await view.board({ akumaLimit: 2 });
  assert.ok(limited.akumas.kind === "present");
  assert.deepEqual(
    limited.akumas.rows?.map((row) => row.id),
    [running.allocated.id, outside.id],
  );
  assert.equal(limited.akumas.more, true, "more describes the filtered active roster");

  const report = await view.board();
  assert.deepEqual(kanshiReportSchema.parse(report), report);
  assert.ok(report.contracts.kind === "present" && report.debts.kind === "present" && report.akumas.kind === "present");
  assert.deepEqual(
    report.contracts.rows?.map((row) => row.id),
    [id],
  );
  assert.deepEqual(
    report.debts.rows?.map((row) => row.id),
    [openDebt.id],
  );
  assert.deepEqual(
    report.akumas.rows?.map((row) => row.id),
    [running.allocated.id, outside.id, missing.id, free.id],
  );
  const text = renderKanshiText(report, { columns: 120, color: false });
  for (const worker of [running.allocated, outside, missing, free])
    assert.equal(text.split(worker.id).length - 1, 1, "every selected Akuma renders exactly once");
  assert.ok(text.indexOf(id) < text.indexOf(running.allocated.id));
  assert.ok(text.indexOf(running.allocated.id) < text.indexOf("AKUMA //"));
  assert.ok(text.indexOf("AKUMA //") < text.indexOf(outside.id));
  assert.ok(text.includes(terminalId));
  assert.ok(text.includes("kei/missing"));
  assert.ok(text.includes("@working"));
  assert.ok(text.includes("npm test"));
});
