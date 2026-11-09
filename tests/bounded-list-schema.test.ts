import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { boundedListSchema, type BoundedList } from "../src/bounded-list.js";
import { assertWireRoundTrip, type Assert, type Exact } from "./support/schema-parity.js";

const row = z.object({ a: z.string() }).strict();
const schema = boundedListSchema(row);
const withEnvelope = boundedListSchema(row, { observedAt: z.string() });
export type ListParity = Assert<Exact<z.output<typeof schema>, BoundedList<z.output<typeof row>>>>;
export type EnvelopeParity = Assert<
  Exact<
    z.output<typeof withEnvelope>,
    Readonly<{
      observedAt: string;
      rows: readonly { a: string }[];
      hasMore: boolean;
    }>
  >
>;
// @ts-expect-error an envelope field remains required
const missingEnvelope: z.output<typeof withEnvelope> = { rows: [], hasMore: false };
void missingEnvelope;

test("bounded lists and envelopes round-trip as strict wire objects", () => {
  assertWireRoundTrip(schema, { rows: [{ a: "one" }], hasMore: false });
  assertWireRoundTrip(withEnvelope, { observedAt: "now", rows: [], hasMore: true });
  assert.equal(schema.safeParse({ rows: [], hasMore: false, extra: true }).success, false);
});
