import type {
  KeiyakuRefusal,
  KeiyakuRetryReason,
  PlacementStop,
  RegionOverlap,
  VerificationStop,
} from "../../index.js";
import type { AcceptedResult, DiffUnavailable, Effect, Lag, RetryResult } from "../result.js";
import { renderOpaqueBlock, type TextRenderContext } from "./terminal.js";

type HookFailure = Extract<Lag, { kind: "worktree-hook-failed" }>["failure"];
type DirtyWithOption = Extract<KeiyakuRefusal, { kind: "dirty-workspace" }> & {
  option?: Readonly<{ flag: string; available: boolean }>;
};

const HANG = "   ";
const EVIDENCE = "  ";
const CHILD = "  ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrap(lines: string[], text: string, indent: string, columns: number): void {
  lines.push(...renderOpaqueBlock(text, indent, columns));
}

function collectionLines(
  name: string,
  members: readonly string[],
  indent: string,
  columns: number,
): readonly string[] {
  if (members.length === 0) return renderOpaqueBlock(`${name} 0`, indent, columns);
  return [
    ...renderOpaqueBlock(name, indent, columns),
    ...members.flatMap((member) => renderOpaqueBlock(member, `${indent}│ `, columns)),
  ];
}

function hookFailureLines(failure: HookFailure, indent: string, columns: number): readonly string[] {
  if (failure.kind === "timeout" || failure.kind === "unknown-exit") {
    return renderOpaqueBlock(failure.kind, indent, columns);
  }
  if (failure.kind === "spawn-error") {
    return renderOpaqueBlock(`spawn-error diagnostic=${failure.diagnostic}`, indent, columns);
  }
  const lines = [...renderOpaqueBlock(
    `exit code=${failure.code} truncated=${failure.truncated}`,
    indent,
    columns,
  )];
  if (failure.stdout.length > 0) lines.push(...collectionLines("stdout", [failure.stdout], indent, columns));
  if (failure.stderr.length > 0) lines.push(...collectionLines("stderr", [failure.stderr], indent, columns));
  return lines;
}

function retryLines(detail: KeiyakuRetryReason, indent: string, columns: number): readonly string[] {
  if (detail.kind === "publication-failed") {
    return renderOpaqueBlock(`publication-failed diagnostic=${detail.diagnostic}`, indent, columns);
  }
  return renderOpaqueBlock(detail.kind, indent, columns);
}

function skipAddressedContract(addressed: string | undefined, contractId: string | undefined): boolean {
  return addressed !== undefined && contractId === addressed;
}

export function renderRefusalFacts(
  refusal: KeiyakuRefusal | (KeiyakuRefusal & { option?: Readonly<{ flag: string; available: boolean }> }),
  indent: string,
  columns: number,
  addressed?: string,
): readonly string[] {
  const lines: string[] = [];
  const contractId = "contractId" in refusal ? refusal.contractId : undefined;
  const identity = skipAddressedContract(addressed, contractId) ? undefined : contractId;
  if (refusal.kind === "dirty-workspace") {
    wrap(lines, identity === undefined ? "dirty-workspace" : `dirty-workspace contractId=${identity}`, indent, columns);
    for (const name of ["staged", "unstaged", "untracked", "submodules"] as const) {
      lines.push(...collectionLines(name, refusal[name], indent, columns));
    }
    const { filesChanged, insertions, deletions } = refusal.shortStat;
    wrap(lines, `shortstat files=${filesChanged} insertions=${insertions} deletions=${deletions}`, indent, columns);
    const option = "option" in refusal ? (refusal as DirtyWithOption).option : undefined;
    if (option !== undefined) {
      wrap(
        lines,
        `option ${option.flag} ${option.available ? "available" : "unavailable"}`,
        indent,
        columns,
      );
    }
    return lines;
  }
  if (refusal.kind === "integration-failed") {
    const head = [
      "integration-failed",
      identity === undefined ? undefined : `contractId=${identity}`,
      `reason=${refusal.reason}`,
      `targetHead=${refusal.targetHead}`,
    ].filter((part) => part !== undefined).join(" ");
    wrap(lines, head, indent, columns);
    if (refusal.conflictPaths !== undefined) {
      lines.push(...collectionLines("conflictPaths", refusal.conflictPaths, indent, columns));
    }
    return lines;
  }
  if (refusal.kind === "integration-unsupported") {
    wrap(
      lines,
      [
        "integration-unsupported",
        identity === undefined ? undefined : `contractId=${identity}`,
        `requiredGit=${refusal.requiredGit}`,
      ].filter((part) => part !== undefined).join(" "),
      indent,
      columns,
    );
    return lines;
  }
  if (refusal.kind === "checkout-not-followable") {
    wrap(
      lines,
      [
        "checkout-not-followable",
        identity === undefined ? undefined : `contractId=${identity}`,
        `target=${refusal.target}`,
        `path=${refusal.path}`,
        `reason=${refusal.reason}`,
      ].filter((part) => part !== undefined).join(" "),
      indent,
      columns,
    );
    lines.push(...collectionLines("paths", refusal.paths, indent, columns));
    return lines;
  }
  if (refusal.kind === "workspace-not-on-target") {
    wrap(
      lines,
      [
        "workspace-not-on-target",
        identity === undefined ? undefined : `contractId=${identity}`,
        `target=${refusal.target}`,
        `branch=${refusal.branch}`,
      ].filter((part) => part !== undefined).join(" "),
      indent,
      columns,
    );
    return lines;
  }
  if (refusal.kind === "here-target-mismatch") {
    wrap(lines, `here-target-mismatch target=${refusal.target} branch=${refusal.branch}`, indent, columns);
    return lines;
  }
  if (refusal.kind === "here-worktree-appointed") {
    const appointed = refusal.contract === undefined ? undefined : `contract=${refusal.contract}`;
    wrap(
      lines,
      ["here-worktree-appointed", appointed, `path=${refusal.path}`].filter((part) => part !== undefined).join(" "),
      indent,
      columns,
    );
    return lines;
  }
  wrap(
    lines,
    [refusal.kind, identity === undefined ? undefined : `contractId=${identity}`]
      .filter((part) => part !== undefined)
      .join(" "),
    indent,
    columns,
  );
  return lines;
}

function obligationBody(
  stop: VerificationStop | PlacementStop,
  indent: string,
  columns: number,
  addressed: string,
): readonly string[] {
  const lines: string[] = [];
  if ("refusal" in stop && stop.refusal !== undefined) {
    wrap(lines, "refusal", indent, columns);
    lines.push(...renderRefusalFacts(stop.refusal, `${indent}${CHILD}`, columns, addressed));
    return lines;
  }
  if ("retry" in stop && stop.retry !== undefined) {
    wrap(lines, "retry", indent, columns);
    lines.push(...retryLines(stop.retry, `${indent}${CHILD}`, columns));
    return lines;
  }
  if (!("failure" in stop)) return lines;
  if (stop.failure === "environment-failure" && "command" in stop) {
    wrap(lines, `environment-failure command=${stop.command}`, indent, columns);
    lines.push(...hookFailureLines(stop.detail, `${indent}${CHILD}`, columns));
    return lines;
  }
  if (stop.failure === "target-moved") {
    const identity = skipAddressedContract(addressed, stop.contractId) ? undefined : `contractId=${stop.contractId}`;
    wrap(
      lines,
      [
        "target-moved",
        identity,
        `target=${stop.target}`,
        `expected=${stop.expected}`,
        `observed=${stop.observed}`,
      ].filter((part) => part !== undefined).join(" "),
      indent,
      columns,
    );
    return lines;
  }
  if ("diagnostic" in stop) {
    wrap(lines, `${stop.failure} diagnostic=${stop.diagnostic}`, indent, columns);
    return lines;
  }
  wrap(lines, stop.failure, indent, columns);
  return lines;
}

function stopLines(
  name: "verification" | "placement",
  stop: VerificationStop | PlacementStop,
  columns: number,
  addressed: string,
): readonly string[] {
  return [`${HANG}stop ${name}`, ...obligationBody(stop, `${HANG}${CHILD}`, columns, addressed)];
}

function outcomeLines(
  mark: "✓" | "!" | "?",
  verb: string,
  word: "accepted" | "refused" | "retry",
  contract: string | undefined,
): string[] {
  const lines = [`${mark} ${verb} ${word}`];
  if (contract !== undefined) lines.push(`└─ ${contract}`);
  return lines;
}

function changedEffect(effect: Effect): boolean {
  return effect.action !== "unchanged";
}

function effectBody(effect: Effect): string {
  const mark = changedEffect(effect) ? "✓" : "·";
  if (effect.kind === "worktree") return `${mark} worktree ${effect.action} ${effect.path}`;
  if (effect.kind === "contract-file") return `${mark} contract-file ${effect.action} ${effect.path}`;
  if (effect.kind === "target-checkout") {
    return `${mark} target-checkout ${effect.action} ${effect.target} ${effect.path}`;
  }
  return `${mark} ref ${effect.action} ${effect.name} ${effect.before ?? "null"} -> ${effect.after ?? "null"}`;
}

function lagLines(lag: Lag, columns: number): readonly string[] {
  if (lag.kind === "worktree-retained") return renderOpaqueBlock(`worktree-retained ${lag.path}`, EVIDENCE, columns);
  if (lag.kind === "unsealed-bytes") {
    const head = lag.head === undefined ? "" : ` head=${lag.head}`;
    const paths = lag.paths.length === 0 ? "" : ` paths=${lag.paths.join(",")}`;
    return renderOpaqueBlock(`unsealed-bytes ${lag.path}${head}${paths}`, EVIDENCE, columns);
  }
  if (lag.kind === "target-checkout-retained") {
    return renderOpaqueBlock(`target-checkout-retained ${lag.target} ${lag.path} ${lag.diagnostic}`, EVIDENCE, columns);
  }
  if (lag.kind === "worktree-hook-failed") {
    return [
      ...renderOpaqueBlock(`worktree-hook-failed ${lag.phase} ${lag.path} command=${lag.command}`, EVIDENCE, columns),
      ...hookFailureLines(lag.failure, `${EVIDENCE}${CHILD}`, columns),
    ];
  }
  if (lag.kind === "contract-file-failed") {
    return renderOpaqueBlock(`contract-file-failed ${lag.worktree} ${lag.path} ${lag.diagnostic}`, EVIDENCE, columns);
  }
  return renderOpaqueBlock(`reconcile-failed ${lag.stage} ${lag.diagnostic}`, EVIDENCE, columns);
}

function witnessKey(patterns: RegionOverlap["patterns"]): string {
  return patterns.map((pattern) => `${pattern.mine}\0${pattern.theirs}`).join("\n");
}

function overlapGroups(overlaps: readonly RegionOverlap[]): readonly (readonly RegionOverlap[])[] {
  const groups: RegionOverlap[][] = [];
  const indexByKey = new Map<string, number>();
  for (const overlap of overlaps) {
    const key = witnessKey(overlap.patterns);
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, groups.length);
      groups.push([overlap]);
    } else groups[existing]!.push(overlap);
  }
  return groups;
}

function overlapLines(overlaps: readonly RegionOverlap[], columns: number): readonly string[] {
  if (overlaps.length === 0) return [];
  const witnesses = overlaps.reduce((count, overlap) => count + overlap.patterns.length, 0);
  const lines = [...renderOpaqueBlock(
    `~ overlap · ${overlaps.length} contracts · ${witnesses} witnesses`,
    "",
    columns,
  )];
  for (const [index, group] of overlapGroups(overlaps).entries()) {
    if (index > 0) lines.push("");
    const patterns = group[0]!.patterns;
    if (group.length > 1) {
      wrap(lines, `${group.length} contracts × ${patterns.length} shared witnesses`, EVIDENCE, columns);
      wrap(lines, "│ contracts", EVIDENCE, columns);
      for (const overlap of group) wrap(lines, overlap.contract, `${EVIDENCE}│   `, columns);
      wrap(lines, "│ witnesses", EVIDENCE, columns);
      for (const pattern of patterns) {
        wrap(lines, `${pattern.mine} ~ ${pattern.theirs}`, `${EVIDENCE}│   `, columns);
      }
      continue;
    }
    wrap(lines, group[0]!.contract, EVIDENCE, columns);
    for (const pattern of patterns) wrap(lines, `${pattern.mine} ~ ${pattern.theirs}`, `${EVIDENCE}│ `, columns);
  }
  return lines;
}

function cleanupLines(cleanup: NonNullable<AcceptedResult["cleanup"]>, columns: number): readonly string[] {
  return [
    ...renderOpaqueBlock(`cleanup ${cleanup.phase} command=${cleanup.command}`, HANG, columns),
    ...hookFailureLines(cleanup.detail, `${HANG}${CHILD}`, columns),
  ];
}

function leakLines(leak: NonNullable<AcceptedResult["leak"]>, indent: string, columns: number): readonly string[] {
  return renderOpaqueBlock(`leak worktree ${leak.path} ${leak.diagnostic}`, indent, columns);
}

function workspaceLines(
  workspace: NonNullable<AcceptedResult["workspace"]>,
  columns: number,
): readonly string[] {
  const lines = [`${HANG}workspace`];
  for (const name of ["staged", "unstaged", "untracked"] as const) {
    const paths = workspace[name];
    if (paths.length === 0) {
      wrap(lines, `${name} 0`, `${HANG}  `, columns);
      continue;
    }
    wrap(lines, name, `${HANG}  `, columns);
    for (const path of paths) wrap(lines, path, `${HANG}  │ `, columns);
  }
  const { filesChanged, insertions, deletions } = workspace.shortStat;
  wrap(lines, `files=${filesChanged} insertions=${insertions} deletions=${deletions}`, `${HANG}  `, columns);
  return lines;
}

function reportLines(
  report: NonNullable<AcceptedResult["report"]>,
  columns: number,
  addressed: string,
): readonly string[] {
  const lines = ["report"];
  wrap(lines, `reworks ${report.reworks} · reviews ${report.reviews}`, EVIDENCE, columns);
  for (const entry of report.timeline) {
    wrap(lines, `${entry.kind} ${entry.at} sincePrior=${entry.sincePrior ?? "null"}`, EVIDENCE, columns);
    if (entry.attestation !== undefined) {
      const summary = entry.attestation.summary === undefined ? "" : ` ${entry.attestation.summary}`;
      wrap(lines, `${entry.attestation.gate} ${entry.attestation.verdict}${summary}`, `${EVIDENCE}  `, columns);
    }
  }
  if (report.delivery !== undefined) {
    const delivery = report.delivery;
    wrap(lines, [
      "delivery",
      delivery.tenderSnapshot,
      delivery.integration.snapshot,
      delivery.integration.changeId,
    ].join(" "), EVIDENCE, columns);
  }
  if (report.targetObservation !== undefined) {
    wrap(lines, `target head=${report.targetObservation.head ?? "null"} drift=${report.targetObservation.drift}`, EVIDENCE, columns);
  }
  if (report.attempt !== undefined) {
    wrap(lines, "attempt", EVIDENCE, columns);
    lines.push(...obligationBody(report.attempt, `${EVIDENCE}${CHILD}`, columns, addressed));
  }
  if (report.cleanup !== undefined) {
    wrap(lines, `cleanup ${report.cleanup.phase} command=${report.cleanup.command}`, EVIDENCE, columns);
    lines.push(...hookFailureLines(report.cleanup.detail, `${EVIDENCE}${CHILD}`, columns));
  }
  if (report.leak !== undefined) lines.push(...leakLines(report.leak, EVIDENCE, columns));
  return lines;
}

function diffLines(diff: string | DiffUnavailable, columns: number): readonly string[] {
  if (typeof diff === "string") return diff.length === 0 ? ["document diff"] : ["document diff", diff];
  return [
    "document diff",
    ...renderOpaqueBlock(
      `git-unavailable integrationSnapshot=${diff.integrationSnapshot} changeId=${diff.changeId}`,
      EVIDENCE,
      columns,
    ),
  ];
}

function settlementLines(
  settlement: AcceptedResult["settlement"],
  columns: number,
  addressed: string,
): readonly string[] {
  if (settlement.actions.length === 0 && settlement.lags.length === 0) return [];
  const lines = ["settlement"];
  for (const action of settlement.actions) {
    wrap(
      lines,
      action.kind === "task"
        ? `· task ${action.action} ${action.taskId}`
        : `· namespace-context ${action.action} ${action.path}`,
      EVIDENCE,
      columns,
    );
  }
  for (const lag of settlement.lags) {
    const identity = skipAddressedContract(addressed, lag.contractId) ? "" : ` contractId=${lag.contractId}`;
    const task = lag.taskId === undefined ? "" : ` taskId=${lag.taskId}`;
    const path = lag.path === undefined ? "" : ` path=${lag.path}`;
    wrap(
      lines,
      `settlement-failed surface=${lag.surface}${identity}${task}${path} ${lag.diagnostic}`,
      EVIDENCE,
      columns,
    );
  }
  return lines;
}

function pushBlock(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(...block);
}

export function renderAccepted(result: AcceptedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const lines = outcomeLines("✓", result.verb, "accepted", result.contract);
  wrap(lines, `head ${result.head ?? "null"}`, HANG, columns);
  for (const fact of result.facts) {
    const contract = fact.contract === result.contract ? "" : `${fact.contract} `;
    wrap(lines, `fact ${contract}${fact.entry} ${fact.kind}`, HANG, columns);
  }
  if (result.target !== undefined) wrap(lines, `target ${result.target ?? "null"}`, HANG, columns);
  for (const name of ["verification", "placement"] as const) {
    const stop = result[name];
    if (stop !== undefined) lines.push(...stopLines(name, stop, columns, result.contract));
  }
  if (result.cleanup !== undefined) lines.push(...cleanupLines(result.cleanup, columns));
  if (result.leak !== undefined) lines.push(...leakLines(result.leak, HANG, columns));
  if (result.workspace !== undefined) lines.push(...workspaceLines(result.workspace, columns));
  if (result.overlaps !== undefined) pushBlock(lines, overlapLines(result.overlaps, columns));
  if (result.overlapFailure !== undefined) {
    pushBlock(lines, ["~ overlap unavailable", ...renderOpaqueBlock(result.overlapFailure, EVIDENCE, columns)]);
  }
  if (result.report !== undefined) pushBlock(lines, reportLines(result.report, columns, result.contract));
  if (result.diff !== undefined) pushBlock(lines, diffLines(result.diff, columns));
  if (result.effects.length > 0) {
    const changed = result.effects.filter(changedEffect);
    const unchanged = result.effects.filter((effect) => !changedEffect(effect));
    pushBlock(lines, [
      "effects",
      ...[...changed, ...unchanged].flatMap((effect) => renderOpaqueBlock(effectBody(effect), EVIDENCE, columns)),
    ]);
  }
  if (result.lag !== undefined && result.lag.length > 0) {
    pushBlock(lines, ["lag", ...result.lag.flatMap((item) => lagLines(item, columns))]);
  }
  pushBlock(lines, settlementLines(result.settlement, columns, result.contract));
  return lines.join("\n");
}

export function renderRetry(result: RetryResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const detail = isRecord(result.detail) && typeof result.detail.kind === "string"
    ? retryLines(result.detail as KeiyakuRetryReason, HANG, columns)
    : [];
  return [...outcomeLines("?", result.verb, "retry", result.contract), ...detail].join("\n");
}
