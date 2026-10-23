import type { DeliveryPreviewOutcome, DeliveryPreviewReport } from "../../index.js";
import { effectCleanup, effectExecutionStops } from "./effects.js";
import { executionCleanupLines, executionStopLines, receiptPayload, receiptRow, titleLines } from "./receipt.js";
import { renderRefusalFacts } from "./refusal.js";
import { abbreviateGitIds, displayGitId, gateFact } from "./contract-observation.js";
import { DEFAULT_CLI_COLUMNS, gitShortStat, renderTextBlock, safeText, type TextRenderContext } from "./terminal.js";

const CHILD = "  ";

function workspaceEvidence(
  workspace: Extract<DeliveryPreviewReport["candidate"], { kind: "ready" }>["workspace"],
): readonly string[] {
  return [`${CHILD}worktree  ${safeText(workspace.path)}`];
}

function candidateLines(
  report: DeliveryPreviewReport,
  columns: number,
  addressed: string,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const candidate = report.candidate;
  const lines: string[] = [];
  if (candidate.kind === "blocked") {
    receiptRow(lines, "!", "candidate", [{ text: "blocked" }], columns);
    lines.push(...renderRefusalFacts(candidate.refusal, CHILD, columns, addressed));
    return lines;
  }
  const identity = candidate.identity;
  receiptRow(
    lines,
    " ",
    "candidate",
    [{ text: "prepared" }, { text: displayGitId(identity.tenderSnapshot, abbreviations), opaque: true }],
    columns,
  );
  lines.push(`${CHILD}integration result  ${displayGitId(identity.integration.snapshot, abbreviations)}`);
  if (!/^0{40}$/u.test(identity.integration.changeId))
    lines.push(`${CHILD}content identity  ${displayGitId(identity.integration.changeId, abbreviations)}`);
  lines.push(...workspaceEvidence(candidate.workspace));
  for (const report of candidate.requirements.gates) lines.push(`${CHILD}${gateFact(report)}`);
  for (const prerequisite of candidate.requirements.unmetPrerequisites) {
    receiptRow(lines, "!", "prerequisite", [{ text: prerequisite.contractId }, { text: prerequisite.state }], columns);
  }
  lines.push(...renderTextBlock(gitShortStat(candidate.scope), CHILD, columns));
  if (candidate.scope.paths !== undefined) {
    for (const path of candidate.scope.paths) {
      lines.push(`${CHILD}${safeText(path)}`);
    }
  }
  if (candidate.diff !== undefined) receiptPayload(lines, "diff", candidate.diff);
  return lines;
}

function verificationLines(verification: DeliveryPreviewReport["verification"], columns: number): readonly string[] {
  const lines: string[] = [];
  if (verification.kind !== "recorded") {
    const text =
      verification.kind === "undeclared"
        ? "none declared"
        : verification.kind === "required"
          ? "required · not run"
          : "not run";
    receiptRow(lines, " ", "verification", [{ text }], columns);
    return lines;
  }
  receiptRow(
    lines,
    verification.verdict === "unsatisfied" ? "!" : " ",
    "verification",
    [{ text: "recorded" }, { text: verification.verdict }],
    columns,
  );
  if (verification.summary !== undefined) receiptPayload(lines, "summary", previewSummary(verification.summary));
  return lines;
}

function previewSummary(summary: string): string {
  return summary.replace(
    /\[(\d+) (bash|zsh|pwsh) exit (-?\d+)( output-truncated)?\]/gu,
    (_, number: string, executor: string, exit: string, truncated: string | undefined) =>
      `declaration ${number} · ${executor} exit ${exit}${truncated ?? ""}`,
  );
}

function admittedCandidateLines(report: DeliveryPreviewReport, columns: number): readonly string[] {
  const delivery = report.delivery;
  if (delivery === undefined) return [];
  const verification = delivery.verification;
  if (verification.kind === "undeclared") return [];
  const detail = verification.kind === "recorded" ? `${verification.kind} ${verification.verdict}` : verification.kind;
  const lines: string[] = [];
  receiptRow(
    lines,
    verification.kind === "unrecorded" ? "!" : " ",
    "admitted verification",
    [{ text: detail }],
    columns,
  );
  return lines;
}

function targetLines(
  report: DeliveryPreviewReport,
  columns: number,
  addressed: string,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const target = report.target;
  const lines: string[] = [];
  if (target.kind === "not-observed") {
    receiptRow(lines, " ", "target", [{ text: "none" }], columns);
    return lines;
  }
  if (target.kind === "placeable") {
    receiptRow(
      lines,
      " ",
      "target",
      [
        { text: "placeable" },
        {
          text: `${target.ref.replace(/^refs\/heads\//u, "")} @ ${displayGitId(target.head, abbreviations)}${report.targetLag?.kind === "counted" && report.targetLag.behind > 0 ? ` · behind ${report.targetLag.behind}` : report.targetLag?.kind === "unknown" ? " · behind unknown" : ""}`,
          opaque: true,
        },
      ],
      columns,
    );
    for (const checkout of target.checkouts) {
      if (checkout.kind === "followable") continue;
      receiptRow(lines, "!", "checkout cannot follow", [{ text: checkout.path, opaque: true }], columns);
      receiptPayload(lines, "reason", checkout.diagnostic);
    }
    return lines;
  }
  if (target.kind === "moved") {
    receiptRow(
      lines,
      "!",
      "target",
      [
        { text: "moved" },
        { text: target.ref, opaque: true },
        {
          text: `${displayGitId(target.expected, abbreviations)} -> ${target.observed === null ? "absent" : displayGitId(target.observed, abbreviations)}`,
          opaque: true,
        },
      ],
      columns,
    );
    return lines;
  }
  if (target.kind === "failed") {
    receiptRow(lines, "!", "target", [{ text: "failed" }], columns);
    receiptPayload(lines, "reason", target.diagnostic);
    return lines;
  }
  receiptRow(lines, "!", "target", [{ text: "refused" }], columns);
  lines.push(...renderRefusalFacts(target.refusal, CHILD, columns, addressed));
  return lines;
}

function obligationLines(result: AcceptedDeliveryPreview, columns: number): readonly string[] {
  return [
    ...executionCleanupLines(effectCleanup(result.effects), columns, result.contract),
    ...executionStopLines(effectExecutionStops(result.effects), columns),
  ];
}

type AcceptedDeliveryPreview = Extract<DeliveryPreviewOutcome, { kind: "accepted" }>;

export function renderDeliveryPreview(result: AcceptedDeliveryPreview, context?: TextRenderContext): string {
  const report = result.value;
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const ids: string[] =
    report.candidate.kind === "ready"
      ? [
          report.candidate.identity.tenderSnapshot,
          report.candidate.identity.integration.snapshot,
          report.candidate.identity.integration.changeId,
        ]
      : [];
  if (report.target.kind === "placeable") ids.push(report.target.head);
  if (report.target.kind === "moved") ids.push(report.target.expected, report.target.observed ?? "");
  const abbreviations = abbreviateGitIds(ids);
  return [
    ...titleLines("✓", "deliver --dry-run", result.contract, columns),
    ...candidateLines(report, columns, result.contract, abbreviations),
    ...admittedCandidateLines(report, columns),
    ...verificationLines(report.verification, columns),
    ...targetLines(report, columns, result.contract, abbreviations),
    ...obligationLines(result, columns),
  ].join("\n");
}
