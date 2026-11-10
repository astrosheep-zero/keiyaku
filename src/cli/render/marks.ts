import type { AkumaLife } from "../../akuma/heart/index.js";
import type { ContractDetail, ContractGateReport, ContractSummary } from "../../protocol/read/status.js";
import type { DebtDisposition } from "../../debt/board.js";
import type { DebtState } from "../../debt/document.js";

export type DebtMarkWord = DebtDisposition | DebtState | "missing";

function unreachable(value: never): never {
  throw new Error(`unhandled Debt mark word: ${String(value)}`);
}

/** Akuma life marks are one vocabulary; render surfaces consume and never re-derive them. */
export function akumaMark(life: AkumaLife | "unborn" | "stillborn"): string {
  switch (life) {
    case "running":
      return "●";
    case "asleep":
    case "unborn":
      return "○";
    case "stranded":
    case "untidy":
    case "stillborn":
      return "!";
    case "killed":
      return "×";
    case "hung":
      return "?";
    default:
      return unreachable(life);
  }
}

/** Contract board marks weigh phase, gates, and target knowledge in one fixed order. */
export function contractMark(row: ContractSummary): string {
  if (row.title === undefined) return "?";
  if ((row.gates ?? []).some((gate) => gate.verdict === "unsatisfied")) return "!";
  if (row.attention !== undefined) return "!";
  return "⧗";
}

/** A selected detail carries the same judgment from its owner currentness instead of summary verdicts. */
export function contractDetailMark(row: {
  phase: ContractDetail["phase"];
  title?: string;
  gates?: readonly ContractGateReport[];
  targetLag?: Readonly<{ kind: string }>;
}): string {
  if (row.phase === "claimed") return "✓";
  if (row.phase === "abandoned") return "×";
  if (row.title === undefined) return "?";
  if (
    (row.gates ?? []).some((gate) =>
      gate.requirements.some(
        (requirement) => requirement.current.kind === "attested" && requirement.current.verdict === "unsatisfied",
      ),
    )
  )
    return "!";
  if (row.targetLag?.kind === "unknown") return "?";
  return "⧗";
}

/** The board's derived dispositions have their own exhaustive source lock. */
export function debtDispositionMark(disposition: DebtDisposition): string {
  switch (disposition) {
    case "ready":
      return "○";
    case "blocked":
      return "‖";
    case "done":
      return "✓";
    case "drop":
      return "×";
    default:
      return unreachable(disposition);
  }
}

/** Document states and missing references reuse the board marks where they overlap. */
export function debtMark(word: DebtMarkWord): string {
  switch (word) {
    case "open":
      return "○";
    case "missing":
      return "!";
    case "ready":
    case "blocked":
    case "done":
    case "drop":
      return debtDispositionMark(word);
    default:
      return unreachable(word);
  }
}
