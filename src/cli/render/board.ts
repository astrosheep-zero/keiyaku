import type { ObservationResult } from "../result.js";
import { safeText } from "./terminal.js";
import { namedValueLines } from "./value.js";

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
  return `✕ observation  ${result.command}\n  diagnostic  ${report.diagnostic}`;
}

export function renderObservation(result: ObservationResult): string {
  const failed = worldObservationFailureText(result);
  if (failed !== undefined) return failed;
  const facts = Object.entries(result)
    .filter(([key]) => key !== "kind" && key !== "command")
    .flatMap(([key, value]) => namedValueLines(key, value, "  "));
  return [`observation  ${safeText(result.command)}`, ...facts].join("\n");
}
