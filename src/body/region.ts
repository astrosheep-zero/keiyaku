import type { DocumentNode, ListItemNode, MarkdownBlockNode, SectionNode } from "../markdown/types.js";

type RegionSegment =
  | Readonly<{ readonly kind: "deep" }>
  | Readonly<{ readonly kind: "segment"; readonly characters: readonly string[] }>;

type CompiledRegionPattern = Readonly<{
  source: string;
  segments: readonly RegionSegment[];
}>;

type SegmentTransition = Readonly<{
  readonly next: number;
  readonly character: string | null;
}>;

export class RegionDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionDocumentError";
  }
}

function refusal(message: string): never {
  throw new RegionDocumentError(message);
}

function compileSegment(segment: string, pattern: string): RegionSegment {
  if (segment === "**") return { kind: "deep" };
  if (segment.includes("**")) {
    refusal(`Region pattern '${pattern}' may use ** only as a complete segment`);
  }
  return { kind: "segment", characters: Array.from(segment) };
}

function compileRegionPattern(pattern: string): CompiledRegionPattern {
  if (pattern.length === 0) refusal("Region path patterns must be nonblank");
  if (/[\r\n]/.test(pattern)) refusal(`Region pattern '${pattern}' must occupy one line`);
  if (/[!\[\]{}]/.test(pattern)) refusal(`Region pattern '${pattern}' contains a forbidden glob form`);
  if (pattern.startsWith("/")) refusal(`Region pattern '${pattern}' must be repository-relative`);
  if (pattern.includes("..")) refusal(`Region pattern '${pattern}' may not contain ..`);
  const segments = pattern.split("/");
  const directory = pattern.endsWith("/");
  if (segments.some((segment, index) => segment.length === 0 && !(directory && index === segments.length - 1))) {
    refusal(`Region pattern '${pattern}' may not contain an empty segment`);
  }
  const source = directory ? `${pattern}**` : pattern;
  const canonical = directory ? [...segments.slice(0, -1), "**"] : segments;
  return { source, segments: canonical.map((segment) => compileSegment(segment, pattern)) };
}

export function assertRegionPattern(pattern: string): string {
  return compileRegionPattern(pattern).source;
}

function segmentTransition(characters: readonly string[], index: number): SegmentTransition | null {
  const character = characters[index];
  if (character === undefined) return null;
  if (character === "*") return { next: index, character: null };
  if (character === "?") return { next: index + 1, character: null };
  return { next: index + 1, character };
}

function compatible(left: SegmentTransition, right: SegmentTransition): boolean {
  return left.character === null || right.character === null || left.character === right.character;
}

function segmentsOverlap(left: readonly string[], right: readonly string[]): boolean {
  type State = readonly [number, number, boolean];
  const queue: State[] = [[0, 0, false]];
  const visited = new Set<string>();
  let cursor = 0;

  while (cursor < queue.length) {
    const [leftIndex, rightIndex, consumed] = queue[cursor++]!;
    const key = `${leftIndex}:${rightIndex}:${consumed}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length && consumed) return true;

    if (left[leftIndex] === "*") queue.push([leftIndex + 1, rightIndex, consumed]);
    if (right[rightIndex] === "*") queue.push([leftIndex, rightIndex + 1, consumed]);

    const leftTransition = segmentTransition(left, leftIndex);
    const rightTransition = segmentTransition(right, rightIndex);
    if (leftTransition !== null && rightTransition !== null && compatible(leftTransition, rightTransition)) {
      queue.push([leftTransition.next, rightTransition.next, true]);
    }
  }

  return false;
}

function patternsOverlap(left: readonly RegionSegment[], right: readonly RegionSegment[]): boolean {
  type State = readonly [number, number];
  const queue: State[] = [[0, 0]];
  const visited = new Set<string>();
  let cursor = 0;

  while (cursor < queue.length) {
    const [leftIndex, rightIndex] = queue[cursor++]!;
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) return true;

    const leftSegment = left[leftIndex];
    const rightSegment = right[rightIndex];
    if (leftSegment?.kind === "deep") queue.push([leftIndex + 1, rightIndex]);
    if (rightSegment?.kind === "deep") queue.push([leftIndex, rightIndex + 1]);
    if (leftSegment === undefined || rightSegment === undefined) continue;

    if (leftSegment.kind === "deep") {
      queue.push([leftIndex, rightSegment.kind === "deep" ? rightIndex : rightIndex + 1]);
      continue;
    }
    if (rightSegment.kind === "deep") {
      queue.push([leftIndex + 1, rightIndex]);
      continue;
    }
    if (segmentsOverlap(leftSegment.characters, rightSegment.characters)) {
      queue.push([leftIndex + 1, rightIndex + 1]);
    }
  }

  return false;
}

const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;

function nonblank(line: string): boolean {
  return line.trim().length > 0;
}

/** The AST has no table, thematic-break, or HTML block kind, so the Region boundary classifies that prose itself. */
function foreignProseKind(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (THEMATIC_BREAK.test(line)) return "thematic break";
    if (/^ {0,3}</u.test(line)) return "HTML";
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index - 1]!.includes("|") && TABLE_DELIMITER.test(lines[index]!)) return "table";
  }
  return null;
}

function nodeKind(node: MarkdownBlockNode): string {
  return node.type.replaceAll("_", " ");
}

function article(kind: string): string {
  return kind === "HTML" || /^[aeiou]/iu.test(kind) ? "an" : "a";
}

function itemLines(item: ListItemNode): string[] {
  const lines: string[] = [];
  for (const child of item.children) {
    if (child.type === "text") lines.push(...child.lines);
    else if (child.type === "list") for (const nested of child.items) lines.push(...itemLines(nested));
  }
  return lines.filter(nonblank);
}

/**
 * Structural refusals are separate from pattern compilation so a caller may aggregate every independent failure.
 * The three authoring forms — fenced lines, list items, and bare paragraph lines — union freely. Blank lines never
 * count, and an info string beyond the exact `txt` still implies executable content that belongs to Verification.
 */
export function regionStructure(section: SectionNode): string | null {
  for (const node of section.children) {
    if (node.type === "code_block") {
      if (!node.closed) return "Region fence must be closed";
      if (node.info !== "" && node.info !== "txt") {
        return "Region fence may not carry an info string other than the exact 'txt'";
      }
      continue;
    }
    if (node.type === "list") continue;
    if (node.type === "text") {
      const foreign = foreignProseKind(node.lines);
      if (foreign !== null) return `Region may not contain ${article(foreign)} ${foreign} block`;
      continue;
    }
    const kind = nodeKind(node);
    return `Region may not contain ${article(kind)} ${kind} block`;
  }
  return null;
}

function regionPatterns(section: SectionNode): readonly string[] {
  const patterns: string[] = [];
  for (const node of section.children) {
    if (node.type === "code_block") patterns.push(...node.lines.slice(1, -1).filter(nonblank));
    else if (node.type === "list") for (const item of node.items) patterns.push(...itemLines(item));
    else if (node.type === "text") patterns.push(...node.lines.filter(nonblank));
  }
  return patterns;
}

/** A whitespace-bearing pattern is almost certainly strayed prose; bind warns and proceeds rather than rejecting. */
export function regionWarnings(patterns: readonly string[]): readonly string[] {
  return patterns
    .filter((pattern) => /\s/u.test(pattern))
    .map((pattern) => `Region pattern '${pattern}' contains whitespace and will never match a path`);
}

export function decodeRegion(_document: DocumentNode, section: SectionNode): readonly string[] {
  const structural = regionStructure(section);
  if (structural !== null) refusal(structural);
  const patterns = regionPatterns(section);
  if (patterns.length === 0) refusal("Region must declare at least one path pattern");
  return patterns.map((pattern) => compileRegionPattern(pattern).source);
}

export function regionsOverlap(mine: readonly string[], theirs: readonly string[]): readonly [string, string][] {
  const myPatterns = mine.map((pattern) => compileRegionPattern(pattern));
  const theirPatterns = theirs.map((pattern) => compileRegionPattern(pattern));
  const overlaps: [string, string][] = [];
  for (const myPattern of myPatterns) {
    for (const theirPattern of theirPatterns) {
      if (patternsOverlap(myPattern.segments, theirPattern.segments)) {
        overlaps.push([myPattern.source, theirPattern.source]);
      }
    }
  }
  return overlaps;
}
