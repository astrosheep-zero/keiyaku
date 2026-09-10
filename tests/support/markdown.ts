/** Assemble fixture bytes independently of the production parser and renderer. */
export function contractMarkdown(title: string, sections: Readonly<Record<string, string>>): string {
  return [`# ${title}`, ...Object.entries(sections).map(([heading, body]) => `## ${heading}\n${body}`)].join("\n\n");
}
