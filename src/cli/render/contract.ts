import type { KeiyakuRetryReason, RegionOverlap } from "../../index.js";
import type {
  AcceptedAbandonResult,
  AcceptedAmendResult,
  AcceptedArcResult,
  AcceptedBindResult,
  AcceptedDeliverResult,
  AcceptedEnvelope,
  AcceptedResult,
  AcceptedReviewResult,
  Lag,
  RetryResult,
} from "../result.js";
import { renderAcceptedAudit } from "./audit.js";
import {
  appendHookPayload,
  cleanupLines,
  hookFailureSummary,
  leakLines,
  outcomeLines,
  seatCloseLines,
  receiptPayload,
  receiptRow,
  reuseLines,
  stopLines,
  titleLines,
} from "./receipt.js";
import { gitShortStat, renderOpaqueBlock, type TextRenderContext } from "./terminal.js";

const HANG = "   ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryLines(detail: KeiyakuRetryReason, indent: string, columns: number): readonly string[] {
  if (detail.kind === "publication-failed") {
    return [...renderOpaqueBlock("publication-failed", indent, columns), ...["diagnostic", "", detail.diagnostic, ""]];
  }
  return renderOpaqueBlock(detail.kind, indent, columns);
}

function lagRows(lag: Lag, columns: number): readonly string[] {
  const lines: string[] = [];
  if (lag.kind === "worktree-retained") {
    receiptRow(lines, "!", "lag", [{ text: `worktree-retained ${lag.path}`, opaque: true }], columns);
  } else if (lag.kind === "worktree-follow-retained") {
    receiptRow(
      lines,
      "!",
      "lag",
      [
        {
          text: `${lag.kind} reason=${lag.reason} tender=${lag.tender} head=${lag.head}${lag.paths === undefined || lag.paths.length === 0 ? "" : ` paths=${lag.paths.join(",")}`} path=${lag.path}`,
          opaque: true,
        },
      ],
      columns,
    );
  } else if (lag.kind === "unsealed-bytes") {
    receiptRow(
      lines,
      "!",
      "lag",
      [
        {
          text: `unsealed-bytes ${lag.path}${lag.head === undefined ? "" : ` head=${lag.head}`}${lag.paths.length === 0 ? "" : ` paths=${lag.paths.join(",")}`}`,
          opaque: true,
        },
      ],
      columns,
    );
  } else if (lag.kind === "target-checkout-retained") {
    receiptRow(
      lines,
      "!",
      "lag",
      [{ text: `target-checkout-retained ${lag.target} ${lag.path}`, opaque: true }],
      columns,
    );
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  } else if (lag.kind === "worktree-hook-failed") {
    receiptRow(
      lines,
      "!",
      "lag",
      [
        {
          text: `worktree-hook-failed ${lag.phase} ${lag.path} command=${lag.command} name=${lag.name} ${hookFailureSummary(lag.failure)}`,
          opaque: true,
        },
      ],
      columns,
    );
    appendHookPayload(lines, lag.failure);
  } else if (lag.kind === "contract-file-failed") {
    receiptRow(
      lines,
      "!",
      "lag",
      [{ text: `contract-file-failed ${lag.worktree} ${lag.path}`, opaque: true }],
      columns,
    );
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  } else {
    receiptRow(lines, "!", "lag", [{ text: `reconcile-failed ${lag.stage}`, opaque: true }], columns);
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  }
  return lines;
}

function settlementLagRows(lag: AcceptedEnvelope["settlementLags"][number], columns: number): readonly string[] {
  const lines: string[] = [];
  receiptRow(
    lines,
    "!",
    "settlement",
    [
      {
        text: [
          `surface=${lag.surface}`,
          lag.taskId === undefined ? undefined : `task=${lag.taskId}`,
          lag.path === undefined ? undefined : `path=${lag.path}`,
        ]
          .filter((part): part is string => part !== undefined)
          .join(" "),
        opaque: true,
      },
    ],
    columns,
  );
  receiptPayload(lines, "diagnostic", lag.diagnostic);
  return lines;
}

function workspaceRows(workspace: NonNullable<AcceptedReviewResult["workspace"]>, columns: number): readonly string[] {
  const lines: string[] = [];
  receiptRow(lines, "~", "workspace", [{ text: gitShortStat(workspace.shortStat) }], columns);
  for (const name of ["staged", "unstaged", "untracked"] as const) {
    for (const path of workspace[name]) {
      receiptRow(lines, " ", name, [{ text: path, opaque: true }], columns);
    }
  }
  return lines;
}

function overlapRows(overlaps: readonly RegionOverlap[], columns: number): readonly string[] {
  const lines: string[] = [];
  for (const overlap of overlaps) {
    for (const pattern of overlap.patterns) {
      receiptRow(
        lines,
        "~",
        "overlap",
        [
          { text: overlap.contract, opaque: true },
          { text: `${pattern.mine} ~ ${pattern.theirs}`, opaque: true },
        ],
        columns,
      );
    }
  }
  return lines;
}

function pushBlock(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return;
  lines.push(...block);
}

function acceptedRecord(
  result:
    | AcceptedBindResult
    | AcceptedAmendResult
    | AcceptedDeliverResult
    | AcceptedReviewResult
    | AcceptedArcResult
    | AcceptedAbandonResult,
  columns: number,
): readonly string[] {
  const record: string[] = [];
  for (const fact of result.facts) {
    const contract = fact.contract === result.contract ? [] : [{ text: fact.contract, opaque: true }];
    receiptRow(
      record,
      " ",
      "journal",
      fact.kind === "reintegrated"
        ? [
            ...contract,
            { text: fact.entry, opaque: true },
            { text: "· reintegrated" },
            { text: fact.data.predecessor, opaque: true },
            { text: "->" },
            { text: fact.data.snapshot, opaque: true },
          ]
        : [...contract, { text: fact.entry, opaque: true }, { text: `· ${fact.kind}` }],
      columns,
    );
  }
  receiptRow(record, " ", "head", [{ text: result.head, opaque: true }], columns);
  if (result.recoverySnapshot !== undefined)
    receiptRow(record, " ", "recovery snapshot", [{ text: result.recoverySnapshot, opaque: true }], columns);
  if (result.verb === "deliver") {
    pushBlock(record, reuseLines(result.verificationReuse, columns));
  }
  return record;
}

function acceptedLagRows(result: AcceptedEnvelope, columns: number): readonly string[] {
  const obligations: string[] = [];
  if (result.lag !== undefined) {
    for (const lag of result.lag) pushBlock(obligations, lagRows(lag, columns));
  }
  for (const lag of result.settlementLags) {
    pushBlock(obligations, settlementLagRows(lag, columns));
  }
  if (result.seatClose !== undefined && result.seatClose.length > 0) {
    pushBlock(obligations, seatCloseLines(result.seatClose, columns));
  }
  return obligations;
}

function indentRecord(lines: readonly string[]): readonly string[] {
  let payload = false;
  return lines.map((line) => {
    if (line.length === 0) {
      payload = !payload;
      return line;
    }
    return payload ? line : `  ${line}`;
  });
}

function acceptedDeviations(
  result: AcceptedBindResult | AcceptedAmendResult | AcceptedReviewResult,
  columns: number,
): readonly string[] {
  const deviations: string[] = [];
  if (result.verb === "review") {
    if (result.workspace !== undefined) pushBlock(deviations, workspaceRows(result.workspace, columns));
    return deviations;
  }
  if (result.overlaps !== undefined) pushBlock(deviations, overlapRows(result.overlaps, columns));
  if (result.overlapFailure !== undefined) {
    receiptRow(deviations, "~", "overlap", [{ text: "unavailable" }], columns);
    receiptPayload(deviations, "diagnostic", result.overlapFailure);
  }
  return deviations;
}

function recordBlock(
  result:
    | AcceptedBindResult
    | AcceptedAmendResult
    | AcceptedDeliverResult
    | AcceptedReviewResult
    | AcceptedArcResult
    | AcceptedAbandonResult,
  columns: number,
): readonly string[] {
  const rows = [...acceptedRecord(result, columns), ...acceptedLagRows(result, columns)];
  return ["  record", ...indentRecord(rows)];
}

function completionLines(result: AcceptedDeliverResult | AcceptedReviewResult, columns: number): readonly string[] {
  const lines: string[] = [];
  const completion = result.completion;
  if (completion === undefined) return lines;
  const verification = completion.verification;
  receiptRow(
    lines,
    " ",
    "target",
    [
      { text: "->" },
      { text: completion.integration, opaque: true },
      ...(verification?.verdict === "satisfied" ? [{ text: `· verified (${verification.mode})` }] : []),
    ],
    columns,
  );
  if (verification?.verdict === "unsatisfied") {
    receiptRow(
      lines,
      "!",
      "verification",
      [{ text: "unsatisfied" }, { text: `(${verification.mode})` }, { text: "· not required by Contract gates" }],
      columns,
    );
    if (result.verificationSummary !== undefined) {
      receiptPayload(lines, "  summary", result.verificationSummary);
    }
  }
  return lines;
}

function movementLines(result: AcceptedDeliverResult | AcceptedReviewResult, columns: number): readonly string[] {
  const count = result.facts.filter((fact) => fact.kind === "reintegrated").length;
  if (count === 0) return [];
  const lines: string[] = [];
  receiptRow(lines, "~", "target", [{ text: `moved · re-integrated x${count}` }], columns);
  return lines;
}

function continuationLines(result: AcceptedDeliverResult | AcceptedReviewResult, columns: number): readonly string[] {
  const report = result.continuation;
  if (report === undefined) return [];
  const lines: string[] = [];
  for (const contractId of report.claimed) {
    receiptRow(lines, "✓", "continuation", [{ text: "complete" }, { text: contractId, opaque: true }], columns);
  }
  for (const { contractId, stop } of report.stopped) {
    if ("kind" in stop) receiptRow(lines, "!", contractId, [{ text: "· already terminal" }], columns);
    else lines.push(...stopLines(stop, columns, contractId, contractId));
  }
  return lines;
}

function renderAcceptedBind(result: AcceptedBindResult, columns: number): string {
  const lines = titleLines("✓", "bound", result.contract, columns);
  receiptRow(lines, " ", "workspace", [{ text: "managed worktree" }], columns);
  if (result.target === null) receiptRow(lines, " ", "no target", [], columns);
  else receiptRow(lines, " ", "target", [{ text: result.target, opaque: true }], columns);
  lines.push(...acceptedDeviations(result, columns), ...recordBlock(result, columns));
  return lines.join("\n");
}

function renderAcceptedAmend(result: AcceptedAmendResult, columns: number): string {
  const lines = titleLines("✓", "terms replaced", result.contract, columns);
  receiptPayload(lines, "  terms diff", result.diff);
  lines.push(...acceptedDeviations(result, columns), ...recordBlock(result, columns));
  return lines.join("\n");
}

function renderAcceptedDeliver(result: AcceptedDeliverResult, columns: number): string {
  const complete = result.completion !== undefined;
  const title = complete ? "delivered" : "deliver — not complete";
  const lines = titleLines("✓", title, result.contract, columns);
  lines.push(...movementLines(result, columns), ...completionLines(result, columns));
  if (result.verification !== undefined) {
    lines.push(...stopLines(result.verification, columns, result.contract));
  }
  if (!complete && result.placement !== undefined) {
    lines.push(...stopLines(result.placement, columns, result.contract));
  }
  if (!complete) receiptRow(lines, " ", "candidate", [{ text: "kept" }], columns);
  lines.push(...continuationLines(result, columns));
  if (result.cleanup !== undefined) pushBlock(lines, cleanupLines(result.cleanup, columns));
  if (result.leak !== undefined) pushBlock(lines, leakLines(result.leak, columns));
  lines.push(...recordBlock(result, columns));
  return lines.join("\n");
}

function renderAcceptedReview(result: AcceptedReviewResult, columns: number): string {
  const complete = result.completion !== undefined;
  const lines = titleLines(
    "✓",
    `review ${result.verdict} — ${complete ? "complete" : "not complete"}`,
    result.contract,
    columns,
  );
  lines.push(...movementLines(result, columns), ...completionLines(result, columns));
  if (result.verification !== undefined) {
    lines.push(...stopLines(result.verification, columns, result.contract));
  }
  if (result.placement !== undefined) {
    lines.push(...stopLines(result.placement, columns, result.contract));
  }
  if (!complete) receiptRow(lines, " ", "candidate", [{ text: "kept" }], columns);
  lines.push(...continuationLines(result, columns));
  if (result.cleanup !== undefined) pushBlock(lines, cleanupLines(result.cleanup, columns));
  if (result.leak !== undefined) pushBlock(lines, leakLines(result.leak, columns));
  lines.push(...acceptedDeviations(result, columns), ...recordBlock(result, columns));
  return lines.join("\n");
}

function renderAcceptedArc(result: AcceptedArcResult, columns: number): string {
  const lines = titleLines("✓", "chapter recorded", result.contract, columns);
  receiptRow(
    lines,
    " ",
    "chapter",
    [{ text: String(result.chapter.seq) }, { text: "·" }, { text: result.chapter.title }],
    columns,
  );
  lines.push(...recordBlock(result, columns));
  return lines.join("\n");
}

function renderAcceptedAbandon(result: AcceptedAbandonResult, columns: number): string {
  const lines = titleLines("✓", "abandoned", result.contract, columns);
  if (result.note !== undefined) receiptRow(lines, " ", "note", [{ text: result.note }], columns);
  lines.push(...recordBlock(result, columns));
  return lines.join("\n");
}

export function renderAccepted(result: AcceptedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  switch (result.verb) {
    case "audit":
      return renderAcceptedAudit(result, context);
    case "bind":
      return renderAcceptedBind(result, columns);
    case "amend":
      return renderAcceptedAmend(result, columns);
    case "review":
      return renderAcceptedReview(result, columns);
    case "arc":
      return renderAcceptedArc(result, columns);
    case "abandon":
      return renderAcceptedAbandon(result, columns);
    case "deliver":
      return renderAcceptedDeliver(result, columns);
  }
}

export function renderRetry(result: RetryResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const detail =
    isRecord(result.detail) && typeof result.detail.kind === "string"
      ? retryLines(result.detail as KeiyakuRetryReason, HANG, columns)
      : [];
  return [...outcomeLines("?", result.verb, "retry", result.contract, columns), ...detail].join("\n");
}

export { renderContractHistory } from "./contract-history.js";
