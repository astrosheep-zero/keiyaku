import { MarkdownParseError, type FenceState, type MarkdownToken, type SourceSpan } from "./types.js";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from "yaml";
import type { FrontmatterValue } from "./types.js";

type SourceLine = Readonly<{ text: string; raw: string; span: SourceSpan }>;

type FenceOpening = FenceState & Readonly<{ leadingSpaces: number; info: string }>;

function leadingSpaces(line: string): number {
  let index = 0;
  while (line[index] === " ") index += 1;
  return index;
}

function fenceOpening(line: string): FenceOpening | null {
  const spaces = leadingSpaces(line);
  if (spaces > 3) return null;
  const value = line.slice(spaces);
  const delimiter = value.startsWith("```") ? "`" : value.startsWith("~~~") ? "~" : null;
  if (delimiter === null) return null;
  let length = 0;
  while (value[length] === delimiter) length += 1;
  const info = value.slice(length).trim();
  if (delimiter === "`" && info.includes("`")) return null;
  return { delimiter, length, leadingSpaces: spaces, info };
}

export function fenceClosing(line: string, fence: FenceState): boolean {
  const spaces = leadingSpaces(line);
  if (spaces > 3) return false;
  const value = line.slice(spaces);
  let length = 0;
  while (value[length] === fence.delimiter) length += 1;
  return length >= fence.length && /^[ \t]*$/.test(value.slice(length));
}

function sourceLines(source: string, start: number): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = start;
  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(cursor, end);
    const withoutNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const text = withoutNewline.endsWith("\r") ? withoutNewline.slice(0, -1) : withoutNewline;
    lines.push({ text, raw, span: { start: cursor, end } });
    cursor = end;
  }
  return lines;
}

function header(line: string): Readonly<{ level: number; text: string }> | null {
  let level = 0;
  while (line[level] === "#") level += 1;
  if (level === 0 || (line[level] !== " " && line[level] !== "\t")) return null;
  const text = line
    .slice(level)
    .trim()
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trimEnd();
  return text.length === 0 ? null : { level, text };
}

function listMarker(line: string): Readonly<{
  indent: number;
  marker: string;
  ordered: boolean;
  body: string;
  bodyStart: number;
}> | null {
  const indent = leadingSpaces(line);
  let end = indent;
  let ordered = false;
  const first = line[end];
  if (first === "-" || first === "*" || first === "+") {
    end += 1;
  } else if (first !== undefined && first >= "0" && first <= "9") {
    while (line[end] !== undefined && line[end]! >= "0" && line[end]! <= "9") end += 1;
    if (line[end] !== "." && line[end] !== ")") return null;
    end += 1;
    ordered = true;
  } else {
    return null;
  }
  if (line[end] !== " " && line[end] !== "\t") return null;
  const marker = line.slice(indent, end);
  while (line[end] === " " || line[end] === "\t") end += 1;
  return { indent, marker, ordered, body: line.slice(end), bodyStart: end };
}

function blockquote(line: string): Readonly<{ marker: string; body: string }> | null {
  const spaces = leadingSpaces(line);
  if (spaces > 3 || line[spaces] !== ">") return null;
  let end = spaces + 1;
  if (line[end] === " ") end += 1;
  return { marker: line.slice(0, end), body: line.slice(end) };
}

function validateFrontmatterNode(node: Node | null | undefined): void {
  if (node == null) return;
  if (isAlias(node) || ("anchor" in node && Boolean(node.anchor)) || ("tag" in node && Boolean(node.tag))) {
    throw new MarkdownParseError("frontmatter aliases, anchors, and explicit tags are not supported");
  }
  if (isMap(node)) {
    for (const item of node.items) {
      const pair = item as Pair;
      validateFrontmatterNode(pair.key as Node);
      validateFrontmatterNode(pair.value as Node | null);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) validateFrontmatterNode(item as Node | null);
    return;
  }
  if (!isScalar(node)) throw new MarkdownParseError("unsupported frontmatter value");
}

function frontmatterValue(value: unknown): FrontmatterValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(frontmatterValue);
  if (typeof value === "object" && value !== null) {
    const record: Record<string, FrontmatterValue> = {};
    for (const [key, item] of Object.entries(value)) record[key] = frontmatterValue(item);
    return record;
  }
  throw new MarkdownParseError("unsupported frontmatter value");
}

function parseFrontmatter(source: string): Readonly<Record<string, FrontmatterValue>> {
  const parsed = parseDocument(source, { merge: false, prettyErrors: false, strict: true, uniqueKeys: true });
  if (parsed.errors.length > 0) throw new MarkdownParseError(parsed.errors[0]!.message);
  validateFrontmatterNode(parsed.contents);
  if (!isMap(parsed.contents)) throw new MarkdownParseError("frontmatter must be a mapping");
  for (const item of parsed.contents.items) {
    if (!isScalar(item.key) || typeof item.key.value !== "string") {
      throw new MarkdownParseError("frontmatter keys must be strings");
    }
  }
  return frontmatterValue(parsed.toJS({ mapAsMap: false })) as Readonly<Record<string, FrontmatterValue>>;
}

function frontmatter(lines: readonly SourceLine[]): Readonly<{ token: MarkdownToken; next: number }> | null {
  if (lines[0]?.text.trim() !== "---") return null;
  let closing = 1;
  while (closing < lines.length && lines[closing]!.text.trim() !== "---") closing += 1;
  if (closing >= lines.length) return null;
  const yaml = lines
    .slice(1, closing)
    .map((line) => line.text)
    .join("\n");
  const entries = parseFrontmatter(yaml);
  const selected = lines.slice(0, closing + 1);
  return {
    token: {
      type: "frontmatter",
      raw: selected.map((line) => line.raw).join(""),
      span: { start: selected[0]!.span.start, end: selected.at(-1)!.span.end },
      entries,
    },
    next: closing + 1,
  };
}

export function lexMarkdown(source: string): readonly MarkdownToken[] {
  const bomLength: 0 | 1 = source.startsWith("\uFEFF") ? 1 : 0;
  const lines = sourceLines(source, bomLength);
  const tokens: MarkdownToken[] = [];
  let index = 0;
  const metadata = frontmatter(lines);
  if (metadata !== null) {
    tokens.push(metadata.token);
    index = metadata.next;
  }
  let activeFence: FenceState | undefined;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    const spaces = leadingSpaces(line.text);
    if (activeFence !== undefined) {
      if (fenceClosing(line.text, activeFence)) {
        const opening = fenceOpening(line.text)!;
        tokens.push({ type: "fence", raw: line.raw, span: line.span, ...opening });
        activeFence = undefined;
      } else {
        tokens.push({ type: "text", raw: line.raw, span: line.span, leadingSpaces: spaces });
      }
      continue;
    }
    const opening = fenceOpening(line.text);
    if (opening !== null) {
      tokens.push({ type: "fence", raw: line.raw, span: line.span, ...opening });
      activeFence = { delimiter: opening.delimiter, length: opening.length };
      continue;
    }
    const parsedHeader = spaces === 0 ? header(line.text) : null;
    if (parsedHeader !== null) {
      tokens.push({ type: "header", raw: line.raw, span: line.span, leadingSpaces: spaces, ...parsedHeader });
      continue;
    }
    const parsedList = listMarker(line.text);
    if (parsedList !== null) {
      tokens.push({
        type: "list_marker",
        raw: line.raw,
        span: line.span,
        leadingSpaces: spaces,
        ...parsedList,
        bodyStart: line.span.start + parsedList.bodyStart,
      });
      continue;
    }
    const parsedQuote = blockquote(line.text);
    if (parsedQuote !== null) {
      tokens.push({ type: "blockquote", raw: line.raw, span: line.span, leadingSpaces: spaces, ...parsedQuote });
      continue;
    }
    tokens.push({ type: "text", raw: line.raw, span: line.span, leadingSpaces: spaces });
  }
  return tokens;
}
