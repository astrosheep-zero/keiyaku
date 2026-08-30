import type { ContractBody, ContractCriterion, ContractExtension, DecodedContractDocument } from "./types.js";
import type { VerificationDeclaration } from "../verification/declaration.js";
import { decodeVerificationDeclarations, VerificationDocumentError } from "./verification.js";
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
import { decodeRegion, RegionDocumentError } from "./region.js";
import { contractSectionName, RESERVED_SECTIONS } from "./shape.js";
import { renderAmendedContractBody } from "./render.js";

type Operation = Readonly<{
  kind: "Add" | "Update" | "Replace" | "Append" | "Remove" | "Set";
  target: string;
  section: SectionNode;
}>;

type MutableBody = {
  title: string;
  context: string;
  objective: string;
  design: string;
  region: readonly string[];
  criteria: ContractCriterion[];
  verification: readonly VerificationDeclaration[];
  extensions: Array<ContractExtension | undefined>;
  criterionIndexes: Map<string, number>;
  extensionIndexes: Map<string, number>;
};

function refusal(message: string): never {
  throw new TypeError(message);
}

function nonblank(document: DocumentNode, node: MarkdownBlockNode): boolean {
  return rawSlice(document, node.span).trim().length > 0;
}

function sections(document: DocumentNode): readonly SectionNode[] {
  return indexedHeadings(indexDocument(document), { level: 2 }).filter(
    (node): node is SectionNode => node.type === "section",
  );
}

function operationSections(document: DocumentNode): readonly Operation[] {
  if (document.frontmatter !== undefined) refusal("amend operations may not contain frontmatter");
  if (indexedHeadings(indexDocument(document), { level: 1 }).length > 0)
    refusal("amend operations may contain H2 sections only");
  if (document.children.some((node) => node.type !== "section" && nonblank(document, node))) {
    refusal("amend operations contain bytes outside H2 sections");
  }
  return sections(document).map((section) => {
    const title = section.title.trim();
    const match = /^(Add|Update|Replace|Append|Remove):[ ]+(.+)$/.exec(title);
    return match
      ? { kind: match[1] as Operation["kind"], target: match[2]!.trim(), section }
      : { kind: "Set", target: title, section };
  });
}

function prose(document: DocumentNode, section: SectionNode, label: string): string {
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal(`${label} operation body must be nonblank`);
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
  if (headings.length === 0) refusal("Criteria operation must contain one or more H3 entries");
  const before = rawSlice(document, { start: section.contentStart, end: headings[0]!.span.start });
  if (before.trim().length > 0) refusal("Criteria operation may contain only H3 entries");
  const seen = new Set<string>();
  return headings.map((heading, index) => {
    const title = heading.text.trim();
    const key = normalizeTitle(title);
    if (title.length === 0 || seen.has(key)) refusal("criteria operation contains duplicate or empty titles");
    seen.add(key);
    const body = rawSlice(document, {
      start: heading.span.end,
      end: headings[index + 1]?.span.start ?? section.span.end,
    });
    if (body.trim().length === 0) refusal(`criterion '${title}' operation body is empty`);
    return { title, body };
  });
}

function verification(document: DocumentNode, section: SectionNode): readonly VerificationDeclaration[] {
  try {
    return decodeVerificationDeclarations(document, section);
  } catch (error) {
    if (error instanceof VerificationDocumentError) refusal(error.message);
    throw error;
  }
}

function cloneBody(body: ContractBody): MutableBody {
  const criteria = body.criteria.map((criterion) => ({ ...criterion }));
  const extensions = body.extensions.map((extension) => ({ ...extension }));
  const criterionIndexes = new Map<string, number>();
  criteria.forEach((criterion, index) => {
    const key = normalizeTitle(criterion.title);
    if (!criterionIndexes.has(key)) criterionIndexes.set(key, index);
  });
  const extensionIndexes = new Map<string, number>();
  extensions.forEach((extension, index) => {
    const key = normalizeTitle(extension.title);
    if (!extensionIndexes.has(key)) extensionIndexes.set(key, index);
  });
  return {
    title: body.title,
    context: body.context,
    objective: body.objective,
    design: body.design,
    region: [...body.region],
    criteria,
    verification: body.verification.map((declaration) => ({ ...declaration })),
    extensions,
    criterionIndexes,
    extensionIndexes,
  };
}

function completeBody(body: MutableBody): ContractBody {
  return {
    title: body.title,
    context: body.context,
    objective: body.objective,
    design: body.design,
    region: body.region,
    criteria: body.criteria,
    verification: body.verification,
    extensions: body.extensions.filter((extension): extension is ContractExtension => extension !== undefined),
  };
}

function extensionIndex(body: MutableBody, target: string): number {
  const index = body.extensionIndexes.get(normalizeTitle(target));
  return index !== undefined && body.extensions[index]?.title === target ? index : -1;
}

function criterionIndex(body: MutableBody, target: string): number {
  const key = normalizeTitle(target);
  return body.criterionIndexes.get(key) ?? -1;
}

function appendText(current: string, addition: string): string {
  return `${current.trimEnd()}\n\n${addition.trim()}\n`;
}

function requireEmpty(document: DocumentNode, section: SectionNode): void {
  if (sectionContent(document, section).trim().length > 0) refusal("Remove operation must not have a body");
}

function alteredText(body: MutableBody, target: "context" | "objective" | "design", value: string): void {
  body[target] = value;
}

function applyRemove(body: MutableBody, operation: Operation, document: DocumentNode): void {
  requireEmpty(document, operation.section);
  const index = extensionIndex(body, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  body.extensions[index] = undefined;
  body.extensionIndexes.delete(normalizeTitle(operation.target));
}

function applyUpdate(body: MutableBody, operation: Operation, document: DocumentNode): void {
  const index = extensionIndex(body, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  const extension = body.extensions[index]!;
  body.extensions[index] = { ...extension, content: prose(document, operation.section, "extension") };
}

function addedCriteria(body: MutableBody, operation: Operation, document: DocumentNode): void {
  const added = criteria(document, operation.section);
  if (added.some((candidate) => criterionIndex(body, candidate.title) >= 0)) {
    refusal(`${operation.kind} Criteria targets an existing criterion`);
  }
  for (const criterion of added) {
    const index = body.criteria.length;
    body.criteria.push(criterion);
    body.criterionIndexes.set(normalizeTitle(criterion.title), index);
  }
}

function applyAdd(body: MutableBody, operation: Operation, document: DocumentNode): void {
  const target = contractSectionName(operation.target);
  if (target === "criteria") {
    addedCriteria(body, operation, document);
    return;
  }
  if (target !== null) refusal(`Add does not support ${operation.target}`);
  const normalized = normalizeTitle(operation.target);
  if (RESERVED_SECTIONS.has(normalized)) refusal(`${normalized} is not a contract Markdown section`);
  if (body.extensionIndexes.has(normalized)) refusal(`extension already exists '${operation.target}'`);
  const index = body.extensions.length;
  body.extensions.push({ title: operation.target, content: prose(document, operation.section, "extension") });
  body.extensionIndexes.set(normalized, index);
}

function applyAppend(body: MutableBody, operation: Operation, document: DocumentNode): void {
  const target = contractSectionName(operation.target);
  if (target === "criteria") {
    addedCriteria(body, operation, document);
    return;
  }
  if (target === "context" || target === "objective" || target === "design") {
    alteredText(body, target, appendText(body[target], prose(document, operation.section, operation.target)));
    return;
  }
  if (target !== null) refusal(`Append does not support ${operation.target}`);
  const index = extensionIndex(body, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  const extension = body.extensions[index]!;
  body.extensions[index] = {
    ...extension,
    content: appendText(extension.content, prose(document, operation.section, "extension")),
  };
}

function applyReplace(body: MutableBody, operation: Operation, document: DocumentNode): void {
  const target = contractSectionName(operation.target);
  if (target === "verification") {
    body.verification = verification(document, operation.section);
    return;
  }
  if (target === "context" || target === "objective" || target === "design") {
    alteredText(body, target, prose(document, operation.section, operation.target));
    return;
  }
  if (target === "region") {
    body.region = region(document, operation.section);
    return;
  }
  if (target === "criteria") {
    const replacement = criteria(document, operation.section);
    body.criteria = [...replacement];
    body.criterionIndexes = new Map(replacement.map((criterion, index) => [normalizeTitle(criterion.title), index]));
    return;
  }
  if (target !== null) refusal(`Replace does not support ${operation.target}`);
  const index = extensionIndex(body, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  const extension = body.extensions[index]!;
  body.extensions[index] = { ...extension, content: prose(document, operation.section, "extension") };
}

function applySet(body: MutableBody, operation: Operation, document: DocumentNode): void {
  if (contractSectionName(operation.target) !== null || extensionIndex(body, operation.target) >= 0) {
    applyReplace(body, operation, document);
    return;
  }
  applyAdd(body, operation, document);
}

function applyOperation(body: MutableBody, operation: Operation, document: DocumentNode): void {
  switch (operation.kind) {
    case "Add":
      applyAdd(body, operation, document);
      return;
    case "Update":
      applyUpdate(body, operation, document);
      return;
    case "Replace":
      applyReplace(body, operation, document);
      return;
    case "Append":
      applyAppend(body, operation, document);
      return;
    case "Remove":
      applyRemove(body, operation, document);
      return;
    case "Set":
      applySet(body, operation, document);
      return;
  }
}

function operationKey(operation: Operation): string {
  return `${operation.kind}:${operation.target}`;
}

function apply(source: string, current: ContractBody): Readonly<{ body: ContractBody; changed: ReadonlySet<string> }> {
  const document = parseToAST(source);
  const operations = operationSections(document);
  if (operations.length === 0) refusal("amend requires at least one H2 operation");
  const seen = new Set<string>();
  const changed = new Set<string>();
  const body = cloneBody(current);
  for (const operation of operations) {
    const key = operationKey(operation);
    if (seen.has(key)) refusal(`duplicate amend operation '${key}'`);
    seen.add(key);
    changed.add(normalizeTitle(operation.target));
    applyOperation(body, operation, document);
  }
  return { body: completeBody(body), changed };
}

export function applyAmendDocument(
  source: string,
  current: DecodedContractDocument,
): Readonly<{ document: string; changedSections: ReadonlySet<string> }> {
  const result = apply(source, current);
  return {
    document: renderAmendedContractBody(current.document.bytes, result.body, result.changed),
    changedSections: result.changed,
  };
}
