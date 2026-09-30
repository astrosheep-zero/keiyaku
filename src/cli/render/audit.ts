import type { AuditOutcome, AuditReport } from "../../index.js";
import { effectCleanup, effectExecutionStops } from "./effects.js";
import {
  executionCleanupLines,
  executionStopLines,
  receiptPayload,
  receiptRow,
  reuseLines,
  stopLines,
  titleLines,
} from "./receipt.js";
import { renderRefusalFacts } from "./refusal.js";
import { abbreviateGitIds, displayGitId } from "./contract-observation.js";
import { DEFAULT_CLI_COLUMNS, gitShortStat, renderTextBlock, safeText, type TextRenderContext } from "./terminal.js";

const CHILD = "  ";

function workspaceEvidence(
  workspace: Extract<AuditReport["candidate"], { kind: "ready" }>["workspace"],
): readonly string[] {
  return [`${CHILD}worktree  ${safeText(workspace.path)}`];
}

function candidateLines(
  report: AuditReport,
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
  receiptRow(lines, " ", "candidate", [{ text: "ready" }], columns);
  lines.push(`${CHILD}candidate  ${displayGitId(identity.tenderSnapshot, abbreviations)}`);
  lines.push(`${CHILD}integration result  ${displayGitId(identity.integration.snapshot, abbreviations)}`);
  if (!/^0{40}$/u.test(identity.integration.changeId))
    lines.push(`${CHILD}content identity (not commit)  ${displayGitId(identity.integration.changeId, abbreviations)}`);
  lines.push(...workspaceEvidence(candidate.workspace));
  lines.push(...renderTextBlock(gitShortStat(candidate.scope), CHILD, columns));
  if (candidate.scope.paths !== undefined) {
    for (const path of candidate.scope.paths) {
      lines.push(`${CHILD}${safeText(path)}`);
    }
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
  if (verification.kind === "undeclared") {
    receiptRow(lines, " ", "verification", [{ text: "none declared" }], columns);
    return lines;
  }
  if (verification.kind === "not-run") {
    receiptRow(lines, " ", "verification", [{ text: "not run" }], columns);
    return lines;
  }
  if (verification.kind === "stopped") {
    return stopLines(verification.stop, columns, addressed);
  }
  if (verification.kind === "reused") {
    receiptRow(lines, " ", "verification", [{ text: "reused" }, { text: verification.verdict }], columns);
    lines.push(...reuseLines(verification, columns));
    if (verification.summary !== undefined) receiptPayload(lines, "summary", auditSummary(verification.summary));
    return lines;
  }
  receiptRow(
    lines,
    verification.kind === "satisfied" ? "✓" : "!",
    "verification",
    [{ text: verification.kind }, { text: `${verification.passed} of ${verification.total}` }],
    columns,
  );
  if (verification.summary !== undefined) {
    receiptPayload(lines, "summary", auditSummary(verification.summary));
  }
  return lines;
}

function auditSummary(summary: string): string {
  return summary.replace(
    /\[(\d+) (bash|zsh|pwsh) exit (-?\d+)( output-truncated)?\]/gu,
    (_, number: string, executor: string, exit: string, truncated: string | undefined) =>
      `declaration ${number} · ${executor} exit ${exit}${truncated ?? ""}`,
  );
}

function admittedCandidateLines(report: AuditReport, columns: number): readonly string[] {
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
  report: AuditReport,
  columns: number,
  addressed: string,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const target = report.target;
  const lines: string[] = [];
  if (target.kind === "not-observed") {
    receiptRow(lines, " ", "target", [{ text: "not-observed" }], columns);
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

function obligationLines(result: AcceptedAudit, columns: number): readonly string[] {
  return [
    ...executionCleanupLines(
      effectCleanup(result.effects).filter((issue) => issue.kind !== "worktree-leak"),
      columns,
      result.contract,
    ),
    ...executionStopLines(effectExecutionStops(result.effects), columns),
  ];
}

type AcceptedAudit = Extract<AuditOutcome, { kind: "accepted" }>;

export function renderAcceptedAudit(result: AcceptedAudit, context?: TextRenderContext): string {
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
    ...titleLines("✓", "audit", result.contract, columns),
    ...candidateLines(report, columns, result.contract, abbreviations),
    ...admittedCandidateLines(report, columns),
    ...verificationLines(report.verification, columns, result.contract),
    ...targetLines(report, columns, result.contract, abbreviations),
    ...obligationLines(result, columns),
  ].join("\n");
}
