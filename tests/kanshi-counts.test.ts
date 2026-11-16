import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { breakBody, finishBodyIfIdle, readSoul, recordTell } from "../src/akuma/heart/index.js";
import { recordAkumaLineage } from "../src/akuma/lineage-cache.js";
import { Debts, Kanshi, Keis, KeiyakuError, Repo, World } from "../src/index.js";
import type { AkumaCaller, KanshiCountsOptions, KanshiScopeInput } from "../src/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("exact counts observe complete independent owners and isolate corrupt Hearts", async (context) => {
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const world = await World.at(repository.path);
  const empty = await Kanshi.of({ world, repo }).counts();
  assert.deepEqual([empty.akuma, empty.contracts, empty.debts], Array(3).fill({ kind: "present", value: 0 }));
  const debts = Debts.of(world);
  for (let i = 0; i < 12; i++) accepted(await debts.add({ title: `Open ${i}` }));
  const done = accepted(await debts.add({ title: "Done" })).id;
  const drop = accepted(await debts.add({ title: "Drop" })).id;
  accepted(await debts.debt({ id: done }).update({ state: "done" }));
  accepted(await debts.debt({ id: drop }).update({ state: "drop" }));
  for (let i = 0; i < 12; i++) {
    accepted(await Keis.of(repo).bind({ target: "main", markdown: contractMarkdown(`Count ${i}`, {
      Context: "counts", Objective: "observe", Design: "owner", Region: "src/**", Criteria: "### Count\nCorrect.",
    }), gates: [] }));
  }
  const terminal = accepted(await Keis.of(repo).bind({ target: "main", markdown: contractMarkdown("Terminal", {
    Context: "counts", Objective: "observe", Design: "owner", Region: "src/**", Criteria: "### Count\nCorrect.",
  }), gates: [] }));
  await terminal.kei.abandon();
  for (let i = 1; i <= 12; i++) {
    const running = await bornDirectAkuma({ root: world, akumaName: "worker", draw: i.toString(16).padStart(8, "0"), createdAt: "2026-08-09T00:00:00.000Z" });
    context.after(() => running.leash.release());
    await running.leash.recordBody(running.paths, { leashTakenAt: running.soul.createdAt });
  }
  const stopped = await bornDirectAkuma({ root: world, akumaName: "worker", draw: "000000ff", createdAt: "2026-08-09T00:00:00.000Z" });
  const body = await stopped.leash.recordBody(stopped.paths, { leashTakenAt: stopped.soul.createdAt });
  await breakBody(stopped.paths, { sequence: body.sequence, end: "put-down", at: stopped.soul.createdAt });
  stopped.leash.release();
  const report = await Kanshi.of({ world, repo }).counts();
  assert.deepEqual([report.akuma, report.contracts, report.debts], [
    { kind: "present", value: 12 }, { kind: "present", value: 12 }, { kind: "present", value: 12 },
  ]);
  const unavailable = await Kanshi.of({ world, repo }).counts({ akumaCaller: null });
  assert.equal(unavailable.akuma.kind, "failed");
  assert.deepEqual([unavailable.contracts, unavailable.debts], [report.contracts, report.debts]);
  writeFileSync(stopped.paths.heart, "corrupt");
  const broken = await Kanshi.of({ world, repo }).counts();
  assert.equal(broken.akuma.kind, "failed");
  assert.deepEqual(broken.contracts, report.contracts);
  assert.deepEqual(broken.debts, report.debts);
  writeFileSync(join(world, ".keiyaku", "debts", "bad.md"), "not a debt document\n");
  const brokenDebt = await Kanshi.of({ world, repo }).counts();
  assert.equal(brokenDebt.debts.kind, "failed");
  assert.deepEqual(brokenDebt.contracts, report.contracts);
});

test("absence, explicit Repo and crossing validation remain independent", async (context) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "counts-world-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = await World.prove(directory);
  const absent = await Kanshi.of({ world }).counts();
  assert.deepEqual([absent.akuma, absent.contracts, absent.debts], Array(3).fill({ kind: "absent" }));
  const repository = makeGitRepository();
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const independent = await Kanshi.of({ world: null, repo }).counts();
  assert.deepEqual(independent.contracts, { kind: "present", value: 0 });
  assert.equal(independent.akuma.kind, "absent");
  const call = (value: unknown) => Kanshi.of(value as KanshiScopeInput).counts();
  assert.throws(
    () => call({ world: directory, repo: {} }),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
  assert.throws(
    () => call({ world: directory, extra: true }),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
  await assert.rejects(call({ world: `${directory}/.` }));
  assert.equal((await Kanshi.of({ world }).counts()).debts.kind, "absent");
  const selection = { akumaCaller: { kind: "external", integration: "pi", id: "S" } } as const;
  assert.equal((await Kanshi.of({ world }).counts(selection)).akuma.kind, "absent");
  await assert.rejects(Kanshi.of({ world }).counts({ akumaCaller: {} } as KanshiCountsOptions),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input");
  await World.at(world);
  mkdirSync(join(world, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "akuma", "run"), "not a directory");
  const unavailable = await Kanshi.of({ world }).counts(selection);
  assert.equal(unavailable.akuma.kind, "failed");
  assert.deepEqual(unavailable.debts, { kind: "present", value: 0 });
});

test("caller running count preserves readable ancestry without trusting the cache or display bound", async (context) => {
  const world = await World.at(temporaryDirectory(context, "counts-caller-"));
  const root: AkumaCaller = { kind: "external", integration: "pi", id: "flagship" };
  const kanshi = Kanshi.of({ world });
  const selected = () => kanshi.counts({ akumaCaller: root });
  assert.deepEqual((await selected()).akuma, { kind: "present", value: 0 });
  let draw = 0;
  const born = async (akumaName: string, caller?: AkumaCaller) => {
    const child = await bornDirectAkuma({
      root: world,
      akumaName,
      draw: (++draw).toString(16).padStart(8, "0"),
      createdAt: "2026-08-09T00:00:00.000Z",
      ...(caller === undefined ? {} : { caller }),
    });
    context.after(() => child.leash.release());
    const body = await child.leash.recordBody(child.paths, { leashTakenAt: child.soul.createdAt });
    return { ...child, body, caller: { kind: "akuma", world, akumaId: child.id } as const };
  };
  const ancestor = await born("worker", root);
  await finishBodyIfIdle(ancestor.paths, { sequence: ancestor.body.sequence, at: ancestor.soul.createdAt });
  ancestor.leash.release();
  const branch = await born("child", ancestor.caller);
  await born("grandchild", branch.caller);
  for (let i = 0; i < 11; i++) await born("peer", ancestor.caller);
  const unrelated = await born("outside");
  await recordTell(unrelated.paths, {
    kind: "tell",
    id: "not-a-parent",
    body: "hello",
    recordedAt: unrelated.soul.createdAt,
    initiator: "pi:flagship",
  });
  const hung = await born("hung", ancestor.caller);
  await hung.leash.recordBodyHung(hung.paths, {
    sequence: hung.body.sequence,
    diagnostic: "cannot retire",
    at: hung.soul.createdAt,
  });
  await recordAkumaLineage(world, { id: unrelated.id, caller: root });
  await recordAkumaLineage(world, { id: branch.id });
  assert.deepEqual((await selected()).akuma, { kind: "present", value: 13 });
  assert.deepEqual((await kanshi.counts({ akumaCaller: ancestor.caller })).akuma, { kind: "present", value: 13 });
  // A life failure must not erase the readable Soul edge to its descendants.
  const database = new DatabaseSync(ancestor.paths.heart);
  try {
    database.exec("DROP TABLE bodies");
  } finally {
    database.close();
  }
  assert.equal((await readSoul(ancestor.paths))?.id, ancestor.id);
  assert.deepEqual((await selected()).akuma, { kind: "present", value: 13 });
  assert.equal((await kanshi.counts()).akuma.kind, "failed");
  writeFileSync(ancestor.paths.heart, "corrupt");
  unrelated.leash.release();
  writeFileSync(unrelated.paths.heart, "corrupt");
  assert.deepEqual((await selected()).akuma, { kind: "present", value: 0 });
  await born("direct", root);
  assert.deepEqual((await selected()).akuma, { kind: "present", value: 1 });
});
