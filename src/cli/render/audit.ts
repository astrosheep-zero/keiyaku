import type { AuditPreview, VerificationReuse } from "../../index.js";
import { renderRefusalFacts } from "./refusal.js";
import { renderOpaqueBlock } from "./terminal.js";

const EVIDENCE = "  ";
const CHILD = "  ";

export function reuseLines(reuse: VerificationReuse | undefined, columns: number): readonly string[] {
  if (reuse === undefined) return [];
  return renderOpaqueBlock(`reuse verification ${reuse.entry} ${reuse.verdict}`, "   ", columns);
}

function targetPreviewLines(
  target: Extract<AuditPreview, { kind: "ready" }>["target"],
  columns: number,
  addressed: string,
): readonly string[] {
  if (target === undefined) return [];
  if (target.kind === "ready") return renderOpaqueBlock("target ready", `${EVIDENCE}${CHILD}`, columns);
  if (target.kind === "failed") {
    return renderOpaqueBlock(`target failed diagnostic=${target.diagnostic}`, `${EVIDENCE}${CHILD}`, columns);
  }
  return [
    ...renderOpaqueBlock("target refused", `${EVIDENCE}${CHILD}`, columns),
    ...renderRefusalFacts(target.refusal, `${EVIDENCE}${CHILD}${CHILD}`, columns, addressed),
  ];
}

function previewDiffLines(
  preview: Extract<AuditPreview, { kind: "ready" }>,
  columns: number,
): readonly string[] {
  if (!("diff" in preview)) return [];
  if (preview.diff === null) {
    return renderOpaqueBlock(
      `git-unavailable integrationSnapshot=${preview.candidate.integration.snapshot} changeId=${preview.candidate.integration.changeId}`,
      EVIDENCE,
      columns,
    );
  }
  return preview.diff.length > 0 ? [preview.diff] : [];
}

export function previewLines(
  preview: AuditPreview,
  columns: number,
  addressed: string,
): readonly string[] {
  if (preview.kind === "blocked") {
    return [
      ...renderOpaqueBlock("preview blocked", EVIDENCE, columns),
      ...renderRefusalFacts(preview.refusal, `${EVIDENCE}${CHILD}`, columns, addressed),
    ];
  }
  const candidate = preview.candidate;
  const lines = [...renderOpaqueBlock(
    ["preview ready", candidate.tenderSnapshot, candidate.integration.snapshot, candidate.integration.changeId].join(" "),
    EVIDENCE,
    columns,
  )];
  lines.push(...targetPreviewLines(preview.target, columns, addressed));
  lines.push(...previewDiffLines(preview, columns));
  return lines;
}
