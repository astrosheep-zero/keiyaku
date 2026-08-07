import { createHash } from "node:crypto";
import { documentKey, documentSegmentKey, type DocumentKey, type DocumentSegmentKey } from "../core/facts/types.js";
import type { SourceSpan } from "../markdown/types.js";

function digest(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

export function mintDocumentKey(source: string): DocumentKey {
  return documentKey(`document:sha256:${digest(source)}`);
}

export function mintDocumentSegmentKey(source: string, span: SourceSpan): DocumentSegmentKey {
  return documentSegmentKey(`segment:sha256:${digest(source.slice(span.start, span.end))}`);
}
