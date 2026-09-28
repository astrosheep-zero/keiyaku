import type { NukeResult } from "../../index.js";

export function renderNukeText(result: NukeResult): string {
  const seatClose =
    result.seatClose === undefined || result.seatClose.length === 0
      ? []
      : result.seatClose.flatMap((lag) => [`  lag  ${lag.kind}`, `  diagnostic  ${lag.diagnostic}`]);
  if (result.kind === "success") {
    return [
      `✓ nuke  ${result.world}`,
      `  refs removed  ${result.removed.refs}`,
      `  worktrees removed  ${result.removed.worktrees}`,
      `  task stores removed  ${result.removed.tasks}`,
      "  locks  may remain · SQLite coordination files cannot be removed safely while concurrent writers may still hold them",
      ...seatClose,
    ].join("\n");
  }
  return [`× nuke  ${result.world}`, `  diagnostic  ${result.diagnostic}`, ...seatClose].join("\n");
}

export function nukeExitCode(result: NukeResult): number {
  return result.kind === "failed" ? 2 : 0;
}
