import type { RefusedResult } from "../result.js";

export function renderRefusal(result: RefusedResult): string {
  return `refused ${result.verb} ${result.contract} ${JSON.stringify(result.refusal)}`;
}
