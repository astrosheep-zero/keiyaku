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

export class ArcDocumentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArcDocumentError";
    this.code = code;
  }
}

function refusal(code: string, message: string): never {
  throw new ArcDocumentError(code, message);
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
  if (section === undefined) refusal("MISSING_SECTION", `arc document is missing ## ${name[0]!.toUpperCase()}${name.slice(1)}`);
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal("EMPTY_SECTION", `arc section '${section.title}' is empty`);
  return value;
}

/** Decode the closed Markdown grammar for one explicit Arc chapter. */
export function decodeArcDocument(source: string): Readonly<Omit<ArcData, "seq">> {
  const document = parseToAST(source);
  if (document.frontmatter !== undefined) refusal("FRONTMATTER_FORBIDDEN", "arc document may not contain frontmatter");

  const titles = indexedHeadings(indexDocument(document), { level: 1 })
    .filter((node): node is SectionNode => node.type === "section");
  if (titles.length !== 1) refusal("INVALID_TITLE", "arc document requires exactly one H1 title");
  const title = titles[0]!;
  if (title.title.trim().length === 0) refusal("INVALID_TITLE", "arc title must be nonblank");
  if (title.children.some((node) => nonblankRaw(document, node))) {
    refusal("UNOWNED_DOCUMENT_BYTES", "arc title may not contain content before the first H2 section");
  }
  const stray = document.children.filter((node) => node.type !== "section" && nonblankRaw(document, node));
  if (stray.length > 0) refusal("UNOWNED_DOCUMENT_BYTES", "arc document contains content outside an H1 or H2 section");

  const sections = new Map<string, SectionNode>();
  for (const section of topLevelSections(document)) {
    const name = normalizeTitle(section.title);
    if (sections.has(name)) refusal("DUPLICATE_SECTION", `duplicate arc section '${section.title}'`);
    if (name !== "objective" && name !== "brief") {
      refusal("UNEXPECTED_SECTION", `arc document does not allow ## ${section.title}`);
    }
    sections.set(name, section);
  }

  return {
    title: title.title,
    objective: requiredProse(document, sections, "objective"),
    brief: requiredProse(document, sections, "brief"),
  };
}
