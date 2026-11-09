import assert from "node:assert/strict";
import { z } from "zod";

export type Assert<T extends true> = T;

type Normalize<T> = { [K in keyof T]: T[K] };
export type Exact<A, B> =
  (<T>() => T extends Normalize<A> ? 1 : 2) extends <T>() => T extends Normalize<B> ? 1 : 2
    ? (<T>() => T extends Normalize<B> ? 1 : 2) extends <T>() => T extends Normalize<A> ? 1 : 2
      ? [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false
      : false
    : false;

/**
 * The JSON wire type of a native value: handles by their toJSON form, function members absent,
 * undefined-only members absent, and members that may be undefined optional (JSON omits undefined).
 */
type Fn = (...args: never[]) => unknown;
type Dropped<V> = [V] extends [Fn | undefined | void] ? true : false;
type MaybeAbsent<V> = undefined extends V ? true : void extends V ? true : false;
type WireObject<T> = {
  readonly [K in keyof T as Dropped<T[K]> extends true ? never : MaybeAbsent<T[K]> extends true ? never : K]: Wire<
    T[K]
  >;
} & {
  readonly [K in keyof T as Dropped<T[K]> extends true ? never : MaybeAbsent<T[K]> extends true ? K : never]?: Wire<
    Exclude<T[K], undefined | void>
  >;
};
type PlainArray<T extends readonly unknown[]> = number extends T["length"]
  ? "0" extends keyof T
    ? false
    : T extends readonly [...unknown[], unknown]
      ? false
      : true
  : false;
export type Wire<T> = T extends string | number | boolean | bigint | null | undefined
  ? T
  : T extends { toJSON(): infer J }
    ? Wire<J>
    : T extends readonly (infer E)[]
      ? PlainArray<T> extends true
        ? readonly Wire<E>[]
        : { readonly [K in keyof T]: Wire<T[K]> }
      : T extends object
        ? { [K in keyof WireObject<T>]: WireObject<T>[K] }
        : T;

/** The schema parses the value's JSON wire form back to exactly that wire form. */
export function assertWireRoundTrip(schema: z.ZodType, value: unknown): void {
  const wire: unknown = JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(schema.parse(wire), wire);
  z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" });
}
