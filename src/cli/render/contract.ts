import type {
  KeiyakuRetryReason,
  PlacementStop,
  RegionOverlap,
  VerificationStop,
} from "../../index.js";
import type { AcceptedResult, Effect, Lag, RetryResult } from "../result.js";
import { previewLines, reuseLines } from "./audit.js";
import { displayColumns, renderOpaqueBlock, safeText, type TextRenderContext } from "./terminal.js";

type HookFailure = Extract<Lag, { kind: "worktree-hook-failed" }>["failure"];
const HANG = "   ";

type ReceiptSegment = Readonly<{ text: string; opaque?: boolean }>;

function receiptRow(
  lines: string[],
  mark: string,
  label: string,
  segments: readonly ReceiptSegment[],
  columns: number,
): void {
  let current = `${mark} ${label}`;
  for (const segment of segments) {
    const text = segment.opaque === true ? safeText(segment.text) : segment.text;
    const candidate = `${current} ${text}`;
    if (displayColumns(candidate) <= columns) {
      current = candidate;
      continue;
    }
    if (current === `${mark} ${label}` && segment.opaque === true) {
      lines.push(current);
      current = `  ${text}`;
      continue;
    }
    lines.push(current);
    current = `  ${text}`;
  }
  lines.push(current);
}

function receiptPayload(lines: string[], label: string, payload: string): void {
  lines.push(label, "", payload, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookFailureSummary(failure: HookFailure): string {
  if (failure.kind === "timeout" || failure.kind === "unknown-exit") return failure.kind;
  if (failure.kind === "spawn-error") return failure.kind;
  return `exit=${failure.code} · truncated=${failure.truncated}`;
}

function appendHookPayload(lines: string[], failure: HookFailure): void {
  if (failure.kind === "spawn-error") receiptPayload(lines, "diagnostic", failure.diagnostic);
  if (!("stdout" in failure)) return;
  if (failure.stdout.length > 0) receiptPayload(lines, "stdout", failure.stdout);
  if (failure.stderr.length > 0) receiptPayload(lines, "stderr", failure.stderr);
}

function retryLines(detail: KeiyakuRetryReason, indent: string, columns: number): readonly string[] {
  if (detail.kind === "publication-failed") {
    return [...renderOpaqueBlock("publication-failed", indent, columns), ...["diagnostic", "", detail.diagnostic, ""]];
  }
  return renderOpaqueBlock(detail.kind, indent, columns);
}

function stopLines(
  name: string,
  stop: VerificationStop | PlacementStop | NonNullable<NonNullable<AcceptedResult["report"]>["attempt"]>,
  columns: number,
  addressed: string,
): readonly string[] {
  const detail: string[] = [];
  if ("refusal" in stop && stop.refusal !== undefined) {
    detail.push(`refusal=${stop.refusal.kind}`);
    if ("contractId" in stop.refusal && stop.refusal.contractId !== addressed) {
      detail.push(`contract=${stop.refusal.contractId}`);
    }
  } else if ("retry" in stop && stop.retry !== undefined) {
    detail.push(`retry=${stop.retry.kind}`);
  } else if ("failure" in stop) {
    detail.push(`failure=${stop.failure}`);
    if (stop.failure === "environment-failure" && "command" in stop) {
      detail.push(`command=${stop.command}`, hookFailureSummary(stop.detail));
    } else if (stop.failure === "target-moved") {
      detail.push(`target=${stop.target}`, `expected=${stop.expected}`, `observed=${stop.observed}`);
    }
  }
  const lines: string[] = [];
  receiptRow(lines, "!", "gate", [
    { text: name },
    { text: detail.join(" · "), opaque: true },
  ], columns);
  if ("failure" in stop && stop.failure === "environment-failure" && "command" in stop) {
    appendHookPayload(lines, stop.detail);
  }
  if ("retry" in stop && stop.retry?.kind === "publication-failed") {
    receiptPayload(lines, "diagnostic", stop.retry.diagnostic);
  } else if ("failure" in stop && "diagnostic" in stop) {
    receiptPayload(lines, "diagnostic", stop.diagnostic);
  }
  return lines;
}

function outcomeLines(
  mark: "✓" | "!" | "?",
  verb: string,
  word: "accepted" | "refused" | "retry",
  contract: string | undefined,
  columns = 80,
): string[] {
  const base = `${mark} ${verb} ${word}`;
  if (contract === undefined) return [base];
  const inline = `${base} — ${contract}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [`${base} —`, `  ${safeText(contract)}`];
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
  for (const name of ["staged", "unstaged", "untracked"] as const) {
    if (workspace[name].length === 0) receiptRow(lines, "!", "workspace", [{ text: `${name}=0` }], columns);
    else for (const path of workspace[name]) receiptRow(lines, "!", "workspace", [{ text: name }, { text: path, opaque: true }], columns);
  }
  const { filesChanged, insertions, deletions } = workspace.shortStat;
  receiptRow(lines, "!", "workspace", [{ text: `files=${filesChanged} insertions=${insertions} deletions=${deletions}`, opaque: true }], columns);
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

function reportRows(
  report: NonNullable<AcceptedResult["report"]>,
  columns: number,
  addressed: string,
): readonly string[] {
  const lines: string[] = [];
  receiptRow(lines, " ", "report", [{ text: `reworks=${report.reworks} reviews=${report.reviews}` }], columns);
  for (const entry of report.timeline) {
    receiptRow(lines, " ", "report", [{ text: `${entry.kind} ${entry.at} sincePrior=${entry.sincePrior ?? "null"}`, opaque: true }], columns);
    if (entry.attestation !== undefined) {
      receiptRow(lines, " ", "report", [{ text: `${entry.attestation.gate} ${entry.attestation.verdict}${entry.attestation.summary === undefined ? "" : ` ${entry.attestation.summary}`}`, opaque: true }], columns);
    }
  }
  if (report.preview !== undefined) lines.push(...previewLines(report.preview, columns, addressed));
  if (report.delivery !== undefined) {
    receiptRow(lines, " ", "report", [{ text: [report.delivery.tenderSnapshot, report.delivery.integration.snapshot, report.delivery.integration.changeId].join(" "), opaque: true }], columns);
  }
  if (report.targetObservation?.drift !== true && report.targetObservation !== undefined) {
    receiptRow(lines, " ", "report", [{ text: `target head=${report.targetObservation.head ?? "null"} drift=false`, opaque: true }], columns);
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
  if (result.report !== undefined) pushBlock(record, reportRows(result.report, columns, result.contract));
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
  const cleanup = result.cleanup ?? result.report?.cleanup;
  const leak = result.leak ?? result.report?.leak;
  for (const name of ["verification", "placement"] as const) {
    const stop = result[name];
    if (stop !== undefined) obligations.push(...stopLines(name, stop, columns, result.contract));
  }
  if (cleanup !== undefined) {
    receiptRow(obligations, "!", "cleanup", [
      { text: cleanup.phase },
      { text: `command=${cleanup.command}` },
      { text: hookFailureSummary(cleanup.detail), opaque: true },
    ], columns);
    appendHookPayload(obligations, cleanup.detail);
  }
  if (leak !== undefined) {
    receiptRow(obligations, "!", "leak", [
      { text: "worktree" },
      { text: leak.path, opaque: true },
    ], columns);
    receiptPayload(obligations, "diagnostic", leak.diagnostic);
  }
  if (result.lag !== undefined) {
    for (const lag of result.lag) pushBlock(obligations, lagRows(lag, columns));
  }
  for (const lag of result.settlement.lags) {
    pushBlock(obligations, settlementLagRows(lag, columns));
  }
  if (result.report?.attempt !== undefined) {
    obligations.push(...stopLines("audit", result.report.attempt, columns, result.contract));
  }
  return obligations;
}

function acceptedDeviations(result: AcceptedResult, columns: number): readonly string[] {
  const deviations: string[] = [];
  if (result.report?.targetObservation?.drift === true) {
    receiptRow(deviations, "!", "target", [{ text: `head=${result.report.targetObservation.head ?? "null"} drift=true`, opaque: true }], columns);
  }
  if (result.workspace !== undefined) pushBlock(deviations, workspaceRows(result.workspace, columns));
  if (result.overlaps !== undefined) pushBlock(deviations, overlapRows(result.overlaps, columns));
  if (result.overlapFailure !== undefined) {
    receiptRow(deviations, "~", "overlap", [{ text: "unavailable" }], columns);
    receiptPayload(deviations, "diagnostic", result.overlapFailure);
  }
  return deviations;
}

export function renderAccepted(result: AcceptedResult, context?: TextRenderContext): string {
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
