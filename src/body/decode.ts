import { mintDocumentKey, mintDocumentSegmentKey } from "./keys.js";
import type { ContractBody, DecodedContractDocument } from "./types.js";
import { decodeDocumentEnvelope } from "./envelope.js";
import { criteriaStructure, decodeCriteria } from "./criteria.js";
import { directChildren, rawSlice, sectionContent } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import { CONTRACT_SECTIONS, RESERVED_SECTIONS, type ContractSectionName } from "./shape.js";
import { decodeRegionOrRefusal, regionStructure } from "./region.js";
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
    ["region", (_document: DocumentNode, section: SectionNode) => regionStructure(section)],
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
    region: decodeRegionOrRefusal(document, requiredSection(sections, "region")),
    criteria: decodeCriteria(document, requiredSection(sections, "criteria")),
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
