import { directChildren, rawSlice } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import type { VerificationDeclaration } from "../verification/declaration.js";

export type { VerificationDeclaration, VerificationExecutor } from "../verification/declaration.js";

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
    const info = /^(bash|zsh|pwsh)(?: timeout=([1-9][0-9]*))?$/.exec(block.info);
    if (!block.closed || info === null) {
      throw new VerificationDocumentError("Verification fences must be closed and use bash, zsh, or pwsh with optional timeout=<milliseconds>");
    }
    const script = block.lines.slice(1, -1).join("\n");
    if (script.trim().length === 0) throw new VerificationDocumentError("Verification scripts must be nonblank");
    const timeoutMs = info[2] === undefined ? undefined : Number(info[2]);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647)) {
      throw new VerificationDocumentError("Verification timeout must be a safe integer from 1 through 2147483647 milliseconds");
    }
    return {
      executor: info[1] as VerificationDeclaration["executor"],
      script,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  });
}
