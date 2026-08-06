import type { ArcData, ContractBody, VerificationDeclaration } from "../core/facts/types.js";

function content(value: string): string {
  return value.trimEnd();
}

function section(title: string, value: string): string {
  return `## ${title}\n\n${content(value)}`;
}

function fence(declaration: VerificationDeclaration): string {
  const marker = (["`", "~"] as const)
    .map((delimiter) => ({
      delimiter,
      length: Math.max(3, ...declaration.script.split("\n").map((line) => {
        const match = new RegExp(`^ {0,3}\\${delimiter}+`).exec(line);
        return (match?.[0].trim().length ?? 0) + 1;
      })),
    }))
    .sort((left, right) => left.length - right.length)[0]!;
  const value = marker.delimiter.repeat(marker.length);
  return `${value}${declaration.executor}\n${declaration.script}\n${value}`;
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

/** Render the journal body into its deterministic presentation form. */
export function renderContractBody(body: ContractBody, currentArc?: ArcData): string {
  const criteria = body.criteria.map((criterion) => `### ${criterion.title}\n\n${content(criterion.body)}`).join("\n\n");
  const verification = body.verification.map(fence).join("\n\n");
  return [
    `# ${body.title}`,
    section("Context", body.context),
    section("Objective", body.objective),
    section("Design", body.design),
    `## Region\n\n\`\`\`\n${body.region.join("\n")}\n\`\`\``,
    section("Criteria", criteria),
    ...(verification.length === 0 ? [] : [section("Verification", verification)]),
    ...body.extensions.map((extension) => section(extension.title, extension.content)),
    ...(currentArc === undefined ? [] : [arcSection(currentArc)]),
  ].join("\n\n").concat("\n");
}
