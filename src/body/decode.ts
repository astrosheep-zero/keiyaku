import { mintDocumentKey, mintDocumentSegmentKey } from "./keys.js";
import type { ContractBody, ContractCriterion, DecodedContractDocument } from "./types.js";
import { parseToAST } from "../markdown/parse.js";
import {
  directChildren,
  indexDocument,
  indexedHeadings,
  normalizeTitle,
  rawSlice,
  sectionContent,
} from "../markdown/query.js";
import type { DocumentNode, MarkdownBlockNode, SectionNode } from "../markdown/types.js";
import { CONTRACT_SECTIONS, RESERVED_SECTIONS, type ContractSectionName } from "./shape.js";
import { decodeRegion, RegionDocumentError } from "./region.js";
import { decodeVerificationDeclarations, VerificationDocumentError } from "./verification.js";
import type { VerificationDefinition } from "../verification/declaration.js";

type RequiredSectionName = {
  [Name in ContractSectionName]: typeof CONTRACT_SECTIONS[Name]["required"] extends true ? Name : never;
}[ContractSectionName];

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

function indexedSections(document: DocumentNode): ReadonlyMap<string, SectionNode> {
  const sections = new Map<string, SectionNode>();
  for (const section of topLevelSections(document)) {
    const title = normalizeTitle(section.title);
    if (sections.has(title)) refusal(`duplicate contract section '${section.title}'`);
    sections.set(title, section);
  }
  return sections;
}

function requireSections(sections: ReadonlyMap<string, SectionNode>): void {
  for (const [name, spec] of Object.entries(CONTRACT_SECTIONS)) {
    if (spec.required && !sections.has(name)) refusal(`contract document is missing ## ${spec.title}`);
  }
}

function requiredSection(sections: ReadonlyMap<string, SectionNode>, name: RequiredSectionName): SectionNode {
  return sections.get(name)!;
}

function prose(document: DocumentNode, section: SectionNode): string {
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal(`contract section '${section.title}' is empty`);
  return value;
}

function region(document: DocumentNode, section: SectionNode): readonly string[] {
  try {
    return decodeRegion(document, section);
  } catch (error) {
    if (error instanceof RegionDocumentError) refusal(error.message);
    throw error;
  }
}

function criteria(document: DocumentNode, section: SectionNode): readonly ContractCriterion[] {
  const headings = directChildren(section, "heading").filter((heading) => heading.level === 3);
  if (headings.length === 0) refusal("Criteria must contain one or more H3 entries");
  const before = rawSlice(document, { start: section.contentStart, end: headings[0]!.span.start });
  if (before.trim().length > 0) refusal("Criteria may contain only H3 entries");
  const seen = new Set<string>();
  return headings.map((heading, index) => {
    const title = heading.text.trim();
    const key = normalizeTitle(title);
    if (seen.has(key)) refusal(`duplicate criterion '${title}'`);
    seen.add(key);
    const body = rawSlice(document, {
      start: heading.span.end,
      end: headings[index + 1]?.span.start ?? section.span.end,
    });
    if (body.trim().length === 0) refusal(`criterion '${title}' is empty`);
    return { title, body };
  });
}

function rejectUnownedBytes(document: DocumentNode, title: SectionNode): void {
  if (title.children.some((node) => nonblankRaw(document, node))) {
    refusal("contract title may not contain content before the first H2 section");
  }
  const stray = document.children.filter((node) => node.type !== "section" && nonblankRaw(document, node));
  if (stray.length > 0) refusal("contract document contains content outside an H1 or H2 section");
}

function verification(document: DocumentNode, section: SectionNode) {
  try {
    return decodeVerificationDeclarations(document, section);
  } catch (error) {
    if (error instanceof VerificationDocumentError) refusal(error.message);
    throw error;
  }
}

export function decodeContractDocument(source: string): DecodedContractDocument {
  let document: DocumentNode;
  try {
    document = parseToAST(source);
  } catch (error) {
    refusal(error instanceof Error ? error.message : String(error));
  }
  if (document.frontmatter !== undefined) refusal("contract document may not contain frontmatter");
  const titles = indexedHeadings(indexDocument(document), { level: 1 })
    .filter((node): node is SectionNode => node.type === "section");
  if (titles.length !== 1) refusal("contract document requires exactly one H1 title");
  const title = titles[0]!;
  rejectUnownedBytes(document, title);
  const sections = indexedSections(document);
  requireSections(sections);
  for (const name of RESERVED_SECTIONS) {
    if (sections.has(name)) refusal(`${name} is not a contract Markdown section`);
  }
  const extensions = [...sections.entries()]
    .filter(([name]) => !Object.hasOwn(CONTRACT_SECTIONS, name))
    .map(([, section]) => {
      const content = sectionContent(document, section);
      if (content.trim().length === 0) refusal(`extension '${section.title}' is empty`);
      return { title: section.title, content };
    });
  const verificationSection = sections.get("verification");
  const body: ContractBody = {
    title: title.title,
    context: prose(document, requiredSection(sections, "context")),
    objective: prose(document, requiredSection(sections, "objective")),
    design: prose(document, requiredSection(sections, "design")),
    region: region(document, requiredSection(sections, "region")),
    criteria: criteria(document, requiredSection(sections, "criteria")),
    verification: verificationSection === undefined ? [] : verification(document, verificationSection),
    extensions,
  };
  const sectionNodes = topLevelSections(document);
  const segments = sectionNodes.map((section) => mintDocumentSegmentKey(document.source, section.span));
  return {
    ...body,
    document: { bytes: source, key: mintDocumentKey(source) },
    segments,
    verificationSegment: verificationSection === undefined
      ? null
      : mintDocumentSegmentKey(document.source, verificationSection.span),
  };
}

export function verificationDefinition(document: DecodedContractDocument): VerificationDefinition | null {
  if (document.verificationSegment === null) return null;
  return {
    segment: document.verificationSegment,
    declarations: document.verification,
  };
}
