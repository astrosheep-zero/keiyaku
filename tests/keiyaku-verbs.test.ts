import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { type VerbName, type VerbInput, type VerbOutput, type VerbRunFor } from "../src/library/keiyaku-verbs.js";
import { Akuma, Keiyaku, KeiyakuUsageError, World } from "../src/index.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { repositoryWithMain, accepted, commitCandidate, document } from "./support/library-verbs.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
} from "./support/process.js";
import { assertWireRoundTrip, type Assert, type Exact } from "./support/schema-parity.js";

export type VerbOutputParity = Assert<
  { [K in VerbName]: Exact<z.output<(typeof Keiyaku.verbs)[K]["output"]>, VerbOutput<K>> }[VerbName]
>;

type TypedMethod<K extends VerbName> = K extends "debt.add"
  ? "debtAdd"
  : K extends "debt.addDocument"
    ? "debtAddDocument"
    : K extends "debt.update"
      ? "debtUpdate"
      : K extends "debt.doctor"
        ? "debtDoctor"
        : K;
type VerbParameters<K extends VerbName> =
  {} extends VerbInput<K>
    ? [input?: VerbInput<K> | undefined, run?: VerbRunFor<K> | undefined]
    : [input: VerbInput<K>, run?: VerbRunFor<K> | undefined];
export type TypedVerbParity = Assert<
  {
    [K in VerbName]: Exact<Parameters<Keiyaku[TypedMethod<K>]>, VerbParameters<K>>;
  }[VerbName]
>;
export type DebtCancellationIsExecution = Assert<
  Exact<
    Extract<
      "signal",
      keyof VerbInput<"debt.add"> | keyof VerbInput<"debt.addDocument"> | keyof VerbInput<"debt.update">
    >,
    never
  >
>;

test("every invocation checks pre-abort before discovery, including native bind", async () => {
  const facet = Keiyaku.for({ cwd: "/missing-keiyaku-preabort", environment: {} });
  const reason = new Error("cancelled before discovery");
  const signal = AbortSignal.abort(reason);
  for (const name of Object.keys(Keiyaku.verbs) as VerbName[]) {
    await assert.rejects(facet.run(name, {} as never, { signal }), (error: unknown) => error === reason);
    const method =
      name === "debt.add"
        ? "debtAdd"
        : name === "debt.addDocument"
          ? "debtAddDocument"
          : name === "debt.update"
            ? "debtUpdate"
            : name === "debt.doctor"
              ? "debtDoctor"
              : name;
    await assert.rejects(
      () => facet[method]({} as never, { signal }),
      (error: unknown) => error === reason,
    );
  }
});

test("verb runner preserves native bind, show and review results", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-verbs-home-");
  const repository = repositoryWithMain();
  const facet = Keiyaku.for({ cwd: repository.path, environment: {}, home });
  const bindInput = { terms: document(), target: null, gates: ["reviewed"] };
  assert.equal(Keiyaku.verbs.bind.input.safeParse(bindInput).success, true);
  const bound = accepted(await facet.bind(bindInput));
  assert.equal(classifyVerb("bind", bindInput, { kind: "returned", value: bound }), "accepted");
  assertWireRoundTrip(Keiyaku.verbs.bind.output, bound);
  // Parsing the wire form cannot preserve the native handle's methods.
  const wire = Keiyaku.verbs.bind.output.parse(JSON.parse(JSON.stringify(bound)));
  assert.equal(typeof bound.kei.state, "function");
  assert.equal(wire.kind, "accepted");
  if (wire.kind !== "accepted") throw new Error("expected accepted bind wire value");
  assert.equal(Object.hasOwn(wire, "kei"), false);
  assert.equal(wire.contractId, bound.contractId);
  assert.ok(bound.worktreePath);
  commitCandidate(repository, bound.worktreePath);

  const showInput = { selector: bound.contractId };
  const guidance = await facet.run("show", showInput);
  assert.deepEqual(guidance, await bound.kei.guidance());
  assert.ok(guidance.kind === "present" && guidance.guidance.includes("Library verbs"));
  assert.equal(classifyVerb("show", showInput, { kind: "returned", value: guidance }), "accepted");
  assertWireRoundTrip(Keiyaku.verbs.show.output, guidance);

  const contextual = Keiyaku.for({ cwd: bound.worktreePath, environment: {}, home });
  assert.deepEqual(await contextual.show(showInput), guidance);
  await assert.rejects(contextual.show({} as never), KeiyakuUsageError);
  await assert.rejects(contextual.run("show", {} as never), KeiyakuUsageError);
  await assert.rejects((contextual.show as () => Promise<unknown>)(), KeiyakuUsageError);

  const reviewInput = { contract: bound.contractId, verdict: "satisfied" as const, summary: "Reviewed the candidate changes" };
  const reviewed = accepted(await facet.run("review", reviewInput));
  assert.equal(classifyVerb("review", reviewInput, { kind: "returned", value: reviewed }), "accepted");
  assertWireRoundTrip(Keiyaku.verbs.review.output, reviewed);
  const history = await bound.kei.history();
  assert.ok(history.kind === "contract");
  assert.ok(history.events.some((event) => event.kind === "attestation"));
});

test("native ask and wire run return parsed JSON", async (t) => {
  const jsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  for (const mode of ["native", "wire"] as const) {
    const root = temporaryDirectory(t, `keiyaku-verbs-ask-${mode}-`);
    const home = temporaryDirectory(t, "keiyaku-verbs-ask-home-");
    const world = await World.at(root);
    installHostAcpFixture(world);
    const agent = join(root, "host-acp.mjs");
    const source = readFileSync(agent, "utf8");
    assert.ok(source.includes('text: "acp-answer"'));
    writeFileSync(agent, source.replace('text: "acp-answer"', `text: ${JSON.stringify('{"ok":true}')}`));
    const allocated = await bornDirectAkuma({
      root: world, akumaName: "acp-worker", draw: mode === "native" ? "a2000011" : "a2000012",
      createdAt: "2026-08-10T00:00:00.000Z",
      provider: { name: "fixture-acp", kind: "acp", executable: process.execPath,
        config: { argvBefore: [agent], argvAfter: [], systemPromptArg: "--system-prompt" } },
    });
    allocated.leash.release();
    const receipt = join(root, "body-pids");
    const restore = installAkumaBodyPidReceipt(receipt);
    let operationFailed = true;
    try {
      const facet = Keiyaku.for({ cwd: root, environment: {}, home });
      const result = mode === "native"
        ? await facet.ask({ akuma: allocated.id, prompt: "structured", schema: jsonSchema, timeout: "30s" })
        : await facet.run("ask", { akuma: allocated.id, prompt: "structured", schema: jsonSchema, timeout: "30s" });
      assert.equal(result.kind, "answered");
      if (result.kind !== "answered") throw new Error("expected an answer");
      assert.deepEqual(result.answer, { ok: true });
      assertWireRoundTrip(Keiyaku.verbs.ask.output, result);
      assert.equal((await Akuma.select(world, allocated.id).idle({ timeoutMs: 30_000 })).reason, "completed");
      operationFailed = false;
    } finally {
      try {
        await cleanupSpawnCapableFixtureForTest(t, { fixturePath: root, pidReceiptPath: receipt, timeoutMs: 30_000, operationFailed });
      } finally {
        restore();
      }
    }
  }
});

test("wire validation and classification reject malformed calls before observation", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-verbs-invalid-");
  const facet = Keiyaku.for({ cwd: join(home, "missing"), environment: {}, home });
  for (const input of [
    { verdict: "satisfied" },
    { verdict: "satisfied", summary: " \t\n" },
    { verdict: "satisfied", summary: "Reviewed", extra: true },
    { verdict: "satisfied", summary: "Reviewed", actor: undefined },
  ]) {
    assert.equal(Keiyaku.verbs.review.input.safeParse(input).success, false);
    try {
      await facet.run("review", input as never);
      assert.fail("invalid review must throw");
    } catch (error) {
      assert.ok(error instanceof KeiyakuUsageError);
      assert.equal(classifyVerb("review", input as never, { kind: "threw", error }), "usage");
    }
  }
  for (const input of [
    { dryRun: true, message: "unused" },
    { dryRun: true, materializeConflict: false },
    { dryRun: true, overwrite: false },
    { showDiff: false },
    { dryRun: false, showDiff: true },
  ]) {
    assert.equal(Keiyaku.verbs.deliver.input.safeParse(input).success, false);
    for (const invoke of [() => facet.deliver(input as never), () => facet.run("deliver", input as never)]) {
      await assert.rejects(invoke, (error: unknown) => {
        assert.ok(error instanceof KeiyakuUsageError);
        assert.equal(classifyVerb("deliver", input as never, { kind: "threw", error }), "usage");
        return true;
      });
    }
  }
  for (const [name, inputs] of [
    ["spawn", [{ akumaName: "worker", prompt: "work", wait: "5m" }]],
    ["tell", [{ akuma: "@worker", prompt: "work", wait: "5m" }]],
    ["show", [undefined, {}, { id: "kei/example" }, { id: "debt/a", selector: "debt/a" },
      { ids: ["debt/a"] }, { selector: ["debt/a"] }, { selector: "" }, { selector: " " },
      { selector: "aku/worker/1234abcd" }, { selector: "debt/" }, { selector: "@*" }, { selector: "@" }]],
    ["kill", [{ akuma: ["aku/worker/1234abcd"] }, { akuma: " " }]],
    ["ls", [{ selector: "aku/", lifecycle: "all" }, { selector: "debt/", mine: true },
      { selector: "aku/", mine: true }, { selector: "aku/*", caller: "aku/intern/00000001" }, { selector: "aku/*", lifecycle: "closed" }]],
    ["status", [{}, { id: "kei/a" }, { selector: "kei/a", id: "kei/a" },
      { selector: "debt/a" }, { selector: "aku/*" }, { selector: "kei/" }, { selector: "@" },
      { selector: "@worker*" }, { selector: ["kei/a", "kei/b"] }, { selectors: ["kei/a", "kei/b"] }]],
  ] as const) for (const input of inputs) {
    await assert.rejects(facet.run(name, input as never), KeiyakuUsageError);
  }
  const mixed = { selectors: ["kei/example", "aku/example/12345678"] };
  assert.equal(Keiyaku.verbs.wait.input.safeParse(mixed).success, true);
  for (const input of [
    { selectors: [] }, { selectors: ["invalid"] },
    { ...mixed, timeout: 1 }, { ...mixed, timeout: "1.5s" },
    { ...mixed, timeout: "9007199254740992ms" },
  ]) {
    await assert.rejects(facet.run("wait", input as never), KeiyakuUsageError);
  }
  assert.equal(Keiyaku.verbs.history.input.safeParse({ selector: "kei/example", limit: 1 }).success, true);
  assert.equal(Keiyaku.verbs.bind.input.safeParse({ terms: document(), forkOf: "kei/example" }).success, false);
  assert.equal(classifyVerb("show", { selector: "kei/missing" }, { kind: "returned", value: { kind: "missing" } }), "refused");
  assert.equal(classifyVerb("show", { selector: "kei/missing" }, { kind: "threw", error: new TypeError("unexpected") }), "failed");
});

test("history selects one item or a page and observation deadlines share duration grammar", () => {
  const history = Keiyaku.verbs.history.input;
  for (const item of ["answer", "turn/1", "report/2", "3"]) {
    assert.equal(history.safeParse({ selector: "@worker", item }).success, true);
    assert.equal(history.safeParse({ selector: "@worker", item, limit: 1 }).success, false);
  }
  assert.equal(history.safeParse({ selector: "@worker", before: 3, limit: 2 }).success, true);
  assert.equal(history.safeParse({ selector: "@worker", since: 1, limit: 2 }).success, true);
  assert.equal(history.safeParse({ selector: "@worker", before: 3, since: 1 }).success, false);
  assert.equal(history.safeParse({ selector: "kei/example", item: "2" }).success, true);
  for (const item of ["answer", "turn/1", "report/2"]) assert.equal(history.safeParse({ selector: "kei/example", item }).success, false);
  assert.equal(history.safeParse({ selector: "kei/example", before: 3, since: 1 }).success, false);
  for (const timeout of [undefined, "0ms", "30s", "5m", "1.5s"]) {
    const expected = timeout !== "1.5s";
    const deadline = timeout === undefined ? {} : { timeout };
    assert.equal(Keiyaku.verbs.ask.input.safeParse({ akuma: "@worker", prompt: "answer", schema: {}, ...deadline }).success, expected);
    assert.equal(Keiyaku.verbs.wait.input.safeParse({ selectors: ["@worker"], ...deadline }).success, expected);
  }
});

test("ls uses one strict object and refuses inapplicable filters before discovery", async (t) => {
  const input = Keiyaku.verbs.ls.input;
  for (const valid of [
    { selector: "kei/" },
    { selector: "debt/", lifecycle: "settled", limit: 1 },
    { selector: "kei/", lifecycle: "all" },
    { selector: "aku/*", lifecycle: "settled", mine: true },
    { selector: "aku/" },
    { selector: "aku/*", mine: false },
    { selector: "aku/worker" },
  ])
    assert.equal(input.safeParse(valid).success, true, JSON.stringify(valid));
  for (const invalid of [
    { selector: "aku/", lifecycle: "all" },
    { selector: "kei/", mine: false },
    { selector: "debt/", mine: true },
    { selector: "aku/", mine: true },
    { selector: "aku/*", lifecycle: "closed" },
    { selector: "debt/", lifecycle: "open" },
    { selector: "debt/example" },
    { selector: "kei/", limit: 0 },
    { selector: "kei/", extra: true },
  ])
    assert.equal(input.safeParse(invalid).success, false, JSON.stringify(invalid));
  const facet = Keiyaku.for({ cwd: join(temporaryDirectory(t, "keiyaku-verbs-ls-"), "missing"), environment: {} });
  for (const inapplicable of [
    { selector: "aku/", lifecycle: "all" },
    { selector: "kei/", mine: false },
  ] as const)
    await assert.rejects(facet.run("ls", inapplicable), (error: unknown) => {
      assert.ok(error instanceof KeiyakuUsageError);
      assert.match(error.message, /valid only with/u);
      assert.equal(classifyVerb("ls", inapplicable, { kind: "threw", error }), "usage");
      return true;
    });
});

test("region uses one strict object and refuses contract with paths before discovery", async () => {
  const input = Keiyaku.verbs.region.input;
  for (const valid of [{}, { contract: "kei/example" }, { paths: ["src/**"] }])
    assert.equal(input.safeParse(valid).success, true, JSON.stringify(valid));
  const contradictory = { contract: "kei/example", paths: ["src/**"] };
  for (const invalid of [contradictory, { paths: [] }, { contract: "kei/example", extra: true }])
    assert.equal(input.safeParse(invalid).success, false, JSON.stringify(invalid));
  const facet = Keiyaku.for({ cwd: "/missing-region-contradiction", environment: {} });
  await assert.rejects(facet.run("region", contradictory), (error: unknown) => {
    assert.ok(error instanceof KeiyakuUsageError);
    assert.match(error.message, /contract and paths are mutually exclusive/u);
    assert.equal(classifyVerb("region", contradictory, { kind: "threw", error }), "usage");
    return true;
  });
});
