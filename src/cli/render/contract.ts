import type { AcceptedResult, Effect, RetryResult } from "../result.js";

function effectLine(effect: Effect): string {
  if (effect.kind === "worktree") return `effect worktree ${effect.action} ${effect.path ?? ""}`.trimEnd();
  return `effect ref ${effect.action} ${effect.name ?? ""} ${effect.before ?? "null"} -> ${effect.after ?? "null"}`;
}

export function renderAccepted(result: AcceptedResult): string {
  const lines = [`accepted ${result.verb} ${result.contract} head=${result.head ?? "null"}`];
  for (const fact of result.facts) lines.push(`fact ${fact.contract} ${fact.entry} ${fact.kind}`);
  if (result.report !== undefined) lines.push(`report ${JSON.stringify(result.report)}`);
  if (result.diff !== undefined) lines.push(typeof result.diff === "string" ? result.diff : JSON.stringify(result.diff));
  for (const effect of result.effects) lines.push(effectLine(effect));
  for (const lag of result.lag ?? []) {
    lines.push(`lag ${lag.kind} ${lag.contract} ${JSON.stringify(lag.error)}`);
  }
  return lines.join("\n");
}

export function renderRetry(result: RetryResult): string {
  return `retry ${result.verb} ${result.contract} ${JSON.stringify(result.detail)}`;
}
