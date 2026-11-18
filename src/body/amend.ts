import { KeiyakuError } from "../errors.js";
import type { ContractBody, DecodedContractDocument } from "./types.js";
import { decodeVerificationDeclarations, VerificationDocumentError } from "./verification.js";
import { parseToAST } from "../markdown/parse.js";
import { indexDocument, indexedHeadings, normalizeTitle, sectionContent } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import { nonblankRaw as nonblank, topLevelSections as sections } from "./envelope.js";
import { decodeRegionOrRefusal } from "./region.js";
import { contractSectionName, RESERVED_SECTIONS } from "./shape.js";
import { renderAmendedContractBody } from "./render.js";
import { decodeCriteria } from "./criteria.js";

type Operation = Readonly<{
  kind: "Add" | "Update" | "Replace" | "Append" | "Remove" | "Set";
  target: string;
  name: ReturnType<typeof contractSectionName>;
  normalized: string;
  section: SectionNode;
}>;

type WorkingBody = {
  -readonly [Key in keyof ContractBody]: Key extends "criteria" | "extensions"
    ? Array<ContractBody[Key][number]>
    : ContractBody[Key];
};

function refusal(message: string): never {
  throw new KeiyakuError("invalid-input", message);
}

function operationSections(document: DocumentNode): readonly Operation[] {
  if (document.frontmatter !== undefined) refusal("amend operations may not contain frontmatter");
  const openedBy = document.children.find((node) => nonblank(document, node));
  const heading = openedBy?.type === "section" && openedBy.level === 1 ? openedBy : undefined;
  if (indexedHeadings(indexDocument(document), { level: 1 }).length > (heading === undefined ? 0 : 1))
    refusal("amend operations may contain H2 sections only");
  const outside = [...document.children, ...(heading?.children ?? [])];
  if (outside.some((node) => node.type !== "section" && nonblank(document, node)))
    refusal("amend operations contain bytes outside H2 sections");
  return sections(document).map((section) => {
    const title = section.title.trim();
    const match = /^(Add|Update|Replace|Append|Remove):[ ]+(.+)$/.exec(title);
    const target = match ? match[2]!.trim() : title;
    return {
      kind: match ? (match[1] as Operation["kind"]) : "Set",
      target,
      name: contractSectionName(target),
      normalized: normalizeTitle(target),
      section,
    };
  });
}

function prose(document: DocumentNode, section: SectionNode, label: string): string {
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal(`${label} operation body must be nonblank`);
  return value;
}

function verification(document: DocumentNode, section: SectionNode): ContractBody["verification"] {
  try {
    return decodeVerificationDeclarations(document, section, { requireTimeout: true });
  } catch (error) {
    if (error instanceof VerificationDocumentError) refusal(error.message);
    throw error;
  }
}

function appendText(current: string, addition: string): string {
  return `${current.trimEnd()}\n\n${addition.trim()}\n`;
}

function applyExtension(body: WorkingBody, operation: Operation, document: DocumentNode): void {
  const { kind, target, normalized, section } = operation;
  const index = body.extensions.findIndex((entry) => normalizeTitle(entry.title) === normalized);
  const extension = body.extensions[index];
  if (kind === "Add" || (kind === "Set" && extension?.title !== target)) {
    if (RESERVED_SECTIONS.has(normalized)) refusal(`${normalized} is not a contract Markdown section`);
    if (extension !== undefined) refusal(`extension already exists '${target}'`);
    body.extensions.push({ title: target, content: prose(document, section, "extension") });
    return;
  }
  if (extension === undefined || extension.title !== target) refusal(`unknown extension '${target}'`);
  if (kind === "Remove") {
    body.extensions.splice(index, 1);
    return;
  }
  const content = prose(document, section, "extension");
  body.extensions[index] = {
    ...extension,
    content: kind === "Append" ? appendText(extension.content, content) : content,
  };
}

function apply(
  document: DocumentNode,
  operations: readonly Operation[],
  current: ContractBody,
): Readonly<{ body: ContractBody; changed: ReadonlySet<string> }> {
  const body: WorkingBody = { ...current, criteria: [...current.criteria], extensions: [...current.extensions] };
  const changed = new Set<string>();
  for (const operation of operations) {
    const { kind, target, name, normalized, section } = operation;
    if (kind === "Remove" && sectionContent(document, section).trim().length > 0)
      refusal("Remove operation must not have a body");
    changed.add(normalized);
    if (name === null) {
      applyExtension(body, operation, document);
      continue;
    }
    if (kind === "Update" || kind === "Remove") refusal(`unknown extension '${target}'`);
    if (kind === "Add" && name !== "criteria") refusal(`Add does not support ${target}`);
    if (name === "criteria") {
      const criteria = decodeCriteria(document, section, "amend");
      if (kind === "Replace" || kind === "Set") {
        body.criteria = [...criteria];
        continue;
      }
      for (const criterion of criteria) {
        const title = normalizeTitle(criterion.title);
        if (body.criteria.some((entry) => normalizeTitle(entry.title) === title))
          refusal(`${kind} Criteria targets an existing criterion`);
        body.criteria.push(criterion);
      }
    } else if (name === "region" || name === "verification") {
      if (kind === "Append") refusal(`Append does not support ${target}`);
      if (name === "region") body.region = decodeRegionOrRefusal(document, section);
      else body.verification = verification(document, section);
    } else {
      const content = prose(document, section, target);
      body[name] = kind === "Append" ? appendText(body[name], content) : content;
    }
  }
  return { body, changed };
}

function operationKey(operation: Operation): string {
  return `${operation.kind}:${operation.target}`;
}

/** Caller syntax is decoded before any repository observation; current-dependent application stays pure. */
export function prepareAmendDocument(source: string): (current: DecodedContractDocument) => Readonly<{
  document: string;
  changedSections: ReadonlySet<string>;
}> {
  const document = parseToAST(source);
  const operations = operationSections(document);
  if (operations.length === 0) refusal("amend requires at least one H2 operation");
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = operationKey(operation);
    if (seen.has(key)) refusal(`duplicate amend operation '${key}'`);
    seen.add(key);
  }
  return (current) => {
    const result = apply(document, operations, current);
    return {
      document: renderAmendedContractBody(current.document.bytes, result.body, result.changed),
      changedSections: result.changed,
    };
  };
}
