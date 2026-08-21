import { directChildren, rawSlice } from "../markdown/query.js";
import type { DocumentNode, MarkdownBlockNode, SectionNode } from "../markdown/types.js";

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

function nonblank(document: DocumentNode, node: MarkdownBlockNode): boolean {
  return rawSlice(document, node.span).trim().length > 0;
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

export function decodeRegion(document: DocumentNode, section: SectionNode): readonly string[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length !== 1 || !blocks[0]!.closed || (blocks[0]!.info !== "" && blocks[0]!.info !== "txt")) {
    refusal("Region must contain one closed fence with no info string or the exact 'txt' info string");
  }
  const other = section.children.filter((node) => node !== blocks[0] && nonblank(document, node));
  if (other.length > 0) refusal("Region may contain only its fenced declaration");
  const patterns = blocks[0]!.lines.slice(1, -1).filter((line) => line.trim().length > 0);
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
