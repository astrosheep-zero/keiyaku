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
import { assertWireRoundTrip } from "./support/schema-parity.js";

test("Debt facet preserves native lifecycle, context, and absent World", async (t) => {
  const cwd = temporaryDirectory(t, "debt-facet-");
  const facet = Keiyaku.at({ cwd, environment: { KEIYAKU_ACTOR_ID: "ambient-fixture" } });
  assert.deepEqual(await facet.debtShow({ id: "debt/missing" }), { kind: "absent" });
  assert.deepEqual(await facet.debtShow({ ids: ["debt/missing", "debt/missing"] }), { kind: "absent" });
  await assert.rejects(facet.debtShow({ ids: [] }), TypeError);
  await assert.rejects(facet.debtDone({ ids: ["debt/missing", "debt/missing"] }), TypeError);
  assert.deepEqual(await facet.ls({ of: "debt" }), { kind: "absent" });
  assert.deepEqual(await facet.debtDoctor(), { kind: "absent" });
  assert.equal((await facet.debtTree({ id: "debt/missing" })).kind, "absent");
  assert.equal((await facet.debtUpdate({ id: "debt/missing", note: "note" })).kind, "refused");
  assert.equal((await facet.debtDone({ ids: ["debt/missing"] })).items[0]?.kind, "refused");
  assert.equal((await facet.debtDrop({ ids: ["debt/missing"] })).items[0]?.kind, "refused");
  const reason = new Error("cancelled"),
    controller = new AbortController();
  controller.abort(reason);
  for (const operation of [
    () => facet.debtUpdate({ id: "debt/missing", note: "note", signal: controller.signal }),
    () => facet.debtDone({ ids: ["debt/missing"], signal: controller.signal }),
    () => facet.debtDrop({ ids: ["debt/missing"], signal: controller.signal }),
  ])
    await assert.rejects(operation, (error: unknown) => error === reason);
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const defaultContext = await facet.debtContext();
  assert.deepEqual(defaultContext, { kind: "present", source: "default-root" });
  assertWireRoundTrip(Keiyaku.verbs["debt.context"].output, defaultContext);
  await assert.rejects(facet.debtContext({ namespace: ["INVALID"] }), TypeError);
  await assert.rejects(facet.debtAdd({ title: " " }), TypeError);
  assert.deepEqual(await facet.ls({ of: "debt" }), { kind: "absent" });
  assert.equal(existsSync(join(cwd, ".keiyaku")), false);
  const installedContext = await facet.debtContext({ namespace: ["nested"] });
  assert.deepEqual(installedContext, { kind: "present", source: "local-override", namespace: "nested" });
  assertWireRoundTrip(Keiyaku.verbs["debt.context"].output, installedContext);
  assertWireRoundTrip(Keiyaku.verbs["debt.context"].output, await facet.debtContext());
  const first = accepted(await facet.debtAdd({ title: "First", actor: "fixture" }));
  const second = accepted(await facet.debtAdd({ title: "Second", needs: [first.id] }));
  const third = accepted(await facet.debtAdd({ title: "Third" }));
  const root = accepted(await facet.debtAdd({ title: "Root", namespace: [] }));
  const shownDebt = async (id: string) => {
    const shown = await facet.debtShow({ id });
    assert.equal(shown.kind, "present");
    if (shown.kind !== "present") throw new Error("missing Debt show");
    const item = shown.items[0];
    assert.equal(item?.kind, "found");
    if (item?.kind !== "found") throw new Error("missing Debt");
    const { kind: _kind, ...detail } = item;
    return detail;
  };
  const firstDetail = await shownDebt(first.id);
  const secondDetail = await shownDebt(second.id);
  assert.equal(firstDetail.createdBy, "fixture");
  assert.equal(secondDetail.createdBy, "ambient-fixture");
  const nativeFirst = await Debts.of(await World.at(cwd)).debt({ id: first.id }).read();
  assert.equal(nativeFirst.kind, "present");
  if (nativeFirst.kind === "present") {
    const { kind: _kind, ...detail } = nativeFirst;
    assert.deepEqual(firstDetail, detail);
  }
  assert.equal((await facet.debtUpdate({ id: first.id, note: "changed" })).kind, "accepted");
  const batch = await facet.debtDone({ ids: [first.id, second.id] });
  assert.deepEqual(
    batch.items.map((item) => item.kind),
    ["accepted", "accepted"],
  );
  assert.equal((await facet.debtDrop({ ids: [third.id] })).items[0]?.kind, "accepted");
  const active = await facet.ls({ of: "debt" });
  const closed = await facet.ls({ of: "debt", selection: "closed" });
  assert.equal(active.kind, "present");
  assert.equal(closed.kind, "present");
  if (active.kind === "present" && closed.kind === "present") {
    assert.equal(active.rows, undefined, "an empty page omits rows");
    assert.equal(closed.rows!.length, 3);
  }
  const all = await facet.ls({ of: "debt", scope: "world", selection: "all", limit: 2 });
  assert.equal(all.kind, "present");
  if (all.kind === "present") {
    assert.equal(all.rows!.length, 2);
    assert.equal(all.more, true);
  }
  const rootOnly = await facet.ls({ of: "debt", namespace: [] });
  assert.equal(rootOnly.kind, "present");
  if (rootOnly.kind === "present")
    assert.deepEqual(
      rootOnly.rows!.map((row) => row.id),
      [root.id],
    );
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
  assert.deepEqual((await captured.whoami()).self, { kind: "external", id: "pi:captured" });
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
  const { observedAt: _facetObservedAt, ...facetList } = await facet.ls({ of: "kei" });
  const { observedAt: _nativeObservedAt, ...comparableList } = nativeList;
  assert.deepEqual(facetList, comparableList);
  assert.deepEqual(await facet.show({ contract }), await Keis.of(repoB).kei({ id: contract }).guidance());
  assert.deepEqual(await facet.history({ selector: contract }), await Keis.of(repoB).kei({ id: contract }).history());

  const nativeDebts = await Debts.of(worldA).list({ selection: "active", namespace: [] });
  assert.deepEqual(await facet.ls({ of: "debt" }), nativeDebts);
  assert.equal(nativeDebts.kind, "present");
  if (nativeDebts.kind === "present") assert.equal(nativeDebts.rows![0]?.id, debtA);
  const nativeWorkers = await Akumas.of(worldA).list({ akumaName: "worker" });
  assert.equal(nativeWorkers.rows![0]?.id, worker.id);
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
  assert.ok("items" in mixed);
  assert.deepEqual(mixed.items[0], workerStatus);
  assert.deepEqual(withoutObservationTimes(mixed.items[1]), withoutObservationTimes(contractStatus));
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
  assert.deepEqual(await other.ls({ of: "debt" }), await Debts.of(worldB).list({ selection: "active", namespace: [] }));
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
  assert.deepEqual(await facet.previewDelivery({ contract: bound.contractId }), await native.previewDelivery());
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
    for (const invalid of [{ ...environment, KEIYAKU_ACTOR_ID: "invalid" }, {}]) {
      await assert.rejects(
        Keiyaku.at({ cwd: world, environment: invalid, home }).report({ text: "bad" }),
        KeiyakuUsageError,
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
