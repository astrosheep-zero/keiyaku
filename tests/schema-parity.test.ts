import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { assertWireRoundTrip, type Assert, type Exact, type Wire } from "./support/schema-parity.js";
export type Same = Assert<Exact<{ a?: string }, { a?: string }>>;
// @ts-expect-error optional and required-with-undefined are different
type OptionalMismatch = Assert<Exact<{ a?: string }, { a: string | undefined }>>;
// @ts-expect-error a missing field is different
type MissingMismatch = Assert<Exact<{ a: string }, { a: string; b: number }>>;
// @ts-expect-error readonly arrays are different from mutable arrays
type ReadonlyMismatch = Assert<Exact<readonly string[], string[]>>;

test("wire parity checks parsing and input JSON schema", () => {
  assertWireRoundTrip(z.strictObject({ a: z.string() }).readonly(), { a: "value" });
  assert.throws(() =>
    assertWireRoundTrip(
      z.string().transform((value) => value.length),
      "value",
    ),
  );
});

class Handle {
  readonly id = "k";
  toJSON(): { contract: string } {
    return { contract: this.id };
  }
}
type Capability = Readonly<{ root: string | null; establish: () => Promise<string>; items?: readonly Handle[] }>;
export type WireDropsFunctions = Assert<
  Exact<Wire<Capability>, { readonly root: string | null; readonly items?: readonly { contract: string }[] }>
>;

test("wire round-trip compares against the JSON projection of handles and capabilities", () => {
  const schema = z
    .strictObject({ root: z.string(), handle: z.strictObject({ contract: z.string() }).readonly() })
    .readonly();
  assertWireRoundTrip(schema, { root: "r", handle: new Handle(), establish: () => "x" });
});
