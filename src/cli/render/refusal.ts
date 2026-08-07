import type { RefusedResult } from "../result.js";

export function renderRefusal(result: RefusedResult): string {
  const contract = result.contract === undefined ? "" : ` ${result.contract}`;
  return `refused ${result.verb}${contract} ${JSON.stringify(result.refusal)}`;
}
