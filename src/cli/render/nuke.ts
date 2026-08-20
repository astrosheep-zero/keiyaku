import type { NukeResult } from "../../index.js";

export function renderNukeText(result: NukeResult): string {
  return result.kind === "success"
    ? `nuke success ${result.world}`
    : `nuke failed ${result.world}\n${result.diagnostic}`;
}

export function nukeExitCode(result: NukeResult): number {
  return result.kind === "failed" ? 2 : 0;
}
