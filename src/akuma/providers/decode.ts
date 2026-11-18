import type { ToolCall, ToolResult } from "../provider.js";

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
  return stringValue(content) ?? observedTextBlocks(content, "");
}

export function observedTextBlocks(content: unknown, separator: string): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap((block) => {
    const value = object(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
  return blocks.length === 0 ? undefined : blocks.join(separator);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A native read with only valid, supplied bounds. */
export function readToolCall(path: unknown, offset?: unknown, limit?: unknown): ToolCall | undefined {
  const supplied = nonblank(path);
  if (supplied === undefined) return undefined;
  const start = integer(offset);
  const count = integer(limit);
  return {
    kind: "read",
    path: supplied,
    ...(start !== undefined && start >= 1 ? { offset: start } : {}),
    ...(count !== undefined && count >= 1 ? { limit: count } : {}),
  };
}

type FileChange = Extract<ToolCall, { kind: "fileChange" }>["changes"][number];

export function observedChange(
  op: FileChange["op"],
  path: string,
  patch?: string,
  diffstat?: FileChange["diffstat"],
): FileChange {
  return {
    op,
    path,
    ...(patch === undefined ? {} : { patch }),
    ...(diffstat === undefined ? {} : { diffstat }),
  };
}

export function fileChangeToolCall(op: FileChange["op"], path: string | undefined): ToolCall | undefined {
  return path === undefined ? undefined : { kind: "fileChange", changes: [{ op, path }] };
}

export function attachObservedPatch(
  call: ToolCall,
  patch: string | undefined,
  diffstat?: FileChange["diffstat"],
): ToolCall {
  if (patch === undefined || call.kind !== "fileChange") return call;
  const [change] = call.changes;
  if (change === undefined || call.changes.length !== 1) return call;
  return { kind: "fileChange", changes: [observedChange(change.op, change.path, patch, diffstat)] };
}

export function diffCounts(added: unknown, removed: unknown): FileChange["diffstat"] {
  const additions = integer(added);
  const deletions = integer(removed);
  if (additions === undefined || deletions === undefined || additions < 0 || deletions < 0) return undefined;
  return { added: additions, removed: deletions };
}

export function toolResult(
  status: ToolResult["status"],
  output?: string,
  message?: string,
  nativeExit?: unknown,
): ToolResult {
  const exitCode = integer(nativeExit);
  return {
    status: exitCode !== undefined && exitCode !== 0 ? "error" : status,
    ...(output === undefined ? {} : { output }),
    ...(message === undefined ? {} : { message }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

/** One neutral search call carrying only the bounds the native input supplied. */
export function searchToolCall(
  query: unknown,
  scope: unknown,
  bounds: Readonly<{ path?: unknown; glob?: unknown }> = {},
): Extract<ToolCall, { kind: "search" }> | undefined {
  const supplied = nonblank(query);
  if (supplied === undefined) return undefined;
  const path = nonblank(bounds.path);
  const glob = nonblank(bounds.glob);
  return {
    kind: "search",
    query: supplied,
    ...(scope === "content" || scope === "files" || scope === "web" ? { scope } : {}),
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
  };
}
