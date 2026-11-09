import assert from "node:assert/strict";
import { z } from "zod";

export type Assert<T extends true> = T;

type Normalize<T> = { [K in keyof T]: T[K] };
export type Exact<A, B> =
  (<T>() => T extends Normalize<A> ? 1 : 2) extends <T>() => T extends Normalize<B> ? 1 : 2
    ? (<T>() => T extends Normalize<B> ? 1 : 2) extends <T>() => T extends Normalize<A> ? 1 : 2
      ? true
      : false
    : false;

export function assertWireRoundTrip(schema: z.ZodType, value: unknown): void {
  assert.deepStrictEqual(schema.parse(JSON.parse(JSON.stringify(value))), value);
  z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" });
}
