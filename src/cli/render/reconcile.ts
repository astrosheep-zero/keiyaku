import type {
  MeaningfulEffect,
  ReconcileCompletion,
  RepoContractReconcileReport,
  RepoReconcileReport,
} from "../../library/reconcile.js";
import { invocationIssueIsFailure } from "../../library/outcome.js";
import type { VerbDisposition } from "../../library/keiyaku-verbs.js";
import { contractIssueLines } from "./contract.js";
import { abbreviateGitIds, displayGitId } from "./contract-observation.js";
import { receiptRow } from "./receipt.js";
import { DEFAULT_CLI_COLUMNS, safeText, type TextRenderContext } from "./terminal.js";

type ReconcileReport = ReconcileCompletion | RepoReconcileReport;

function words(kind: string): string {
  return kind.replaceAll("-", " ");
}

function effectSegments(effect: MeaningfulEffect): readonly { text: string; opaque?: boolean }[] {
  switch (effect.kind) {
    case "ref": {
      const ids = abbreviateGitIds([effect.before ?? "", effect.after ?? ""]);
      return [
        { text: "ref" },
        {
          text: `${effect.before === null ? "absent" : displayGitId(effect.before, ids)} → ${effect.after === null ? "absent" : displayGitId(effect.after, ids)}`,
        },
        { text: effect.name, opaque: true },
      ];
    }
    case "target-checkout":
      return [{ text: "target checkout" }, { text: effect.target, opaque: true }, { text: effect.path, opaque: true }];
    case "recovery-snapshot":
      return [
        { text: "recovery snapshot" },
        { text: displayGitId(effect.snapshot, abbreviateGitIds([effect.snapshot])), opaque: true },
      ];
    case "debt-settled":
      return [{ text: "debt settled" }, { text: effect.debtId, opaque: true }];
    case "worktree-created":
    case "worktree-removed":
      return [{ text: words(effect.kind) }, { text: effect.path, opaque: true }];
  }
}

function nativeDisposition(report: ReconcileReport): VerbDisposition {
  if (report.kind === "missing") return "refused";
  if (report.kind === "world-observation-failed") return "failed";
  const rows = report.kind === "world" ? (report.contracts ?? []) : [report];
  return rows.some((row) => row.issues?.some(invocationIssueIsFailure) === true) ? "failed" : "accepted";
}

function appendReport(lines: string[], report: RepoContractReconcileReport, columns: number, seen: Set<string>): void {
  for (const effect of report.effects ?? []) {
    const key = JSON.stringify([report.contractId, effect]);
    if (seen.has(key)) continue;
    seen.add(key);
    receiptRow(lines, " ", "effect", effectSegments(effect), columns);
  }
  lines.push(...contractIssueLines(report, columns));
}

/** Reconcile reports only native disposition, movement, and repair issues; it never re-adjudicates them. */
export function renderReconcile(
  report: ReconcileReport,
  context?: TextRenderContext,
  disposition?: VerbDisposition,
): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  if (report.kind === "world-observation-failed")
    return [`! reconcile failed`, `! reconcile  ${safeText(report.diagnostic)}`].join("\n");
  if (report.kind === "missing")
    return `× reconcile refused\n  reason  contract missing\n  contract  ${safeText(report.contractId)}`;
  const verdict = disposition ?? nativeDisposition(report);
  const lines: string[] = [verdict === "failed" ? "! reconcile incomplete" : "✓ reconcile"];
  const seen = new Set<string>();
  if (report.kind === "world") {
    for (const item of report.contracts ?? []) appendReport(lines, item, columns, seen);
  } else appendReport(lines, report, columns, seen);
  if (lines.length === 1) lines.push("  already consistent");
  return lines.join("\n");
}
