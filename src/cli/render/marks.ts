import type { TaskDisposition } from "../../task/board.js";
import type { TaskState } from "../../task/document.js";

export type TaskMarkWord = TaskDisposition | TaskState | "missing";

function unreachable(value: never): never {
  throw new Error(`unhandled Task mark word: ${String(value)}`);
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
