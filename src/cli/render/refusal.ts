import type { BindDraftReceipt, RefusedResult } from "../result.js";
import type { KeiyakuRefusal } from "../../index.js";
import { renderRefusalFacts } from "./contract.js";
import type { TextRenderContext } from "./terminal.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function renderRefusal(result: RefusedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const lines = [`! ${result.verb} refused`];
  if (result.contract !== undefined) lines.push(`└─ ${result.contract}`);
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
