import type { NukeResult } from "../../index.js";

export function renderNukeText(result: NukeResult): string {
  const seatClose =
    result.seatClose === undefined || result.seatClose.length === 0
      ? []
      : result.seatClose.flatMap((lag) => [`lag ${lag.kind}`, `diagnostic ${lag.diagnostic}`]);
  if (result.kind === "success") {
    return [`nuke success ${result.world}`, ...seatClose].join("\n");
  }
  return [`nuke failed ${result.world}`, result.diagnostic, ...seatClose].join("\n");
}

export function nukeExitCode(result: NukeResult): number {
  return result.kind === "failed" ? 2 : 0;
}
