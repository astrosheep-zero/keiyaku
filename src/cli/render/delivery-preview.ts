import type { DeliveryPreviewOutcome } from "../../index.js";
import { unmetRequirementLines, receiptPayload, receiptRow, titleLines } from "./receipt.js";
import { renderRefusalFacts } from "./refusal.js";
import { abbreviateGitIds, displayGitId } from "./contract-observation.js";
import { DEFAULT_CLI_COLUMNS, gitShortStat, safeText, type TextRenderContext } from "./terminal.js";
import { contractIssueLines } from "./contract.js";

type Preview = Extract<DeliveryPreviewOutcome, { kind: "ready" | "blocked" }>;
type Ready = Extract<Preview, { kind: "ready" }>;

function targetLines(
  report: Ready,
  columns: number,
  ids: ReadonlyMap<string, string>,
  surface: TextRenderContext["surface"],
): readonly string[] {
  const target = report.target;
  const lines: string[] = [];
  if (target === undefined) return lines;
  if (target.kind === "placeable") {
    const lag =
      target.behind === undefined ? "" : ` · behind ${target.behind === "unknown" ? "unknown" : String(target.behind)}`;
    receiptRow(
      lines,
      " ",
      "target",
      [
        { text: "placeable" },
        {
          text: `${target.ref.replace(/^refs\/heads\//u, "")} @ ${displayGitId(target.head, ids)}${lag}`,
          opaque: true,
        },
      ],
      columns,
    );
    for (const checkout of target.checkouts ?? []) {
      receiptRow(lines, "!", "checkout cannot follow", [{ text: checkout.path, opaque: true }], columns);
      receiptPayload(lines, "reason", checkout.diagnostic);
    }
  } else if (target.kind === "moved") {
    receiptRow(
      lines,
      "!",
      "target",
      [
        { text: "moved" },
        { text: target.ref, opaque: true },
        {
          text: `${displayGitId(target.expected, ids)} -> ${target.observed === null ? "absent" : displayGitId(target.observed, ids)}`,
          opaque: true,
        },
      ],
      columns,
    );
  } else if (target.kind === "failed") {
    receiptRow(lines, "!", "target", [{ text: "failed" }], columns);
    receiptPayload(lines, "reason", target.diagnostic);
  } else {
    receiptRow(lines, "!", "target", [{ text: "refused" }], columns);
    lines.push(...renderRefusalFacts(target.reason, "  ", columns, report.contractId, surface));
  }
  return lines;
}

function previewGitIds(report: Ready): ReadonlyMap<string, string> {
  const ids: string[] = [report.candidate, report.integration, report.contentId];
  if (report.previousContentId !== undefined) ids.push(report.previousContentId);
  if (report.target?.kind === "placeable") ids.push(report.target.head);
  if (report.target?.kind === "moved") ids.push(report.target.expected, report.target.observed ?? "");
  return abbreviateGitIds(ids);
}

function unmetLines(report: Ready, columns: number): readonly string[] {
  const lines: string[] = [];
  lines.push(...unmetRequirementLines(report.unmetGates ?? [], columns));
  for (const prerequisite of report.unmetPrerequisites ?? [])
    receiptRow(
      lines,
      "!",
      "prerequisite",
      [{ text: prerequisite.contractId, opaque: true }, { text: prerequisite.state }],
      columns,
    );
  return lines;
}

function scopeLines(report: Ready): readonly string[] {
  const lines: string[] = [
    `  ${safeText(
      gitShortStat({
        filesChanged: report.scope.filesChanged ?? 0,
        insertions: report.scope.insertions ?? 0,
        deletions: report.scope.deletions ?? 0,
      }),
    )}`,
  ];
  for (const path of report.scope.paths ?? []) lines.push(`  ${safeText(path)}`);
  return lines;
}

/** A preview is an observation, not a successful mutation or a prediction of placement. */
export function renderDeliveryPreview(report: Preview, context?: TextRenderContext): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const lines = titleLines(report.kind === "ready" ? "✓" : "!", "deliver --dry-run", report.contractId, columns);
  if (report.kind === "blocked") {
    receiptRow(lines, "!", "candidate", [{ text: "blocked" }], columns);
    lines.push(
      ...renderRefusalFacts(report.reason, "  ", columns, report.contractId, context?.surface),
      ...contractIssueLines(report, columns),
    );
    return lines.join("\n");
  }
  const ids = previewGitIds(report);
  receiptRow(
    lines,
    " ",
    "candidate",
    [{ text: "prepared" }, { text: displayGitId(report.candidate, ids), opaque: true }],
    columns,
  );
  receiptRow(
    lines,
    " ",
    "integration result",
    [{ text: displayGitId(report.integration, ids), opaque: true }],
    columns,
  );
  if (!/^0{40}$/u.test(report.contentId))
    receiptRow(lines, " ", "content identity", [{ text: displayGitId(report.contentId, ids), opaque: true }], columns);
  lines.push(...unmetLines(report, columns), ...scopeLines(report));
  if (report.diff?.kind === "present") {
    if (report.diff.text.length === 0) receiptRow(lines, " ", "diff", [{ text: "empty" }], columns);
    else receiptPayload(lines, "diff", report.diff.text);
  } else if (report.diff?.kind === "unavailable") receiptRow(lines, "!", "diff", [{ text: "unavailable" }], columns);
  if (report.previousContentId !== undefined)
    receiptRow(
      lines,
      " ",
      "admitted candidate",
      [{ text: `previous content ${displayGitId(report.previousContentId, ids)}` }],
      columns,
    );
  lines.push(...targetLines(report, columns, ids, context?.surface), ...contractIssueLines(report, columns));
  return lines.join("\n");
}
