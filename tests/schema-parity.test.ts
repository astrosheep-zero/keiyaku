import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { akumaStatusSchema, type AkumaStatus } from "../src/index.js";
import { assertWireRoundTrip, type Assert, type Exact, type Wire } from "./support/schema-parity.js";
export type Same = Assert<Exact<{ a?: string }, { a?: string }>>;
// @ts-expect-error optional and required-with-undefined are different
export type OptionalMismatch = Assert<Exact<{ a?: string }, { a: string | undefined }>>;
// @ts-expect-error exact optional excludes an explicitly supplied undefined
export type OptionalUndefinedMismatch = Assert<Exact<{ a?: string }, { a?: string | undefined }>>;
// @ts-expect-error nested exact optional excludes explicit undefined
export type NestedOptionalUndefinedMismatch = Assert<Exact<{ a: { b?: string } }, { a: { b?: string | undefined } }>>;
// @ts-expect-error optional-undefined drift inside an array element is different
export type ArrayOptionalUndefinedMismatch = Assert<Exact<{ a: { b?: string }[] }, { a: { b?: string | undefined }[] }>>;
// @ts-expect-error optional-undefined drift inside a union member is different
export type UnionOptionalUndefinedMismatch = Assert<Exact<{ a: { kind: "a"; b?: string } | { kind: "b" } }, { a: { kind: "a"; b?: string | undefined } | { kind: "b" } }>>;
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

export function nativeSnapshotEntryRemainsMutable(status: AkumaStatus): void {
  const entry = status.timeline.entries[0];
  if (entry?.kind === "gap") entry.count = 1;
}

export function publicSnapshotEntryRemainsReadonly(status: z.output<typeof akumaStatusSchema>): void {
  const entry = status.timeline.entries[0];
  if (entry?.kind === "gap") {
    // @ts-expect-error public wire entries are readonly
    entry.count = 1;
  }
}

export type WireTupleReadonly = Assert<Exact<Wire<[{ nested: string }]>, readonly [{ readonly nested: string }]>>;

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
