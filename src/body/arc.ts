import type { ArcData } from "../core/facts/types.js";
import { parseToAST } from "../markdown/parse.js";
import {
  indexDocument,
  indexedHeadings,
  normalizeTitle,
  rawSlice,
  sectionContent,
} from "../markdown/query.js";
import type { DocumentNode, MarkdownBlockNode, SectionNode } from "../markdown/types.js";

function refusal(message: string): never {
  throw new TypeError(message);
}

function nonblankRaw(document: DocumentNode, node: MarkdownBlockNode): boolean {
  return rawSlice(document, node.span).trim().length > 0;
}

function topLevelSections(document: DocumentNode): readonly SectionNode[] {
  return indexedHeadings(indexDocument(document), { level: 2 })
    .filter((node): node is SectionNode => node.type === "section");
}

function requiredProse(document: DocumentNode, sections: ReadonlyMap<string, SectionNode>, name: "objective" | "brief"): string {
  const section = sections.get(name);
  if (section === undefined) refusal(`arc document is missing ## ${name[0]!.toUpperCase()}${name.slice(1)}`);
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal(`arc section '${section.title}' is empty`);
  return value;
}

export function decodeArcDocument(source: string): Readonly<Omit<ArcData, "seq">> {
  const document = parseToAST(source);
  if (document.frontmatter !== undefined) refusal("arc document may not contain frontmatter");

  const titles = indexedHeadings(indexDocument(document), { level: 1 })
    .filter((node): node is SectionNode => node.type === "section");
  if (titles.length !== 1) refusal("arc document requires exactly one H1 title");
  const title = titles[0]!;
  if (title.title.trim().length === 0) refusal("arc title must be nonblank");
  if (title.children.some((node) => nonblankRaw(document, node))) {
    refusal("arc title may not contain content before the first H2 section");
  }
  const stray = document.children.filter((node) => node.type !== "section" && nonblankRaw(document, node));
  if (stray.length > 0) refusal("arc document contains content outside an H1 or H2 section");

  const sections = new Map<string, SectionNode>();
  for (const section of topLevelSections(document)) {
    const name = normalizeTitle(section.title);
    if (sections.has(name)) refusal(`duplicate arc section '${section.title}'`);
    if (name !== "objective" && name !== "brief") {
      refusal(`arc document does not allow ## ${section.title}`);
    }
    sections.set(name, section);
  }

  return {
    title: title.title,
    objective: requiredProse(document, sections, "objective"),
    brief: requiredProse(document, sections, "brief"),
  };
}
