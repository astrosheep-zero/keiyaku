import type { ArcData } from "../core/facts/types.js";
import { sectionContent } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import { decodeDocumentEnvelope } from "./envelope.js";

function refusal(message: string): never {
  throw new TypeError(message);
}

function requiredProse(
  document: DocumentNode,
  sections: ReadonlyMap<string, SectionNode>,
  name: "objective" | "brief",
): string {
  const section = sections.get(name);
  if (section === undefined) refusal(`arc document is missing ## ${name[0]!.toUpperCase()}${name.slice(1)}`);
  const value = sectionContent(document, section);
  if (value.trim().length === 0) refusal(`arc section '${section.title}' is empty`);
  return value;
}

export function decodeArcDocument(source: string): Readonly<Omit<ArcData, "seq">> {
  const { document, title, sections } = decodeDocumentEnvelope(source, "arc");
  if (title.title.trim().length === 0) refusal("arc title must be nonblank");
  for (const [name, section] of sections) {
    if (name !== "objective" && name !== "brief") {
      refusal(`arc document does not allow ## ${section.title}`);
    }
  }

  return {
    title: title.title,
    objective: requiredProse(document, sections, "objective"),
    brief: requiredProse(document, sections, "brief"),
  };
}
