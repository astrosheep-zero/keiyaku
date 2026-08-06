import type { InvocationResult } from "../result.js";
import { renderObservation } from "./board.js";
import { renderAccepted, renderRetry } from "./contract.js";
import { renderRefusal } from "./refusal.js";

export function renderText(result: InvocationResult): string {
  if (result.kind === "accepted") return renderAccepted(result);
  if (result.kind === "refused") return renderRefusal(result);
  if (result.kind === "retry") return renderRetry(result);
  return renderObservation(result);
}
