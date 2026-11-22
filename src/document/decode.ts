import { createHash } from "node:crypto";
import { KeiyakuError } from "../errors.js";
import type { ContractBody, DecodedContractDocument } from "./types.js";
import { decodeDocumentEnvelope } from "./envelope.js";
import { decodeCriteria } from "./criteria.js";
import { sectionContent } from "../markdown/query.js";
import type { DocumentNode, SectionNode, SourceSpan } from "../markdown/types.js";
import { documentKey, documentSegmentKey, type DocumentKey, type DocumentSegmentKey } from "../core/facts/types.js";
import { CONTRACT_SECTIONS, RESERVED_SECTIONS, type ContractSectionName } from "./shape.js";
import { decodeRegionOrRefusal } from "./region.js";
import { decodeVerificationDeclarations, VerificationDocumentError } from "./verification.js";
import type { VerificationDefinition } from "../verification/declaration.js";

type RequiredSectionName = {
  [Name in ContractSectionName]: (typeof CONTRACT_SECTIONS)[Name]["required"] extends true ? Name : never;
}[ContractSectionName];

function refusal(message: string): never {
  throw new KeiyakuError("invalid-input", message);
}

function digest(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function mintDocumentKey(source: string): DocumentKey {
  return documentKey(`document:sha256:${digest(source)}`);
}

function mintDocumentSegmentKey(source: string, span: SourceSpan): DocumentSegmentKey {
  return documentSegmentKey(`segment:sha256:${digest(source.slice(span.start, span.end))}`);
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
  requireSections(sections);
  // sections keeps authored order, so the first reserved heading in the source is refused first.
  for (const name of sections.keys()) {
    if (RESERVED_SECTIONS.has(name)) refusal(`${name} is not a contract Markdown section`);
  }
  const verificationSection = sections.get("verification");
  const body: ContractBody = {
    title: title.title,
    context: prose(document, requiredSection(sections, "context")),
    objective: prose(document, requiredSection(sections, "objective")),
    design: prose(document, requiredSection(sections, "design")),
    region: decodeRegionOrRefusal(document, requiredSection(sections, "region")),
    criteria: decodeCriteria(document, requiredSection(sections, "criteria")),
    verification: verificationSection === undefined ? [] : verification(document, verificationSection, options),
    extensions: [...sections.entries()]
      .filter(([name]) => !Object.hasOwn(CONTRACT_SECTIONS, name))
      .map(([, section]) => {
        const content = sectionContent(document, section);
        if (content.trim().length === 0) refusal(`extension '${section.title}' is empty`);
        return { title: section.title, content };
      }),
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
