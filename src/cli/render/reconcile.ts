import type { ReconcileReport } from "../../library/reconcile.js";
import { reconcileLagIsFailure, type RepoReconcileReport } from "../../library/reconcile.js";
import { abbreviateGitIds, displayGitId } from "./contract-observation.js";
import { receiptPayload, receiptRow } from "./receipt.js";
import { DEFAULT_CLI_COLUMNS, type TextRenderContext } from "./terminal.js";

type Effect = ReconcileReport["effects"][number];
type ReconcileLag = ReconcileReport["lag"][number];

function effectText(effect: Effect): readonly string[] | null {
  if (effect.action === "unchanged") return null;
  const ids =
    effect.kind === "ref"
      ? [effect.before ?? "", effect.after ?? ""]
      : effect.kind === "worktree" && effect.action === "followed"
        ? [effect.before, effect.after]
        : effect.kind === "recovery-snapshot"
          ? [effect.snapshot]
          : [];
  const abbreviations = abbreviateGitIds(ids);
  const state =
    effect.kind === "ref"
      ? `${effect.action}${effect.before === null ? "" : ` · ${displayGitId(effect.before, abbreviations)}`}${effect.after === null ? "" : ` → ${displayGitId(effect.after, abbreviations)}`}`
      : effect.kind === "worktree" && effect.action === "followed"
        ? `followed · ${displayGitId(effect.before, abbreviations)} → ${displayGitId(effect.after, abbreviations)}`
        : effect.action;
  const path =
    effect.kind === "ref"
      ? effect.name
      : effect.kind === "recovery-snapshot"
        ? displayGitId(effect.snapshot, abbreviations)
        : effect.path;
  return [effect.kind, state, path];
}

type WorktreeHookLag = Extract<ReconcileLag, { kind: "worktree-hook-failed" }>;

function worktreeHookLagRows(
  lines: string[],
  lag: WorktreeHookLag,
  columns: number,
  contract: string | undefined,
): void {
  receiptRow(
    lines,
    "!",
    "reconcile",
    [
      ...(contract === undefined ? [] : [{ text: contract, opaque: true }]),
      { text: "hook", opaque: true },
      { text: lag.phase, opaque: true },
      { text: lag.path, opaque: true },
      { text: lag.name, opaque: true },
      { text: `command ${lag.command}`, opaque: true },
      { text: lag.failure.kind === "exit" ? `exit ${lag.failure.code}` : lag.failure.kind, opaque: true },
    ],
    columns,
  );
  const output = "stdout" in lag.failure ? lag.failure.stdout : undefined;
  const error = "stderr" in lag.failure ? lag.failure.stderr : undefined;
  if (lag.failure.kind === "spawn-error") {
    receiptRow(lines, "!", "reason", [{ text: lag.failure.diagnostic, opaque: true }], columns);
  }
  if (output !== undefined && output.length > 0) receiptPayload(lines, "stdout", output);
  if (error !== undefined && error.length > 0) receiptPayload(lines, "stderr", error);
}

function lagRow(lines: string[], lag: ReconcileLag, columns: number, contract: string | undefined): void {
  switch (lag.kind) {
    case "worktree-hook-failed":
      worktreeHookLagRows(lines, lag, columns, contract);
      break;
    case "reconcile-failed":
      receiptRow(
        lines,
        "!",
        "reconcile",
        [
          ...(contract === undefined ? [] : [{ text: contract, opaque: true }]),
          { text: lag.stage, opaque: true },
          { text: lag.diagnostic, opaque: true },
        ],
        columns,
      );
      break;
    case "worktree-retained":
      receiptRow(lines, " ", "worktree retained at", [{ text: lag.path, opaque: true }], columns);
      if (lag.diagnostic !== undefined)
        receiptRow(lines, " ", "reason", [{ text: lag.diagnostic, opaque: true }], columns);
      break;
    case "worktree-follow-retained":
      receiptRow(
        lines,
        " ",
        "worktree follow kept at",
        [{ text: lag.path, opaque: true }, { text: `· ${lag.reason.replaceAll("-", " ")}` }],
        columns,
      );
      break;
    case "unsealed-bytes":
      receiptRow(lines, " ", "unsealed bytes kept at", [{ text: lag.path, opaque: true }], columns);
      break;
    case "target-checkout-retained":
      receiptRow(
        lines,
        "!",
        "target checkout kept at",
        [
          { text: lag.path, opaque: true },
          { text: `· ${lag.target}`, opaque: true },
        ],
        columns,
      );
      receiptRow(lines, " ", "reason", [{ text: lag.diagnostic, opaque: true }], columns);
      break;
    case "contract-file-failed":
      receiptRow(
        lines,
        "!",
        "contract file unavailable",
        [
          { text: lag.worktree, opaque: true },
          { text: `· ${lag.path}`, opaque: true },
        ],
        columns,
      );
      receiptRow(lines, " ", "reason", [{ text: lag.diagnostic, opaque: true }], columns);
      break;
    default: {
      const exhaustive: never = lag;
      return exhaustive;
    }
  }
}

function appendReport(
  lines: string[],
  report: ReconcileReport,
  columns: number,
  seen: Set<string>,
  contract?: string,
): void {
  for (const effect of report.effects) {
    const parts = effectText(effect);
    if (parts === null) continue;
    const key = JSON.stringify([contract, effect]);
    if (seen.has(key)) continue;
    seen.add(key);
    receiptRow(
      lines,
      " ",
      "effect",
      parts.map((text) => ({ text, opaque: true })),
      columns,
    );
  }
  for (const lag of report.lag) lagRow(lines, lag, columns, contract);
  for (const action of report.settlement?.actions ?? []) {
    receiptRow(lines, " ", "settlement", [{ text: action.kind, opaque: true }], columns);
  }
  for (const lag of report.settlement?.lags ?? []) {
    receiptRow(
      lines,
      "!",
      "settlement",
      Object.entries(lag)
        .filter(([key]) => key !== "kind")
        .map(([key, value]) => ({ text: `${key} ${String(value)}`, opaque: true })),
      columns,
    );
  }
  for (const failure of report.settlement?.seatClose ?? []) {
    receiptRow(lines, "!", "settlement", [{ text: failure.kind, opaque: true }], columns);
    receiptRow(lines, "!", "reason", [{ text: failure.diagnostic, opaque: true }], columns);
  }
}

type CompletedRepoReport = Extract<RepoReconcileReport, { kind: "completed" }>;

function isRepoReport(report: ReconcileReport | RepoReconcileReport): report is RepoReconcileReport {
  return "kind" in report && (report.kind === "completed" || report.kind === "world-observation-failed");
}

export function reconcileHasFailure(report: ReconcileReport | RepoReconcileReport): boolean {
  if (isRepoReport(report)) {
    if (report.kind === "world-observation-failed") return true;
    const completed: CompletedRepoReport = report;
    return completed.contracts.some((item) => {
      return (
        item.report.lag.some((lag) => reconcileLagIsFailure(lag)) ||
        item.report.settlement.lags.length > 0 ||
        (item.report.settlement.seatClose?.length ?? 0) > 0
      );
    });
  }
  return (
    report.lag.some((lag) => reconcileLagIsFailure(lag)) ||
    (report.settlement?.lags.length ?? 0) > 0 ||
    (report.settlement?.seatClose?.length ?? 0) > 0
  );
}

export function renderReconcile(report: ReconcileReport | RepoReconcileReport, context?: TextRenderContext): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const lines: string[] = ["✓ reconcile"];
  const seen = new Set<string>();
  if (isRepoReport(report)) {
    if (report.kind === "world-observation-failed") {
      receiptRow(lines, "!", "reconcile", [{ text: report.diagnostic, opaque: true }], columns);
      return lines.join("\n");
    }
    for (const item of report.contracts) appendReport(lines, item.report, columns, seen, item.contractId);
  } else appendReport(lines, report, columns, seen);
  if (lines.length === 1) lines.push("  already consistent");
  return lines.join("\n");
}
