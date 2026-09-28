import type { AkumaLife } from "../../akuma/heart/index.js";
import type { ContractRow } from "../../library/contract.js";
import type { TaskDisposition } from "../../task/board.js";
import type { TaskState } from "../../task/document.js";

export type TaskMarkWord = TaskDisposition | TaskState | "missing";

function unreachable(value: never): never {
  throw new Error(`unhandled Task mark word: ${String(value)}`);
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
export function contractMark(row: ContractRow): string {
  if (row.phase === "claimed") return "✓";
  if (row.phase === "abandoned") return "×";
  if (row.title === null) return "?";
  if (row.gates.reports.some((gate) => gate.current.kind === "attested" && gate.current.verdict === "unsatisfied"))
    return "!";
  if (row.targetLag.kind === "unknown") return "?";
  return "⧗";
}

/** The board's derived dispositions have their own exhaustive source lock. */
export function taskDispositionMark(disposition: TaskDisposition): string {
  switch (disposition) {
    case "ready":
      return "○";
    case "blocked":
      return "‖";
    case "in_progress":
      return "●";
    case "on_hold":
      return "⧗";
    case "done":
      return "✓";
    case "drop":
      return "×";
    default:
      return unreachable(disposition);
  }
}

/** Document states and missing references reuse the board marks where they overlap. */
export function taskMark(word: TaskMarkWord): string {
  switch (word) {
    case "open":
      return "○";
    case "missing":
      return "!";
    case "ready":
    case "blocked":
    case "in_progress":
    case "on_hold":
    case "done":
    case "drop":
      return taskDispositionMark(word);
    default:
      return unreachable(word);
  }
}
