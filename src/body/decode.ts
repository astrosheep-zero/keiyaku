import { mintDocumentKey, mintDocumentSegmentKey } from "./keys.js";
import type { ContractBody, ContractCriterion, DecodedContractDocument } from "./types.js";
import { decodeDocumentEnvelope } from "./envelope.js";
import { directChildren, normalizeTitle, rawSlice, sectionContent } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import { CONTRACT_SECTIONS, RESERVED_SECTIONS, type ContractSectionName } from "./shape.js";
import { decodeRegion, RegionDocumentError } from "./region.js";
import { decodeVerificationDeclarations, VerificationDocumentError } from "./verification.js";
import type { VerificationDefinition } from "../verification/declaration.js";

type RequiredSectionName = {
  [Name in ContractSectionName]: (typeof CONTRACT_SECTIONS)[Name]["required"] extends true ? Name : never;
}[ContractSectionName];

function refusal(message: string): never {
  throw new TypeError(message);
}

function requireSections(sections: ReadonlyMap<string, SectionNode>): string[] {
  const diagnostics: string[] = [];
  for (const [name, spec] of Object.entries(CONTRACT_SECTIONS)) {
    if (spec.required && !sections.has(name)) diagnostics.push(`contract document is missing ## ${spec.title}`);
  }
  return diagnostics;
}

function requiredSection(sections: ReadonlyMap<string, SectionNode>, name: RequiredSectionName): SectionNode {
  return sections.get(name)!;
}

function regionStructure(document: DocumentNode, section: SectionNode): string | null {
  const blocks = directChildren(section, "code_block");
  if (blocks.length !== 1 || !blocks[0]!.closed || (blocks[0]!.info !== "" && blocks[0]!.info !== "txt")) {
    return "Region must contain one closed fence with no info string or the exact 'txt' info string";
  }
  const other = section.children.filter(
    (node) => node !== blocks[0] && rawSlice(document, node.span).trim().length > 0,
  );
  return other.length === 0 ? null : "Region may contain only its fenced declaration";
}

function criteriaStructure(document: DocumentNode, section: SectionNode): string | null {
  const headings = directChildren(section, "heading").filter((heading) => heading.level === 3);
  if (headings.length === 0) return "Criteria must contain one or more H3 entries";
  const before = rawSlice(document, { start: section.contentStart, end: headings[0]!.span.start });
  return before.trim().length === 0 ? null : "Criteria may contain only H3 entries";
}

function verificationStructure(document: DocumentNode, section: SectionNode): string | null {
  const blocks = directChildren(section, "code_block");
  if (blocks.length === 0) return "Verification must contain one or more fenced executor declarations";
  const other = section.children.filter(
    (node) => node.type !== "code_block" && rawSlice(document, node.span).trim().length > 0,
  );
  return other.length === 0 ? null : "Verification may contain only fenced executor declarations";
}

// Independent structural rules collect together; each predicate mirrors the
// fence, heading, or reserved-name check its decoder already enforces so a
// document with several violations is refused once with every diagnostic.
function structuralDiagnostics(document: DocumentNode, sections: ReadonlyMap<string, SectionNode>): string[] {
  const diagnostics = requireSections(sections);
  for (const name of RESERVED_SECTIONS) {
    if (sections.has(name)) diagnostics.push(`${name} is not a contract Markdown section`);
  }
  const checks = [
    ["region", regionStructure],
    ["criteria", criteriaStructure],
    ["verification", verificationStructure],
  ] as const;
  for (const [name, check] of checks) {
    const section = sections.get(name);
    if (section === undefined) continue;
    const diagnostic = check(document, section);
    if (diagnostic !== null) diagnostics.push(diagnostic);
  }
  return diagnostics;
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
  const structural = criteriaStructure(document, section);
  if (structural !== null) refusal(structural);
  const headings = directChildren(section, "heading").filter((heading) => heading.level === 3);
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

function verification(document: DocumentNode, section: SectionNode, options: Readonly<{ requireTimeout?: boolean }>) {
  try {
    return decodeVerificationDeclarations(document, section, options);
  } catch (error) {
    if (error instanceof VerificationDocumentError) refusal(error.message);
    throw error;
  }
}

export function decodeContractDocument(
  source: string,
  options: Readonly<{ requireTimeout?: boolean }> = {},
): DecodedContractDocument {
  let envelope: ReturnType<typeof decodeDocumentEnvelope>;
  try {
    envelope = decodeDocumentEnvelope(source, "contract");
  } catch (error) {
    refusal(error instanceof Error ? error.message : String(error));
  }
  const { document, title, sections, sectionNodes } = envelope;
  const structural = structuralDiagnostics(document, sections);
  if (structural.length > 0) refusal(structural.join("\n"));
  const verificationSection = sections.get("verification");
  const extensions = [...sections.entries()]
    .filter(([name]) => !Object.hasOwn(CONTRACT_SECTIONS, name))
    .map(([, section]) => {
      const content = sectionContent(document, section);
      if (content.trim().length === 0) refusal(`extension '${section.title}' is empty`);
      return { title: section.title, content };
    });
  const body: ContractBody = {
    title: title.title,
    context: prose(document, requiredSection(sections, "context")),
    objective: prose(document, requiredSection(sections, "objective")),
    design: prose(document, requiredSection(sections, "design")),
    region: region(document, requiredSection(sections, "region")),
    criteria: criteria(document, requiredSection(sections, "criteria")),
    verification: verificationSection === undefined ? [] : verification(document, verificationSection, options),
    extensions,
  };
  const segments = sectionNodes.map((section) => mintDocumentSegmentKey(document.source, section.span));
  return {
    ...body,
    document: { bytes: source, key: mintDocumentKey(source) },
    segments,
    verificationSegment:
      verificationSection === undefined ? null : mintDocumentSegmentKey(document.source, verificationSection.span),
  };
}

export function verificationDefinition(document: DecodedContractDocument): VerificationDefinition | null {
  if (document.verificationSegment === null) return null;
  return {
    segment: document.verificationSegment,
    declarations: document.verification,
  };
}
