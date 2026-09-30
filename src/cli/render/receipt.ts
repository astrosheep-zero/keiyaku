import type { ExecutionCleanup, ExecutionStop, PartialOutcomeEnvelope, ReconciliationLag } from "../../index.js";
import type { PlacementStop, VerificationReuse, VerificationStop } from "../../index.js";
import { renderRefusalFacts } from "./refusal.js";
import {
  DEFAULT_CLI_COLUMNS,
  displayColumns,
  orderRefusalFacts,
  renderOpaqueBlock,
  safeText,
  quotedText,
} from "./terminal.js";

export type ReceiptSegment = Readonly<{ text: string; opaque?: boolean }>;

type HookFailure = Extract<ReconciliationLag, { kind: "worktree-hook-failed" }>["failure"];

export function receiptRow(
  lines: string[],
  mark: string,
  label: string,
  segments: readonly ReceiptSegment[],
  columns: number,
): void {
  const prefix = mark.trim().length === 0 ? "  " : `${mark} `;
  let current = `${prefix}${label}`;
  for (const segment of segments) {
    const text = segment.opaque === true ? safeText(segment.text) : segment.text;
    const candidate = `${current}  ${text}`;
    if (displayColumns(candidate) <= columns) {
      current = candidate;
      continue;
    }
    if (current === `${prefix}${label}` && segment.opaque === true) {
      lines.push(current);
      current = `  ${text}`;
      continue;
    }
    lines.push(current);
    current = `  ${text}`;
  }
  lines.push(current);
}

export function receiptPayload(lines: string[], label: string, payload: string): void {
  lines.push(`  ${label.trim()}`, ...renderOpaqueBlock(payload, "  ", DEFAULT_CLI_COLUMNS), "");
}

export function outcomeLines(
  mark: "✓" | "×" | "!" | "?",
  verb: string,
  word: "accepted" | "refused" | "retry",
  contract: string | undefined,
  columns = DEFAULT_CLI_COLUMNS,
): string[] {
  const base = `${mark} ${verb} ${word}`;
  if (contract === undefined) return [base];
  const inline = `${base}  ${contract}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [`${base}`, `  contract  ${safeText(contract)}`];
}

export function refusalLines(
  verb: string,
  facts: readonly string[],
  columns = DEFAULT_CLI_COLUMNS,
  trailingFacts: readonly string[] = [],
): string[] {
  const lines = [
    ...outcomeLines("×", verb, "refused", undefined, columns),
    ...orderRefusalFacts(facts).map((fact) => `  ${fact}`),
    ...trailingFacts,
  ];
  return lines;
}

export function titleLines(mark: string, title: string, contract: string, columns = DEFAULT_CLI_COLUMNS): string[] {
  const base = `${mark} ${title}`;
  const inline = `${base}  ${contract}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [`${base}`, `  contract  ${safeText(contract)}`];
}

export function hookFailureSummary(failure: HookFailure): string {
  if (failure.kind === "timeout" || failure.kind === "unknown-exit") return failure.kind;
  if (failure.kind === "spawn-error") return failure.kind;
  return `exit ${failure.code} · output ${failure.truncated ? "truncated" : "complete"}`;
}

export function appendHookPayload(lines: string[], failure: HookFailure): void {
  if (failure.kind === "spawn-error") receiptPayload(lines, "reason", failure.diagnostic);
  if (!("stdout" in failure)) return;
  if (failure.stdout !== undefined && failure.stdout.length > 0) receiptPayload(lines, "stdout", failure.stdout);
  if (failure.stderr !== undefined && failure.stderr.length > 0) receiptPayload(lines, "stderr", failure.stderr);
}

export function reuseLines(reuse: VerificationReuse | undefined, columns: number): readonly string[] {
  if (reuse === undefined) return [];
  return renderOpaqueBlock(`reuse  verified · ${reuse.verdict}`, "  ", columns);
}

function prerequisiteRows(stop: VerificationStop | PlacementStop, columns: number): readonly string[] {
  if (!("refusal" in stop) || stop.refusal?.kind !== "prerequisites-unsatisfied") return [];
  const lines: string[] = [];
  for (const prerequisite of stop.refusal.unmet) {
    receiptRow(
      lines,
      " ",
      "prerequisite",
      [{ text: prerequisite.contractId, opaque: true }, { text: "·" }, { text: prerequisite.state }],
      columns,
    );
  }
  return lines;
}

/** Requirement names speak as plain event nouns; the "gate" class word never prints on a receipt. */
function eventNoun(gate: string): string {
  if (gate === "reviewed") return "review";
  if (gate === "verified") return "verification";
  return gate;
}

/** Only a recorded unsatisfied verdict alarms; missing and stale requirements fold into the await line. */
function gateAlarmRows(stop: VerificationStop | PlacementStop, columns: number): readonly string[] {
  if (!("refusal" in stop) || stop.refusal?.kind !== "gates-unsatisfied") return [];
  const lines: string[] = [];
  for (const report of stop.refusal.unmet) {
    const { gate, current } = report;
    if (current.kind !== "attested") continue;
    receiptRow(
      lines,
      "!",
      eventNoun(gate),
      [{ text: `· ${current.verdict}` }, { text: `· at ${current.at}` }],
      columns,
    );
    if (current.summary !== undefined) receiptPayload(lines, `  summary ${gate}`, current.summary);
  }
  return lines;
}

/**
 * The pending margin statement: the not-yet-happened requirements a refused placement awaits. A gate in stale
 * state awaits the same event; when every unmet gate already holds a recorded verdict there is nothing pending and
 * the line is omitted.
 */
export function gatesAwaitLines(placement: VerificationStop | PlacementStop | undefined): readonly string[] {
  if (placement === undefined || !("refusal" in placement) || placement.refusal?.kind !== "gates-unsatisfied")
    return [];
  const events = placement.refusal.unmet
    .filter((report) => report.current.kind !== "attested")
    .map((report) => eventNoun(report.gate));
  if (events.length === 0) return [];
  return [`⧗ awaiting ${events.length > 3 ? `${events.length} gates` : events.join(", ")}`];
}

function targetMovedDetail(stop: Extract<PlacementStop, { failure: "target-moved" }>): readonly ReceiptSegment[] {
  if ("integratedAt" in stop) {
    return [
      { text: stop.target, opaque: true },
      { text: `${stop.integratedAt} -> ${stop.observed}`, opaque: true },
      { text: `attempts ${stop.attempts}` },
      ...(stop.observedTreeEqualsCandidate ? [{ text: "content identical" }] : []),
    ];
  }
  return [
    { text: stop.target, opaque: true },
    { text: `${stop.expected} -> ${stop.observed}`, opaque: true },
    ...(stop.observedTreeEqualsCandidate ? [{ text: "content identical" }] : []),
  ];
}

function directStopName(stop: VerificationStop | PlacementStop): string {
  if ("refusal" in stop) return stop.refusal.kind.replaceAll("-", " ");
  if ("retry" in stop) return stop.retry.kind.replaceAll("-", " ");
  return stop.failure.replaceAll("-", " ");
}

function refusalEvidence(stop: VerificationStop | PlacementStop, columns: number): readonly string[] {
  const lines: string[] = [];
  lines.push(...prerequisiteRows(stop, columns));
  if (!("refusal" in stop) || stop.refusal === undefined) return lines;
  const refusal = stop.refusal;
  if (refusal.kind === "integration-failed") {
    receiptRow(lines, " ", "reason", [{ text: refusal.reason }], columns);
    receiptRow(lines, " ", "target", [{ text: refusal.targetHead, opaque: true }], columns);
    if ("conflictPaths" in refusal) {
      for (const path of refusal.conflictPaths)
        receiptRow(lines, " ", "conflict", [{ text: path, opaque: true }], columns);
    }
    const recovery = "recovery" in refusal ? refusal.recovery : undefined;
    if (
      typeof recovery === "object" &&
      recovery !== null &&
      "materialize" in recovery &&
      typeof recovery.materialize === "string" &&
      "deliver" in recovery &&
      typeof recovery.deliver === "string"
    ) {
      receiptRow(lines, " ", "materialize", [{ text: recovery.materialize }], columns);
      receiptRow(lines, " ", "deliver", [{ text: recovery.deliver }], columns);
    }
  } else if (refusal.kind === "integration-unsupported") {
    receiptRow(lines, " ", "required Git", [{ text: refusal.requiredGit }], columns);
  }
  return lines;
}

type Stop = VerificationStop | PlacementStop;

function checkoutNotFollowableStopLines(
  stop: Stop,
  columns: number,
  addressed: string,
  dependent: string | undefined,
): readonly string[] | undefined {
  if (!("refusal" in stop) || stop.refusal?.kind !== "checkout-not-followable") return undefined;
  const checkout = renderRefusalFacts(stop.refusal, "", columns, addressed);
  if (dependent === undefined) return checkout;
  const lines: string[] = [];
  receiptRow(lines, "!", "dependent", [{ text: dependent, opaque: true }], columns);
  return [...lines, ...checkout];
}

function targetPlacementFailedStopLines(
  stop: Stop,
  columns: number,
  dependent: string | undefined,
): readonly string[] | undefined {
  if (!("failure" in stop) || stop.failure !== "target-placement-failed") return undefined;
  const lines: string[] = [];
  receiptRow(lines, "×", "not accepted", dependent === undefined ? [] : [{ text: dependent, opaque: true }], columns);
  receiptPayload(lines, "reason", stop.diagnostic);
  return lines;
}

function retryStopLines(stop: Stop, columns: number, dependent: string | undefined): readonly string[] | undefined {
  if (!("retry" in stop) || stop.retry === undefined) return undefined;
  const lines: string[] = [];
  const segments: ReceiptSegment[] = [{ text: stop.retry.kind.replaceAll("-", " ") }];
  if (dependent !== undefined) segments.push({ text: "·" }, { text: dependent, opaque: true });
  receiptRow(lines, "?", "retry", segments, columns);
  if (stop.retry.kind === "publication-failed") receiptPayload(lines, "reason", stop.retry.diagnostic);
  return lines;
}

function gatesUnsatisfiedStopLines(
  stop: Stop,
  columns: number,
  dependent: string | undefined,
): readonly string[] | undefined {
  if (!("refusal" in stop) || stop.refusal?.kind !== "gates-unsatisfied") return undefined;
  // The refused placement never prints its refusal kind: the per-gate alarms and the target's non-movement
  // carry the story, and the caller closes the receipt with the awaiting margin line.
  const lines: string[] = [];
  const target = stop.refusal.target;
  if (dependent !== undefined) receiptRow(lines, "⧗", dependent, [{ text: "·" }, { text: "gates unmet" }], columns);
  else if (target !== undefined)
    receiptRow(lines, " ", "target", [{ text: target, opaque: true }, { text: "· unchanged" }], columns);
  lines.push(...gateAlarmRows(stop, columns));
  return lines;
}

function directStopLines(stop: Stop, columns: number, dependent: string | undefined): readonly string[] {
  const lines: string[] = [];
  const segments: ReceiptSegment[] = dependent === undefined ? [] : [{ text: "·" }, { text: directStopName(stop) }];
  if ("failure" in stop && stop.failure === "target-moved") segments.push(...targetMovedDetail(stop));
  if ("failure" in stop && stop.failure === "environment-failure" && "name" in stop) {
    segments.push({ text: `name ${quotedText(stop.name)}` }, { text: hookFailureSummary(stop.detail), opaque: true });
  }
  receiptRow(lines, "!", dependent === undefined ? directStopName(stop) : dependent, segments, columns);
  lines.push(...refusalEvidence(stop, columns));
  if ("failure" in stop && stop.failure === "environment-failure" && "name" in stop) {
    appendHookPayload(lines, stop.detail);
  }
  if ("failure" in stop && "diagnostic" in stop) {
    receiptPayload(lines, "reason", stop.diagnostic);
  }
  return lines;
}

export function stopLines(
  stop: VerificationStop | PlacementStop,
  columns: number,
  addressed: string,
  dependent?: string,
): readonly string[] {
  return (
    checkoutNotFollowableStopLines(stop, columns, addressed, dependent) ??
    targetPlacementFailedStopLines(stop, columns, dependent) ??
    retryStopLines(stop, columns, dependent) ??
    gatesUnsatisfiedStopLines(stop, columns, dependent) ??
    directStopLines(stop, columns, dependent)
  );
}

export function cleanupLines(
  cleanup: Extract<ExecutionCleanup, { kind: "verification-cleanup" }>["failure"],
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  receiptRow(
    lines,
    "!",
    "cleanup",
    [
      { text: cleanup.phase },
      { text: `name ${quotedText(cleanup.name)}` },
      { text: hookFailureSummary(cleanup.detail), opaque: true },
    ],
    columns,
  );
  appendHookPayload(lines, cleanup.detail);
  return lines;
}

export function leakLines(
  leak: Extract<ExecutionCleanup, { kind: "worktree-leak" }>["leak"],
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  receiptRow(lines, " ", "verification scratch kept at", [{ text: leak.path, opaque: true }], columns);
  receiptPayload(lines, "reason", leak.diagnostic);
  return lines;
}

export function seatCloseLines(
  seatClose: readonly Extract<ExecutionCleanup, { kind: "private-state-seat-close" }>["failure"][],
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  for (const lag of seatClose) {
    receiptRow(lines, "!", "lag", [{ text: lag.kind }], columns);
    receiptPayload(lines, "reason", lag.diagnostic);
  }
  return lines;
}

export function executionStopLines(stops: readonly ExecutionStop[], columns: number): readonly string[] {
  const lines: string[] = [];
  for (const stop of stops) {
    receiptRow(lines, "!", "execution", [{ text: stop.reason }, { text: stop.contractId, opaque: true }], columns);
    receiptPayload(lines, "reason", stop.diagnostic);
  }
  return lines;
}

export function executionCleanupLines(
  cleanup: readonly ExecutionCleanup[],
  columns: number,
  primary?: string,
): readonly string[] {
  const lines: string[] = [];
  for (const issue of cleanup) {
    if (primary !== undefined && issue.contractId !== primary)
      receiptRow(lines, "!", "cleanup owner", [{ text: issue.contractId, opaque: true }], columns);
    if ("snapshot" in issue && issue.snapshot !== undefined)
      receiptRow(lines, " ", "cleanup snapshot", [{ text: issue.snapshot, opaque: true }], columns);
    if (issue.kind === "verification-cleanup") lines.push(...cleanupLines(issue.failure, columns));
    else if (issue.kind === "worktree-leak") lines.push(...leakLines(issue.leak, columns));
    else if (issue.kind === "decode-channel-retirement") receiptPayload(lines, "cleanup", issue.diagnostic);
    else lines.push(...seatCloseLines([issue.failure], columns));
  }
  return lines;
}

export function executionFailureLines(
  receipt: PartialOutcomeEnvelope,
  category: string,
  diagnostic: string,
  columns: number,
): readonly string[] {
  const contract = "contract" in receipt ? receipt.contract : undefined;
  const stops: ExecutionStop[] = [];
  const cleanup: ExecutionCleanup[] = [];
  for (const effect of receipt.effects) {
    if (effect.kind === "execution-stopped")
      stops.push({
        kind: "execution-stopped",
        contractId: effect.contract,
        stage: effect.stage,
        reason: effect.reason,
        diagnostic: effect.diagnostic,
      });
    else if (effect.kind === "cleanup") cleanup.push(effect.issue);
  }
  const lines: string[] = [];
  receiptRow(
    lines,
    "!",
    "execution failed after admission",
    [{ text: category }, ...(contract === undefined ? [] : [{ text: contract, opaque: true }])],
    columns,
  );
  receiptPayload(lines, "reason", diagnostic);
  lines.push(...executionStopLines(stops, columns), ...executionCleanupLines(cleanup, columns, contract));
  return lines;
}
