import type { AuditReport } from "../../index.js";
import type { AcceptedAuditResult } from "../result.js";
import {
  cleanupLines,
  leakLines,
  outcomeLines,
  receiptPayload,
  receiptRow,
  stopLines,
} from "./receipt.js";
import { renderRefusalFacts } from "./refusal.js";
import {
  gitShortStat,
  renderBoundedTextBlock,
  renderOpaqueBlock,
  type TextRenderContext,
} from "./terminal.js";

const CHILD = "  ";

function workspaceEvidence(
  workspace: Extract<AuditReport["candidate"], { kind: "ready" }>["workspace"],
  columns: number,
): readonly string[] {
  return renderOpaqueBlock(`workspace ${workspace.kind} ${workspace.path}`, CHILD, columns);
}

function candidateLines(
  report: AuditReport,
  columns: number,
  addressed: string,
): readonly string[] {
  const candidate = report.candidate;
  const lines: string[] = [];
  if (candidate.kind === "blocked") {
    receiptRow(lines, "!", "candidate", [{ text: "blocked" }], columns);
    lines.push(...renderRefusalFacts(candidate.refusal, CHILD, columns, addressed));
    return lines;
  }
  const identity = candidate.identity;
  receiptRow(lines, "✓", "candidate", [{ text: "ready" }], columns);
  lines.push(...renderOpaqueBlock(`tender=${identity.tenderSnapshot}`, CHILD, columns));
  lines.push(...renderOpaqueBlock(`integration=${identity.integration.snapshot}`, CHILD, columns));
  lines.push(...renderOpaqueBlock(`change=${identity.integration.changeId}`, CHILD, columns));
  lines.push(...workspaceEvidence(candidate.workspace, columns));
  lines.push(...renderOpaqueBlock(gitShortStat(candidate.scope), CHILD, columns));
  if (candidate.scope.paths !== undefined) {
    for (const path of candidate.scope.paths) {
      lines.push(...renderOpaqueBlock(path, CHILD, columns));
    }
  }
  if (report.delivery !== undefined) {
    lines.push(...renderOpaqueBlock(
      `delivery change=${report.delivery.changeId} ${report.delivery.relation}`,
      CHILD,
      columns,
    ));
  }
  if (candidate.diff !== undefined) receiptPayload(lines, "diff", candidate.diff);
  return lines;
}

function verificationLines(
  verification: AuditReport["verification"],
  columns: number,
  addressed: string,
): readonly string[] {
  const lines: string[] = [];
  if (verification.kind === "not-run") {
    receiptRow(lines, "·", "verification", [{ text: "not-run" }], columns);
    return lines;
  }
  if (verification.kind === "stopped") {
    return stopLines("verification", verification.stop, columns, addressed);
  }
  receiptRow(lines, verification.kind === "satisfied" ? "✓" : "!", "verification", [
    { text: verification.kind },
    { text: `${verification.passed} of ${verification.total}` },
  ], columns);
  if (verification.summary !== undefined) {
    lines.push(...renderBoundedTextBlock(verification.summary, {
      first: `${CHILD}summary `,
      continuation: CHILD,
      columns,
    }));
  }
  return lines;
}

function targetLines(target: AuditReport["target"], columns: number, addressed: string): readonly string[] {
  const lines: string[] = [];
  if (target.kind === "not-observed") {
    receiptRow(lines, "·", "target", [{ text: "not-observed" }], columns);
    return lines;
  }
  if (target.kind === "placeable") {
    receiptRow(lines, "✓", "target", [
      { text: "placeable" },
      { text: target.ref, opaque: true },
      { text: target.head, opaque: true },
    ], columns);
    return lines;
  }
  if (target.kind === "moved") {
    receiptRow(lines, "!", "target", [
      { text: "moved" },
      { text: target.ref, opaque: true },
      { text: `${target.expected} -> ${target.observed}`, opaque: true },
    ], columns);
    return lines;
  }
  if (target.kind === "failed") {
    receiptRow(lines, "!", "target", [{ text: "failed" }], columns);
    receiptPayload(lines, "diagnostic", target.diagnostic);
    return lines;
  }
  receiptRow(lines, "!", "target", [{ text: "refused" }], columns);
  lines.push(...renderRefusalFacts(target.refusal, CHILD, columns, addressed));
  return lines;
}

function obligationLines(result: AcceptedAuditResult, columns: number): readonly string[] {
  return [
    ...(result.cleanup === undefined ? [] : cleanupLines(result.cleanup, columns)),
    ...(result.leak === undefined ? [] : leakLines(result.leak, columns)),
  ];
}

export function renderAcceptedAudit(result: AcceptedAuditResult, context?: TextRenderContext): string {
  const report = result.report;
  const columns = context?.columns ?? 80;
  return [
    ...outcomeLines("✓", result.verb, "accepted", result.contract, columns),
    ...candidateLines(report, columns, result.contract),
    ...verificationLines(report.verification, columns, result.contract),
    ...targetLines(report.target, columns, result.contract),
    ...obligationLines(result, columns),
  ].join("\n");
}
