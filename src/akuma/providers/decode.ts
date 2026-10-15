import type { SearchScope, ToolCall } from "../provider.js";

/**
 * Native payload decoders shared by provider event adaptation. Every adapter
 * reads the same untrusted native shapes; these are the only places that decide
 * what a present value means, so each keeps one exact predicate and return.
 */

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

/** A string with non-blank trim, returned as supplied. */
export function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A string with non-blank trim, returned trimmed. */
export function trimmed(value: unknown): string | undefined {
  const text = nonblank(value);
  return text === undefined ? undefined : text.trim();
}

/** A nonempty string, returned as supplied; internal whitespace stays content. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Any string, including the empty one; absence stays absence. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The observed text of one native result value: a plain string, or its text
 * blocks joined in native order. A value carrying no text block observed no
 * text, while a present empty string is observed and empty.
 */
export function observedTextContent(content: unknown): string | undefined {
  const single = stringValue(content);
  if (single !== undefined) return single;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap((block) => {
    const value = object(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
  return blocks.length === 0 ? undefined : blocks.join("");
}

/** A one-based line number. */
export function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

export function nonnegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One neutral search call carrying only the bounds the native input supplied. */
export function searchToolCall(
  query: string,
  scope: SearchScope | undefined,
  bounds: Readonly<{ path?: string | undefined; glob?: string | undefined }> = {},
): Extract<ToolCall, { kind: "search" }> {
  return {
    kind: "search",
    query,
    ...(scope === undefined ? {} : { scope }),
    ...(bounds.path === undefined ? {} : { path: bounds.path }),
    ...(bounds.glob === undefined ? {} : { glob: bounds.glob }),
  };
}
