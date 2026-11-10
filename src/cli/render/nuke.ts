import type { NukeResult } from "../../index.js";
import { renderStructuredRefusal } from "./refusal.js";

export function renderNukeText(result: NukeResult, input: Readonly<{ confirm?: string }> = {}): string {
  if (result.kind === "accepted") {
    const issues = (result.issues ?? []).flatMap((issue) => [`  lag  ${issue.kind}`, `  reason  ${issue.diagnostic}`]);
    return [
      `✓ nuke${input.confirm === undefined ? "" : `  ${input.confirm}`}`,
      ...(result.refsRemoved === undefined ? [] : [`  refs removed  ${result.refsRemoved}`]),
      ...(result.worktreesRemoved === undefined ? [] : [`  worktrees removed  ${result.worktreesRemoved}`]),
      ...(result.debtsRemoved === undefined ? [] : [`  debt stores removed  ${result.debtsRemoved}`]),
      "  locks  may remain · SQLite coordination files cannot be removed safely while concurrent writers may still hold them",
      ...issues,
    ].join("\n");
  }
  if (result.kind === "refused") {
    return renderStructuredRefusal(
      "nuke",
      input.confirm === undefined ? "confirmation required" : "confirmation mismatch",
      [
        `world  ${result.world}`,
        ...(input.confirm === undefined ? [] : [`confirmation  ${input.confirm}`]),
        `option  keiyaku nuke --confirm '${result.world.replaceAll("'", "'\"'\"'")}'`,
      ],
    );
  }
  return "";
}
