import type { BindDraftReceipt, RefusedResult } from "../result.js";
import type { IntegrationConflictMaterialized, KeiyakuRefusal } from "../../index.js";
import {
  checkoutNotFollowableLines,
  displayColumns,
  gitShortStat,
  renderOpaqueBlock,
  safeText,
  type TextRenderContext,
} from "./terminal.js";

type DirtyWithOption = Extract<KeiyakuRefusal, { kind: "dirty-workspace" }> & {
  option?: Readonly<{ flag: string; available: boolean }>;
};
export type RenderableRefusal = KeiyakuRefusal | DirtyWithOption;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrap(lines: string[], text: string, indent: string, columns: number): void {
  lines.push(...renderOpaqueBlock(text, indent, columns));
}

function collectionLines(name: string, members: readonly string[], indent: string): readonly string[] {
  if (members.length === 0) return [`${indent}${name}  0`];
  return [`${indent}${name}`, ...members.map((member) => `${indent}  ${safeText(member)}`)];
}

function skipAddressedContract(addressed: string | undefined, contractId: string | undefined): boolean {
  return addressed !== undefined && contractId === addressed;
}

function refusalIdentity(refusal: RenderableRefusal, addressed?: string): string | undefined {
  const contractId = "contractId" in refusal ? refusal.contractId : undefined;
  return skipAddressedContract(addressed, contractId) ? undefined : contractId;
}

function refusalHead(kind: string, identity: string | undefined, details: readonly string[]): string {
  return [kind, identity, ...details].filter((part): part is string => part !== undefined).join("  ");
}

function renderDirtyRefusal(
  refusal: DirtyWithOption,
  indent: string,
  columns: number,
  identity: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  wrap(lines, refusalHead(refusal.kind, identity, []), indent, columns);
  wrap(lines, "reason  worktree has uncommitted changes", indent, columns);
  for (const name of ["staged", "unstaged", "untracked", "submodules"] as const) {
    lines.push(...collectionLines(name, refusal[name], indent));
  }
  wrap(lines, gitShortStat(refusal.shortStat), indent, columns);
  if (refusal.option?.available === false) {
    lines.push(`${indent}option  --include-dirty · unavailable with submodule changes`);
  } else {
    lines.push(`${indent}option  --include-dirty · captures complete non-ignored worktree bytes`);
    lines.push(`${indent}capture index  private · real index unchanged, including any unmerged entries`);
    lines.push(`${indent}staging  not required for --include-dirty`);
  }
  return lines;
}

export function renderRefusalFacts(
  refusal: RenderableRefusal,
  indent: string,
  columns: number,
  addressed?: string,
): readonly string[] {
  const identity = refusalIdentity(refusal, addressed);
  if (refusal.kind === "nuke-confirmation-mismatch" || refusal.kind === "nuke-confirmation-required") {
    const world = safeText(refusal.world);
    return [
      `${indent}nuke confirmation ${refusal.kind === "nuke-confirmation-mismatch" ? "mismatch" : "required"}`,
      `${indent}world  ${world}`,
      ...(refusal.kind === "nuke-confirmation-mismatch"
        ? [`${indent}confirmation  ${safeText(refusal.confirmation)}`]
        : []),
      `${indent}nuke  keiyaku nuke --confirm '${world.replaceAll("'", "'\"'\"'")}'`,
    ];
  }
  if (refusal.kind === "dirty-workspace") return renderDirtyRefusal(refusal, indent, columns, identity);
  if (refusal.kind === "unmerged-paths") {
    return [
      ...renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns),
      ...collectionLines("paths", refusal.paths, indent),
    ];
  }
  if (refusal.kind === "integration-failed") {
    const lines = [...renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns)];
    lines.push(`${indent}reason  ${safeText(refusal.reason)}`, `${indent}target  ${safeText(refusal.targetHead)}`);
    if (refusal.conflictPaths !== undefined) lines.push(...collectionLines("conflicts", refusal.conflictPaths, indent));
    if ("recovery" in refusal && refusal.recovery !== undefined) {
      lines.push(`${indent}materialize  ${safeText(refusal.recovery.materialize)}`);
      lines.push(`${indent}deliver  ${safeText(refusal.recovery.continue)}`);
    }
    return lines;
  }
  if (refusal.kind === "merge-state-present") {
    return [
      ...renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns),
      `${indent}workspace kind  ${refusal.workspace.kind}`,
      `${indent}workspace  ${safeText(refusal.workspace.path)}`,
    ];
  }
  if (refusal.kind === "integration-unsupported") {
    return [
      ...renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns),
      `${indent}required Git  ${safeText(refusal.requiredGit)}`,
    ];
  }
  if (refusal.kind === "checkout-not-followable") {
    return checkoutNotFollowableLines(refusal);
  }
  return renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns);
}

export function renderRefusal(result: RefusedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const base = `✕ ${result.verb} refused`;
  const lines =
    result.contract === undefined
      ? [base]
      : displayColumns(`${base}  ${result.contract}`) <= columns
        ? [`${base}  ${result.contract}`]
        : [base, `  contract  ${safeText(result.contract)}`];
  if (isRecord(result.refusal) && typeof result.refusal.kind === "string") {
    lines.push(...renderRefusalFacts(result.refusal as RenderableRefusal, "  ", columns, result.contract));
  }
  const output = lines.join("\n");
  return result.draft === undefined ? output : `${output}\n${renderBindDraftReceipt(result.draft)}`;
}

export function renderConflictMaterialized(
  result: IntegrationConflictMaterialized,
  _context?: TextRenderContext,
): string {
  const indent = "  ";
  return [
    "! integration-conflict-materialized",
    `${indent}target  ${safeText(result.targetHead)}`,
    `${indent}recorded  no delivery`,
    `${indent}index  unmerged`,
    `${indent}saved  worktree bytes before projection`,
    `${indent}handoff base  ${safeText(result.handoffBase)}`,
    ...collectionLines("conflicts", result.conflictPaths, indent),
    `${indent}workspace  ${safeText(result.workspace.path)}`,
    `${indent}deliver  ${safeText(result.recovery.continue)} · reads worktree bytes, not index`,
  ].join("\n");
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  return [
    ...(receipt.path === undefined ? [] : [`  draft  ${safeText(receipt.path)}`]),
    ...(receipt.warning === undefined ? [] : [`! draft warning  ${safeText(receipt.warning)}`]),
  ].join("\n");
}
