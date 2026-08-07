import { directChildren, rawSlice } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import type { VerificationDeclaration } from "../verification/types.js";

export type { VerificationDeclaration, VerificationExecutor } from "../verification/types.js";

export class VerificationDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationDocumentError";
  }
}

export function decodeVerificationDeclarations(document: DocumentNode, section: SectionNode): readonly VerificationDeclaration[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length === 0) throw new VerificationDocumentError("Verification must contain one or more fenced executor declarations");
  const other = section.children.filter((node) => node.type !== "code_block" && rawSlice(document, node.span).trim().length > 0);
  if (other.length > 0) throw new VerificationDocumentError("Verification may contain only fenced executor declarations");
  return blocks.map((block) => {
    const executor = block.info.trim();
    if (!block.closed || (executor !== "bash" && executor !== "zsh" && executor !== "pwsh")) {
      throw new VerificationDocumentError("Verification fences must be closed and use bash, zsh, or pwsh");
    }
    const script = block.lines.slice(1, -1).join("\n");
    if (script.trim().length === 0) throw new VerificationDocumentError("Verification scripts must be nonblank");
    return { executor, script };
  });
}
