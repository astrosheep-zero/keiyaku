import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  akumaStatusSchema, askProgressSchema, spawnProgressSchema, whoamiFactsSchema,
  type AkumaStatus, type AskProgress, type SpawnProgress, type WhoamiFacts, type Delivery,
} from "../src/index.js";
import type { DeliveryValue } from "../src/library/delivery.js";
import { deliverPlacementSchema } from "../src/library/delivery.js";
import { verbs, type VerbName, type VerbOutputs } from "../src/library/keiyaku-verbs.js";
import { bindOutcomeSchema, deliverOutcomeSchema } from "../src/library/contract-outcomes.js";
import { spawnResultSchema, type SpawnResult } from "../src/library/akuma-creation.js";
import { akumaAskResultSchema, type AkumaAskObservation, type AkumaAskResult } from "../src/akuma/selection-observation.js";
import { settingsSchema } from "../src/settings.js";
import { resetOutcomeSchema } from "../src/library/outcome.js";
import { debtMutationResultSchema, debtUpdateResultSchema, debtBatchResultSchema, debtTreeResultSchema, debtAbsentSchema, debtContextResultSchema } from "../src/debt/index.js";
import { assertWireRoundTrip, type Assert, type Exact, type Wire } from "./support/schema-parity.js";
export type VerbKeysMatchNativeOutputs = Assert<Exact<VerbName, keyof VerbOutputs>>;
// TypeScript cannot express enumerability: bind's process-local capability is
// nonenumerable and runtime round-trips independently pin that JSON boundary.
// Native ask/spawn decoders may carry any caller-owned T; the published schema
// is the JSON wire, so parity instantiates the native generic at that boundary.
type JsonWireValue = Extract<z.output<typeof akumaAskResultSchema>, { kind: "answered"; answer: unknown }>["answer"];
// Wire maps JSON object/array payloads to a different readonly projection. Native
// ask/spawn payloads are already JSON wire values, so drop only never-typed
// discriminants and leave the decoded JSON payload exactly as it is.
type DropNeverShallow<T> = T extends unknown
  ? { readonly [K in keyof T as [Exclude<T[K], undefined>] extends [never] ? never : K]: T[K] }
  : never;
// The distributive projection expands the native subject/observation
// intersection, removes never-typed discriminants, and leaves the decoded JSON
// payload untouched.
type AskWireValue = DropNeverShallow<AkumaAskResult<JsonWireValue>>;
type SpawnWireValue = DropNeverShallow<Omit<SpawnResult<JsonWireValue>, "input">> & Readonly<{
  input?: DropNeverShallow<AkumaAskObservation<JsonWireValue>>;
}>;
type VerbNativeWireValue<K extends VerbName> = K extends "bind"
  ? Omit<Extract<VerbOutputs[K], { kind: "accepted" }>, "kei"> | Exclude<VerbOutputs[K], { kind: "accepted" }>
  : K extends "ask"
    ? AskWireValue
    : K extends "spawn"
      ? SpawnWireValue
      : VerbOutputs[K];
// Settings carries a process-local namespace accessor over keyed entry records.
// Wire's mapped Record projection cannot compare that shape exactly, so project
// the native stored value directly and let the ambient schema test pin the wires.
type VerbWire<K extends VerbName> = K extends "settings"
  ? Omit<VerbNativeWireValue<K>, "namespace">
  : K extends "ask" | "spawn"
    ? VerbNativeWireValue<K>
    : Wire<VerbNativeWireValue<K>>;
type VerbWireMismatches = {
  [K in VerbName]: Exact<z.output<(typeof verbs)[K]["output"]>, VerbWire<K>> extends true ? never : K;
}[VerbName];
export type VerbSchemasMatchNativeWire = Assert<Exact<VerbWireMismatches, never>>;
export type RootWhoamiWire = Assert<Exact<z.output<typeof whoamiFactsSchema>, Wire<WhoamiFacts>>>;
export type RootAskProgressWire = Assert<Exact<z.output<typeof askProgressSchema>, AskProgress>>;
export type RootSpawnProgressWire = Assert<Exact<z.output<typeof spawnProgressSchema>, SpawnProgress>>;

test("verb output schemas directly reference their owners", () => {
  assert.strictEqual(verbs.bind.output, bindOutcomeSchema);
  assert.strictEqual(verbs.deliver.output, deliverOutcomeSchema);
  assert.strictEqual(verbs.spawn.output, spawnResultSchema);
  assert.strictEqual(verbs.ask.output, akumaAskResultSchema);
  assert.strictEqual(verbs.ask.progress, askProgressSchema);
  assert.strictEqual(verbs.spawn.progress, spawnProgressSchema);
  assert.strictEqual(verbs.whoami.output, whoamiFactsSchema);
  assert.strictEqual(verbs.settings.output, settingsSchema);
  assert.strictEqual(verbs.nuke.output, resetOutcomeSchema);
  assert.strictEqual(verbs["debt.add"].output, debtMutationResultSchema);
  assert.strictEqual(verbs["debt.update"].output, debtUpdateResultSchema);
  assert.strictEqual(verbs["debt.done"].output, debtBatchResultSchema);
  // The invocation scope adds native absence without changing the resolved owner's answer.
  assert.strictEqual(verbs["debt.tree"].output.options[0], debtTreeResultSchema);
  assert.strictEqual(verbs["debt.tree"].output.options[1], debtAbsentSchema);
  assert.strictEqual(verbs["debt.context"].output, debtContextResultSchema);
});

export type Same = Assert<Exact<{ a?: string }, { a?: string }>>;
// @ts-expect-error optional and required-with-undefined are different
export type OptionalMismatch = Assert<Exact<{ a?: string }, { a: string | undefined }>>;
// @ts-expect-error exact optional excludes an explicitly supplied undefined
export type OptionalUndefinedMismatch = Assert<Exact<{ a?: string }, { a?: string | undefined }>>;
// @ts-expect-error nested exact optional excludes explicit undefined
export type NestedOptionalUndefinedMismatch = Assert<Exact<{ a: { b?: string } }, { a: { b?: string | undefined } }>>;
export type ArrayOptionalUndefinedMismatch = Assert<
  // @ts-expect-error optional-undefined drift inside an array element is different
  Exact<{ a: { b?: string }[] }, { a: { b?: string | undefined }[] }>
>;
export type UnionOptionalUndefinedMismatch = Assert<
  // @ts-expect-error optional-undefined drift inside a union member is different
  Exact<{ a: { kind: "a"; b?: string } | { kind: "b" } }, { a: { kind: "a"; b?: string | undefined } | { kind: "b" } }>
>;
export type NestedOptionalSame = Assert<Exact<{ a: readonly { b?: string }[] }, { a: readonly { b?: string }[] }>>;
// @ts-expect-error a missing field is different
export type MissingMismatch = Assert<Exact<{ a: string }, { a: string; b: number }>>;
// @ts-expect-error readonly arrays are different from mutable arrays
export type ReadonlyMismatch = Assert<Exact<readonly string[], string[]>>;

test("wire parity checks parsing and input JSON schema", () => {
  assertWireRoundTrip(z.strictObject({ a: z.string() }).readonly(), { a: "value" });
  assert.throws(() =>
    assertWireRoundTrip(
      z.string().transform((value) => value.length),
      "value",
    ),
  );
});

const nestedMutable = z.strictObject({ inner: z.strictObject({ value: z.string() }) }).readonly();
// @ts-expect-error nested wire objects must be readonly
export type NestedMutableMismatch = Assert<Exact<z.output<typeof nestedMutable>, Wire<{ inner: { value: string } }>>>;

export function nativeSnapshotEntryRemainsReadonly(status: AkumaStatus): void {
  const entry = status.timeline.entries[0];
  if (entry?.kind === "gap") {
    // @ts-expect-error native entries share the owner's readonly projection
    entry.count = 1;
  }
}

export function publicSnapshotEntryRemainsReadonly(status: z.output<typeof akumaStatusSchema>): void {
  const entry = status.timeline.entries[0];
  if (entry?.kind === "gap") {
    // @ts-expect-error public wire entries are readonly
    entry.count = 1;
  }
}

export type WireTupleReadonly = Assert<Exact<Wire<[{ nested: string }]>, readonly [{ readonly nested: string }]>>;
export type WireVariadicHead = Assert<Exact<Wire<[string, ...number[]]>, readonly [string, ...number[]]>>;
export type WireVariadicOptional = Assert<Exact<Wire<[string?, ...number[]]>, readonly [string?, ...number[]]>>;
export type WireVariadicTail = Assert<Exact<Wire<[...string[], number]>, readonly [...string[], number]>>;
export type WireVariadicUnknown = Assert<Exact<Wire<[unknown?, ...unknown[]]>, readonly [unknown?, ...unknown[]]>>;
type Branded = string & { readonly __brand: "identity" };
export type WireBrandPreserved = Assert<Exact<Wire<Branded>, Branded>>;
export type DeliveryPlacement = Assert<
  Exact<Wire<NonNullable<(Delivery & DeliveryValue)["placement"]>>, z.output<typeof deliverPlacementSchema>>
>;
// @ts-expect-error tuples retain their fixed length rather than becoming arrays
export type TupleNotArray = Assert<Exact<Wire<[string, number]>, readonly (string | number)[]>>;

class Handle {
  readonly id = "k";
  toJSON(): { contract: string } {
    return { contract: this.id };
  }
}
type Capability = Readonly<{
  root: string | null;
  establish: () => Promise<string>;
  items?: readonly Handle[];
  value: undefined;
  note: string | undefined;
}>;
export type WireDropsFunctionsAndUndefined = Assert<
  Exact<
    Wire<Capability>,
    { readonly root: string | null; readonly items?: readonly { readonly contract: string }[]; readonly note?: string }
  >
>;

test("wire round-trip compares against the JSON projection of handles and capabilities", () => {
  const schema = z
    .strictObject({ root: z.string(), handle: z.strictObject({ contract: z.string() }).readonly() })
    .readonly();
  assertWireRoundTrip(schema, { root: "r", handle: new Handle(), establish: () => "x" });
});
