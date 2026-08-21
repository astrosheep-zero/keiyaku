import type { BindDraftReceipt, RefusedResult } from "../result.js";
import type { IntegrationConflictMaterialized, KeiyakuRefusal } from "../../index.js";
import { displayColumns, gitShortStat, renderOpaqueBlock, safeText, type TextRenderContext } from "./terminal.js";

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

function collectionLines(name: string, members: readonly string[], indent: string, columns: number): readonly string[] {
  if (members.length === 0) return renderOpaqueBlock(`${name} 0`, indent, columns);
  return [
    ...renderOpaqueBlock(name, indent, columns),
    ...members.flatMap((member) => renderOpaqueBlock(member, `${indent}│ `, columns)),
  ];
}

function skipAddressedContract(addressed: string | undefined, contractId: string | undefined): boolean {
  return addressed !== undefined && contractId === addressed;
}

function refusalIdentity(refusal: RenderableRefusal, addressed?: string): string | undefined {
  const contractId = "contractId" in refusal ? refusal.contractId : undefined;
  return skipAddressedContract(addressed, contractId) ? undefined : contractId;
}

function refusalHead(kind: string, identity: string | undefined, details: readonly string[]): string {
  return [kind, identity === undefined ? undefined : `contractId=${identity}`, ...details]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function renderDirtyRefusal(
  refusal: DirtyWithOption,
  indent: string,
  columns: number,
  identity: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  wrap(lines, refusalHead(refusal.kind, identity, []), indent, columns);
  for (const name of ["staged", "unstaged", "untracked", "submodules"] as const) {
    lines.push(...collectionLines(name, refusal[name], indent, columns));
  }
  wrap(lines, gitShortStat(refusal.shortStat), indent, columns);
  if (refusal.option !== undefined) {
    wrap(
      lines,
      `option ${refusal.option.flag} ${refusal.option.available ? "available" : "unavailable"}`,
      indent,
      columns,
    );
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
  if (refusal.kind === "nuke-confirmation-mismatch") {
    return [
      ...renderOpaqueBlock(
        `nuke confirmation mismatch world=${refusal.world} confirmation=${refusal.confirmation}`,
        indent,
        columns,
      ),
      ...renderOpaqueBlock(`keiyaku nuke --confirm ${refusal.world}`, indent, columns),
    ];
  }
  if (refusal.kind === "nuke-confirmation-required") {
    return [
      ...renderOpaqueBlock(`nuke confirmation required world=${refusal.world}`, indent, columns),
      ...renderOpaqueBlock(`keiyaku nuke --confirm ${refusal.world}`, indent, columns),
    ];
  }
  if (refusal.kind === "dirty-workspace") return renderDirtyRefusal(refusal, indent, columns, identity);
  if (refusal.kind === "unmerged-paths") {
    return [
      ...renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns),
      ...collectionLines("paths", refusal.paths, indent, columns),
    ];
  }
  if (refusal.kind === "integration-failed") {
    const lines = [
      ...renderOpaqueBlock(
        refusalHead(refusal.kind, identity, [`reason=${refusal.reason}`, `targetHead=${refusal.targetHead}`]),
        indent,
        columns,
      ),
    ];
    if (refusal.conflictPaths !== undefined)
      lines.push(...collectionLines("conflictPaths", refusal.conflictPaths, indent, columns));
    if ("recovery" in refusal && refusal.recovery !== undefined) {
      wrap(lines, `recovery materialize conflicts · ${refusal.recovery.materialize}`, indent, columns);
      wrap(lines, `recovery continue after resolve and commit · ${refusal.recovery.continue}`, indent, columns);
    }
    return lines;
  }
  if (refusal.kind === "merge-state-present") {
    return renderOpaqueBlock(
      refusalHead(refusal.kind, identity, [`workspace=${refusal.workspace.kind}`, `path=${refusal.workspace.path}`]),
      indent,
      columns,
    );
  }
  if (refusal.kind === "integration-unsupported") {
    return renderOpaqueBlock(
      refusalHead(refusal.kind, identity, [`requiredGit=${refusal.requiredGit}`]),
      indent,
      columns,
    );
  }
  if (refusal.kind === "checkout-not-followable") {
    const lines = [
      ...renderOpaqueBlock(
        refusalHead(refusal.kind, identity, [
          `target=${refusal.target}`,
          `path=${refusal.path}`,
          `reason=${refusal.reason}`,
        ]),
        indent,
        columns,
      ),
    ];
    lines.push(...collectionLines("paths", refusal.paths, indent, columns));
    return lines;
  }
  if (refusal.kind === "workspace-not-on-target") {
    return renderOpaqueBlock(
      refusalHead(refusal.kind, identity, [`target=${refusal.target}`, `branch=${refusal.branch}`]),
      indent,
      columns,
    );
  }
  if (refusal.kind === "here-target-mismatch") {
    return renderOpaqueBlock(`here-target-mismatch target=${refusal.target} branch=${refusal.branch}`, indent, columns);
  }
  if (refusal.kind === "here-worktree-appointed") {
    return renderOpaqueBlock(
      refusalHead(refusal.kind, undefined, [
        refusal.contract === undefined ? "" : `contract=${refusal.contract}`,
        `path=${refusal.path}`,
      ]),
      indent,
      columns,
    );
  }
  return renderOpaqueBlock(refusalHead(refusal.kind, identity, []), indent, columns);
}

export function renderRefusal(result: RefusedResult, context?: TextRenderContext): string {
  const columns = context?.columns ?? 80;
  const base = `! ${result.verb} refused`;
  const lines =
    result.contract === undefined
      ? [base]
      : displayColumns(`${base} — ${result.contract}`) <= columns
        ? [`${base} — ${result.contract}`]
        : [`${base} —`, `  ${safeText(result.contract)}`];
  if (isRecord(result.refusal) && typeof result.refusal.kind === "string") {
    lines.push(...renderRefusalFacts(result.refusal as RenderableRefusal, "   ", columns, result.contract));
  }
  const output = lines.join("\n");
  return result.draft === undefined ? output : `${output}\n${renderBindDraftReceipt(result.draft)}`;
}

export function renderConflictMaterialized(
  result: IntegrationConflictMaterialized,
  context?: TextRenderContext,
): string {
  const columns = context?.columns ?? 80;
  const indent = "   ";
  return [
    ...renderOpaqueBlock(`integration-conflict-materialized targetHead=${result.targetHead}`, "", columns),
    ...collectionLines("conflictPaths", result.conflictPaths, indent, columns),
    ...renderOpaqueBlock(`workspace ${result.workspace.kind} ${result.workspace.path}`, indent, columns),
  ].join("\n");
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  return [
    ...(receipt.path === undefined ? [] : [`draft preserved: ${receipt.path}`]),
    ...(receipt.warning === undefined ? [] : [`warning: ${receipt.warning}`]),
  ].join("\n");
}
