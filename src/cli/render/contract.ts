import type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  AuditOutcome,
  BindOutcome,
  DeliverOutcome,
  Fact,
  KeiyakuRetryReason,
  ReconciliationLag,
  RegionOverlap,
  ReviewOutcome,
  SettlementLag,
} from "../../index.js";
import {
  effectCleanup,
  effectExecutionStops,
  effectLags,
  effectRecoverySnapshot,
  effectRetainedCheckouts,
  effectRetainedWorktrees,
  effectRetiredWorktrees,
  effectSettlementLags,
} from "./effects.js";
import { renderAcceptedAudit } from "./audit.js";
import {
  appendHookPayload,
  executionCleanupLines,
  executionStopLines,
  gatesAwaitLines,
  hookFailureSummary,
  outcomeLines,
  receiptPayload,
  receiptRow,
  reuseLines,
  stopLines,
  titleLines,
} from "./receipt.js";
import { abbreviateGitIds, displayGitId, lifecycleWord } from "./contract-observation.js";
import { renderDiffstat } from "./akuma-tool.js";
import { DEFAULT_CLI_COLUMNS, renderOpaqueBlock, safeText, tone, type TextRenderContext } from "./terminal.js";

const HANG = "  ";

type Accepted<O> = Extract<O, { kind: "accepted" }>;

export type ContractOutcome =
  | BindOutcome
  | AmendOutcome
  | DeliverOutcome
  | ReviewOutcome
  | AuditOutcome
  | ArcOutcome
  | AbandonOutcome;
export type AcceptedContractOutcome = Extract<ContractOutcome, { kind: "accepted" }>;
export type RetryContractOutcome = Extract<ContractOutcome, { kind: "retry" }>;

function attestationVerdict(facts: readonly Fact[]): "satisfied" | "unsatisfied" {
  const attestation = facts.findLast(
    (fact): fact is Extract<Fact, { kind: "attestation" }> =>
      fact.kind === "attestation" && fact.data.gate === "reviewed",
  );
  if (attestation === undefined) throw new Error("accepted review is missing its reviewed attestation");
  return attestation.data.verdict;
}

function bindTarget(facts: readonly Fact[]): string | null {
  return facts.findLast((fact) => fact.kind === "bind")?.data.coordinates.target ?? null;
}

function arcChapter(facts: readonly Fact[]): Readonly<{ seq: number; title: string }> {
  const arc = facts.findLast((fact) => fact.kind === "arc");
  if (arc === undefined) throw new Error("accepted arc is missing its arc fact");
  return { seq: arc.data.seq, title: arc.data.title };
}

function abandonedNote(facts: readonly Fact[]): string | undefined {
  return facts.findLast((fact) => fact.kind === "abandoned")?.data.note;
}

function retryLines(detail: KeiyakuRetryReason, indent: string, columns: number): readonly string[] {
  if (detail.kind === "publication-failed") {
    return [...renderOpaqueBlock("publication-failed", indent, columns), ...["reason", "", detail.diagnostic, ""]];
  }
  return renderOpaqueBlock(detail.kind, indent, columns);
}

/**
 * The one word for a checkout git could not carry to the landed head: `behind` is git's own name for
 * that state, and the raw result kind never prints on a receipt.
 */
function checkoutBehindRows(path: string, target: string, columns: number): readonly string[] {
  const lines: string[] = [];
  receiptRow(
    lines,
    "!",
    "lag",
    [{ text: "checkout behind" }, { text: path, opaque: true }, { text: `· ${target}`, opaque: true }],
    columns,
  );
  return lines;
}

function lagRows(lag: ReconciliationLag, columns: number): readonly string[] {
  const lines: string[] = [];
  if (lag.kind === "worktree-retained") {
    receiptRow(lines, "!", "lag", [{ text: "worktree retained" }, { text: lag.path, opaque: true }], columns);
  } else if (lag.kind === "worktree-follow-retained") {
    receiptRow(
      lines,
      "!",
      "lag",
      [
        { text: "worktree follow retained" },
        { text: "·" },
        { text: lag.reason.replaceAll("-", " ") },
        { text: "·" },
        { text: lag.path, opaque: true },
      ],
      columns,
    );
  } else if (lag.kind === "unsealed-bytes") {
    receiptRow(lines, "!", "lag", [{ text: "unsealed bytes" }, { text: lag.path, opaque: true }], columns);
  } else if (lag.kind === "target-checkout-retained") {
    pushBlock(lines, checkoutBehindRows(lag.path, lag.target, columns));
    receiptPayload(lines, "reason", lag.diagnostic);
  } else if (lag.kind === "worktree-hook-failed") {
    receiptRow(
      lines,
      "!",
      "lag",
      [
        {
          text: `worktree-hook-failed ${lag.phase} ${lag.path} command ${lag.command} name ${lag.name} ${hookFailureSummary(lag.failure)}`,
          opaque: true,
        },
      ],
      columns,
    );
    appendHookPayload(lines, lag.failure);
  } else if (lag.kind === "contract-file-failed") {
    receiptRow(
      lines,
      "!",
      "lag",
      [{ text: `contract-file-failed ${lag.worktree} ${lag.path}`, opaque: true }],
      columns,
    );
    receiptPayload(lines, "reason", lag.diagnostic);
  } else {
    receiptRow(lines, "!", "lag", [{ text: `reconcile-failed ${lag.stage}`, opaque: true }], columns);
    receiptPayload(lines, "reason", lag.diagnostic);
  }
  return lines;
}

function settlementLagRows(lag: SettlementLag, columns: number): readonly string[] {
  const lines: string[] = [];
  receiptRow(lines, "!", "settlement", [{ text: lag.surface.replaceAll("-", " ") }], columns);
  if (lag.taskId !== undefined) receiptRow(lines, " ", "task", [{ text: lag.taskId, opaque: true }], columns);
  if (lag.path !== undefined) receiptRow(lines, " ", "path", [{ text: lag.path, opaque: true }], columns);
  receiptPayload(lines, "reason", lag.diagnostic);
  return lines;
}

type OverlapPattern = RegionOverlap["patterns"][number];

type OverlapGroup = Readonly<{
  identical: readonly string[];
  contained: readonly Readonly<{ container: string; leaves: readonly string[] }>[];
  intersections: readonly Readonly<{ mine: string; theirs: string }>[];
}>;

function overlapGroup(patterns: readonly OverlapPattern[]): OverlapGroup {
  const identical: string[] = [];
  const identicalSeen = new Set<string>();
  const contained = new Map<string, { container: string; leaves: string[] }>();
  const intersections: Array<{ mine: string; theirs: string }> = [];
  const intersectionSeen = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.relation === "same" || (pattern.relation === undefined && pattern.mine === pattern.theirs)) {
      if (!identicalSeen.has(pattern.mine)) {
        identicalSeen.add(pattern.mine);
        identical.push(pattern.mine);
      }
      continue;
    }
    if (pattern.relation === "mine-within-theirs" || pattern.relation === "theirs-within-mine") {
      const container = pattern.relation === "mine-within-theirs" ? pattern.theirs : pattern.mine;
      const leaf = pattern.relation === "mine-within-theirs" ? pattern.mine : pattern.theirs;
      const entry = contained.get(container) ?? { container, leaves: [] };
      if (!entry.leaves.includes(leaf)) entry.leaves.push(leaf);
      contained.set(container, entry);
      continue;
    }
    const key = `${pattern.mine}\u0000${pattern.theirs}`;
    if (!intersectionSeen.has(key)) {
      intersectionSeen.add(key);
      intersections.push({ mine: pattern.mine, theirs: pattern.theirs });
    }
  }

  return { identical, contained: [...contained.values()], intersections };
}

function overlapRows(overlaps: readonly RegionOverlap[], color: boolean): readonly string[] {
  const groups = new Map<string, OverlapPattern[]>();
  for (const overlap of overlaps) {
    const patterns = groups.get(overlap.contract) ?? [];
    patterns.push(...overlap.patterns);
    groups.set(overlap.contract, patterns);
  }
  if (groups.size === 0) return [];

  const lines = [""];
  let groupIndex = 0;
  for (const [contract, patterns] of groups) {
    if (groupIndex++ > 0) lines.push("");
    const identity = safeText(contract);
    lines.push(`  overlap  ${color ? `\u001b[1m${identity}\u001b[0m` : identity}`);
    const group = overlapGroup(patterns);
    const relation = (symbol: string) => tone(symbol, "dim", color);
    const bounded = group.identical.slice(0, 6);
    for (const pattern of bounded) lines.push(`    ${relation("≡")}  ${safeText(pattern)}`);
    if (group.identical.length > 6) lines.push(`    ${relation("≡")}  … (${group.identical.length - 6} more)`);
    for (const { container, leaves } of group.contained) {
      for (const leaf of leaves.slice(0, 6))
        lines.push(`    ${safeText(leaf)}  ${relation("⊂")}  ${safeText(container)}`);
      if (leaves.length > 6) lines.push(`    … (${leaves.length - 6} more)  ${relation("⊂")}  ${safeText(container)}`);
    }
    for (const { mine, theirs } of group.intersections)
      lines.push(`    ${relation("∩")}  ${safeText(mine)} · ${safeText(theirs)}`);
  }
  return lines;
}

function pushBlock(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return;
  lines.push(...block);
}

function acceptedRecord(
  result:
    | Accepted<BindOutcome>
    | Accepted<AmendOutcome>
    | Accepted<DeliverOutcome>
    | Accepted<ReviewOutcome>
    | Accepted<ArcOutcome>
    | Accepted<AbandonOutcome>,
  columns: number,
): readonly string[] {
  const record: string[] = [];
  const recoverySnapshot = effectRecoverySnapshot(result.effects);
  if (recoverySnapshot !== undefined)
    receiptRow(record, " ", "recovery snapshot", [{ text: recoverySnapshot, opaque: true }], columns);
  if (result.operation === "deliver") {
    pushBlock(record, reuseLines(result.value.verificationReuse, columns));
  }
  return record;
}

function acceptedLagRows(result: AcceptedContractOutcome, columns: number): readonly string[] {
  const obligations: string[] = [];
  // A checkout this invocation's own follow could not carry is loud; the same arm's reconciliation lag
  // is pre-existing residue and stays in the typed result only.
  for (const checkout of effectRetainedCheckouts(result.effects) ?? []) {
    pushBlock(obligations, checkoutBehindRows(checkout.path, checkout.target, columns));
  }
  for (const { contract, lag } of effectLags(result.effects)) {
    if (
      lag.kind === "worktree-retained" ||
      lag.kind === "worktree-follow-retained" ||
      lag.kind === "unsealed-bytes" ||
      lag.kind === "target-checkout-retained"
    )
      continue;
    if (contract !== result.contract)
      receiptRow(obligations, "!", "lag owner", [{ text: contract, opaque: true }], columns);
    pushBlock(obligations, lagRows(lag, columns));
  }
  for (const { contract, lag } of effectSettlementLags(result.effects)) {
    if (contract !== result.contract)
      receiptRow(obligations, "!", "settlement owner", [{ text: contract, opaque: true }], columns);
    pushBlock(obligations, settlementLagRows(lag, columns));
  }
  pushBlock(
    obligations,
    executionCleanupLines(
      effectCleanup(result.effects).filter((issue) => issue.kind !== "worktree-leak"),
      columns,
      result.contract,
    ),
  );
  pushBlock(obligations, executionStopLines(effectExecutionStops(result.effects), columns));
  return obligations;
}

function acceptedDeviations(
  result: Accepted<BindOutcome> | Accepted<AmendOutcome>,
  columns: number,
  color: boolean,
): readonly string[] {
  const deviations: string[] = [];
  if (result.value.overlaps !== undefined) pushBlock(deviations, overlapRows(result.value.overlaps, color));
  if (result.value.overlapFailure !== undefined) {
    receiptRow(deviations, "!", "overlap", [{ text: "unavailable" }], columns);
    receiptPayload(deviations, "reason", result.value.overlapFailure);
  }
  return deviations;
}

function recordBlock(
  result:
    | Accepted<BindOutcome>
    | Accepted<AmendOutcome>
    | Accepted<DeliverOutcome>
    | Accepted<ReviewOutcome>
    | Accepted<ArcOutcome>
    | Accepted<AbandonOutcome>,
  columns: number,
): readonly string[] {
  const rows = [...acceptedRecord(result, columns), ...acceptedLagRows(result, columns)];
  return rows;
}

function nonGatingVerificationLines(
  result: Accepted<DeliverOutcome> | Accepted<ReviewOutcome>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  const verification = result.value.completion?.verification;
  if (verification === undefined || verification.verdict !== "unsatisfied") return lines;
  receiptRow(
    lines,
    "!",
    "verification",
    [
      ...(verification.mode === "reused" ? [{ text: "reused" }] : []),
      { text: "unsatisfied" },
      { text: "· not required by Contract gates" },
    ],
    columns,
  );
  if (result.value.verificationSummary !== undefined) {
    receiptPayload(lines, "  summary", result.value.verificationSummary);
  }
  return lines;
}

/** A terminal command names the worktree it retired, or the retained worktree it failed to remove. */
function worktreeRetirementLines(result: AcceptedContractOutcome, columns: number): readonly string[] {
  const lines: string[] = [];
  for (const { contract, name } of effectRetiredWorktrees(result.effects)) {
    if (contract === result.contract) receiptRow(lines, " ", "worktree", [{ text: `${name} retired` }], columns);
    else
      receiptRow(
        lines,
        "!",
        "worktree owner",
        [
          { text: contract, opaque: true },
          { text: `${name} retired`, opaque: true },
        ],
        columns,
      );
  }
  for (const { contract, path } of effectRetainedWorktrees(result.effects)) {
    if (contract === result.contract)
      receiptRow(lines, "!", "lag", [{ text: "worktree retained" }, { text: path, opaque: true }], columns);
    else
      receiptRow(
        lines,
        "!",
        "worktree owner",
        [
          { text: contract, opaque: true },
          { text: `retained ${path}`, opaque: true },
        ],
        columns,
      );
  }
  return lines;
}

/** The landed diff's shape, rendered by the one diffstat rule the akuma surfaces already own. */
function landedChangesLines(
  scope: Readonly<{ filesChanged: number; insertions: number; deletions: number }> | undefined,
  columns: number,
): readonly string[] {
  if (scope === undefined) return [];
  const files = `${scope.filesChanged} ${scope.filesChanged === 1 ? "file" : "files"}`;
  const lines: string[] = [];
  receiptRow(
    lines,
    " ",
    "changes",
    [{ text: `${files} · ${renderDiffstat({ added: scope.insertions, removed: scope.deletions })}` }],
    columns,
  );
  return lines;
}

/**
 * Shared presentation of a completed placement, so a deliver and a review that placed the same candidate read
 * identically: one git-shaped target movement row, naming the reference it advanced, then the final lifecycle
 * state. Satisfied Verification adds one fact row naming the integrated result; placement made that commit the
 * reference's new head, so the movement and integrated-result rows share one sha. The verdict names reuse in the
 * audit surface's vocabulary and carries no qualifier when this command executed declarations. A completion
 * without an advanced reference states no movement. Journal ULIDs stay in JSON and `history`, never in ordinary
 * receipt text.
 */
function completedPlacementLines(
  result: Accepted<DeliverOutcome> | Accepted<ReviewOutcome>,
  columns: number,
): readonly string[] {
  const completion = result.value.completion;
  if (completion === undefined) return [];
  const abbreviations = abbreviateGitIds([
    completion.predecessor ?? "",
    completion.integration,
    ...(result.operation === "deliver"
      ? [result.value.tenderSnapshot ?? "", result.value.integration?.changeId ?? ""]
      : []),
  ]);
  const lines: string[] = [];
  if (completion.predecessor !== undefined && completion.target !== undefined) {
    receiptRow(
      lines,
      " ",
      "target",
      [
        {
          text: `${displayGitId(completion.predecessor, abbreviations)}..${displayGitId(completion.integration, abbreviations)}`,
        },
        { text: completion.target, opaque: true },
      ],
      columns,
    );
  }
  if (completion.verification?.verdict === "satisfied") {
    receiptRow(
      lines,
      " ",
      "integration result",
      [
        {
          text: `${displayGitId(completion.integration, abbreviations)} · verification ${
            completion.verification.mode === "reused" ? "reused " : ""
          }satisfied`,
        },
      ],
      columns,
    );
  }
  lines.push(...landedChangesLines(completion.scope, columns));
  lines.push(...nonGatingVerificationLines(result, columns));
  // Placement admission always admits the claim entry beside the movement, so a completed placement is accepted.
  receiptRow(lines, "✓", lifecycleWord("claimed"), [], columns);
  return lines;
}

/** Evidence handles stay in JSON and history; ordinary receipt text carries only outstanding obligations. */
function obligationLines(
  result: Accepted<DeliverOutcome> | Accepted<ReviewOutcome>,
  columns: number,
): readonly string[] {
  const rows: string[] = [];
  const recoverySnapshot = effectRecoverySnapshot(result.effects);
  if (recoverySnapshot !== undefined)
    receiptRow(rows, " ", "recovery snapshot", [{ text: recoverySnapshot, opaque: true }], columns);
  rows.push(...acceptedLagRows(result, columns));
  return rows;
}

function movementLines(result: Accepted<DeliverOutcome>, columns: number): readonly string[] {
  const count = result.facts.filter((fact) => fact.kind === "reintegrated").length;
  if (count === 0) return [];
  const lines: string[] = [];
  receiptRow(lines, "!", "target", [{ text: `moved · re-integrated x${count}` }], columns);
  return lines;
}

function continuationLines(
  result: Accepted<DeliverOutcome> | Accepted<ReviewOutcome>,
  columns: number,
): readonly string[] {
  const report = result.value.continuation;
  if (report === undefined) return [];
  const lines: string[] = [];
  for (const contractId of report.claimed) {
    receiptRow(lines, "✓", "dependent", [{ text: "complete" }, { text: contractId, opaque: true }], columns);
  }
  for (const { contractId, stop } of report.stopped) {
    if ("kind" in stop && stop.kind === "already-terminal")
      receiptRow(lines, "!", contractId, [{ text: "already terminal" }], columns);
    else if ("kind" in stop && stop.kind === "execution-stopped") lines.push(...executionStopLines([stop], columns));
    else if ("kind" in stop && stop.kind === "physical-lag") {
      receiptRow(
        lines,
        "!",
        "dependent",
        [{ text: contractId, opaque: true }, { text: "physical follow stopped" }],
        columns,
      );
    } else lines.push(...stopLines(stop, columns, contractId, contractId));
  }
  return lines;
}

function renderAcceptedBind(result: Accepted<BindOutcome>, columns: number, color: boolean): string {
  const lines = titleLines("✓", "bound", result.contract, columns);
  if (result.value.workspace !== undefined)
    receiptRow(lines, " ", "worktree", [{ text: result.value.workspace.path, opaque: true }], columns);
  const target = bindTarget(result.facts);
  if (target === null) receiptRow(lines, " ", "no target", [], columns);
  else receiptRow(lines, " ", "target", [{ text: target, opaque: true }], columns);
  for (const warning of result.value.warnings ?? [])
    receiptRow(lines, "!", "region warning", [{ text: warning }], columns);
  lines.push(...acceptedDeviations(result, columns, color), ...recordBlock(result, columns));
  return lines.join("\n");
}

function termsDiffText(diff: string): string {
  return diff.replace(/^={3,}\r?\n/u, "").replace(/^((?:---|\+\+\+) [^\r\n]*)[ \t]+$/gmu, "$1");
}

function renderAcceptedAmend(result: Accepted<AmendOutcome>, columns: number, color: boolean): string {
  const documentChanged = result.value.documentDiff.length > 0;
  const changed =
    documentChanged || result.value.changes.gates !== undefined || result.value.changes.after !== undefined;
  const lines = titleLines("✓", "amended", result.contract, columns);
  if (!changed) receiptRow(lines, " ", "terms", [{ text: "unchanged" }], columns);
  if (result.value.changes.gates !== undefined)
    receiptRow(lines, " ", "gates", [{ text: result.value.changes.gates.join(" · ") || "none" }], columns);
  if (result.value.changes.after !== undefined)
    receiptRow(lines, " ", "after", [{ text: result.value.changes.after.join(" · ") || "none" }], columns);
  if (documentChanged) receiptPayload(lines, "terms diff", termsDiffText(result.value.documentDiff));
  lines.push(...acceptedDeviations(result, columns, color), ...recordBlock(result, columns));
  return lines.join("\n");
}

function deliverIdentityLines(
  result: Accepted<DeliverOutcome>,
  abbreviations: ReadonlyMap<string, string>,
  columns: number,
): readonly string[] {
  const lines: string[] = [];
  if (result.value.leading !== undefined && result.value.leading.kind === "already-admitted")
    receiptRow(lines, " ", "leading", [{ text: result.value.leading.kind.replaceAll("-", " ") }], columns);
  if (result.value.tenderSnapshot !== undefined)
    receiptRow(
      lines,
      " ",
      "candidate",
      [{ text: displayGitId(result.value.tenderSnapshot, abbreviations), opaque: true }],
      columns,
    );
  if (result.value.integration !== undefined && !/^0{40}$/u.test(result.value.integration.changeId))
    receiptRow(
      lines,
      " ",
      "content identity (not commit)",
      [{ text: displayGitId(result.value.integration.changeId, abbreviations), opaque: true }],
      columns,
    );
  return lines;
}

function renderAcceptedDeliver(result: Accepted<DeliverOutcome>, columns: number): string {
  const complete = result.value.completion !== undefined;
  const lines = titleLines("✓", "delivered", result.contract, columns);
  const abbreviations = abbreviateGitIds([
    result.value.tenderSnapshot ?? "",
    result.value.integration?.changeId ?? "",
    result.value.verificationSubject?.snapshot ?? "",
    result.value.completion?.predecessor ?? "",
    result.value.completion?.integration ?? "",
  ]);
  lines.push(...deliverIdentityLines(result, abbreviations, columns));
  if (complete) lines.push(...completedPlacementLines(result, columns));
  else {
    const subject = result.value.verificationSubject;
    if (subject !== undefined)
      receiptRow(
        lines,
        " ",
        "integration result",
        [
          {
            text: `${displayGitId(subject.snapshot, abbreviations)} · verification ${
              subject.mode === "reused" ? "reused " : ""
            }${subject.verdict}`,
          },
        ],
        columns,
      );
    lines.push(...movementLines(result, columns));
  }
  if (result.value.verification !== undefined)
    lines.push(...stopLines(result.value.verification, columns, result.contract));
  if (!complete && result.value.placement !== undefined)
    lines.push(...stopLines(result.value.placement, columns, result.contract));
  if (!complete) receiptRow(lines, " ", "candidate", [{ text: "kept" }], columns);
  lines.push(
    ...continuationLines(result, columns),
    ...(complete ? obligationLines(result, columns) : recordBlock(result, columns)),
    ...worktreeRetirementLines(result, columns),
    ...gatesAwaitLines(result.value.placement),
  );
  return lines.join("\n");
}

function renderAcceptedReview(result: Accepted<ReviewOutcome>, columns: number): string {
  const lines = titleLines("✓", `review ${attestationVerdict(result.facts)}`, result.contract, columns);
  lines.push(...completedPlacementLines(result, columns));
  if (result.value.verification !== undefined) {
    lines.push(...stopLines(result.value.verification, columns, result.contract));
  }
  if (result.value.placement !== undefined) {
    lines.push(...stopLines(result.value.placement, columns, result.contract));
  }
  lines.push(...continuationLines(result, columns));
  lines.push(...obligationLines(result, columns));
  lines.push(...worktreeRetirementLines(result, columns));
  lines.push(...gatesAwaitLines(result.value.placement));
  return lines.join("\n");
}

function renderAcceptedArc(result: Accepted<ArcOutcome>, columns: number): string {
  const lines = titleLines(
    "✓",
    `chapter ${arcChapter(result.facts).seq} opened · ${arcChapter(result.facts).title}`,
    result.contract,
    columns,
  );
  lines.push(...recordBlock(result, columns));
  return lines.join("\n");
}

function renderAcceptedAbandon(result: Accepted<AbandonOutcome>, columns: number): string {
  const lines = titleLines("✓", "abandoned", result.contract, columns);
  const note = abandonedNote(result.facts);
  if (note !== undefined) receiptRow(lines, " ", "note", [{ text: note }], columns);
  lines.push(...recordBlock(result, columns));
  lines.push(...worktreeRetirementLines(result, columns));
  return lines.join("\n");
}

export function renderAccepted(result: AcceptedContractOutcome, context?: TextRenderContext): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  switch (result.operation) {
    case "audit":
      return renderAcceptedAudit(result, context);
    case "bind":
      return renderAcceptedBind(result, columns, context?.color === true);
    case "amend":
      return renderAcceptedAmend(result, columns, context?.color === true);
    case "review":
      return renderAcceptedReview(result, columns);
    case "arc":
      return renderAcceptedArc(result, columns);
    case "abandon":
      return renderAcceptedAbandon(result, columns);
    case "deliver":
      return renderAcceptedDeliver(result, columns);
  }
}

export function renderRetry(result: RetryContractOutcome, context?: TextRenderContext): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const detail = retryLines(result.reason, HANG, columns);
  return [...outcomeLines("?", result.operation, "retry", result.contract, columns), ...detail].join("\n");
}

export { renderContractHistory } from "./contract-history.js";
