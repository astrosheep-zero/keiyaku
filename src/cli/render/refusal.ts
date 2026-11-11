import type { BindDraftReceipt } from "../draft.js";
import { usageAcceptanceLines, type CliUsageGuide } from "../usage.js";
import type { ContractId, KeiyakuRefusal } from "../../index.js";
import type { HandoffOutcome } from "../../library/outcome.js";
import { contractOperationName, shortGitId } from "./contract-observation.js";
import {
  DEFAULT_CLI_COLUMNS,
  orderRefusalFacts,
  renderOpaqueBlock,
  safeText,
  type TextRenderContext,
} from "./terminal.js";

type DirtyWithOption = Extract<KeiyakuRefusal, { kind: "dirty-workspace" }> & {
  option?: Readonly<{ flag: string; available: boolean }>;
};
/** Edge acquisition refusals the CLI owns; they never come from the SDK. */
type CliEdgeRefusal = Readonly<{ kind: "invalid-document"; diagnostic: string }>;
export type RenderableRefusal = KeiyakuRefusal | DirtyWithOption | CliEdgeRefusal;

function wrap(lines: string[], text: string, indent: string, columns: number): void {
  lines.push(...renderOpaqueBlock(text, indent, columns));
}

function words(kind: string): string {
  return kind.replaceAll("-", " ");
}

function collectionLines(name: string, members: readonly string[], indent: string): readonly string[] {
  if (members.length === 0) return [];
  return [`${indent}${name}`, ...members.map((member) => `${indent}  ${safeText(member)}`)];
}

function addressedContract(addressed: string | undefined, contractId: string | undefined): string | undefined {
  return contractId !== undefined && contractId !== addressed ? contractId : undefined;
}

function refusalIdentity(refusal: RenderableRefusal, addressed?: string): string | undefined {
  const contractId = "contractId" in refusal && typeof refusal.contractId === "string" ? refusal.contractId : undefined;
  return addressedContract(addressed, contractId);
}

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  "contract-missing": "contract missing",
};

function refusalWords(kind: string): string {
  return REFUSAL_WORDS[kind] ?? words(kind);
}

function renderDirtyRefusal(refusal: DirtyWithOption, indent: string, columns: number): readonly string[] {
  const lines: string[] = [];
  wrap(lines, "reason  worktree has uncommitted changes", indent, columns);
  lines.push(...collectionLines("paths", refusal.paths ?? [], indent));
  lines.push(...collectionLines("submodules", refusal.submodules ?? [], indent));
  if (refusal.option === undefined) {
    if ((refusal.submodules ?? []).length > 0)
      wrap(lines, "reason  submodule changes cannot be captured for review", indent, columns);
  } else if (!refusal.option.available) {
    lines.push(`${indent}option  ${refusal.option.flag} · unavailable with submodule changes`);
  } else {
    lines.push(`${indent}option  ${refusal.option.flag} · captures complete non-ignored worktree bytes`);
    lines.push(`${indent}capture index  private · real index unchanged, including any unmerged entries`);
    lines.push(`${indent}staging  not required for --include-dirty`);
  }
  return lines;
}

function verificationRefusalFacts(
  refusal: RenderableRefusal,
  indent: string,
  identity: string | undefined,
): readonly string[] | undefined {
  const contract = identity === undefined ? [] : [`${indent}contract  ${safeText(identity)}`];
  if (refusal.kind === "verification-declaration-invalid")
    return [
      ...contract,
      `${indent}reason  Verification requires valid executable declarations; the Contract declares none`,
    ];
  if (refusal.kind === "verification-index-out-of-range")
    return [
      `${indent}reason  Verification declaration index is out of range`,
      ...contract,
      `${indent}declarations  ${refusal.total}`,
    ];
  return undefined;
}

function targetRefusalLines(
  target: string | undefined,
  indent: string,
  identity: string | undefined,
  contract: string | undefined,
): readonly string[] {
  return [
    ...(identity === undefined ? [] : [`${indent}contract  ${safeText(identity)}`]),
    ...(target === undefined ? [] : [`${indent}target  ${safeText(target)}`]),
    ...(contract === undefined ? [] : [`${indent}detail  ${safeText(contract)}`]),
  ];
}

function nukeRefusalFacts(
  refusal: Extract<RenderableRefusal, { kind: "nuke-confirmation-mismatch" | "nuke-confirmation-required" }>,
  indent: string,
): readonly string[] {
  const world = safeText(refusal.world);
  return [
    `${indent}reason  ${refusalWords(refusal.kind)}`,
    `${indent}world  ${world}`,
    ...(refusal.kind === "nuke-confirmation-mismatch"
      ? [`${indent}confirmation  ${safeText(refusal.confirmation)}`]
      : []),
    `${indent}option  keiyaku nuke --confirm '${world.replaceAll("'", "'\"'\"'")}'`,
  ];
}

function refusalFacts(
  refusal: RenderableRefusal,
  indent: string,
  columns: number,
  addressed?: string,
): readonly string[] {
  const identity = refusalIdentity(refusal, addressed);
  const target = "targetContractId" in refusal ? refusal.targetContractId : undefined;
  if (refusal.kind === "nuke-confirmation-mismatch" || refusal.kind === "nuke-confirmation-required")
    return nukeRefusalFacts(refusal, indent);
  const verification = verificationRefusalFacts(refusal, indent, identity);
  if (verification !== undefined) return verification;
  if (refusal.kind === "dirty-workspace") return renderDirtyRefusal(refusal, indent, columns);
  if (refusal.kind === "dirty-submodules") {
    return [
      `${indent}reason  submodule changes cannot be captured for review`,
      ...collectionLines("paths", refusal.paths, indent),
    ];
  }
  if (refusal.kind === "integration-conflict") {
    return [
      `${indent}reason  integration conflict`,
      ...targetRefusalLines(undefined, indent, identity, undefined),
      `${indent}target  ${safeText(refusal.targetHead)}`,
      ...collectionLines("conflicts", refusal.conflictPaths, indent),
      `${indent}option  materialize  deliver --materialize-conflict --include-dirty`,
      `${indent}option  deliver  deliver --include-dirty`,
    ];
  }
  if (refusal.kind === "not-based-on-target" || refusal.kind === "unrelated-histories") {
    return [
      `${indent}reason  ${refusalWords(refusal.kind)}`,
      ...targetRefusalLines(undefined, indent, identity, undefined),
      `${indent}target  ${safeText(refusal.targetHead)}`,
    ];
  }
  if (refusal.kind === "merge-state-present") {
    return [
      `${indent}reason  ${refusalWords(refusal.kind)}`,
      ...targetRefusalLines(undefined, indent, identity, undefined),
      `${indent}worktree  ${safeText(refusal.worktreePath)}`,
    ];
  }
  if (refusal.kind === "integration-unsupported") {
    return [
      `${indent}reason  ${refusalWords(refusal.kind)}`,
      ...targetRefusalLines(undefined, indent, identity, undefined),
    ];
  }
  if (refusal.kind === "checkout-not-followable") {
    return [
      `${indent}reason  checkout not followable`,
      ...targetRefusalLines(refusal.target, indent, identity, undefined),
      `${indent}checkout  ${safeText(refusal.path)}`,
      ...collectionLines("paths", refusal.paths, indent),
    ];
  }
  if (refusal.kind === "target-workspace-unavailable") {
    return [
      `${indent}reason  target workspace unavailable`,
      ...targetRefusalLines(target, indent, identity, words(refusal.reason)),
    ];
  }
  if (refusal.kind === "target-contract-missing" || refusal.kind === "target-contract-terminal") {
    return [
      `${indent}reason  ${refusalWords(refusal.kind)}`,
      ...targetRefusalLines(target, indent, identity, undefined),
    ];
  }
  const lines = [`${indent}reason  ${refusalWords(refusal.kind)}`];
  if (identity !== undefined) lines.push(`${indent}contract  ${safeText(identity)}`);
  if ("diagnostic" in refusal && typeof refusal.diagnostic === "string")
    for (const detail of refusal.diagnostic.split("\n")) lines.push(`${indent}detail  ${safeText(detail)}`);
  return lines;
}

export function renderRefusalFacts(
  refusal: RenderableRefusal,
  indent: string,
  columns: number,
  addressed?: string,
): readonly string[] {
  return orderRefusalFacts(
    refusalFacts(refusal, indent, columns, addressed).map((line) => line.slice(indent.length)),
  ).map((line) => `${indent}${line}`);
}

function refusalTitle(verb: string): string {
  return `× ${contractOperationName(verb)} refused`;
}

/**
 * The one refusal receipt assembly: a denied-verdict title, a labeled reason, labeled facts, and the
 * applicable acceptance grammar. Typed refusals and bare command refusals both render through here.
 */
export function renderStructuredRefusal(
  verb: string,
  reason: string,
  facts: readonly string[] = [],
  guide?: CliUsageGuide,
): string {
  const lines = [refusalTitle(verb), `  reason  ${safeText(reason)}`, ...facts.map((fact) => `  ${safeText(fact)}`)];
  if (guide !== undefined) lines.push(...usageAcceptanceLines(guide));
  return lines.join("\n");
}

/** One native refusal plus the CLI's own presentation identity; the draft belongs only to edge bind. */
type RefusedInvocation = Readonly<{
  operation: string;
  contract?: ContractId;
  refusal: RenderableRefusal;
}>;

export function renderRefusal(
  refused: RefusedInvocation,
  draft?: BindDraftReceipt,
  context?: TextRenderContext,
): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const lines = [refusalTitle(refused.operation)];
  if (refused.contract !== undefined) lines.push(`  contract  ${safeText(refused.contract)}`);
  lines.push(...renderRefusalFacts(refused.refusal, "  ", columns, refused.contract));
  const output = lines.join("\n");
  return draft === undefined ? output : `${output}\n${renderBindDraftReceipt(draft)}`;
}

export function renderConflictMaterialized(result: HandoffOutcome, _context?: TextRenderContext): string {
  const indent = "  ";
  return [
    "! integration-conflict-materialized",
    `${indent}target  ${shortGitId(result.targetHead)}`,
    `${indent}delivery  none`,
    `${indent}index  unmerged`,
    `${indent}saved  worktree bytes before projection`,
    `${indent}handoff base  ${shortGitId(result.handoffBase)}`,
    ...collectionLines("conflicts", result.conflictPaths, indent),
    `${indent}workspace  ${safeText(result.worktreePath)}`,
    `${indent}option  deliver  deliver --include-dirty · reads worktree bytes, not index`,
  ].join("\n");
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  return [
    ...(receipt.path === undefined ? [] : [`  draft  ${safeText(receipt.path)}`]),
    ...(receipt.warning === undefined ? [] : [`! draft warning  ${safeText(receipt.warning)}`]),
  ].join("\n");
}
