import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { Akumas, Debts, Keis, Keiyaku, KeiyakuUsageError, Repo, World } from "../src/index.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { repositoryWithCommit } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";

const markdown = contractMarkdown("Invocation fixture", {
  Context: "Exercise explicit invocation coordinates.",
  Objective: "Delegate to the native Contract owner.",
  Design: "Capture invocation input, then resolve on each call.",
  Region: "src/**",
  Criteria: "### Read\nReturn the native result.",
});

test("construction captures explicit inputs synchronously without observing cwd", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-invocation-home-");
  const missing = join(home, "missing");
  const facet = Keiyaku.for({ cwd: missing, environment: {}, home });
  assert.ok(facet instanceof Keiyaku);
  await assert.rejects(facet.ls({ selector: "kei/" }), /invocation cwd is not an existing directory/u);

  assert.throws(
    () => Keiyaku.for({ cwd: "relative", environment: {} }),
    (error: unknown) => error instanceof KeiyakuUsageError && error.category === "invalid-input",
  );

  const environment: Record<string, string> = { PI_SESSION_ID: "captured" };
  const captured = Keiyaku.for({ cwd: home, environment, home });
  environment.PI_SESSION_ID = "changed";
  assert.deepEqual((await captured.whoami({})).self, { kind: "external", id: "pi:captured" });
});

test("facet delegates reads and mutations using selected Repo but invocation World", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-invocation-home-");
  const first = repositoryWithCommit();
  const second = repositoryWithCommit();
  const worldA = await World.at(first.path);
  const worldB = await World.at(second.path);
  writeFileSync(join(worldA, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const debtA = accepted(await Debts.of(worldA).add({ title: "Debt in invocation world" })).id;
  accepted(await Debts.of(worldB).add({ title: "Debt in selected repo world" }));
  const worker = await bornLineageAkuma({
    root: worldA,
    akumaName: "worker",
    draw: "1234abcd",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const facet = Keiyaku.for({ cwd: first.path, repo: relative(first.path, second.path), environment: {}, home });
  const bound = accepted(await facet.bind({ terms: markdown, gates: ["reviewed"] }));
  const selectedContracts = await facet.ls({ selector: "kei/" });
  assert.ok(selectedContracts.kind === "contract-catalogue");
  assert.deepEqual(selectedContracts.rows?.map(({ id }) => id), [bound.contractId]);
  assert.ok(bound.worktreePath);
  const appointment = relative(second.path, bound.worktreePath);
  assert.ok(appointment && !isAbsolute(appointment) && !appointment.startsWith(`..${sep}`));

  const selectedDebts = await facet.ls({ selector: "debt/" });
  assert.ok(selectedDebts.kind === "debt-catalogue" && "rows" in selectedDebts);
  assert.deepEqual(selectedDebts.rows.map(({ id }) => id), [debtA]);
  const selectedWorkers = await facet.ls({ selector: "aku/worker", lifecycle: "all" });
  assert.ok(selectedWorkers.kind === "akuma-catalogue");
  assert.deepEqual(selectedWorkers.rows?.map(({ id }) => id), [worker.id]);

  const repo = await Repo.at({ path: second.path });
  const contractWait = (await facet.wait({ selectors: [bound.contractId], for: "0ms" })).members[0];
  assert.ok(contractWait && "contract" in contractWait);
  const native = (await Keis.of(repo).wait({ contracts: [bound.contractId], timeoutMs: 0 })).contracts[0];
  assert.equal(contractWait.contract, native?.id);
  assert.equal(contractWait.phase, native?.summary?.phase);
  assert.equal(contractWait.state, "waiting");
  assert.deepEqual(
    (await facet.wait({ selectors: [worker.id], for: "0ms" })).members,
    (await Akumas.of(worldA).wait({ akuma: [worker.id], repo, timeoutMs: 0 })).results,
  );
});
