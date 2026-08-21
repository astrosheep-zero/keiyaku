import type { ObservationResult } from "../result.js";

export function worldObservationFailureText(result: ObservationResult): string | undefined {
  if (result.command !== "reconcile") return undefined;
  const report = result.report;
  if (
    typeof report !== "object" ||
    report === null ||
    !("kind" in report) ||
    report.kind !== "world-observation-failed" ||
    !("diagnostic" in report) ||
    typeof report.diagnostic !== "string"
  ) {
    return undefined;
  }
  return `reconcile: world observation failed · ${report.diagnostic}`;
}

export function renderObservation(result: ObservationResult): string {
  const failed = worldObservationFailureText(result);
  if (failed !== undefined) return failed;
  const { kind: _kind, command, ...observation } = result;
  return [`observation ${command}`, JSON.stringify(observation, null, 2)].join("\n");
}
