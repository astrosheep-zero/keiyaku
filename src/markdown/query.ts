import type { DocumentNode, HeadingNode, MarkdownBlockNode, MarkdownNode, SectionNode, SourceSpan } from "./types.js";

type HeadingLike = SectionNode | HeadingNode;

type DocumentIndex = Readonly<{
  byLevel: ReadonlyMap<number, readonly HeadingLike[]>;
  byTitle: ReadonlyMap<string, readonly HeadingLike[]>;
}>;

export function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function headings(node: DocumentNode | SectionNode | MarkdownBlockNode): readonly HeadingLike[] {
  const result: HeadingLike[] = [];
  if (node.type === "section" || node.type === "heading") result.push(node);
  if (node.type === "document" || node.type === "section") {
    for (const child of node.children) result.push(...headings(child));
  } else if (node.type === "list") {
    for (const item of node.items) {
      for (const child of item.children) result.push(...headings(child));
    }
  }
  return result;
}

export function indexDocument(document: DocumentNode): DocumentIndex {
  const byLevel = new Map<number, HeadingLike[]>();
  const byTitle = new Map<string, HeadingLike[]>();
  for (const node of headings(document)) {
    const level = byLevel.get(node.level) ?? [];
    level.push(node);
    byLevel.set(node.level, level);
    const title = normalizeTitle(node.type === "section" ? node.title : node.text);
    const matches = byTitle.get(title) ?? [];
    matches.push(node);
    byTitle.set(title, matches);
  }
  return { byLevel, byTitle };
}

export function rawSlice(document: DocumentNode, span: SourceSpan): string {
  if (span.start < 0 || span.end < span.start || span.end > document.source.length) {
    throw new RangeError("source span is outside the parsed document");
  }
  return document.source.slice(span.start, span.end);
}

export function sectionContent(document: DocumentNode, section: SectionNode): string {
  return rawSlice(document, { start: section.contentStart, end: section.span.end });
}

export function indexedHeadings(
  index: DocumentIndex,
  query: Readonly<{ title?: string; level?: number }>,
): readonly HeadingLike[] {
  const candidates =
    query.title === undefined
      ? query.level === undefined
        ? []
        : (index.byLevel.get(query.level) ?? [])
      : (index.byTitle.get(normalizeTitle(query.title)) ?? []);
  return query.level === undefined ? candidates : candidates.filter((node) => node.level === query.level);
}

type NodeByType<Type extends MarkdownBlockNode["type"]> = Extract<MarkdownBlockNode, { type: Type }>;

export function directChildren<Type extends MarkdownBlockNode["type"]>(
  node: Extract<MarkdownNode, { children: readonly MarkdownBlockNode[] }>,
  type: Type,
): readonly NodeByType<Type>[] {
  return node.children.filter((child): child is NodeByType<Type> => child.type === type);
}
