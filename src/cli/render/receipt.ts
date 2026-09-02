import type { PlacementStop, VerificationReuse, VerificationStop } from "../../index.js";
import type { AcceptedDeliverResult, Lag } from "../result.js";
import { renderRefusalFacts } from "./refusal.js";
import { displayColumns, renderOpaqueBlock, safeText } from "./terminal.js";

export type ReceiptSegment = Readonly<{ text: string; opaque?: boolean }>;

type HookFailure = Extract<Lag, { kind: "worktree-hook-failed" }>["failure"];

export function receiptRow(
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

export function receiptPayload(lines: string[], label: string, payload: string): void {
  lines.push(label, "", payload, "");
}

export function outcomeLines(
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

export function titleLines(mark: string, title: string, contract: string, columns = 80): string[] {
  const base = `${mark} ${title}`;
  const inline = `${base} — ${contract}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [`${base} —`, `  ${safeText(contract)}`];
}

export function hookFailureSummary(failure: HookFailure): string {
  if (failure.kind === "timeout" || failure.kind === "unknown-exit") return failure.kind;
  if (failure.kind === "spawn-error") return failure.kind;
  return `exit=${failure.code} · truncated=${failure.truncated}`;
}

export function appendHookPayload(lines: string[], failure: HookFailure): void {
  if (failure.kind === "spawn-error") receiptPayload(lines, "diagnostic", failure.diagnostic);
  if (!("stdout" in failure)) return;
  if (failure.stdout.length > 0) receiptPayload(lines, "stdout", failure.stdout);
  if (failure.stderr.length > 0) receiptPayload(lines, "stderr", failure.stderr);
}

export function reuseLines(reuse: VerificationReuse | undefined, columns: number): readonly string[] {
  if (reuse === undefined) return [];
  return renderOpaqueBlock(`reuse verification ${reuse.entry} ${reuse.verdict}`, "   ", columns);
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

function gateRows(stop: VerificationStop | PlacementStop, columns: number): readonly string[] {
  if (!("refusal" in stop) || stop.refusal?.kind !== "gates-unsatisfied") return [];
  const lines: string[] = [];
  for (const report of stop.refusal.unmet) {
    const { gate, current } = report;
    if (current.kind === "attested") {
      receiptRow(
        lines,
        " ",
        "gate",
        [{ text: gate, opaque: true }, { text: "·" }, { text: current.verdict }, { text: `· at=${current.at}` }],
        columns,
      );
      if (current.summary !== undefined) receiptPayload(lines, `  summary ${gate}`, current.summary);
    } else if (current.kind === "stale") {
      receiptRow(
        lines,
        " ",
        "gate",
        [{ text: gate, opaque: true }, { text: "· stale" }, { text: `· prior=${current.priorVerdict}` }],
        columns,
      );
    } else {
      receiptRow(lines, " ", "gate", [{ text: gate, opaque: true }, { text: "· missing" }], columns);
    }
  }
  return lines;
}

function targetMovedDetail(stop: Extract<PlacementStop, { failure: "target-moved" }>): readonly ReceiptSegment[] {
  if ("integratedAt" in stop) {
    return [
      { text: stop.target, opaque: true },
      { text: `${stop.integratedAt} -> ${stop.observed}`, opaque: true },
      { text: `attempts=${stop.attempts}` },
      ...(stop.observedTreeEqualsCandidate ? [{ text: "content=identical" }] : []),
    ];
  }
  return [
    { text: stop.target, opaque: true },
    { text: `${stop.expected} -> ${stop.observed}`, opaque: true },
    ...(stop.observedTreeEqualsCandidate ? [{ text: "content=identical" }] : []),
  ];
}

function directStopName(stop: VerificationStop | PlacementStop): string {
  if ("refusal" in stop && stop.refusal !== undefined) return stop.refusal.kind.replaceAll("-", " ");
  if ("retry" in stop && stop.retry !== undefined) return stop.retry.kind.replaceAll("-", " ");
  return stop.failure.replaceAll("-", " ");
}

function refusalEvidence(stop: VerificationStop | PlacementStop, columns: number): readonly string[] {
  const lines: string[] = [];
  lines.push(...prerequisiteRows(stop, columns));
  lines.push(...gateRows(stop, columns));
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
      "continue" in recovery &&
      typeof recovery.continue === "string"
    ) {
      receiptRow(lines, " ", "recovery materialize conflicts", [{ text: recovery.materialize }], columns);
      receiptRow(lines, " ", "recovery continue after resolve", [{ text: recovery.continue }], columns);
    }
  } else if (refusal.kind === "integration-unsupported") {
    receiptRow(lines, " ", "required Git", [{ text: refusal.requiredGit }], columns);
  }
  return lines;
}

export function stopLines(
  stop: VerificationStop | PlacementStop,
  columns: number,
  addressed: string,
  dependent?: string,
): readonly string[] {
  if ("refusal" in stop && stop.refusal?.kind === "checkout-not-followable") {
    const checkout = renderRefusalFacts(stop.refusal, "", columns, addressed);
    if (dependent === undefined) return checkout;
    const lines: string[] = [];
    receiptRow(lines, "!", "continuation", [{ text: dependent, opaque: true }], columns);
    return [...lines, ...checkout];
  }
  const lines: string[] = [];
  const segments: ReceiptSegment[] = dependent === undefined ? [] : [{ text: "·" }, { text: directStopName(stop) }];
  if ("failure" in stop && stop.failure === "target-moved") segments.push(...targetMovedDetail(stop));
  if ("failure" in stop && stop.failure === "environment-failure" && "command" in stop) {
    segments.push({ text: `command=${stop.command}` }, { text: hookFailureSummary(stop.detail), opaque: true });
  }
  receiptRow(lines, "!", dependent === undefined ? directStopName(stop) : dependent, segments, columns);
  lines.push(...refusalEvidence(stop, columns));
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

export function cleanupLines(
  cleanup: NonNullable<AcceptedDeliverResult["cleanup"]>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  receiptRow(
    lines,
    "!",
    "cleanup",
    [
      { text: cleanup.phase },
      { text: `command=${cleanup.command}` },
      { text: hookFailureSummary(cleanup.detail), opaque: true },
    ],
    columns,
  );
  appendHookPayload(lines, cleanup.detail);
  return lines;
}

export function leakLines(leak: NonNullable<AcceptedDeliverResult["leak"]>, columns: number): readonly string[] {
  const lines: string[] = [];
  receiptRow(lines, "!", "leak", [{ text: "worktree" }, { text: leak.path, opaque: true }], columns);
  receiptPayload(lines, "diagnostic", leak.diagnostic);
  return lines;
}

export function seatCloseLines(
  seatClose: NonNullable<AcceptedDeliverResult["seatClose"]>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  for (const lag of seatClose) {
    receiptRow(lines, "!", "lag", [{ text: lag.kind }], columns);
    receiptPayload(lines, "diagnostic", lag.diagnostic);
  }
  return lines;
}
