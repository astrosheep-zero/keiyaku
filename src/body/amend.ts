import { validateContractBody } from "../core/facts/codec.js";
import type { ContractBody, ContractCriterion, ContractExtension, VerificationDeclaration } from "../core/facts/types.js";
import { parseToAST } from "../markdown/parse.js";
import { directChildren, indexDocument, indexedHeadings, normalizeTitle, rawSlice, sectionContent } from "../markdown/query.js";
import type { DocumentNode, MarkdownBlockNode, SectionNode } from "../markdown/types.js";
import { ContractDocumentError } from "./grammar.js";

type Operation = Readonly<{ kind: "Add" | "Update" | "Replace" | "Append" | "Remove"; target: string; section: SectionNode }>;

function refusal(message: string): never {
  throw new ContractDocumentError("INVALID_AMEND_OPERATIONS", message);
}

function nonblank(document: DocumentNode, node: MarkdownBlockNode): boolean {
  return rawSlice(document, node.span).trim().length > 0;
}

function sections(document: DocumentNode): readonly SectionNode[] {
  return indexedHeadings(indexDocument(document), { level: 2 })
    .filter((node): node is SectionNode => node.type === "section");
}

function operationSections(document: DocumentNode): readonly Operation[] {
  if (document.frontmatter !== undefined) refusal("amend operations may not contain frontmatter");
  if (indexedHeadings(indexDocument(document), { level: 1 }).length > 0) refusal("amend operations may contain H2 sections only");
  if (document.children.some((node) => node.type !== "section" && nonblank(document, node))) {
    refusal("amend operations contain bytes outside H2 sections");
  }
  return sections(document).map((section) => {
    const match = /^(Add|Update|Replace|Append|Remove):[ ]+(.+)$/.exec(section.title.trim());
    if (!match) refusal(`invalid amend operation heading: ${section.title}`);
    return { kind: match[1] as Operation["kind"], target: match[2]!.trim(), section };
  });
}

function prose(document: DocumentNode, section: SectionNode, label: string): string {
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal(`${label} operation body must be nonblank`);
  return value;
}

function region(document: DocumentNode, section: SectionNode): readonly string[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length !== 1 || !blocks[0]!.closed || blocks[0]!.info.length > 0) {
    refusal("Region operation must contain one closed fence without an info string");
  }
  const other = section.children.filter((node) => node !== blocks[0] && nonblank(document, node));
  if (other.length > 0) refusal("Region operation may contain only its fenced declaration");
  const patterns = blocks[0]!.lines.slice(1, -1).map((line) => line.trim()).filter((line) => line.length > 0);
  if (patterns.length === 0) refusal("Region operation must declare at least one path pattern");
  return patterns;
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
    const body = rawSlice(document, { start: heading.span.end, end: headings[index + 1]?.span.start ?? section.span.end });
    if (body.trim().length === 0) refusal(`criterion '${title}' operation body is empty`);
    return { title, body };
  });
}

function verification(document: DocumentNode, section: SectionNode): readonly VerificationDeclaration[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length === 0) refusal("Verification operation must contain one or more fenced executor declarations");
  const other = section.children.filter((node) => node.type !== "code_block" && nonblank(document, node));
  if (other.length > 0) refusal("Verification operation may contain only fenced executor declarations");
  return blocks.map((block) => {
    const executor = block.info.trim();
    if (!block.closed || !["bash", "zsh", "pwsh"].includes(executor)) {
      refusal("Verification fences must be closed and use bash, zsh, or pwsh");
    }
    const script = block.lines.slice(1, -1).join("\n");
    if (script.trim().length === 0) refusal("Verification scripts must be nonblank");
    return { executor: executor as VerificationDeclaration["executor"], script };
  });
}

function cloneBody(body: ContractBody): ContractBody {
  return {
    title: body.title,
    context: body.context,
    objective: body.objective,
    design: body.design,
    region: [...body.region],
    criteria: body.criteria.map((criterion) => ({ ...criterion })),
    verification: body.verification.map((declaration) => ({ ...declaration })),
    extensions: body.extensions.map((extension) => ({ ...extension })),
    ...(body.gates === undefined ? {} : { gates: [...body.gates] }),
    ...(body.after === undefined ? {} : { after: [...body.after] }),
  };
}

function targetCore(target: string): string | null {
  return ["Context", "Objective", "Design", "Region", "Criteria", "Verification"].includes(target) ? target : null;
}

function extensionIndex(extensions: readonly ContractExtension[], target: string): number {
  return extensions.findIndex((extension) => extension.title === target);
}

function criterionIndex(criteriaList: readonly ContractCriterion[], target: string): number {
  const key = normalizeTitle(target);
  return criteriaList.findIndex((criterion) => normalizeTitle(criterion.title) === key);
}

function appendText(current: string, addition: string): string {
  return `${current.trimEnd()}\n\n${addition.trim()}\n`;
}

function requireEmpty(document: DocumentNode, section: SectionNode): void {
  if (sectionContent(document, section).trim().length > 0) refusal("Remove operation must not have a body");
}

function alteredText(body: ContractBody, target: "Context" | "Objective" | "Design", value: string): ContractBody {
  return { ...body, [target.toLowerCase()]: value };
}

function applyRemove(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  requireEmpty(document, operation.section);
  if (operation.target.startsWith("Criterion ")) {
    const title = operation.target.slice("Criterion ".length);
    const index = criterionIndex(body.criteria, title);
    if (index < 0) refusal(`unknown criterion '${title}'`);
    return { ...body, criteria: body.criteria.filter((_, candidate) => candidate !== index) };
  }
  const index = extensionIndex(body.extensions, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  return { ...body, extensions: body.extensions.filter((_, candidate) => candidate !== index) };
}

function applyUpdate(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  if (operation.target.startsWith("Criterion ")) {
    const title = operation.target.slice("Criterion ".length);
    const index = criterionIndex(body.criteria, title);
    if (index < 0) refusal(`unknown criterion '${title}'`);
    return { ...body, criteria: body.criteria.map((criterion, candidate) => candidate === index ? { ...criterion, body: prose(document, operation.section, "criterion") } : criterion) };
  }
  const index = extensionIndex(body.extensions, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  return { ...body, extensions: body.extensions.map((extension, candidate) => candidate === index ? { ...extension, content: prose(document, operation.section, "extension") } : extension) };
}

function addedCriteria(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  const added = criteria(document, operation.section);
  if (added.some((candidate) => criterionIndex(body.criteria, candidate.title) >= 0)) {
    refusal(`${operation.kind} Criteria targets an existing criterion`);
  }
  return { ...body, criteria: [...body.criteria, ...added] };
}

function applyAdd(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  if (operation.target === "Criteria") return addedCriteria(body, operation, document);
  if (targetCore(operation.target) !== null) refusal(`Add does not support ${operation.target}`);
  if (extensionIndex(body.extensions, operation.target) >= 0) refusal(`extension already exists '${operation.target}'`);
  return { ...body, extensions: [...body.extensions, { title: operation.target, content: prose(document, operation.section, "extension") }] };
}

function applyAppend(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  if (operation.target === "Criteria") return addedCriteria(body, operation, document);
  if (operation.target === "Context" || operation.target === "Objective" || operation.target === "Design") {
    const target = operation.target;
    return alteredText(body, target, appendText(body[target.toLowerCase() as "context" | "objective" | "design"], prose(document, operation.section, target)));
  }
  if (targetCore(operation.target) !== null) refusal(`Append does not support ${operation.target}`);
  const index = extensionIndex(body.extensions, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  return { ...body, extensions: body.extensions.map((extension, candidate) => candidate === index ? { ...extension, content: appendText(extension.content, prose(document, operation.section, "extension")) } : extension) };
}

function applyReplace(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  if (operation.target === "Verification") return { ...body, verification: verification(document, operation.section) };
  if (operation.target === "Context" || operation.target === "Objective" || operation.target === "Design") {
    return alteredText(body, operation.target, prose(document, operation.section, operation.target));
  }
  if (operation.target === "Region") return { ...body, region: region(document, operation.section) };
  if (operation.target === "Criteria") return { ...body, criteria: criteria(document, operation.section) };
  if (targetCore(operation.target) !== null) refusal(`Replace does not support ${operation.target}`);
  const index = extensionIndex(body.extensions, operation.target);
  if (index < 0) refusal(`unknown extension '${operation.target}'`);
  return { ...body, extensions: body.extensions.map((extension, candidate) => candidate === index ? { ...extension, content: prose(document, operation.section, "extension") } : extension) };
}

function applyOperation(body: ContractBody, operation: Operation, document: DocumentNode): ContractBody {
  switch (operation.kind) {
    case "Add": return applyAdd(body, operation, document);
    case "Update": return applyUpdate(body, operation, document);
    case "Replace": return applyReplace(body, operation, document);
    case "Append": return applyAppend(body, operation, document);
    case "Remove": return applyRemove(body, operation, document);
  }
}

function operationKey(operation: Operation): string {
  const target = operation.target.startsWith("Criterion ")
    ? `Criterion ${normalizeTitle(operation.target.slice("Criterion ".length))}`
    : operation.target;
  return `${operation.kind}:${target}`;
}

export function applyAmendOperations(source: string, current: ContractBody): ContractBody {
  const document = parseToAST(source);
  const operations = operationSections(document);
  if (operations.length === 0) refusal("amend requires at least one H2 operation");
  const seen = new Set<string>();
  let body = cloneBody(current);
  for (const operation of operations) {
    const key = operationKey(operation);
    if (seen.has(key)) refusal(`duplicate amend operation '${key}'`);
    seen.add(key);
    body = applyOperation(body, operation, document);
  }
  return validateContractBody(body);
}
