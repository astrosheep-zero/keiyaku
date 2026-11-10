import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Keiyaku, z } from "@astrosheep/keiyaku";

type Schema = boolean | { readonly [key: string]: unknown };
type SchemaObject = Exclude<Schema, boolean>;

function object(value: unknown): value is SchemaObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "boolean" || object(value);
}

function alternatives(schema: SchemaObject): unknown {
  return schema.anyOf ?? schema.oneOf;
}

/** Expand each reference at its use, stopping only recursive ancestor edges. */
export function outputFieldPaths(root: Schema): readonly string[] {
  const paths = new Set<string>();
  const dereference = (schema: Schema): Schema => {
    const visited = new Set<string>();
    while (object(schema) && typeof schema.$ref === "string") {
      const reference = schema.$ref;
      if (!reference.startsWith("#/") || visited.has(reference))
        throw new Error(`Invalid local schema reference: ${reference}`);
      visited.add(reference);
      let value: unknown = root;
      for (const part of reference.slice(2).split("/")) {
        if (!object(value)) throw new Error(`Unresolved schema reference: ${reference}`);
        value = value[part.replaceAll("~1", "/").replaceAll("~0", "~")];
      }
      if (!isSchema(value)) throw new Error(`Unresolved schema reference: ${reference}`);
      schema = value;
    }
    return schema;
  };
  const kinds = (schema: Schema): readonly string[] => {
    schema = dereference(schema);
    if (!object(schema) || !object(schema.properties)) return [];
    const kind = schema.properties.kind;
    if (!object(kind)) return [];
    const value = dereference(kind);
    if (!object(value)) return [];
    if (typeof value.const === "string") return [value.const];
    return Array.isArray(value.enum) ? value.enum.filter((item): item is string => typeof item === "string") : [];
  };
  const visit = (schema: Schema, path: string, ancestors: ReadonlySet<SchemaObject>, tagged: boolean): void => {
    schema = dereference(schema);
    if (!object(schema) || ancestors.has(schema)) return;
    const nested = new Set(ancestors).add(schema);
    const variants = alternatives(schema);
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        if (isSchema(variant)) visit(variant, path, nested, false);
      }
      return;
    }
    const tags = tagged ? [] : kinds(schema);
    if (tags.length > 0) {
      for (const tag of tags) visit(schema, `${path}<${tag}>`, ancestors, true);
      return;
    }
    if (object(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const field = `${path}.${name}`;
        paths.add(field);
        if (isSchema(property)) visit(property, field, nested, false);
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf) {
        if (isSchema(part)) visit(part, path, nested, true);
      }
    }
    if (isSchema(schema.items)) visit(schema.items, `${path}[]`, nested, false);
    if (Array.isArray(schema.prefixItems)) {
      for (const item of schema.prefixItems) {
        if (isSchema(item)) visit(item, `${path}[]`, nested, false);
      }
    }
    if (object(schema.additionalProperties)) visit(schema.additionalProperties, `${path}.*`, nested, false);
  };
  visit(root, "$", new Set(), false);
  return [...paths].sort();
}

function main(): void {
  const destination = process.argv[2];
  if (destination === undefined)
    throw new Error("Usage: node --import tsx scripts/dump-output-schemas.ts <directory> [baseline-schemas.json]");
  const directory = resolve(destination);
  mkdirSync(directory, { recursive: true });
  const baselinePath = process.argv[3];
  const baseline: Record<string, unknown> | undefined =
    baselinePath === undefined ? undefined : JSON.parse(readFileSync(baselinePath, "utf8"));
  const references: Record<string, unknown> = {};
  const fields: Record<string, readonly string[]> = {};
  const sizes: Record<
    string,
    { inlineBytes: number; referenceBytes: number; baselineBytes?: number; reduction?: number }
  > = {};
  for (const [name, verb] of Object.entries(Keiyaku.verbs)) {
    const inline = z.toJSONSchema(verb.output, { io: "input", unrepresentable: "throw" });
    const schema = z.toJSONSchema(verb.output, { io: "input", reused: "ref", unrepresentable: "throw" });
    references[name] = schema;
    fields[name] = outputFieldPaths(schema);
    const inlineBytes = Buffer.byteLength(JSON.stringify(inline));
    const before = baseline?.[name];
    const baselineBytes = before === undefined ? undefined : Buffer.byteLength(JSON.stringify(before));
    sizes[name] = {
      inlineBytes,
      referenceBytes: Buffer.byteLength(JSON.stringify(schema)),
      ...(baselineBytes === undefined ? {} : { baselineBytes, reduction: 1 - inlineBytes / baselineBytes }),
    };
  }
  for (const [filename, value] of Object.entries({
    "schemas.json": references,
    "fields.json": fields,
    "sizes.json": sizes,
  })) {
    writeFileSync(join(directory, filename), JSON.stringify(value, null, 2) + "\n");
  }
  console.log(`${Object.keys(fields).length} native verb schemas and field inventories -> ${directory}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
