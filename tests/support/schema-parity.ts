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

/** The JSON wire type of a native value: handles by their toJSON form, function members absent. */
export type Wire<T> = T extends { toJSON(): infer J }
  ? Wire<J>
  : T extends readonly unknown[]
    ? { [K in keyof T]: Wire<T[K]> }
    : T extends object
      ? { [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: Wire<T[K]> }
      : T;

/** The schema parses the value's JSON wire form back to exactly that wire form. */
export function assertWireRoundTrip(schema: z.ZodType, value: unknown): void {
  const wire: unknown = JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(schema.parse(wire), wire);
  z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" });
}
