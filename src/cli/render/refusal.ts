import type { BindDraftReceipt, RefusedResult } from "../result.js";

type DirtyWorkspaceRefusal = Readonly<{
  kind: "dirty-workspace";
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  submodules: readonly string[];
  shortStat: Readonly<{ filesChanged: number; insertions: number; deletions: number }>;
  option?: Readonly<{ flag: string; available: boolean }>;
}>;

function dirtyWorkspace(value: unknown): value is DirtyWorkspaceRefusal {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "dirty-workspace";
}

export function renderRefusal(result: RefusedResult): string {
  const contract = result.contract === undefined ? "" : ` ${result.contract}`;
  let output: string;
  if (dirtyWorkspace(result.refusal)) {
    const lines = [`refused ${result.verb}${contract} dirty-workspace`];
    for (const category of ["staged", "unstaged", "untracked", "submodules"] as const) {
      const label = category === "submodules" ? "submodule" : category;
      for (const path of result.refusal[category]) lines.push(`dirty ${label} ${path}`);
    }
    const { filesChanged, insertions, deletions } = result.refusal.shortStat;
    lines.push(`shortstat files=${filesChanged} insertions=${insertions} deletions=${deletions}`);
    if (result.refusal.option !== undefined) {
      lines.push(`option ${result.refusal.option.flag} ${result.refusal.option.available ? "available" : "unavailable"}`);
    }
    output = lines.join("\n");
  } else {
    output = `refused ${result.verb}${contract} ${JSON.stringify(result.refusal)}`;
  }
  return result.draft === undefined ? output : `${output}\n${renderBindDraftReceipt(result.draft)}`;
}

export function renderBindDraftReceipt(receipt: BindDraftReceipt): string {
  return [
    ...(receipt.path === undefined ? [] : [`draft preserved: ${receipt.path}`]),
    ...(receipt.warning === undefined ? [] : [`warning: ${receipt.warning}`]),
  ].join("\n");
}
