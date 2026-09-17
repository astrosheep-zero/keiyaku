import { toJSONSchema, type ZodType } from "zod";

const SCHEMA_JSON_MAX_BYTES = 65_536;

/**
 * Keywords a provider answer contract may carry. Provider failures from
 * fragile constraints are expensive to diagnose, so the seam refuses any
 * projected document that steps outside simple JSON shape vocabulary.
 */
const SIMPLE_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "additionalProperties",
  "description",
  "title",
  "$schema",
  "$defs",
  "$ref",
]);

export type JsonSchemaDocument = Readonly<{ readonly [key: string]: unknown }>;
export type JsonSchema = JsonSchemaDocument;

export type StandardResult<Output> =
  | Readonly<{ readonly value: Output; readonly issues?: undefined }>
  | Readonly<{ readonly issues: readonly Readonly<{ readonly message: string }>[] }>;

/** Structural Standard Schema v1 marker; no runtime dependency on a library. */
export type StandardSchemaV1<Output = unknown> = Readonly<{
  readonly "~standard": Readonly<{
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: Readonly<{ readonly input: unknown; readonly output: Output }> | undefined;
    readonly jsonSchema?:
      | Readonly<{ readonly output: (options: Readonly<{ readonly target: string }>) => unknown }>
      | undefined;
  }>;
}>;

/** The schema forms a Tell answer contract accepts. */
export type SchemaLike<T> = Schema<T> | StandardSchemaV1<T>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} contains a non-JSON number`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw new TypeError(`${path} contains a non-JSON value`);
}

/**
 * Walk every subschema position and refuse a keyword outside the blessed shape
 * vocabulary. Property names and enum/const data are not keywords, so their
 * keys are never judged.
 */
function assertSimpleSchema(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be a JSON Schema object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!SIMPLE_SCHEMA_KEYWORDS.has(key)) {
      throw new TypeError(
        `provider answer contract uses unsupported JSON Schema keyword "${key}" at ${path}; ` +
          "provider answer contracts carry simple shapes only",
      );
    }
    if (key === "properties" || key === "$defs") {
      for (const [name, subschema] of Object.entries(entry as Record<string, unknown>)) {
        assertSimpleSchema(subschema, `${path}.${key}.${name}`);
      }
    } else if (key === "items") {
      if (Array.isArray(entry))
        entry.forEach((subschema, index) => assertSimpleSchema(subschema, `${path}.items[${index}]`));
      else assertSimpleSchema(entry, `${path}.items`);
    } else if (key === "anyOf") {
      (entry as unknown[]).forEach((subschema, index) => assertSimpleSchema(subschema, `${path}.anyOf[${index}]`));
    } else if (key === "additionalProperties" && typeof entry !== "boolean") {
      assertSimpleSchema(entry, `${path}.additionalProperties`);
    }
  }
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
  assertJsonValue(value, label);
  const sorted = sortValue(value);
  if (!isPlainObject(sorted)) throw new TypeError(`${label} must be a JSON object`);
  const jsonText = JSON.stringify(sorted);
  if (new TextEncoder().encode(jsonText).byteLength > SCHEMA_JSON_MAX_BYTES) {
    throw new TypeError(`${label} exceeds the ${SCHEMA_JSON_MAX_BYTES}-byte bound`);
  }
  return { json: freezeValue(JSON.parse(jsonText)) as JsonSchemaDocument, jsonText };
}

function standardMarker<Output>(value: unknown): StandardSchemaV1<Output>["~standard"] {
  const marker =
    typeof value === "object" && value !== null ? (value as { "~standard"?: unknown })["~standard"] : undefined;
  if (
    typeof marker !== "object" ||
    marker === null ||
    (marker as { version?: unknown }).version !== 1 ||
    typeof (marker as { vendor?: unknown }).vendor !== "string" ||
    typeof (marker as { validate?: unknown }).validate !== "function"
  ) {
    throw new TypeError("schema must be a Schema or a Standard Schema v1 value");
  }
  return marker as unknown as StandardSchemaV1<Output>["~standard"];
}

/** Project a Standard Schema value to a JSON Schema document, or refuse honestly. */
function projectStandardSchema<Output>(
  value: StandardSchemaV1<Output>,
  marker: StandardSchemaV1<Output>["~standard"],
): unknown {
  if (marker.vendor === "zod") {
    return toJSONSchema(value as unknown as ZodType, { target: "draft-07", unrepresentable: "throw", cycles: "throw" });
  }
  const converter = marker.jsonSchema;
  if (converter !== undefined && typeof converter.output === "function") {
    return converter.output({ target: "draft-07" });
  }
  const method = (value as { readonly toJSONSchema?: unknown }).toJSONSchema;
  if (typeof method === "function") {
    return (method as (options: Readonly<{ readonly target: string }>) => unknown).call(value, { target: "draft-07" });
  }
  throw new TypeError(
    `schema vendor "${marker.vendor}" does not carry a JSON Schema projection; ` +
      "pass a JSON Schema document and decoder to Schema.json instead",
  );
}

function decodeStandard<Output>(value: unknown, marker: StandardSchemaV1<Output>["~standard"]): Output {
  const result = marker.validate(value);
  if (result instanceof Promise || (typeof result === "object" && result !== null && "then" in result)) {
    throw new TypeError(`schema vendor "${marker.vendor}" validates asynchronously`);
  }
  if ("issues" in result && result.issues !== undefined) {
    const detail = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(detail.length === 0 ? "Standard Schema validation failed" : detail);
  }
  return (result as Readonly<{ value: Output }>).value;
}

export class Schema<T> {
  private constructor(
    readonly jsonSchema: JsonSchemaDocument,
    readonly decode: (value: unknown) => T,
  ) {
    Object.freeze(this);
  }

  static zod<Output>(schema: ZodType<Output>): Schema<Output> {
    const payload = toJSONSchema(schema, { target: "draft-07", unrepresentable: "throw", cycles: "throw" });
    assertSimpleSchema(payload, "$");
    const canonical = canonicalDocument(payload, "Zod JSON Schema");
    return new Schema(canonical.json, (value) => schema.parse(value));
  }

  static json<Output>(schema: JsonSchemaDocument, decode: (value: unknown) => Output): Schema<Output> {
    if (typeof decode !== "function") throw new TypeError("JSON Schema decoder must be a function");
    const document = schema;
    const canonical = canonicalDocument(document, "JSON Schema");
    return new Schema(canonical.json, decode);
  }

  /**
   * Bless a Standard Schema v1 value as a real Schema: validate the marker,
   * project a JSON Schema document, refuse shapes outside the simple
   * vocabulary, and decode at the boundary. The class owns this path so every
   * normalized schema is born through the constructor rather than around it.
   */
  static standard<Output>(value: StandardSchemaV1<Output>): Schema<Output> {
    const marker = standardMarker<Output>(value);
    const payload = projectStandardSchema(value, marker);
    assertSimpleSchema(payload, "$");
    const canonical = canonicalDocument(payload, `${marker.vendor} JSON Schema`);
    return new Schema(canonical.json, (input: unknown) => decodeStandard(input, marker));
  }
}

/**
 * Normalize a Tell answer contract to the internal Schema. The package's own
 * Schema passes through; anything else delegates to the class's own blessing
 * path, so inferred output types keep flowing from a genuine Schema instance.
 */
export function schemaFromStandard<T>(value: SchemaLike<T>): Schema<T> {
  if (value instanceof Schema) return value;
  return Schema.standard(value);
}

/** Internal neutral serialization for Heart/provider forwarding. */
export function schemaJsonText(schema: Schema<unknown>): string {
  return JSON.stringify(schema.jsonSchema);
}
