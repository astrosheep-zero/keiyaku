import { directChildren, rawSlice } from "../markdown/query.js";
import type { DocumentNode, SectionNode } from "../markdown/types.js";
import { parseDuration } from "../duration.js";
import type { VerificationDeclaration } from "../verification/declaration.js";

export type { VerificationDeclaration, VerificationExecutor } from "../verification/declaration.js";

export class VerificationDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationDocumentError";
  }
}

export function decodeVerificationDeclarations(
  document: DocumentNode,
  section: SectionNode,
): readonly VerificationDeclaration[] {
  const blocks = directChildren(section, "code_block");
  if (blocks.length === 0)
    throw new VerificationDocumentError("Verification must contain one or more fenced executor declarations");
  const other = section.children.filter(
    (node) => node.type !== "code_block" && rawSlice(document, node.span).trim().length > 0,
  );
  if (other.length > 0)
    throw new VerificationDocumentError("Verification may contain only fenced executor declarations");
  return blocks.map((block) => {
    const info = /^(bash|zsh|pwsh)(?: timeout=([^ ]+))?$/.exec(block.info);
    if (!block.closed || info === null) {
      throw new VerificationDocumentError(
        "Verification fences must be closed and use bash, zsh, or pwsh with optional timeout=<duration>",
      );
    }
    const script = block.lines.slice(1, -1).join("\n");
    if (script.trim().length === 0) throw new VerificationDocumentError("Verification scripts must be nonblank");
    const duration = info[2] === undefined ? undefined : parseDuration(info[2]);
    if (duration?.kind === "invalid") {
      throw new VerificationDocumentError("Verification timeout must be an integer duration with unit ms, s, m, or h");
    }
    if (duration?.kind === "overflow" || (duration?.kind === "parsed" && duration.milliseconds > 2_147_483_647)) {
      throw new VerificationDocumentError("Verification timeout exceeds the supported process duration");
    }
    if (duration?.kind === "parsed" && duration.milliseconds === 0) {
      throw new VerificationDocumentError("Verification timeout must be positive");
    }
    return {
      executor: info[1] as VerificationDeclaration["executor"],
      script,
      ...(duration === undefined ? {} : { timeoutMs: duration.milliseconds }),
    };
  });
}
