import type {
  KeiyakuRetryReason,
  RegionOverlap,
} from "../../index.js";
import type { AcceptedResult, Effect, Lag, RetryResult } from "../result.js";
import { renderAcceptedAudit } from "./audit.js";
import {
  appendHookPayload,
  cleanupLines,
  hookFailureSummary,
  leakLines,
  outcomeLines,
  receiptPayload,
  receiptRow,
  reuseLines,
  stopLines,
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

function changedEffect(effect: Effect): boolean {
  return effect.action !== "unchanged";
}

function effectRows(effect: Effect, columns: number): readonly string[] {
  const mark = changedEffect(effect) ? "✓" : "·";
  const lines: string[] = [];
  if (effect.kind === "worktree") {
    receiptRow(lines, mark, "worktree", [{ text: effect.action }, { text: effect.path, opaque: true }], columns);
  } else if (effect.kind === "contract-file") {
    receiptRow(lines, mark, "contract-file", [{ text: effect.action }, { text: effect.path, opaque: true }], columns);
  } else if (effect.kind === "target-checkout") {
    receiptRow(lines, mark, "target-checkout", [
      { text: effect.action },
      { text: effect.target, opaque: true },
      { text: effect.path, opaque: true },
    ], columns);
  } else {
    receiptRow(lines, mark, "ref", [
      { text: effect.action },
      { text: effect.name, opaque: true },
      { text: `${effect.before ?? "null"} -> ${effect.after ?? "null"}`, opaque: true },
    ], columns);
  }
  return lines;
}

function lagRows(lag: Lag, columns: number): readonly string[] {
  const lines: string[] = [];
  if (lag.kind === "worktree-retained") {
    receiptRow(lines, "!", "lag", [{ text: `worktree-retained ${lag.path}`, opaque: true }], columns);
  } else if (lag.kind === "unsealed-bytes") {
    receiptRow(lines, "!", "lag", [{ text: `unsealed-bytes ${lag.path}${lag.head === undefined ? "" : ` head=${lag.head}`}${lag.paths.length === 0 ? "" : ` paths=${lag.paths.join(",")}`}`, opaque: true }], columns);
  } else if (lag.kind === "target-checkout-retained") {
    receiptRow(lines, "!", "lag", [{ text: `target-checkout-retained ${lag.target} ${lag.path}`, opaque: true }], columns);
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  } else if (lag.kind === "worktree-hook-failed") {
    receiptRow(lines, "!", "lag", [{ text: `worktree-hook-failed ${lag.phase} ${lag.path} command=${lag.command} ${hookFailureSummary(lag.failure)}`, opaque: true }], columns);
    appendHookPayload(lines, lag.failure);
  } else if (lag.kind === "contract-file-failed") {
    receiptRow(lines, "!", "lag", [{ text: `contract-file-failed ${lag.worktree} ${lag.path}`, opaque: true }], columns);
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  } else {
    receiptRow(lines, "!", "lag", [{ text: `reconcile-failed ${lag.stage}`, opaque: true }], columns);
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  }
  return lines;
}

function settlementLagRows(lag: AcceptedResult["settlement"]["lags"][number], columns: number): readonly string[] {
  const lines: string[] = [];
  receiptRow(lines, "!", "settlement", [{ text: [
    `surface=${lag.surface}`,
    lag.taskId === undefined ? undefined : `task=${lag.taskId}`,
    lag.path === undefined ? undefined : `path=${lag.path}`,
  ].filter((part): part is string => part !== undefined).join(" "), opaque: true }], columns);
  receiptPayload(lines, "diagnostic", lag.diagnostic);
  return lines;
}

function workspaceRows(
  workspace: NonNullable<AcceptedResult["workspace"]>,
  columns: number,
): readonly string[] {
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
      receiptRow(lines, "~", "overlap", [
        { text: overlap.contract, opaque: true },
        { text: `${pattern.mine} ~ ${pattern.theirs}`, opaque: true },
      ], columns);
    }
  }
  return lines;
}

function pushBlock(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return;
  lines.push(...block);
}

function acceptedRecord(result: AcceptedResult, columns: number): readonly string[] {
  const record: string[] = [];
  receiptRow(record, " ", "head", [{ text: result.head ?? "null", opaque: true }], columns);
  for (const fact of result.facts) {
    const contract = fact.contract === result.contract ? [] : [{ text: fact.contract, opaque: true }];
    receiptRow(record, " ", "journal", [
      ...contract,
      { text: fact.entry, opaque: true },
      { text: `· ${fact.kind}` },
    ], columns);
  }
  if (result.target !== undefined) {
    receiptRow(record, " ", "target", [{ text: result.target ?? "null", opaque: true }], columns);
  }
  pushBlock(record, reuseLines(result.verificationReuse, columns));
  if (result.diff !== undefined) {
    if (typeof result.diff === "string") receiptPayload(record, "diff", result.diff);
    else receiptRow(record, " ", "diff", [{ text: `git-unavailable integrationSnapshot=${result.diff.integrationSnapshot} changeId=${result.diff.changeId}`, opaque: true }], columns);
  }
  const changed = result.effects.filter(changedEffect);
  const unchanged = result.effects.filter((effect) => !changedEffect(effect));
  for (const effect of [...changed, ...unchanged]) pushBlock(record, effectRows(effect, columns));
  for (const action of result.settlement.actions) {
    receiptRow(record, "·", "settle", [
      { text: action.kind },
      { text: action.action },
      { text: action.kind === "task" ? action.taskId : action.path, opaque: true },
    ], columns);
  }
  return record;
}

function acceptedObligations(result: AcceptedResult, columns: number): readonly string[] {
  const obligations: string[] = [];
  for (const name of ["verification", "placement"] as const) {
    const stop = result[name];
    if (stop !== undefined) {
      obligations.push(...stopLines(name === "placement" ? "claim" : "verification", stop, columns, result.contract));
    }
  }
  if (result.cleanup !== undefined) pushBlock(obligations, cleanupLines(result.cleanup, columns));
  if (result.leak !== undefined) pushBlock(obligations, leakLines(result.leak, columns));
  if (result.lag !== undefined) {
    for (const lag of result.lag) pushBlock(obligations, lagRows(lag, columns));
  }
  for (const lag of result.settlement.lags) {
    pushBlock(obligations, settlementLagRows(lag, columns));
  }
  return obligations;
}

function acceptedDeviations(result: AcceptedResult, columns: number): readonly string[] {
  const deviations: string[] = [];
  if (result.workspace !== undefined) pushBlock(deviations, workspaceRows(result.workspace, columns));
  if (result.overlaps !== undefined) pushBlock(deviations, overlapRows(result.overlaps, columns));
  if (result.overlapFailure !== undefined) {
    receiptRow(deviations, "~", "overlap", [{ text: "unavailable" }], columns);
    receiptPayload(deviations, "diagnostic", result.overlapFailure);
  }
  return deviations;
}

export function renderAccepted(result: AcceptedResult, context?: TextRenderContext): string {
  if (result.report !== undefined) return renderAcceptedAudit(result, context);
  const columns = context?.columns ?? 80;
  const lines = outcomeLines("✓", result.verb, "accepted", result.contract, columns);
  const obligations = acceptedObligations(result, columns);
  const deviations = acceptedDeviations(result, columns);
  const record = acceptedRecord(result, columns);
  lines.push(...obligations, ...deviations, ...record);
  return lines.join("\n");
}

export function renderRetry(result: RetryResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const detail = isRecord(result.detail) && typeof result.detail.kind === "string"
    ? retryLines(result.detail as KeiyakuRetryReason, HANG, columns)
    : [];
  return [...outcomeLines("?", result.verb, "retry", result.contract, columns), ...detail].join("\n");
}
