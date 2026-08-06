import { validateContractBody } from "../core/facts/codec.js";
import type { ContractBody, ContractCriterion, VerificationDeclaration } from "../core/facts/types.js";
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
import { CONTRACT_SECTION, ContractDocumentError } from "./grammar.js";

const REQUIRED_SECTIONS = ["context", "objective", "design", "region", "criteria"] as const;
const RESERVED_REMOVED_SECTIONS = new Set(["gates", "pipeline", "after"]);

function refusal(code: string, message: string): never {
  throw new ContractDocumentError(code, message);
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
    if (sections.has(title)) refusal("DUPLICATE_SECTION", `duplicate contract section '${section.title}'`);
    sections.set(title, section);
  }
  return sections;
}

function requiredSection(sections: ReadonlyMap<string, SectionNode>, name: typeof REQUIRED_SECTIONS[number]): SectionNode {
  const section = sections.get(CONTRACT_SECTION[name]);
  if (section === undefined) refusal("MISSING_SECTION", `contract document is missing ## ${name[0]!.toUpperCase()}${name.slice(1)}`);
  return section;
}

function prose(document: DocumentNode, section: SectionNode): string {
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal("EMPTY_SECTION", `contract section '${section.title}' is empty`);
  return value;
}

function region(document: DocumentNode, section: SectionNode): readonly string[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length !== 1 || !blocks[0]!.closed || blocks[0]!.info.length > 0) {
    refusal("INVALID_REGION", "Region must contain one closed fence without an info string");
  }
  const other = section.children.filter((node) => node !== blocks[0] && nonblankRaw(document, node));
  if (other.length > 0) refusal("INVALID_REGION", "Region may contain only its fenced declaration");
  const patterns = blocks[0]!.lines.slice(1, -1).map((line) => line.trim()).filter((line) => line.length > 0);
  if (patterns.length === 0) refusal("INVALID_REGION", "Region must declare at least one path pattern");
  return patterns;
}

function criteria(document: DocumentNode, section: SectionNode): readonly ContractCriterion[] {
  const headings = directChildren(section, "heading").filter((heading) => heading.level === 3);
  if (headings.length === 0) refusal("INVALID_CRITERIA", "Criteria must contain one or more H3 entries");
  const before = rawSlice(document, { start: section.contentStart, end: headings[0]!.span.start });
  if (before.trim().length > 0) refusal("INVALID_CRITERIA", "Criteria may contain only H3 entries");
  const seen = new Set<string>();
  return headings.map((heading, index) => {
    const title = heading.text.trim();
    const key = normalizeTitle(title);
    if (seen.has(key)) refusal("DUPLICATE_CRITERION", `duplicate criterion '${title}'`);
    seen.add(key);
    const body = rawSlice(document, {
      start: heading.span.end,
      end: headings[index + 1]?.span.start ?? section.span.end,
    });
    if (body.trim().length === 0) refusal("EMPTY_CRITERION", `criterion '${title}' is empty`);
    return { title, body };
  });
}

function verification(document: DocumentNode, section: SectionNode): readonly VerificationDeclaration[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length === 0) refusal("INVALID_VERIFICATION", "Verification must contain one or more fenced executor declarations");
  const other = section.children.filter((node) => node.type !== "code_block" && nonblankRaw(document, node));
  if (other.length > 0) refusal("INVALID_VERIFICATION", "Verification may contain only fenced executor declarations");
  return blocks.map((block) => {
    const executor = block.info.trim();
    if (!block.closed || !["bash", "zsh", "pwsh"].includes(executor)) {
      refusal("INVALID_VERIFICATION", "Verification fences must be closed and use bash, zsh, or pwsh");
    }
    const script = block.lines.slice(1, -1).join("\n");
    if (script.trim().length === 0) refusal("INVALID_VERIFICATION", "Verification scripts must be nonblank");
    return { executor: executor as VerificationDeclaration["executor"], script };
  });
}

function rejectUnownedBytes(document: DocumentNode, title: SectionNode): void {
  if (title.children.some((node) => nonblankRaw(document, node))) {
    refusal("UNOWNED_DOCUMENT_BYTES", "contract title may not contain content before the first H2 section");
  }
  const stray = document.children.filter((node) => node.type !== "section" && nonblankRaw(document, node));
  if (stray.length > 0) refusal("UNOWNED_DOCUMENT_BYTES", "contract document contains content outside an H1 or H2 section");
}

export function decodeContractDocument(source: string): ContractBody {
  const document = parseToAST(source);
  if (document.frontmatter !== undefined) refusal("FRONTMATTER_FORBIDDEN", "contract document may not contain frontmatter");
  const titles = indexedHeadings(indexDocument(document), { level: 1 })
    .filter((node): node is SectionNode => node.type === "section");
  if (titles.length !== 1) refusal("INVALID_TITLE", "contract document requires exactly one H1 title");
  const title = titles[0]!;
  rejectUnownedBytes(document, title);
  const sections = indexedSections(document);
  for (const name of RESERVED_REMOVED_SECTIONS) {
    if (sections.has(name)) refusal("REMOVED_SECTION", `${name} is not a contract Markdown section`);
  }
  const extensions = [...sections.entries()]
    .filter(([name]) => !Object.hasOwn(CONTRACT_SECTION, name))
    .map(([, section]) => {
      const content = sectionContent(document, section);
      if (content.trim().length === 0) refusal("EMPTY_EXTENSION", `extension '${section.title}' is empty`);
      return { title: section.title, content };
    });
  return validateContractBody({
    title: title.title,
    context: prose(document, requiredSection(sections, "context")),
    objective: prose(document, requiredSection(sections, "objective")),
    design: prose(document, requiredSection(sections, "design")),
    region: region(document, requiredSection(sections, "region")),
    criteria: criteria(document, requiredSection(sections, "criteria")),
    verification: sections.has(CONTRACT_SECTION.verification)
      ? verification(document, sections.get(CONTRACT_SECTION.verification)!)
      : [],
    extensions,
  });
}
