import type {
  ContractHistory,
  ContractHistoryEvent,
  Fact,
  KeiyakuRetryReason,
  RegionOverlap,
} from "../../index.js";
import type {
  AcceptedAbandonResult,
  AcceptedAmendResult,
  AcceptedArcResult,
  AcceptedBindResult,
  AcceptedDeliverResult,
  AcceptedEnvelope,
  AcceptedResult,
  AcceptedReviewResult,
  Effect,
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

function settlementLagRows(lag: AcceptedEnvelope["settlement"]["lags"][number], columns: number): readonly string[] {
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
  workspace: NonNullable<AcceptedReviewResult["workspace"]>,
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

function acceptedRecord(
  result: AcceptedBindResult | AcceptedAmendResult | AcceptedDeliverResult | AcceptedReviewResult | AcceptedArcResult | AcceptedAbandonResult,
  columns: number,
): readonly string[] {
  const record: string[] = [];
  receiptRow(record, " ", "head", [{ text: result.head, opaque: true }], columns);
  for (const fact of result.facts) {
    const contract = fact.contract === result.contract ? [] : [{ text: fact.contract, opaque: true }];
    receiptRow(record, " ", "journal", [
      ...contract,
      { text: fact.entry, opaque: true },
      { text: `· ${fact.kind}` },
    ], columns);
  }
  if (result.verb === "bind") {
    receiptRow(record, " ", "target", [{ text: result.target ?? "null", opaque: true }], columns);
  }
  if (result.verb === "deliver") {
    pushBlock(record, reuseLines(result.verificationReuse, columns));
  }
  if (result.verb === "amend") {
    receiptPayload(record, "diff", result.diff);
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

function acceptedLagRows(result: AcceptedEnvelope, columns: number): readonly string[] {
  const obligations: string[] = [];
  if (result.lag !== undefined) {
    for (const lag of result.lag) pushBlock(obligations, lagRows(lag, columns));
  }
  for (const lag of result.settlement.lags) {
    pushBlock(obligations, settlementLagRows(lag, columns));
  }
  return obligations;
}

function acceptedObligations(
  result: AcceptedDeliverResult | AcceptedReviewResult,
  columns: number,
): readonly string[] {
  const obligations: string[] = [];
  if (result.verb === "deliver" && result.verification !== undefined) {
    obligations.push(...stopLines("verification", result.verification, columns, result.contract));
  }
  if (result.placement !== undefined) {
    obligations.push(...stopLines("claim", result.placement, columns, result.contract));
  }
  if (result.verb === "deliver") {
    if (result.cleanup !== undefined) pushBlock(obligations, cleanupLines(result.cleanup, columns));
    if (result.leak !== undefined) pushBlock(obligations, leakLines(result.leak, columns));
  }
  obligations.push(...acceptedLagRows(result, columns));
  return obligations;
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

function renderAcceptedReceipt(
  result: AcceptedBindResult | AcceptedAmendResult | AcceptedDeliverResult | AcceptedReviewResult | AcceptedArcResult | AcceptedAbandonResult,
  context?: TextRenderContext,
): string {
  const columns = context?.columns ?? 80;
  const lines = outcomeLines("✓", result.verb, "accepted", result.contract, columns);
  if (result.verb === "deliver" || result.verb === "review") {
    lines.push(...acceptedObligations(result, columns));
  } else {
    lines.push(...acceptedLagRows(result, columns));
  }
  if (result.verb === "bind" || result.verb === "amend" || result.verb === "review") {
    lines.push(...acceptedDeviations(result, columns));
  }
  lines.push(...acceptedRecord(result, columns));
  return lines.join("\n");
}

export function renderAccepted(result: AcceptedResult, context?: TextRenderContext): string {
  switch (result.verb) {
    case "audit":
      return renderAcceptedAudit(result, context);
    case "bind":
    case "amend":
    case "deliver":
    case "review":
    case "arc":
    case "abandon":
      return renderAcceptedReceipt(result, context);
  }
}

export function renderRetry(result: RetryResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const detail = isRecord(result.detail) && typeof result.detail.kind === "string"
    ? retryLines(result.detail as KeiyakuRetryReason, HANG, columns)
    : [];
  return [...outcomeLines("?", result.verb, "retry", result.contract, columns), ...detail].join("\n");
}

function journalCount(events: readonly ContractHistoryEvent[], source: ContractHistoryEvent["source"]): number {
  return events.filter((event) => event.source === source).length;
}

function journalHead(fact: Fact): string {
  return fact.actor === undefined
    ? `${fact.at} ${fact.kind} · ${fact.entry}`
    : `${fact.at} ${fact.kind} · ${fact.entry} · ${fact.actor}`;
}

function listFact(label: string, values: readonly string[]): readonly string[] {
  return values.length === 0 ? [`  ${label} 0`] : [`  ${label} ${values.join(" · ")}`];
}

function journalBody(fact: Fact): readonly string[] {
  switch (fact.kind) {
    case "bind": {
      const { coordinates, terms } = fact.data;
      return [
        `  start ${coordinates.start}`,
        ...(coordinates.target === undefined ? [] : [`  target ${coordinates.target}`]),
        `  workspace ${coordinates.workspace}`,
        `  document ${terms.document.key}`,
        ...listFact("gates", terms.gates),
        ...listFact("after", terms.after),
      ];
    }
    case "amend":
      return [
        `  document ${fact.data.document.key}`,
        ...listFact("gates", fact.data.gates),
        ...listFact("after", fact.data.after),
      ];
    case "bound":
      return [];
    case "deliver": {
      const { tenderSnapshot, integration, method, policy } = fact.data;
      return [
        `  tender ${tenderSnapshot}`,
        `  predecessor ${integration.predecessor}`,
        `  snapshot ${integration.snapshot}`,
        `  change ${integration.changeId}`,
        `  method ${method}`,
        `  require-branches-to-be-up-to-date ${String(policy.requireBranchesToBeUpToDate)}`,
      ];
    }
    case "attestation": {
      const lines = [
        `  gate ${fact.data.gate}`,
        `  verdict ${fact.data.verdict}`,
        `  subject ${fact.data.subject}`,
      ];
      if (fact.data.summary !== undefined) receiptPayload(lines, "summary", fact.data.summary);
      return lines;
    }
    case "claimed":
      return [`  delivery ${fact.data.delivery}`];
    case "arc": {
      const lines = [`  sequence ${String(fact.data.seq)}`, `  title ${fact.data.title}`];
      receiptPayload(lines, "objective", fact.data.objective);
      receiptPayload(lines, "brief", fact.data.brief);
      return lines;
    }
    case "abandoned": {
      if (fact.data.note === undefined) return [];
      const lines: string[] = [];
      receiptPayload(lines, "note", fact.data.note);
      return lines;
    }
  }
}

function contractHistoryEventLines(event: ContractHistoryEvent): readonly string[] {
  if (event.source === "dispatch") {
    return [`${event.dispatch.dispatchedAt} dispatch · ${event.dispatch.akuId}`];
  }
  return [journalHead(event.fact), ...journalBody(event.fact)];
}

export function renderContractHistory(history: ContractHistory): string {
  const journals = journalCount(history.events, "journal");
  const dispatches = journalCount(history.events, "dispatch");
  return [
    `history ${history.id} · ${journals} journal · ${dispatches} dispatch`,
    "",
    ...history.events.flatMap(contractHistoryEventLines),
  ].join("\n");
}
