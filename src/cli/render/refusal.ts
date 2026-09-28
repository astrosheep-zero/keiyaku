import type { BindDraftReceipt, RefusedResult } from "../result.js";
import type { IntegrationConflictMaterialized, KeiyakuRefusal } from "../../index.js";
import {
  DEFAULT_CLI_COLUMNS,
  checkoutNotFollowableLines,
  gitShortStat,
  orderRefusalFacts,
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
  if (members.length === 0) return [];
  return [`${indent}${name}`, ...members.map((member) => `${indent}  ${safeText(member)}`)];
}

function shortGitId(value: string): string {
  return /^[0-9a-f]{40}$/iu.test(value) ? value.slice(0, 7) : value;
}

function skipAddressedContract(addressed: string | undefined, contractId: string | undefined): boolean {
  return addressed !== undefined && contractId === addressed;
}

function refusalIdentity(refusal: RenderableRefusal, addressed?: string): string | undefined {
  const contractId = "contractId" in refusal ? refusal.contractId : undefined;
  return skipAddressedContract(addressed, contractId) ? undefined : contractId;
}

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  "contract-missing": "contract missing",
  "task-missing": "task missing",
  "invalid-lifecycle-transition": "invalid lifecycle transition",
  "invalid-namespace-context": "invalid namespace context",
  "relation-owned-by-other": "relation owned by other",
  "invalid-composition": "invalid composition",
};

function refusalWords(kind: string): string {
  return REFUSAL_WORDS[kind] ?? kind.replaceAll("-", " ");
}

function refusalHead(kind: string, identity: string | undefined, details: readonly string[]): string {
  return [refusalWords(kind), identity, ...details].filter((part): part is string => part !== undefined).join("  ");
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

// eslint-disable-next-line complexity -- one closed projection preserves every refusal fact.
function refusalFacts(
  refusal: RenderableRefusal,
  indent: string,
  columns: number,
  addressed?: string,
): readonly string[] {
  const identity = refusalIdentity(refusal, addressed);
  if (refusal.kind === "nuke-confirmation-mismatch" || refusal.kind === "nuke-confirmation-required") {
    const world = safeText(refusal.world);
    return [
      `${indent}diagnostic  ${refusalWords(refusal.kind)}`,
      `${indent}world  ${world}`,
      ...(refusal.kind === "nuke-confirmation-mismatch"
        ? [`${indent}confirmation  ${safeText(refusal.confirmation)}`]
        : []),
      `${indent}nuke  keiyaku nuke --confirm '${world.replaceAll("'", "'\"'\"'")}'`,
    ];
  }
  if (refusal.kind === "verification-declaration-invalid") {
    return [
      ...(identity === undefined ? [] : [`${indent}contract  ${safeText(identity)}`]),
      `${indent}diagnostic  gate 'verified' requires a declared Verification; the Contract declares none`,
    ];
  }
  if (refusal.kind === "dirty-workspace") return renderDirtyRefusal(refusal, indent, columns, identity);
  if (refusal.kind === "unmerged-paths") {
    return [`${indent}diagnostic  ${refusalWords(refusal.kind)}`, ...collectionLines("paths", refusal.paths, indent)];
  }
  if (refusal.kind === "integration-failed") {
    const lines = [
      `${indent}diagnostic  ${refusalWords(refusal.kind)}`,
      ...(identity === undefined ? [] : [`${indent}contract  ${safeText(identity)}`]),
    ];
    lines.push(`${indent}reason  ${safeText(refusal.reason)}`, `${indent}target  ${safeText(refusal.targetHead)}`);
    if (refusal.conflictPaths !== undefined) lines.push(...collectionLines("conflicts", refusal.conflictPaths, indent));
    if ("recovery" in refusal && refusal.recovery !== undefined) {
      lines.push(`${indent}materialize  ${safeText(refusal.recovery.materialize)}`);
      lines.push(`${indent}deliver  ${safeText(refusal.recovery.deliver)}`);
    }
    return lines;
  }
  if (refusal.kind === "merge-state-present") {
    return [
      `${indent}diagnostic  ${refusalWords(refusal.kind)}`,
      ...(identity === undefined ? [] : [`${indent}contract  ${safeText(identity)}`]),
      `${indent}workspace kind  ${refusal.workspace.kind}`,
      `${indent}workspace  ${safeText(refusal.workspace.path)}`,
    ];
  }
  if (refusal.kind === "integration-unsupported") {
    return [
      `${indent}diagnostic  ${refusalWords(refusal.kind)}`,
      ...(identity === undefined ? [] : [`${indent}contract  ${safeText(identity)}`]),
      `${indent}required Git  ${safeText(refusal.requiredGit)}`,
    ];
  }
  if (refusal.kind === "checkout-not-followable") {
    return checkoutNotFollowableLines(refusal);
  }
  const lines = [`${indent}diagnostic  ${refusalWords(refusal.kind)}`];
  if (identity !== undefined) lines.push(`${indent}contract  ${safeText(identity)}`);
  if ("taskId" in refusal && typeof refusal.taskId === "string")
    lines.push(`${indent}task  ${safeText(refusal.taskId)}`);
  const fields = refusal as unknown as Record<string, unknown>;
  const kind = String(fields.kind);
  if (kind === "invalid-lifecycle-transition")
    lines.push(`${indent}state  ${safeText(String(fields.state))} · verb  ${safeText(String(fields.verb))}`);
  if (kind === "invalid-namespace-context") lines.push(`${indent}path  ${safeText(String(fields.path))}`);
  if (kind === "relation-owned-by-other") {
    lines.push(`${indent}related task  ${safeText(String(fields.related))}`);
    lines.push(`${indent}declaring task  ${safeText(String(fields.declaringTask))}`);
  }
  if ("diagnostic" in refusal && typeof refusal.diagnostic === "string")
    lines.push(`${indent}detail  ${safeText(refusal.diagnostic)}`);
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

export function renderRefusal(result: RefusedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? DEFAULT_CLI_COLUMNS;
  const base = `× ${result.verb} refused`;
  const lines = [base];
  if (result.contract !== undefined) lines.push(`  contract  ${safeText(result.contract)}`);
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
    `${indent}target  ${shortGitId(result.targetHead)}`,
    `${indent}delivery  none`,
    `${indent}index  unmerged`,
    `${indent}saved  worktree bytes before projection`,
    `${indent}handoff base  ${shortGitId(result.handoffBase)}`,
    ...collectionLines("conflicts", result.conflictPaths, indent),
    `${indent}workspace  ${safeText(result.workspace.path)}`,
    `${indent}deliver  ${safeText(result.recovery.deliver)} · reads worktree bytes, not index`,
  ].join("\n");
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  return [
    ...(receipt.path === undefined ? [] : [`  draft  ${safeText(receipt.path)}`]),
    ...(receipt.warning === undefined ? [] : [`! draft warning  ${safeText(receipt.warning)}`]),
  ].join("\n");
}
