import type { ArcData } from "../core/facts/types.js";
import type { ContractBody } from "./types.js";
import type { VerificationDeclaration } from "../verification/declaration.js";
import { parseToAST } from "../markdown/parse.js";
import { indexDocument, indexedHeadings, normalizeTitle, rawSlice } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import { CONTRACT_SECTIONS } from "./shape.js";

function content(value: string): string {
  return value.trimEnd();
}

function section(title: string, value: string): string {
  return `## ${title}\n\n${content(value)}`;
}

function fenced(value: string, info = ""): string {
  const marker = (["`", "~"] as const)
    .map((delimiter) => ({
      delimiter,
      length: Math.max(3, ...value.split("\n").map((line) => {
        const match = new RegExp(`^ {0,3}\\${delimiter}+`).exec(line);
        return (match?.[0].trim().length ?? 0) + 1;
      })),
    }))
    .sort((left, right) => left.length - right.length)[0]!;
  const boundary = marker.delimiter.repeat(marker.length);
  return `${boundary}${info}\n${value}\n${boundary}`;
}

function verificationFence(declaration: VerificationDeclaration): string {
  return fenced(declaration.script, `${declaration.executor}${declaration.timeoutMs === undefined ? "" : ` timeout=${declaration.timeoutMs}`}`);
}

function arcSection(arc: ArcData): string {
  return [
    "## Arc",
    "### Sequence",
    String(arc.seq),
    "### Title",
    content(arc.title),
    "### Objective",
    content(arc.objective),
    "### Brief",
    content(arc.brief),
  ].join("\n\n");
}

export function renderContractBody(body: ContractBody, currentArc?: ArcData): string {
  const criteria = body.criteria.map((criterion) => `### ${criterion.title}\n\n${content(criterion.body)}`).join("\n\n");
  const verification = body.verification.map(verificationFence).join("\n\n");
  return [
    `# ${body.title}`,
    section(CONTRACT_SECTIONS.context.title, body.context),
    section(CONTRACT_SECTIONS.objective.title, body.objective),
    section(CONTRACT_SECTIONS.design.title, body.design),
    section(CONTRACT_SECTIONS.region.title, fenced(body.region.join("\n"))),
    section(CONTRACT_SECTIONS.criteria.title, criteria),
    ...(verification.length === 0 ? [] : [section(CONTRACT_SECTIONS.verification.title, verification)]),
    ...body.extensions.map((extension) => section(extension.title, extension.content)),
    ...(currentArc === undefined ? [] : [arcSection(currentArc)]),
  ].join("\n\n").concat("\n");
}

function sections(document: DocumentNode): readonly SectionNode[] {
  return indexedHeadings(indexDocument(document), { level: 2 })
    .filter((node): node is SectionNode => node.type === "section");
}

export function renderAmendedContractBody(
  currentSource: string,
  body: ContractBody,
  changedSections: ReadonlySet<string>,
): string {
  const current = parseToAST(currentSource);
  const renderedSource = renderContractBody(body);
  const rendered = parseToAST(renderedSource);
  const currentSections = sections(current);
  const preserved = new Map(currentSections.map((node) => [
    normalizeTitle(node.title),
    rawSlice(current, node.span),
  ]));
  const first = currentSections[0];
  const prefix = first === undefined ? currentSource : currentSource.slice(0, first.span.start);
  return prefix + sections(rendered).map((node) => {
    const name = normalizeTitle(node.title);
    return changedSections.has(name) ? rawSlice(rendered, node.span) : preserved.get(name) ?? rawSlice(rendered, node.span);
  }).join("");
}
