import { quotedText } from "./terminal.js";

export function fieldName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name) ? name : quotedText(name);
}

function scalar(value: unknown): string {
  return typeof value === "string" ? quotedText(value) : String(value);
}

/** Opaque values retain exact keys, scalar types, and collection boundaries. */
export function namedValueLines(name: string, value: unknown, indent = ""): readonly string[] {
  const label = `${indent}${fieldName(name)}`;
  if (value === null || typeof value !== "object") return [`${label}  ${scalar(value)}`];
  if (Array.isArray(value)) {
    return [
      `${label}  list (${value.length})`,
      ...value.flatMap((item, index) => namedValueLines(String(index), item, `${indent}  `)),
    ];
  }
  const entries = Object.entries(value);
  return [
    `${label}  object (${entries.length})`,
    ...entries.flatMap(([key, item]) => namedValueLines(key, item, `${indent}  `)),
  ];
}
