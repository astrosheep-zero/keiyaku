import { fromJSONSchema, toJSONSchema, type ZodType } from "zod";

const SCHEMA_JSON_MAX_BYTES = 65_536;

export type JsonSchemaDocument = Readonly<{ readonly [key: string]: unknown }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "~standard") continue;
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

function freezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) freezeValue(entry);
    return Object.freeze(value);
  }
  if (!isPlainObject(value)) return value;
  for (const key of Object.keys(value)) freezeValue(value[key]);
  return Object.freeze(value);
}

function canonicalDocument(value: unknown, label: string): Readonly<{ json: JsonSchemaDocument; jsonText: string }> {
  const sorted = sortValue(value);
  if (!isPlainObject(sorted)) throw new TypeError(`${label} must be a JSON object`);
  const jsonText = JSON.stringify(sorted);
  if (new TextEncoder().encode(jsonText).byteLength > SCHEMA_JSON_MAX_BYTES) {
    throw new TypeError(`${label} exceeds the ${SCHEMA_JSON_MAX_BYTES}-byte bound`);
  }
  return { json: freezeValue(JSON.parse(jsonText)) as JsonSchemaDocument, jsonText };
}

function decodeJsonDocument(schema: unknown): unknown {
  if (typeof schema === "string") {
    try {
      return JSON.parse(schema);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : "JSON Schema is not valid JSON");
    }
  }
  if (isPlainObject(schema) || Array.isArray(schema)) return schema;
  throw new TypeError("JSON Schema must be a JSON object or JSON text");
}

export class Schema<T> {
  private constructor(
    readonly jsonSchema: JsonSchemaDocument,
    readonly jsonText: string,
    readonly decode: (value: unknown) => T,
  ) {
    Object.freeze(this);
  }

  get json(): JsonSchemaDocument {
    return this.jsonSchema;
  }

  static zod<Output>(schema: ZodType<Output>): Schema<Output> {
    const payload = toJSONSchema(schema, { target: "draft-07", unrepresentable: "throw", cycles: "throw" });
    const canonical = canonicalDocument(payload, "Zod JSON Schema");
    return new Schema(canonical.json, canonical.jsonText, (value) => schema.parse(value));
  }

  static json(schema: unknown): Schema<unknown>;
  static json<Output>(schema: unknown, decode: (value: unknown) => Output): Schema<Output>;
  static json<Output>(schema: unknown, decode?: (value: unknown) => Output): Schema<Output> {
    const document = decodeJsonDocument(schema);
    const canonical = canonicalDocument(document, "JSON Schema");
    const decoder =
      decode ??
      ((value: unknown) =>
        fromJSONSchema(JSON.parse(canonical.jsonText) as Parameters<typeof fromJSONSchema>[0]).parse(value) as Output);
    return new Schema(canonical.json, canonical.jsonText, decoder);
  }

  parse(value: unknown): T {
    return this.decode(value);
  }
}

export function JsonSchema(schema: unknown): Schema<unknown> {
  return Schema.json(schema);
}
