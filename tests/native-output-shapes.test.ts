import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { Keiyaku } from "../src/index.js";

type Schema = Readonly<Record<string, unknown>>;
const node = (value: unknown): Schema | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : undefined;

function resolve(schema: Schema, root: Schema): Schema {
  if (typeof schema.$ref !== "string") return schema;
  assert.ok(schema.$ref.startsWith("#/"), `nonlocal owner schema reference: ${schema.$ref}`);
  let selected: unknown = root;
  for (const part of schema.$ref.slice(2).split("/")) {
    const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    selected = node(selected)?.[key];
  }
  const result = node(selected);
  assert.ok(result, `unresolved owner schema reference: ${schema.$ref}`);
  return resolve(result, root);
}

function objects(schema: Schema, root: Schema): boolean {
  const resolved = resolve(schema, root);
  const alternatives = resolved.oneOf ?? resolved.anyOf;
  return Array.isArray(alternatives)
    ? alternatives.every((value) => {
        const branch = node(value);
        assert.ok(branch, "owner union branch must be a schema");
        return objects(branch, root);
      })
    : resolved.type === "object";
}

for (const [name, verb] of Object.entries(Keiyaku.verbs)) {
  test(`${name}: published root and every root alternative are objects`, () => {
    const schema = z.toJSONSchema(verb.output, { io: "input" });
    assert.equal(objects(schema, schema), true, `${name} has a non-object root alternative`);
  });
}
