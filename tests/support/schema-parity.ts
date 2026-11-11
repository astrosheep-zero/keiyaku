import assert from "node:assert/strict";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

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

/** The schema parses the value's JSON wire form back to exactly that wire form. */
export function assertWireRoundTrip(schema: z.ZodType, value: unknown): void {
  const wire: unknown = JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(schema.parse(wire), wire);
  z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" });
}

/** Test both the owner declaration and the JSON Schema consumed by an MCP client. */
export function assertWireConformance(schema: z.ZodType, value: unknown, expected = true): void {
  const wire: unknown = JSON.parse(JSON.stringify(value));
  assert.equal(schema.safeParse(wire).success, expected);
  const schemaWire = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input", reused: "ref" })));
  const result = new AjvJsonSchemaValidator().getValidator(schemaWire)(wire);
  assert.equal(result.valid, expected, result.errorMessage);
}
