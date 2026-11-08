import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { breakBody } from "../src/akuma/heart/index.js";
import { Debts, kanshiCounts, Keiyaku, Repo, World } from "../src/index.js";
import type { KanshiCountsInput } from "../src/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";

test("exact counts observe complete independent owners and isolate corrupt Hearts", async (context) => {
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const empty = await kanshiCounts({ world, repo });
  assert.deepEqual([empty.akuma, empty.contracts, empty.debts], Array(3).fill({ kind: "present", value: 0 }));
  const debts = Debts.of(world);
  for (let i = 0; i < 12; i++) accepted(await debts.add({ title: `Open ${i}`, namespace: i % 2 ? ["nested"] : [] }));
  const done = accepted(await debts.add({ title: "Done" })).value.id;
  const drop = accepted(await debts.add({ title: "Drop" })).value.id;
  accepted(await debts.debt({ id: done }).done());
  accepted(await debts.debt({ id: drop }).drop());
  for (let i = 0; i < 12; i++) {
    accepted(await Keiyaku.with().bind({ repo, target: "main", markdown: contractMarkdown(`Count ${i}`, {
      Context: "counts", Objective: "observe", Design: "owner", Region: "src/**", Criteria: "### Count\nCorrect.",
    }), gates: [] }));
  }
  const terminal = accepted(await Keiyaku.with().bind({ repo, target: "main", markdown: contractMarkdown("Terminal", {
    Context: "counts", Objective: "observe", Design: "owner", Region: "src/**", Criteria: "### Count\nCorrect.",
  }), gates: [] }));
  await terminal.value.keiyaku.abandon();
  for (let i = 1; i <= 12; i++) {
    const running = await bornDirectAkuma({ root: world, akumaName: "worker", draw: i.toString(16).padStart(8, "0"), createdAt: "2026-08-09T00:00:00.000Z" });
    context.after(() => running.leash.release());
    await running.leash.recordBody(running.paths, { leashTakenAt: running.soul.createdAt });
  }
  const stopped = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "000000ff", createdAt: "2026-08-09T00:00:00.000Z" });
  const body = await stopped.leash.recordBody(stopped.paths, { leashTakenAt: stopped.soul.createdAt });
  await breakBody(stopped.paths, { sequence: body.sequence, end: "put-down", at: stopped.soul.createdAt });
  stopped.leash.release();
  const report = await kanshiCounts({ world, repo });
  assert.deepEqual([report.akuma, report.contracts, report.debts], [
    { kind: "present", value: 12 }, { kind: "present", value: 12 }, { kind: "present", value: 12 },
  ]);
  writeFileSync(stopped.paths.heart, "corrupt");
  const broken = await kanshiCounts({ world, repo });
  assert.equal(broken.akuma.kind, "failed");
  assert.deepEqual(broken.contracts, report.contracts);
  assert.deepEqual(broken.debts, report.debts);
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  const brokenDebt = await kanshiCounts({ world, repo });
  assert.equal(brokenDebt.debts.kind, "failed");
  assert.deepEqual(brokenDebt.contracts, report.contracts);
});

test("absence, explicit Repo and crossing validation remain independent", async (context) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "counts-world-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = await World.prove(directory);
  const absent = await kanshiCounts({ world });
  assert.deepEqual([absent.akuma, absent.contracts, absent.debts], Array(3).fill({ kind: "absent" }));
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const independent = await kanshiCounts({ world: null, repo });
  assert.deepEqual(independent.contracts, { kind: "present", value: 0 });
  assert.equal(independent.akuma.kind, "absent");
  const call = (value: unknown) => kanshiCounts(value as KanshiCountsInput);
  await assert.rejects(call({ world: directory, repo: {} }), TypeError);
  await assert.rejects(call({ world: directory, extra: true }), TypeError);
  await assert.rejects(call({ world: `${directory}/.` }));
  assert.equal((await kanshiCounts({ world })).debts.kind, "absent");
});
