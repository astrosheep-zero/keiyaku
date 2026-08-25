import type { InvocationResult } from "../result.js";
import { renderObservation } from "./board.js";
import { renderAccepted, renderContractHistory, renderRetry } from "./contract.js";
import { renderKanshiText } from "./kanshi.js";
import { renderConflictMaterialized, renderRefusal } from "./refusal.js";
import type { TextRenderContext } from "./terminal.js";
import { renderCatalogText } from "./catalog.js";
import { renderNukeText } from "./nuke.js";
import { renderRegionText } from "./region.js";
import { renderStatusSetText } from "./status-set.js";

export function renderText(result: InvocationResult, context?: TextRenderContext): string {
  if (result.kind === "guidance") return result.guidance;
  if (result.kind === "status") return renderKanshiText(result.report, context, result.selection);
  if (result.kind === "status-set") return renderStatusSetText(result, context);
  if (result.kind === "catalog") return renderCatalogText(result.catalog);
  if (result.kind === "contract-history") return renderContractHistory(result.history);
  if (result.kind === "region") return renderRegionText(result.region);
  if (result.kind === "nuke") return renderNukeText(result.result);
  if (result.kind === "accepted") return renderAccepted(result, context);
  if (result.kind === "refused") return renderRefusal(result, context);
  if (result.kind === "retry") return renderRetry(result, context);
  if (result.kind === "integration-conflict-materialized") return renderConflictMaterialized(result, context);
  return renderObservation(result);
}
