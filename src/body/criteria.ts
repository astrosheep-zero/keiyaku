import { directChildren, normalizeTitle, rawSlice } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import type { ContractCriterion } from "./types.js";

type CriteriaContext = "contract" | "amend";

function criteriaHeadings(section: SectionNode) {
  return directChildren(section, "heading").filter((heading) => heading.level === 3);
}

export function criteriaStructure(
  document: DocumentNode,
  section: SectionNode,
  context: CriteriaContext = "contract",
): string | null {
  const label = context === "amend" ? "Criteria operation" : "Criteria";
  const headings = criteriaHeadings(section);
  if (headings.length === 0) return `${label} must contain one or more H3 entries`;
  const before = rawSlice(document, { start: section.contentStart, end: headings[0]!.span.start });
  return before.trim().length === 0 ? null : `${label} may contain only H3 entries`;
}

export function decodeCriteria(
  document: DocumentNode,
  section: SectionNode,
  context: CriteriaContext = "contract",
): readonly ContractCriterion[] {
  const structural = criteriaStructure(document, section, context);
  if (structural !== null) throw new TypeError(structural);
  const headings = criteriaHeadings(section);
  const seen = new Set<string>();
  return headings.map((heading, index) => {
    const title = heading.text.trim();
    const key = normalizeTitle(title);
    if (title.length === 0 || seen.has(key)) {
      throw new TypeError(
        context === "amend"
          ? "criteria operation contains duplicate or empty titles"
          : `duplicate criterion '${title}'`,
      );
    }
    seen.add(key);
    const body = rawSlice(document, {
      start: heading.span.end,
      end: headings[index + 1]?.span.start ?? section.span.end,
    });
    if (body.trim().length === 0) {
      throw new TypeError(
        context === "amend" ? `criterion '${title}' operation body is empty` : `criterion '${title}' is empty`,
      );
    }
    return { title, body };
  });
}
