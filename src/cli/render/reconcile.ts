import type { ReconcileReport } from "../../library/contract-types.js";
import { reconcileLagIsFailure, type RepoReconcileReport } from "../../library/reconcile.js";
import type { ReconcileResult } from "../result.js";
import { receiptPayload, receiptRow } from "./receipt.js";
import { DEFAULT_CLI_COLUMNS, type TextRenderContext } from "./terminal.js";

type Effect = ReconcileReport["effects"][number];
type ReconcileLag = ReconcileReport["lag"][number];

function effectText(effect: Effect): readonly string[] {
  return [
    effect.kind,
    ...Object.entries(effect)
      .filter(([key]) => key !== "kind")
      .map(([, item]) => String(item)),
  ];
}

function lagRow(lines: string[], lag: ReconcileLag, columns: number, contract: string | undefined): void {
  const kind = lag.kind;
  switch (lag.kind) {
    case "worktree-hook-failed": {
      const failure = lag;
      receiptRow(
        lines,
        "!",
        "reconcile",
        [
          ...(contract === undefined ? [] : [{ text: contract, opaque: true }]),
          { text: "hook", opaque: true },
          { text: failure.phase, opaque: true },
          { text: failure.path, opaque: true },
          { text: failure.name, opaque: true },
          { text: `command ${failure.command}`, opaque: true },
          {
            text: failure.failure.kind === "exit" ? `exit ${failure.failure.code}` : failure.failure.kind,
            opaque: true,
          },
        ],
        columns,
      );
      const output = "stdout" in failure.failure ? failure.failure.stdout : undefined;
      const error = "stderr" in failure.failure ? failure.failure.stderr : undefined;
      if (failure.failure.kind === "spawn-error") {
        receiptRow(lines, "!", "diagnostic", [{ text: failure.failure.diagnostic, opaque: true }], columns);
      }
      if (output !== undefined && output.length > 0) receiptPayload(lines, "stdout", output);
      if (error !== undefined && error.length > 0) receiptPayload(lines, "stderr", error);
      break;
    }
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
    case "worktree-follow-retained":
    case "unsealed-bytes":
    case "target-checkout-retained":
    case "contract-file-failed": {
      const details = Object.entries(lag)
        .filter(([key]) => key !== "kind")
        .map(([key, value]) => ({ text: `${key} ${String(value)}`, opaque: true }));
      receiptRow(
        lines,
        "!",
        "reconcile",
        [
          ...(contract === undefined ? [] : [{ text: contract, opaque: true }]),
          { text: lag.kind, opaque: true },
          ...details,
        ],
        columns,
      );
      break;
    }
  }
  if (
    kind !== "worktree-hook-failed" &&
    kind !== "reconcile-failed" &&
    kind !== "worktree-retained" &&
    kind !== "worktree-follow-retained" &&
    kind !== "unsealed-bytes" &&
    kind !== "target-checkout-retained" &&
    kind !== "contract-file-failed"
  ) {
    const exhaustive: never = kind;
    return exhaustive;
  }
}

function appendReport(lines: string[], report: ReconcileReport, columns: number, contract?: string): void {
  for (const effect of report.effects) {
    receiptRow(
      lines,
      " ",
      "effect",
      effectText(effect).map((text) => ({ text, opaque: true })),
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
    receiptRow(lines, "!", "diagnostic", [{ text: failure.diagnostic, opaque: true }], columns);
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

export function renderReconcile(result: ReconcileResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const lines: string[] = [];
  const report = result.report;
  if (isRepoReport(report)) {
    if (report.kind === "world-observation-failed") {
      receiptRow(lines, "!", "reconcile", [{ text: report.diagnostic, opaque: true }], columns);
      return lines.join("\n");
    }
    for (const item of report.contracts) appendReport(lines, item.report, columns, item.contractId);
  } else appendReport(lines, report, columns);
  return lines.length === 0 ? "✓ reconcile" : lines.join("\n");
}
