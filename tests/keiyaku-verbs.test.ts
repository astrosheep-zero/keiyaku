import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { type VerbName, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { Akuma, Keiyaku, KeiyakuUsageError, World, classifyVerb } from "../src/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { installHostAcpFixture } from "./support/acp-host-fixture.js";
import { repositoryWithMain, accepted, commitCandidate, document } from "./support/library-verbs.js";
import { cleanupSpawnCapableFixtureForTest, installAkumaBodyPidReceipt, temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip, type Assert, type Exact } from "./support/schema-parity.js";

export type VerbOutputParity = Assert<
  { [K in VerbName]: Exact<z.output<(typeof Keiyaku.verbs)[K]["output"]>, VerbOutput<K>> }[VerbName]
>;

test("verb runner preserves native bind, show and review results", async (t) => {
  const home = temporaryDirectory(t, "keiyaku-verbs-home-");
  const repository = repositoryWithMain();
  const facet = Keiyaku.at({ cwd: repository.path, environment: {}, home });
  const bindInput = { markdown: document(), target: null, gates: ["reviewed"] };
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

  const showInput = { contract: bound.contractId };
  const guidance = await facet.run("show", showInput);
  assert.deepEqual(guidance, await bound.kei.guidance());
  assert.ok(guidance.kind === "present" && guidance.guidance.includes("Library verbs"));
  assert.equal(classifyVerb("show", showInput, { kind: "returned", value: guidance }), "accepted");
  assertWireRoundTrip(Keiyaku.verbs.show.output, guidance);

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
      const facet = Keiyaku.at({ cwd: root, environment: {}, home });
      const result = mode === "native"
        ? await facet.ask({ akuma: allocated.id, prompt: "structured", schema: jsonSchema, timeoutMs: 30_000 })
        : await facet.run("ask", { akuma: allocated.id, prompt: "structured", schema: jsonSchema, timeoutMs: 30_000 });
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
  const facet = Keiyaku.at({ cwd: join(home, "missing"), environment: {}, home });
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
  const mixed = { selectors: ["kei/example", "aku/example/12345678"] };
  assert.equal(Keiyaku.verbs.wait.input.safeParse(mixed).success, false);
  await assert.rejects(facet.run("wait", mixed), (error: unknown) => {
    assert.ok(error instanceof KeiyakuUsageError);
    assert.equal(classifyVerb("wait", mixed, { kind: "threw", error }), "usage");
    return true;
  });
  assert.equal(Keiyaku.verbs.history.input.safeParse({ selector: "kei/example", limit: 1 }).success, false);
  assert.equal(Keiyaku.verbs.bind.input.safeParse({ markdown: document(), forkOf: "kei/example" }).success, false);
  assert.equal(classifyVerb("show", {}, { kind: "returned", value: { kind: "missing" } }), "refused");
  assert.equal(classifyVerb("show", {}, { kind: "threw", error: new TypeError("unexpected") }), "failed");
});
