import { parseToAST } from "../markdown/parse.js";
import { indexDocument, indexedHeadings, normalizeTitle, rawSlice } from "../markdown/query.js";
import type { DocumentNode, MarkdownBlockNode, SectionNode } from "../markdown/types.js";

function refusal(message: string): never {
  throw new TypeError(message);
}

function nonblankRaw(document: DocumentNode, node: MarkdownBlockNode): boolean {
  return rawSlice(document, node.span).trim().length > 0;
}

function topLevelSections(document: DocumentNode): readonly SectionNode[] {
  return indexedHeadings(indexDocument(document), { level: 2 }).filter(
    (node): node is SectionNode => node.type === "section",
  );
}

export function decodeDocumentEnvelope(
  source: string,
  kind: "arc" | "contract",
): Readonly<{
  document: DocumentNode;
  title: SectionNode;
  sections: ReadonlyMap<string, SectionNode>;
  sectionNodes: readonly SectionNode[];
}> {
  const document = parseToAST(source);
  if (document.frontmatter !== undefined) refusal(`${kind} document may not contain frontmatter`);
  const titles = indexedHeadings(indexDocument(document), { level: 1 }).filter(
    (node): node is SectionNode => node.type === "section",
  );
  if (titles.length !== 1) refusal(`${kind} document requires exactly one H1 title`);
  const title = titles[0]!;
  if (title.children.some((node) => nonblankRaw(document, node))) {
    refusal(`${kind} title may not contain content before the first H2 section`);
  }
  if (document.children.some((node) => node.type !== "section" && nonblankRaw(document, node))) {
    refusal(`${kind} document contains content outside an H1 or H2 section`);
  }
  const sectionNodes = topLevelSections(document);
  const sections = new Map<string, SectionNode>();
  for (const section of sectionNodes) {
    const name = normalizeTitle(section.title);
    if (sections.has(name)) refusal(`duplicate ${kind} section '${section.title}'`);
    sections.set(name, section);
  }
  return { document, title, sections, sectionNodes };
}
