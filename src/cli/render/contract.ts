import type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  BindOutcome as NativeBindOutcome,
  DeliverOutcome,
  ReviewOutcome,
  VerifyOutcome,
  ContractId,
  InvocationIssue,
  RegionOverlap,
} from "../../index.js";
import {
  deliveryIdentityRows,
  gatesAwaitLines,
  targetMovementRows,
  receiptPayload,
  receiptRow,
  recoverySnapshotLines,
  stopLines,
  titleLines,
  verificationCheckLines,
  outcomeLines,
} from "./receipt.js";
import { abbreviateGitIds, displayGitId } from "./contract-observation.js";
import {
  DEFAULT_CLI_COLUMNS,
  quotedText,
  renderOpaqueBlock,
  safeText,
  tone,
  type TextRenderContext,
} from "./terminal.js";

type BindOutcome =
  | Exclude<NativeBindOutcome, { kind: "accepted" }>
  | Omit<Extract<NativeBindOutcome, { kind: "accepted" }>, "kei">;

type ContractAnswers = {
  bind: BindOutcome;
  amend: AmendOutcome;
  arc: ArcOutcome;
  abandon: AbandonOutcome;
  deliver: DeliverOutcome;
  review: ReviewOutcome;
  verify: VerifyOutcome;
};
export type ContractMutationName = "bind" | "amend" | "deliver" | "verify" | "review" | "arc" | "abandon";
export type ContractOutcome = ContractAnswers[ContractMutationName];
export type AcceptedContractOutcome = Extract<ContractOutcome, { kind: "accepted" }>;
type AcceptedOf<K extends ContractMutationName> = Extract<ContractAnswers[K], { kind: "accepted" }>;
type PresentationInput = Readonly<{ verdict?: "satisfied" | "unsatisfied"; note?: string; message?: string }>;
type ContractReceipt = Readonly<{ contractId?: ContractId; issues?: readonly InvocationIssue[] }>;

function words(kind: string): string {
  return kind.replaceAll("-", " ");
}

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

function cleanupResourceRows(issue: InvocationIssue, columns: number): readonly string[] {
  const lines: string[] = [];
  if ("snapshot" in issue && issue.snapshot !== undefined)
    receiptRow(lines, " ", "cleanup snapshot", [{ text: issue.snapshot, opaque: true }], columns);
  if ("requirement" in issue && issue.requirement !== undefined)
    receiptRow(lines, " ", "cleanup requirement", [{ text: issue.requirement, opaque: true }], columns);
  if ("index" in issue && issue.index !== undefined)
    receiptRow(lines, " ", "cleanup check", [{ text: String(issue.index) }], columns);
  return lines;
}

type RetainedIssue = Extract<
  InvocationIssue,
  {
    kind:
      | "worktree-retained"
      | "worktree-follow-retained"
      | "unsealed-bytes"
      | "target-checkout-retained"
      | "target-workspace-retained"
      | "worktree-hook-failed"
      | "reconcile-failed"
      | "contract-file-failed";
  }
>;

function retainedIssueRows(issue: RetainedIssue, columns: number): readonly string[] {
  const lines: string[] = [];
  switch (issue.kind) {
    case "worktree-retained":
      receiptRow(lines, "!", "lag", [{ text: "worktree retained" }, { text: issue.path, opaque: true }], columns);
      if (issue.diagnostic !== undefined) receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
    case "worktree-follow-retained":
      receiptRow(
        lines,
        " ",
        "worktree follow kept at",
        [{ text: issue.path, opaque: true }, { text: `· ${words(issue.reason)}` }],
        columns,
      );
      return lines;
    case "unsealed-bytes":
      receiptRow(lines, " ", "unsealed bytes kept at", [{ text: issue.path, opaque: true }], columns);
      return lines;
    case "target-checkout-retained":
      lines.push(...checkoutBehindRows(issue.path, issue.target, columns));
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
    case "target-workspace-retained":
      receiptRow(
        lines,
        "!",
        "target workspace unavailable",
        [{ text: issue.targetContractId, opaque: true }, { text: words(issue.reason) }],
        columns,
      );
      return lines;
    case "worktree-hook-failed":
      receiptRow(
        lines,
        "!",
        "lag",
        [{ text: `worktree-hook-failed ${issue.phase} ${issue.path} name ${issue.name}`, opaque: true }],
        columns,
      );
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
    case "reconcile-failed":
      receiptRow(lines, "!", "lag", [{ text: "reconcile-failed", opaque: true }], columns);
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
    case "contract-file-failed":
      receiptRow(lines, "!", "lag", [{ text: `contract-file-failed ${issue.path}`, opaque: true }], columns);
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
  }
}

type ResidualIssue = Extract<
  InvocationIssue,
  {
    kind: "diagnostic" | "execution-stopped" | "settlement-failed";
  }
>;

function residualIssueRows(issue: ResidualIssue, columns: number): readonly string[] {
  const lines: string[] = [];
  switch (issue.kind) {
    case "diagnostic":
      lines.push(...cleanupResourceRows(issue, columns));
      receiptRow(
        lines,
        issue.severity === "required" ? "!" : " ",
        issue.severity === "required" ? "stopped" : "residue",
        [
          ...(issue.name === undefined ? [] : [{ text: `name ${quotedText(issue.name)}` }]),
          ...(issue.path === undefined ? [] : [{ text: issue.path, opaque: true }]),
        ],
        columns,
      );
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
    case "execution-stopped":
      receiptRow(
        lines,
        "!",
        "execution",
        [{ text: issue.reason }, ...(issue.contractId === undefined ? [] : [{ text: issue.contractId, opaque: true }])],
        columns,
      );
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
    case "settlement-failed":
      receiptRow(
        lines,
        "!",
        "settlement",
        issue.debtId === undefined ? [] : [{ text: issue.debtId, opaque: true }],
        columns,
      );
      receiptPayload(lines, "reason", issue.diagnostic);
      return lines;
  }
}

function issueRows(issue: InvocationIssue, columns: number): readonly string[] {
  switch (issue.kind) {
    case "worktree-retained":
    case "worktree-follow-retained":
    case "unsealed-bytes":
    case "target-checkout-retained":
    case "target-workspace-retained":
    case "worktree-hook-failed":
    case "reconcile-failed":
    case "contract-file-failed":
      return retainedIssueRows(issue, columns);
    default:
      return residualIssueRows(issue, columns);
  }
}

type IssuePresentation = Readonly<{ mode?: "receipt" | "terminal" | "exception"; follow?: boolean }>;

/** Successful retention stays typed-only unless the operation is terminal or removal failed. */
function issueIsPresented(issue: InvocationIssue, presentation: IssuePresentation): boolean {
  const mode = presentation.mode ?? "exception";
  if (mode === "exception") return true;
  if (issue.kind === "worktree-follow-retained" || issue.kind === "unsealed-bytes") return false;
  if (issue.kind === "target-checkout-retained") return presentation.follow === true;
  if (issue.kind === "worktree-retained") return mode === "terminal" || issue.diagnostic !== undefined;
  return true;
}

/** Flat issues inherit the primary owner; a distinct owner is named once before its issue. */
export function contractIssueLines(
  result: ContractReceipt,
  columns: number,
  presentation: IssuePresentation = {},
): readonly string[] {
  const lines: string[] = [];
  for (const issue of result.issues ?? []) {
    if (!issueIsPresented(issue, presentation)) continue;
    if (issue.contractId !== undefined && issue.contractId !== result.contractId)
      receiptRow(lines, "!", "issue owner", [{ text: issue.contractId, opaque: true }], columns);
    lines.push(...issueRows(issue, columns));
  }
  return lines;
}

type OverlapPattern = RegionOverlap["patterns"][number];
function groupPatterns(patterns: readonly OverlapPattern[]) {
  const identical = new Set<string>();
  const contained = new Map<string, Set<string>>();
  const intersections = new Map<string, OverlapPattern>();
  for (const pattern of patterns) {
    if (pattern.relation === undefined && pattern.mine === pattern.theirs) identical.add(pattern.mine);
    else if (pattern.relation === "mine-within-theirs" || pattern.relation === "theirs-within-mine") {
      const container = pattern.relation === "mine-within-theirs" ? pattern.theirs : pattern.mine;
      const leaf = pattern.relation === "mine-within-theirs" ? pattern.mine : pattern.theirs;
      const leaves = contained.get(container) ?? new Set<string>();
      leaves.add(leaf);
      contained.set(container, leaves);
    } else intersections.set(`${pattern.mine}\u0000${pattern.theirs}`, pattern);
  }
  return { identical, contained, intersections };
}

function overlapRows(overlaps: readonly RegionOverlap[], color: boolean): readonly string[] {
  const groups = new Map<string, OverlapPattern[]>();
  for (const overlap of overlaps)
    groups.set(overlap.contractId, [...(groups.get(overlap.contractId) ?? []), ...overlap.patterns]);
  if (groups.size === 0) return [];
  const lines = [""];
  let index = 0;
  for (const [contract, patterns] of groups) {
    if (index++ > 0) lines.push("");
    const identity = safeText(contract);
    lines.push(`  overlap  ${color ? `\u001b[1m${identity}\u001b[0m` : identity}`);
    const { identical, contained, intersections } = groupPatterns(patterns);
    const relation = (symbol: string) => tone(symbol, "dim", color);
    for (const pattern of [...identical].slice(0, 6)) lines.push(`    ${relation("≡")}  ${safeText(pattern)}`);
    if (identical.size > 6) lines.push(`    ${relation("≡")}  … (${identical.size - 6} more)`);
    for (const [container, leaves] of contained) {
      for (const leaf of [...leaves].slice(0, 6))
        lines.push(`    ${safeText(leaf)}  ${relation("⊂")}  ${safeText(container)}`);
      if (leaves.size > 6) lines.push(`    … (${leaves.size - 6} more)  ${relation("⊂")}  ${safeText(container)}`);
    }
    for (const { mine, theirs } of intersections.values())
      lines.push(`    ${relation("∩")}  ${safeText(mine)} · ${safeText(theirs)}`);
  }
  return lines;
}

function deviations(
  result: Readonly<{ overlaps?: readonly RegionOverlap[]; overlapError?: string }>,
  columns: number,
  color: boolean,
): readonly string[] {
  const lines: string[] = [];
  if (result.overlaps !== undefined) lines.push(...overlapRows(result.overlaps, color));
  if (result.overlapError !== undefined) {
    receiptRow(lines, "!", "overlap", [{ text: "unavailable" }], columns);
    receiptPayload(lines, "reason", result.overlapError);
  }
  return lines;
}

function bind(result: AcceptedOf<"bind">, columns: number, color: boolean): string {
  const lines = titleLines("✓", "bound", result.contractId, columns);
  if (result.worktreePath !== undefined)
    receiptRow(lines, " ", "worktree", [{ text: result.worktreePath, opaque: true }], columns);
  if (result.target === undefined) receiptRow(lines, " ", "no target", [], columns);
  else receiptRow(lines, " ", "target", [{ text: result.target, opaque: true }], columns);
  lines.push(
    ...deviations(result, columns, color),
    ...contractIssueLines(result, columns, { mode: "receipt" }),
    ...recoverySnapshotLines(result.recoverySnapshots, columns, result.contractId),
  );
  return lines.join("\n");
}

function amend(result: AcceptedOf<"amend">, columns: number, color: boolean): string {
  const lines = titleLines("✓", "amended", result.contractId, columns);
  if (result.changedSections === undefined && result.gatesChanged === undefined && result.afterChanged === undefined)
    receiptRow(lines, " ", "terms", [{ text: "unchanged" }], columns);
  if (result.changedSections !== undefined)
    receiptRow(lines, " ", "changed sections", [{ text: result.changedSections.join(" · ") }], columns);
  if (result.gatesChanged === true) receiptRow(lines, " ", "gates", [{ text: "changed" }], columns);
  if (result.afterChanged === true) receiptRow(lines, " ", "after", [{ text: "changed" }], columns);
  lines.push(
    ...deviations(result, columns, color),
    ...contractIssueLines(result, columns, { mode: "receipt" }),
    ...recoverySnapshotLines(result.recoverySnapshots, columns, result.contractId),
  );
  return lines.join("\n");
}

type CompletionAccepted = AcceptedOf<"deliver"> | AcceptedOf<"review"> | AcceptedOf<"verify">;

function continuationLines(
  continuation: CompletionAccepted["continuation"],
  columns: number,
  surface: TextRenderContext["surface"],
): readonly string[] {
  if (continuation === undefined) return [];
  const lines: string[] = [];
  for (const contractId of continuation.claimed ?? [])
    receiptRow(lines, "✓", "dependent", [{ text: "complete" }, { text: contractId, opaque: true }], columns);
  for (const { contractId, stop } of continuation.stopped ?? [])
    lines.push(...stopLines(stop, columns, contractId, contractId, surface));
  return lines;
}

function completionPlacementLines(
  result: CompletionAccepted,
  columns: number,
  surface: TextRenderContext["surface"],
): readonly string[] {
  const placement = result.placement;
  if (placement === undefined) return [];
  if (placement.kind !== "placed") return stopLines(placement, columns, result.contractId, undefined, surface);
  const fallback = "integration" in result ? result.integration : undefined;
  const integration = ("integration" in placement ? placement.integration : undefined) ?? fallback;
  if (integration === undefined || placement.target === undefined) return [];
  const lines: string[] = [];
  targetMovementRows(lines, { ...placement, integration }, columns);
  receiptRow(lines, "✓", "accepted", [], columns);
  return lines;
}

function trailingPlacementLines(
  result: CompletionAccepted,
  columns: number,
  surface: TextRenderContext["surface"],
): readonly string[] {
  const placement = result.placement;
  return [
    ...completionPlacementLines(result, columns, surface),
    ...continuationLines(result.continuation, columns, surface),
    ...recoverySnapshotLines(result.recoverySnapshots, columns, result.contractId),
    ...contractIssueLines(result, columns, { mode: "receipt", follow: placement !== undefined }),
    ...gatesAwaitLines(placement?.kind === "placed" ? undefined : placement),
  ];
}

function deliver(
  result: AcceptedOf<"deliver">,
  columns: number,
  input: PresentationInput,
  surface: TextRenderContext["surface"],
): string {
  const lines = titleLines("✓", "delivered", result.contractId, columns);
  const placement: Readonly<{ kind: string; predecessor?: string; integration?: string }> | undefined =
    result.placement;
  const ids = abbreviateGitIds([
    result.candidate,
    result.integration,
    result.contentId,
    result.previousContentId ?? "",
    placement?.kind === "placed" ? (placement.predecessor ?? "") : "",
    placement?.kind === "placed" ? (placement.integration ?? result.integration) : "",
  ]);
  if (result.admission === "reused") receiptRow(lines, " ", "admission", [{ text: "reused" }], columns);
  deliveryIdentityRows(
    lines,
    {
      candidate: `${displayGitId(result.candidate, ids)}${placement?.kind === "placed" ? "" : " · kept"}`,
      integration: displayGitId(result.integration, ids),
      contentId: /^0{40}$/u.test(result.contentId) ? undefined : displayGitId(result.contentId, ids),
    },
    columns,
  );
  if (result.previousContentId !== undefined)
    receiptRow(
      lines,
      " ",
      "candidate content changed",
      [{ text: `previous ${displayGitId(result.previousContentId, ids)}`, opaque: true }],
      columns,
    );
  if (input.message !== undefined && result.admission !== "reused") receiptPayload(lines, "note", input.message);
  lines.push(...trailingPlacementLines(result, columns, surface));
  return lines.join("\n");
}

function worktreeChangeLines(result: AcceptedOf<"review">, columns: number): readonly string[] {
  const lines: string[] = [];
  for (const field of ["staged", "unstaged", "untracked", "unmergedPaths"] as const)
    for (const path of result.worktreeChanges?.[field] ?? [])
      receiptRow(lines, " ", field === "unmergedPaths" ? "unmerged" : field, [{ text: path, opaque: true }], columns);
  return lines;
}

function review(
  result: AcceptedOf<"review">,
  columns: number,
  input: PresentationInput,
  surface: TextRenderContext["surface"],
): string {
  if (input.verdict === undefined) throw new Error("review renderer requires its invocation verdict");
  const lines = titleLines("✓", `review ${input.verdict}`, result.contractId, columns);
  lines.push(...worktreeChangeLines(result, columns), ...trailingPlacementLines(result, columns, surface));
  return lines.join("\n");
}

function verify(result: AcceptedOf<"verify">, columns: number, surface: TextRenderContext["surface"]): string {
  const lines = titleLines("✓", "verify", result.contractId, columns);
  lines.push(
    ...verificationCheckLines(result.checks, result.snapshot, columns, result.contractId, surface),
    ...trailingPlacementLines(result, columns, surface),
  );
  return lines.join("\n");
}

/** The operation and supplied input stay renderer context, never fields manufactured on the native result. */
export function renderAccepted<K extends ContractMutationName>(
  operation: K,
  result: AcceptedOf<K>,
  context?: TextRenderContext,
  input: PresentationInput = {},
): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  switch (operation) {
    case "bind":
      return bind(result as AcceptedOf<"bind">, columns, context?.color === true);
    case "amend":
      return amend(result as AcceptedOf<"amend">, columns, context?.color === true);
    case "deliver":
      return deliver(result as AcceptedOf<"deliver">, columns, input, context?.surface);
    case "review":
      return review(result as AcceptedOf<"review">, columns, input, context?.surface);
    case "verify":
      return verify(result as AcceptedOf<"verify">, columns, context?.surface);
    case "arc": {
      const arc = result as AcceptedOf<"arc">;
      return [
        ...titleLines("✓", `chapter ${arc.chapter} opened`, arc.contractId, columns),
        ...contractIssueLines(arc, columns, { mode: "receipt" }),
        ...recoverySnapshotLines(arc.recoverySnapshots, columns, arc.contractId),
      ].join("\n");
    }
    case "abandon": {
      const abandoned = result as AcceptedOf<"abandon">;
      const lines = titleLines("✓", "abandoned", abandoned.contractId, columns);
      if (input.note !== undefined) receiptRow(lines, " ", "note", [{ text: input.note }], columns);
      lines.push(
        ...contractIssueLines(abandoned, columns, { mode: "terminal" }),
        ...recoverySnapshotLines(abandoned.recoverySnapshots, columns, abandoned.contractId),
      );
      return lines.join("\n");
    }
  }
}

export function renderRetry(
  operation: ContractMutationName | "deliver --dry-run",
  result: Extract<ContractOutcome, { kind: "retry" }>,
  context?: TextRenderContext,
): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const lines = outcomeLines("?", operation, "retry", "contractId" in result ? result.contractId : undefined, columns);
  lines.push(...renderOpaqueBlock(words(result.reason), "  ", columns));
  if (result.reason === "publication-failed") receiptPayload(lines, "reason", result.diagnostic);
  return lines.join("\n");
}

export { renderContractHistory } from "./contract-history.js";
