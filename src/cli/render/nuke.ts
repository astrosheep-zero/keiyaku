import type { NukeResult } from "../../index.js";
import { renderRefusal } from "./refusal.js";

export function renderNukeText(result: NukeResult): string {
  const seatClose =
    result.effects.length > 0
      ? result.effects.flatMap((effect) => [`  lag  ${effect.kind}`, `  reason  ${effect.diagnostic}`])
      : [];
  if (result.kind === "accepted") {
    return [
      `✓ nuke  ${result.world}`,
      `  refs removed  ${result.value.removed.refs}`,
      `  worktrees removed  ${result.value.removed.worktrees}`,
      `  task stores removed  ${result.value.removed.tasks}`,
      "  locks  may remain · SQLite coordination files cannot be removed safely while concurrent writers may still hold them",
      ...seatClose,
    ].join("\n");
  }
  if (result.kind === "refused") {
    return renderRefusal({ operation: "nuke", refusal: result.refusal });
  }
  return "";
}

export function nukeExitCode(result: NukeResult): number {
  return result.kind === "refused" ? 1 : result.pending.some((surface) => surface.required) ? 2 : 0;
}
