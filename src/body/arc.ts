import { parseToAST } from "../markdown/parse.js";
import { indexDocument, indexedHeadings } from "../markdown/query.js";
import type { SectionNode } from "../markdown/types.js";

const ARC_SHAPE =
  "arc document requires exactly one nonblank H1 chapter name (# <name>) followed by a freeform Markdown body (which may be empty)";

export function decodeArcDocument(source: string): Readonly<{ title: string; body: string }> {
  let document: ReturnType<typeof parseToAST>;
  try {
    document = parseToAST(source);
  } catch {
    throw new TypeError(ARC_SHAPE);
  }
  const titles = indexedHeadings(indexDocument(document), { level: 1 }).filter(
    (node): node is SectionNode => node.type === "section",
  );
  const title = titles[0];
  if (
    document.frontmatter !== undefined ||
    titles.length !== 1 ||
    title === undefined ||
    title.title.trim().length === 0 ||
    source.slice(0, title.span.start).trim().length !== 0
  ) {
    throw new TypeError(ARC_SHAPE);
  }
  return { title: title.title, body: source.slice(title.contentStart) };
}
