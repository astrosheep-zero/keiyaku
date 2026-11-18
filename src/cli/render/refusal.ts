import type { ContractId, KeiyakuRefusal } from "../../index.js";
import type { BindDraftReceipt } from "../draft.js";
import { usageAcceptanceLines, type CliUsageGuide } from "../usage.js";
import { evidenceLines, fact } from "./receipt.js";
import { contractOperationName } from "./contract-observation.js";
import { formatNextCall, safeText, type RecoveryCall, type TextRenderContext } from "./terminal.js";

export type RenderableRefusal = KeiyakuRefusal | Readonly<{ kind: "invalid-document"; diagnostic: string }>;

export function callLines(next: RecoveryCall | undefined, context: TextRenderContext): string[] {
  const text = next === undefined ? undefined : formatNextCall(next, context);
  return text === undefined ? [] : [`  available  ${text}`];
}

export function refusalRecoveryLines(
  reason: Readonly<{ kind: string; submodules?: readonly string[] }>,
  call: Exclude<RecoveryCall, { verb: "ls" }>,
  context: TextRenderContext,
): string[] {
  if (reason.kind === "dirty-workspace") {
    if ((reason.submodules?.length ?? 0) > 0) return ["  capture  unavailable with submodule changes"];
    if (call.input.includeDirty !== true)
      return callLines({ ...call, input: { ...call.input, includeDirty: true } }, context);
  }
  if (
    reason.kind === "integration-conflict" &&
    call.verb === "deliver" &&
    call.input.dryRun !== true &&
    call.input.materializeConflict !== true
  ) {
    return callLines(
      { verb: call.verb, input: { ...call.input, materializeConflict: true, includeDirty: true } },
      context,
    );
  }
  return [];
}

export function renderStructuredRefusal(
  verb: string,
  reason: string,
  facts: readonly string[] = [],
  guide?: CliUsageGuide,
): string {
  return [
    `× ${contractOperationName(verb)} refused`,
    `  reason  ${safeText(reason)}`,
    ...facts.map((value) => `  ${safeText(value)}`),
    ...(guide === undefined ? [] : usageAcceptanceLines(guide)),
  ].join("\n");
}

/** Invocation assembly only; native stop selection belongs to receipt. */
export function renderRefusal(
  refused: Readonly<{ operation: string; contract?: ContractId; refusal: RenderableRefusal }>,
  draft?: BindDraftReceipt,
): string {
  const { refusal, operation } = refused;
  const name = contractOperationName(operation);
  const title = operation === "bind" ? `${name} refused` : `× ${name} refused`;
  const lines = [title];
  fact(lines, "contract", refused.contract);
  if (refusal.kind === "nuke-confirmation-required" || refusal.kind === "nuke-confirmation-mismatch") {
    fact(lines, "reason", refusal.kind.replaceAll("-", " "));
    fact(lines, "world", refusal.world);
    if (refusal.kind === "nuke-confirmation-mismatch") fact(lines, "confirmation", refusal.confirmation);
    lines.push(`  option  keiyaku nuke --confirm '${safeText(refusal.world).replaceAll("'", "'\"'\"'")}'`);
  } else lines.push(...evidenceLines(refusal));
  if (draft !== undefined) lines.push(renderBindDraftReceipt(draft));
  return lines.join("\n");
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  const lines: string[] = [];
  fact(lines, "draft", receipt.path);
  if (receipt.warning !== undefined) lines.push(`! draft warning  ${safeText(receipt.warning)}`);
  return lines.join("\n");
}
