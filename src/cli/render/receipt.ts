import type { PlacementStop, VerificationReuse, VerificationStop } from "../../index.js";
import type { AcceptedDeliverResult, Lag } from "../result.js";
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

export function stopLines(
  label: "verification" | "completion",
  stop: VerificationStop | PlacementStop,
  columns: number,
  addressed: string,
): readonly string[] {
  const detail = stopSummary(stop, addressed);
  const lines: string[] = [];
  const state = label === "verification" ? "failed" : "blocked";
  receiptRow(lines, "!", label, [{ text: state }, { text: "·" }, ...detail], columns);
  lines.push(...prerequisiteRows(stop, columns));
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

export function stopSummary(stop: VerificationStop | PlacementStop, addressed: string): readonly ReceiptSegment[] {
  const detail: ReceiptSegment[] = [];
  if ("refusal" in stop && stop.refusal !== undefined) {
    detail.push({ text: stop.refusal.kind });
    if ("contractId" in stop.refusal && stop.refusal.contractId !== addressed) {
      detail.push({ text: `contract=${stop.refusal.contractId}`, opaque: true });
    }
  } else if ("retry" in stop && stop.retry !== undefined) {
    detail.push({ text: stop.retry.kind });
  } else if ("failure" in stop) {
    detail.push({ text: stop.failure });
    if (stop.failure === "environment-failure" && "command" in stop) {
      detail.push({ text: `command=${stop.command}` }, { text: hookFailureSummary(stop.detail), opaque: true });
    } else if (stop.failure === "target-moved") {
      detail.push(...targetMovedDetail(stop));
    }
  }
  return detail;
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
