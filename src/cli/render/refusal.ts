import type { BindDraftReceipt, RefusedResult } from "../result.js";
import type { KeiyakuRefusal } from "../../index.js";
import { renderRefusalFacts } from "./contract.js";
import { displayColumns, safeText, type TextRenderContext } from "./terminal.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function renderRefusal(result: RefusedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const base = `! ${result.verb} refused`;
  const lines = result.contract === undefined
    ? [base]
    : displayColumns(`${base} — ${result.contract}`) <= columns
      ? [`${base} — ${result.contract}`]
      : [`${base} —`, `  ${safeText(result.contract)}`];
  if (isRecord(result.refusal) && typeof result.refusal.kind === "string") {
    lines.push(...renderRefusalFacts(
      result.refusal as KeiyakuRefusal,
      "   ",
      columns,
      result.contract,
    ));
  }
  const output = lines.join("\n");
  return result.draft === undefined ? output : `${output}\n${renderBindDraftReceipt(result.draft)}`;
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  return [
    ...(receipt.path === undefined ? [] : [`draft preserved: ${receipt.path}`]),
    ...(receipt.warning === undefined ? [] : [`warning: ${receipt.warning}`]),
  ].join("\n");
}
