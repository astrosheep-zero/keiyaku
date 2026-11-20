import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { type VerbName, type VerbInput, type VerbOutput, type VerbRunFor } from "../src/library/keiyaku-verbs.js";
import { Keiyaku, KeiyakuUsageError } from "../src/index.js";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { repositoryWithMain, accepted, commitCandidate, document } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";
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
  K extends "bind"
    ? [input: VerbInput<K>, run?: VerbRunFor<K> | undefined]
    : {} extends VerbInput<K>
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

  const reviewInput = {
    contract: bound.contractId,
    verdict: "satisfied" as const,
    summary: "Reviewed the candidate changes",
  };
  const reviewed = accepted(await facet.run("review", reviewInput));
  assert.equal(classifyVerb("review", reviewInput, { kind: "returned", value: reviewed }), "accepted");
  assertWireRoundTrip(Keiyaku.verbs.review.output, reviewed);
  const history = await bound.kei.history();
  assert.ok(history.kind === "contract");
  assert.ok(history.events.some((event) => event.kind === "attestation"));
});
