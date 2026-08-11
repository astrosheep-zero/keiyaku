import type { InvocationResult } from "../result.js";
import { renderObservation } from "./board.js";
import { renderAccepted, renderRetry } from "./contract.js";
import { renderKanshiText } from "./kanshi.js";
import { renderRefusal } from "./refusal.js";
import type { TextRenderContext } from "./terminal.js";

export function renderText(result: InvocationResult, context?: TextRenderContext): string {
  if (result.kind === "status") return renderKanshiText(result.report, context, result.selection);
  if (result.kind === "accepted") return renderAccepted(result);
  if (result.kind === "refused") return renderRefusal(result);
  if (result.kind === "retry") return renderRetry(result);
  return renderObservation(result);
}
