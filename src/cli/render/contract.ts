import type { AcceptedResult, Effect, Lag, RetryResult } from "../result.js";

function effectLine(effect: Effect): string {
  if (effect.kind === "worktree") return `effect worktree ${effect.action} ${effect.path}`.trimEnd();
  if (effect.kind === "target-checkout") {
    return `effect target-checkout ${effect.action} ${effect.target} ${effect.path}`;
  }
  return `effect ref ${effect.action} ${effect.name} ${effect.before ?? "null"} -> ${effect.after ?? "null"}`;
}

function lagLine(lag: Lag): string {
  if (lag.kind === "worktree-retained") return `lag worktree-retained ${lag.path}`;
  if (lag.kind === "unsealed-bytes") {
    const head = lag.head === undefined ? "" : ` head=${lag.head}`;
    const paths = lag.paths.length === 0 ? "" : ` paths=${lag.paths.join(",")}`;
    return `lag unsealed-bytes ${lag.path}${head}${paths}`;
  }
  if (lag.kind === "target-checkout-retained") {
    return `lag target-checkout-retained ${lag.target} ${lag.path} ${lag.diagnostic}`;
  }
  if (lag.kind === "worktree-hook-failed") {
    return `lag worktree-hook-failed ${lag.phase} ${lag.path} command=${lag.command} ${JSON.stringify(lag.failure)}`;
  }
  return `lag reconcile-failed ${lag.stage} ${lag.diagnostic}`;
}

function leakLine(leak: AcceptedResult["leak"]): string | undefined {
  if (leak === undefined) return undefined;
  return `leak worktree ${leak.path} ${leak.diagnostic}`;
}

function workspaceLine(workspace: AcceptedResult["workspace"]): string | undefined {
  return workspace === undefined ? undefined : `workspace ${JSON.stringify(workspace)}`;
}

export function obligationLines(value: Pick<AcceptedResult, "verification" | "placement" | "cleanup" | "leak">): readonly string[] {
  const lines: string[] = [];
  for (const name of ["verification", "placement"] as const) {
    const stop = value[name];
    if (stop === undefined) continue;
    lines.push(`stop ${name} ${JSON.stringify(stop)}`);
  }
  if (value.cleanup !== undefined) lines.push(`cleanup ${value.cleanup.phase} command=${value.cleanup.command} ${JSON.stringify(value.cleanup.detail)}`);
  const leak = leakLine(value.leak);
  if (leak !== undefined) lines.push(leak);
  return lines;
}

function observationLines(result: AcceptedResult): readonly string[] {
  const lines: string[] = [];
  if (result.target !== undefined) lines.push(`target ${result.target ?? "null"}`);
  const reportLeak = leakLine(result.report?.leak);
  if (reportLeak !== undefined) lines.push(reportLeak);
  if (result.report?.cleanup !== undefined) {
    const cleanup = result.report.cleanup;
    lines.push(`cleanup ${cleanup.phase} command=${cleanup.command} ${JSON.stringify(cleanup.detail)}`);
  }
  for (const overlap of result.overlaps ?? []) {
    for (const pattern of overlap.patterns) {
      lines.push(`overlap ${overlap.contract} ${pattern.mine} ~ ${pattern.theirs}`);
    }
  }
  if (result.overlapFailure !== undefined) lines.push(`overlap unavailable ${result.overlapFailure}`);
  if (result.report !== undefined) lines.push(`report ${JSON.stringify(result.report)}`);
  const workspace = workspaceLine(result.workspace);
  if (workspace !== undefined) lines.push(workspace);
  if (result.diff !== undefined) lines.push(typeof result.diff === "string" ? result.diff : JSON.stringify(result.diff));
  return lines;
}

export function renderAccepted(result: AcceptedResult): string {
  const lines = [`accepted ${result.verb} ${result.contract} head=${result.head ?? "null"}`];
  for (const fact of result.facts) lines.push(`fact ${fact.contract} ${fact.entry} ${fact.kind}`);
  lines.push(...obligationLines(result));
  lines.push(...observationLines(result));
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
