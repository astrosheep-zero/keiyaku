import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  Akuma,
  Akumas,
  Debts,
  Keis,
  Keiyaku,
  KeiyakuError,
  KeiyakuUsageError,
  Repo,
  World,
  Kanshi,
  type ExecutionObservation,
} from "../src/index.js";
import { beginTurn } from "../src/akuma/heart/index.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { Settings } from "../src/settings.js";
import { bornBody, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { repositoryWithCommit } from "./support/git.js";
import { accepted, commitCandidate, document } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";

test("Debt facet preserves native lifecycle, flat World listing, and absent World", async (t) => {
  const cwd = temporaryDirectory(t, "debt-facet-");
  const facet = Keiyaku.at({ cwd, environment: { KEIYAKU_ACTOR_ID: "ambient-fixture" } });
  assert.deepEqual(await facet.show({ id: "debt/missing" }), { kind: "absent" });
  assert.deepEqual(await facet.ls({ selector: "debt/" }), { kind: "debt-catalogue", absent: true });
  assert.deepEqual(await facet.debtDoctor({}), { kind: "absent" });
  assert.equal((await facet.debtUpdate({ id: "debt/missing", note: "note" })).kind, "refused");
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const first = accepted(await facet.debtAdd({ title: "First" }));
  const second = accepted(await facet.debtAdd({ title: "Second", needs: [first.id] }));
  const world = await World.at(cwd);
  assert.deepEqual(await facet.show({ ids: [first.id, second.id] }), await Debts.of(world).read({ ids: [first.id, second.id] }));
  assert.equal((await facet.debtUpdate({ id: first.id, state: "done", note: "finished" })).kind, "accepted");
  for (const selection of ["active", "closed", "all"] as const)
    assert.deepEqual(await facet.ls({ selector: "debt/", selection, limit: 1 }), await Debts.of(world).list({ selection, limit: 1 }));
});

function withoutObservationTimes(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => (key === "observedAt" ? undefined : item)));
}

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
  const facet = Keiyaku.at({ cwd: missing, environment: {}, home });
  assert.ok(facet instanceof Keiyaku);
  await assert.rejects(facet.ls({ selector: "kei/" }), /invocation cwd is not an existing directory/u);

  for (const input of [
    { cwd: "relative", environment: {} },
    { cwd: home, environment: null },
    { cwd: home, environment: [] },
    { cwd: home, environment: { BAD: 12 } },
    { cwd: home, environment: {}, home: 1 },
    { cwd: home, environment: {}, repo: 1 },
  ])
    assert.throws(
      () => Keiyaku.at(input as never),
      (error: unknown) =>
        error instanceof KeiyakuUsageError && error.category === "invalid-input",
    );

  const environment: Record<string, string> = { PI_SESSION_ID: "captured" };
  const captured = Keiyaku.at({ cwd: home, environment, home });
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
  await pluginRuntime({ world: worldA, settings: await Settings.load({ cwd: worldA, home }) });
  const repoA = await Repo.at({ path: first.path });
  const repoB = await Repo.at({ path: second.path });
  const debtA = accepted(await Debts.of(worldA).add({ title: "Debt in invocation world" })).id;
  accepted(await Debts.of(worldB).add({ title: "Debt in selected repo world" }));
  const worker = await bornLineageAkuma({
    root: worldA,
    akumaName: "worker",
    draw: "1234abcd",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const facet = Keiyaku.at({ cwd: first.path, repo: relative(first.path, second.path), environment: {}, home });
  const bound = accepted(await facet.bind({ markdown, gates: ["reviewed"] }));
  const contract = bound.contractId;
  assert.equal((await Keis.of(repoA).list({})).rows, undefined, "an empty catalogue omits rows");
  const nativeList = await Keis.of(repoB).list({});
  assert.equal(nativeList.rows![0]?.id, contract);
  const selectedContracts = await facet.ls({ selector: "kei/" });
  if (selectedContracts.kind !== "contract-catalogue") assert.fail("wrong catalogue");
  const { observedAt: _facetObservedAt, ...facetList } = selectedContracts;
  const { observedAt: _nativeObservedAt, ...comparableList } = nativeList;
  assert.deepEqual(facetList, comparableList);
  assert.deepEqual(await facet.show({ id: contract }), await Keis.of(repoB).kei({ id: contract }).guidance());
  assert.deepEqual(await facet.history({ selector: contract }), await Keis.of(repoB).kei({ id: contract }).history());

  const nativeDebts = await Debts.of(worldA).list({ selection: "active" });
  assert.deepEqual(await facet.ls({ selector: "debt/" }), nativeDebts);
  assert.equal(nativeDebts.kind, "debt-catalogue");
  assert.equal(nativeDebts.rows![0]?.id, debtA);
  const nativeWorkers = await Akumas.of(worldA).list({ akumaName: "worker", repo: repoB });
  assert.equal(nativeWorkers.rows![0]?.id, worker.id);
  const selectedWorkers = await facet.ls({ selector: "aku/worker" });
  if (selectedWorkers.kind !== "akuma-catalogue") assert.fail("wrong catalogue");
  const { observedAt: _facetWorkersAt, ...facetWorkers } = selectedWorkers;
  const { observedAt: _nativeWorkersAt, ...comparableWorkers } = nativeWorkers;
  assert.deepEqual(facetWorkers, comparableWorkers);
  const workerStatus = await Akumas.of(worldA).status({ akuma: worker.id, repo: repoB });
  assert.deepEqual(await facet.status({ id: worker.id }), workerStatus);
  assert.deepEqual(
    await facet.history({ selector: worker.id }),
    await Akumas.of(worldA).history({ akuma: worker.id, repo: repoB }),
  );
  const contractStatus = await Kanshi.of({ world: worldA, repo: repoB }).contract(contract);
  assert.deepEqual(withoutObservationTimes(await facet.status({ id: contract })), withoutObservationTimes(contractStatus));
  assert.deepEqual(withoutObservationTimes(await facet.kanshi({})), withoutObservationTimes(await Kanshi.of({ world: worldA, repo: repoB }).board()));
  assert.deepEqual(
    await facet.wait({ selectors: [contract], timeoutMs: 0 }),
    await Keis.of(repoB).wait({ contracts: [contract], timeoutMs: 0 }),
  );
  assert.deepEqual(
    await facet.wait({ selectors: [worker.id], timeoutMs: 0 }),
    await Akumas.of(worldA).wait({ akuma: [worker.id], repo: repoB, timeoutMs: 0 }),
  );
  const short = `@${contract.slice("kei/".length)}`;
  assert.deepEqual(await facet.show({ id: short }), await Keis.of(repoB).kei({ id: contract }).guidance());

  const other = Keiyaku.at({ cwd: second.path, environment: {}, home });
  assert.deepEqual(await other.ls({ selector: "debt/" }), await Debts.of(worldB).list({ selection: "active" }));
  const selectedOtherWorkers = await other.ls({ selector: "aku/*" });
  if (selectedOtherWorkers.kind !== "akuma-catalogue") assert.fail("wrong catalogue");
  const { observedAt: _otherWorkersAt, ...otherWorkers } = selectedOtherWorkers;
  const { observedAt: _emptyWorkersAt, ...emptyWorkers } = await Akumas.of(worldB).list({});
  assert.deepEqual(otherWorkers, emptyWorkers);
  const selectedOtherContracts = await other.ls({ selector: "kei/" });
  if (selectedOtherContracts.kind !== "contract-catalogue") assert.fail("wrong catalogue");
  const { observedAt: _otherObservedAt, ...otherList } = selectedOtherContracts;
  assert.deepEqual(otherList, comparableList);
});

test("native Contract results, verification progress and cancellation pass through the facet", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-invocation-verify-");
  const repository = repositoryWithCommit();
  const repo = await Repo.at({ path: repository.path });
  const facet = Keiyaku.at({ cwd: repository.path, environment: {}, home });
  const bound = accepted(
    await Keis.of(repo).bind({
      markdown: document("printf invocation-progress"),
      target: null,
      gates: ["verified"],
    }),
  );
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);
  const native = bound.kei;
  const events: ExecutionObservation[] = [];
  const result = accepted(
    await facet.verify(
      { contract: bound.contractId },
      {
        observe: (event) => {
          events.push(event);
        },
      },
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "verification" &&
        event.observation.kind === "output" &&
        event.observation.text.includes("invocation-progress"),
    ),
  );
  const firstCheck = result.checks[0];
  assert.ok(firstCheck?.kind === "terminal");
  const direct = accepted(await native.verify());
  const repeated = accepted(await facet.verify({ contract: bound.contractId }));
  assert.deepEqual(repeated, direct);
  const controller = new AbortController();
  controller.abort(new Error("caller cancellation"));
  await assert.rejects(native.verify({ signal: controller.signal }));
  await assert.rejects(facet.verify({ contract: bound.contractId }, { signal: controller.signal }));
  assert.deepEqual(await facet.deliver({ contract: bound.contractId, dryRun: true }), await native.previewDelivery());
});

test("report uses the explicit Akuma execution and returns native evidence", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-invocation-report-");
  const home = temporaryDirectory(t, "keiyaku-invocation-report-home-");
  const world = await World.at(root);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await pluginRuntime({ world, settings: await Settings.load({ cwd: world, home }) });
  const born = await bornBody(world, "feed0021", "2026-10-30T00:00:00.000Z");
  try {
    await beginTurn(born.allocated.paths, {
      bodySequence: born.body.sequence,
      startedAt: "2026-10-30T00:00:00.000Z",
    });
    const environment = {
      KEIYAKU_ACTOR_ID: born.allocated.id,
      KEIYAKU_ACTOR_WORLD: world,
    };
    const facet = Keiyaku.at({ cwd: world, environment, home });
    const native = Akuma.select(world, born.allocated.id);
    const recorded = await facet.report({ text: "facet milestone" });
    assert.equal(recorded.kind, "recorded");
    if (recorded.kind !== "recorded") assert.fail("report was not recorded");
    const history = await native.history();
    assert.ok(history.rows.some((row) => row.kind === "report" && row.text === "facet milestone"));
    assert.deepEqual(
      await facet.history({ selector: born.allocated.id }),
      await Akumas.of(world).history({ akuma: born.allocated.id }),
    );
    for (const invalid of [{ ...environment, KEIYAKU_ACTOR_ID: "invalid" }, {}]) {
      await assert.rejects(
        Keiyaku.at({ cwd: world, environment: invalid, home }).report({ text: "bad" }),
        (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
      );
    }
  } finally {
    born.holder.release();
  }
});

test("mixed wait refuses before observing even a nonexistent invocation cwd", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-invocation-wait-");
  const facet = Keiyaku.at({ cwd: join(home, "missing"), environment: {}, home });
  await assert.rejects(
    facet.wait({ selectors: ["kei/example", "aku/worker/1234abcd"] }),
    KeiyakuUsageError,
  );
});
