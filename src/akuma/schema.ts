import { KeiyakuError } from "../errors.js";
const SCHEMA_JSON_MAX_BYTES = 65_536;

export type JsonSchemaDocument = Readonly<{ readonly [key: string]: unknown }>;
export type JsonSchema = JsonSchemaDocument;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new KeiyakuError("invalid-input", `${path} contains a non-JSON number`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw new KeiyakuError("invalid-input", `${path} contains a non-JSON value`);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
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

export function canonicalDocument(
  value: unknown,
  label = "JSON Schema",
): Readonly<{ json: JsonSchemaDocument; jsonText: string }> {
  assertJsonValue(value, label);
  const sorted = sortValue(value);
  if (!isPlainObject(sorted)) throw new KeiyakuError("invalid-input", `${label} must be a JSON object`);
  const jsonText = JSON.stringify(sorted);
  if (new TextEncoder().encode(jsonText).byteLength > SCHEMA_JSON_MAX_BYTES) {
    throw new KeiyakuError("invalid-input", `${label} exceeds the ${SCHEMA_JSON_MAX_BYTES}-byte bound`);
  }
  return { json: freezeValue(JSON.parse(jsonText)) as JsonSchemaDocument, jsonText };
}
