import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  Akuma,
  Akumas,
  Debts,
  Keis,
  Keiyaku,
  KeiyakuUsageError,
  Repo,
  World,
  kanshi,
  type ExecutionObservation,
} from "../src/index.js";
import { beginTurn } from "../src/akuma/heart/index.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { settings } from "../src/settings.js";
import { bornBody, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { repositoryWithCommit } from "./support/git.js";
import { accepted, commitCandidate, document } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";

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
  await assert.rejects(facet.ls({ of: "kei" }), /invocation cwd is not an existing directory/u);

  for (const input of [
    { cwd: "relative", environment: {} },
    { cwd: home, environment: null },
    { cwd: home, environment: [] },
    { cwd: home, environment: { BAD: 12 } },
    { cwd: home, environment: {}, home: 1 },
    { cwd: home, environment: {}, repo: 1 },
  ])
    assert.throws(() => Keiyaku.at(input as never), TypeError);

  const environment: Record<string, string> = { PI_SESSION_ID: "captured" };
  const captured = Keiyaku.at({ cwd: home, environment, home });
  environment.PI_SESSION_ID = "changed";
  assert.deepEqual((await captured.whoami()).self, { kind: "external", integration: "pi", id: "captured" });
});

test("facet delegates reads and mutations using selected Repo but invocation World", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-invocation-home-");
  const first = repositoryWithCommit();
  const second = repositoryWithCommit();
  const worldA = await World.at(first.path);
  const worldB = await World.at(second.path);
  writeFileSync(join(worldA, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await pluginRuntime({ world: worldA, settings: await settings({ root: worldA, home }) });
  const repoA = await Repo.at({ path: first.path });
  const repoB = await Repo.at({ path: second.path });
  const debtA = accepted(await Debts.of(worldA).add({ title: "Debt in invocation world" }));
  accepted(await Debts.of(worldB).add({ title: "Debt in selected repo world" }));
  const worker = await bornLineageAkuma({
    root: worldA,
    akumaName: "worker",
    draw: "1234abcd",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const facet = Keiyaku.at({ cwd: first.path, repo: relative(first.path, second.path), environment: {}, home });
  const bound = accepted(await facet.bind({ markdown, gates: ["reviewed"] }));
  const contract = bound.contract;
  assert.equal((await Keis.of(repoA).list({})).rows.length, 0);
  const nativeList = await Keis.of(repoB).list({});
  assert.equal(nativeList.rows[0]?.id, contract);
  const { observedAt: _facetObservedAt, ...facetList } = await facet.ls({ of: "kei" });
  const { observedAt: _nativeObservedAt, ...comparableList } = nativeList;
  assert.deepEqual(facetList, comparableList);
  assert.deepEqual(await facet.show({ contract }), await Keis.of(repoB).kei({ id: contract }).guidance());
  assert.deepEqual(await facet.history({ selector: contract }), await Keis.of(repoB).kei({ id: contract }).history());

  const nativeDebts = await Debts.of(worldA).list({ selection: "all", namespace: [] });
  assert.deepEqual(await facet.ls({ of: "debt" }), nativeDebts);
  assert.equal(nativeDebts.kind, "accepted");
  if (nativeDebts.kind === "accepted") assert.equal(nativeDebts.value.rows[0]?.id, debtA.value.id);
  const nativeWorkers = await Akumas.of(worldA).list({ akumaName: "worker" });
  assert.equal(nativeWorkers.rows[0]?.id, worker.id);
  const { observedAt: _facetWorkersAt, ...facetWorkers } = await facet.ls({ of: "aku", akumaName: "worker" });
  const { observedAt: _nativeWorkersAt, ...comparableWorkers } = nativeWorkers;
  assert.deepEqual(facetWorkers, comparableWorkers);
  const workerStatus = await Akumas.of(worldA).status({ akuma: worker.id, repo: repoB });
  assert.deepEqual(await facet.status({ selector: worker.id }), workerStatus);
  assert.deepEqual(
    await facet.history({ selector: worker.id }),
    await Akumas.of(worldA).history({ akuma: worker.id, repo: repoB }),
  );
  const contractStatus = await kanshi({ world: worldA, repo: repoB, contract });
  const mixed = await facet.status({ selectors: [worker.id, contract] });
  assert.ok(Array.isArray(mixed));
  assert.deepEqual(mixed[0], workerStatus);
  assert.deepEqual(withoutObservationTimes(mixed[1]), withoutObservationTimes(contractStatus));
  assert.deepEqual(
    await facet.wait({ selectors: [contract], timeoutMs: 0 }),
    await Keis.of(repoB).wait({ contracts: [contract], timeoutMs: 0 }),
  );
  assert.deepEqual(
    await facet.wait({ selectors: [worker.id], timeoutMs: 0 }),
    await Akumas.of(worldA).wait({ akuma: [worker.id], repo: repoB, timeoutMs: 0 }),
  );
  const short = `@${contract.slice("kei/".length)}`;
  assert.deepEqual(await facet.show({ contract: short }), await Keis.of(repoB).kei({ id: contract }).guidance());

  const other = Keiyaku.at({ cwd: second.path, environment: {}, home });
  assert.deepEqual(await other.ls({ of: "debt" }), await Debts.of(worldB).list({ selection: "all", namespace: [] }));
  const { observedAt: _otherWorkersAt, ...otherWorkers } = await other.ls({ of: "aku" });
  const { observedAt: _emptyWorkersAt, ...emptyWorkers } = await Akumas.of(worldB).list({});
  assert.deepEqual(otherWorkers, emptyWorkers);
  const { observedAt: _otherObservedAt, ...otherList } = await other.ls({ of: "kei" });
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
  assert.ok(bound.value.workspace);
  commitCandidate(repository, bound.value.workspace.path);
  const native = bound.value.kei;
  const events: ExecutionObservation[] = [];
  const result = accepted(
    await facet.verify(
      { contract: bound.contract },
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
  const firstCheck = result.value.checks[0];
  assert.ok(firstCheck?.kind === "terminal");
  const direct = accepted(await native.verify());
  const repeated = accepted(await facet.verify({ contract: bound.contract }));
  assert.deepEqual(repeated, direct);
  const controller = new AbortController();
  controller.abort(new Error("caller cancellation"));
  await assert.rejects(native.verify({ signal: controller.signal }));
  await assert.rejects(facet.verify({ contract: bound.contract, signal: controller.signal }));
  assert.deepEqual(await facet.previewDelivery({ contract: bound.contract }), await native.previewDelivery());
});

test("report uses the explicit Akuma execution and returns native evidence", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-invocation-report-");
  const home = temporaryDirectory(t, "keiyaku-invocation-report-home-");
  const world = await World.at(root);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await pluginRuntime({ world, settings: await settings({ root: world, home }) });
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
    for (const invalid of [
      { ...environment, KEIYAKU_ACTOR_ID: "invalid" },
      {},
    ]) {
      await assert.rejects(Keiyaku.at({ cwd: world, environment: invalid, home }).report({ text: "bad" }), KeiyakuUsageError);
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
    (error: unknown) =>
      error instanceof KeiyakuUsageError && /wait cannot mix Contract and Akuma selectors/u.test(error.message),
  );
});
