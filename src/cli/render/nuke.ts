import type { CliOutcome } from "../streams.js";
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
      `  debt stores removed  ${result.value.removed.debts}`,
      "  locks  may remain · SQLite coordination files cannot be removed safely while concurrent writers may still hold them",
      ...seatClose,
    ].join("\n");
  }
  if (result.kind === "refused") {
    return renderRefusal({ operation: "nuke", refusal: result.refusal });
  }
  return "";
}

export function nukeOutcome(result: NukeResult): CliOutcome {
  return result.kind === "refused"
    ? "refused"
    : result.pending.some((surface) => surface.required)
      ? "retryable"
      : "accepted";
}
