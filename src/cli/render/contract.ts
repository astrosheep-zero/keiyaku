import type { AcceptedResult, Effect, Lag, RetryResult } from "../result.js";

function effectLine(effect: Effect): string {
  if (effect.kind === "worktree") return `effect worktree ${effect.action} ${effect.path}`.trimEnd();
  return `effect ref ${effect.action} ${effect.name} ${effect.before ?? "null"} -> ${effect.after ?? "null"}`;
}

function lagLine(lag: Lag): string {
  return lag.kind === "worktree-retained"
    ? `lag worktree-retained ${lag.path}`
    : `lag reconcile-failed ${lag.stage} ${lag.diagnostic}`;
}

function leakLine(leak: AcceptedResult["leak"]): string | undefined {
  if (leak === undefined) return undefined;
  return `leak worktree ${leak.path} ${leak.diagnostic}`;
}

export function obligationLines(value: Pick<AcceptedResult, "verification" | "placement" | "leak">): readonly string[] {
  const lines: string[] = [];
  for (const name of ["verification", "placement"] as const) {
    const stop = value[name];
    if (stop === undefined) continue;
    lines.push(`stop ${name} ${JSON.stringify(stop)}`);
  }
  const leak = leakLine(value.leak);
  if (leak !== undefined) lines.push(leak);
  return lines;
}

export function renderAccepted(result: AcceptedResult): string {
  const lines = [`accepted ${result.verb} ${result.contract} head=${result.head ?? "null"}`];
  for (const fact of result.facts) lines.push(`fact ${fact.contract} ${fact.entry} ${fact.kind}`);
  lines.push(...obligationLines(result));
  const reportLeak = leakLine(result.report?.leak);
  if (reportLeak !== undefined) lines.push(reportLeak);
  for (const overlap of result.overlaps ?? []) {
    for (const pattern of overlap.patterns) {
      lines.push(`overlap ${overlap.contract} ${pattern.mine} ~ ${pattern.theirs}`);
    }
  }
  if (result.overlapFailure !== undefined) lines.push(`overlap unavailable ${result.overlapFailure}`);
  if (result.report !== undefined) lines.push(`report ${JSON.stringify(result.report)}`);
  if (result.diff !== undefined) lines.push(typeof result.diff === "string" ? result.diff : JSON.stringify(result.diff));
  for (const effect of result.effects) lines.push(effectLine(effect));
  for (const lag of result.lag ?? []) lines.push(lagLine(lag));
  for (const action of result.settlement.actions) {
    lines.push(action.kind === "task"
      ? `settlement task ${action.action} ${action.taskId}`
      : `settlement namespace-context ${action.action} ${action.path}`);
  }
  for (const lag of result.settlement.lags) lines.push(`settlement lag ${JSON.stringify(lag)}`);
  return lines.join("\n");
}

export function renderRetry(result: RetryResult): string {
  const contract = result.contract === undefined ? "" : ` ${result.contract}`;
  return `retry ${result.verb}${contract} ${JSON.stringify(result.detail)}`;
}
