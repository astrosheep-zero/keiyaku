import type { ObservationResult } from "../result.js";

export function renderObservation(result: ObservationResult): string {
  const { kind: _kind, command, ...observation } = result;
  return `observation ${command}\n${JSON.stringify(observation, null, 2)}`;
}
