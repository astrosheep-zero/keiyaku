import type { ContractAfterEdge, ContractDetail, ContractGateReport, ContractSummary } from "../../index.js";
import type { ContractDetailWorkspace } from "../../protocol/read/status.js";

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/iu;

export function shortGitId(value: string): string {
  return GIT_OBJECT_ID.test(value) ? value.slice(0, 7) : value;
}

export function contractOperationName(operation: string): string {
  return operation === "deliver-preview" ? "deliver --dry-run" : operation;
}

export function gateDisplayName(gate: string): string {
  if (gate === "reviewed") return "review";
  if (gate === "verified") return "verification";
  return gate;
}

/**
 * The one display vocabulary for a Contract's lifecycle phase. The journal fact kind stays `claimed`; every
 * readable surface names the completed Contract `accepted`.
 */
export function lifecycleWord(phase: ContractDetail["phase"]): string {
  return phase === "claimed" ? "accepted" : phase;
}

function progressChip(mark: " " | "✓" | "×", label: string): string {
  return `[${mark}] ${label}`;
}

type SummaryGate = NonNullable<ContractSummary["gates"]>[number];

function verdictChip(gate: SummaryGate): " " | "✓" | "×" {
  switch (gate.verdict) {
    case "satisfied":
      return "✓";
    case "unsatisfied":
      return "×";
    case "missing":
    case "stale":
      return " ";
  }
}

/** The one readable projection of delivery and gate progress against the current candidate. */
export function progressStrip(row: Pick<ContractSummary, "delivered" | "gates">): string {
  const delivery = progressChip(row.delivered === true ? "✓" : " ", "delivery");
  const gates = (row.gates ?? []).map((gate) => progressChip(verdictChip(gate), gateDisplayName(gate.name)));
  return [delivery, ...gates].join("  ");
}

export function contractAttentionFacts(row: Pick<ContractSummary, "attention">): readonly string[] {
  return (row.attention ?? []).map((issue) => {
    switch (issue.kind) {
      case "workspace-unavailable":
        return "workspace unavailable";
      case "workspace-unappointed":
        return "workspace unappointed";
      case "workspace-failed":
        return `workspace unavailable · ${issue.diagnostic}`;
      case "merge-in-progress":
        return issue.conflicts === undefined ? "merge in progress" : `merge conflict (${issue.conflicts} paths)`;
      case "target-behind":
        return `target behind ${issue.behind}`;
      case "target-unknown":
        return "target lag unknown";
    }
  });
}

export function gateGlyph(report: Readonly<{ current: { kind: string; verdict?: string } }>): string {
  if (report.current.kind === "stale") return "!";
  if (report.current.kind === "missing") return "○";
  return report.current.verdict === "satisfied" ? "✓" : "×";
}

export function requirementDisplayName(
  gate: string,
  requirement: Readonly<{ requirement?: string | undefined; index?: number | undefined }>,
): string {
  const name = gateDisplayName(gate);
  if (gate === "verified") return `${name} ${requirement.index ?? requirement.requirement}`;
  return requirement.requirement === undefined || requirement.requirement === `gate:${gate}`
    ? name
    : `${name} ${requirement.requirement}`;
}

/** Currentness is supplied by the owner for every requirement; rendering never aggregates testimony. */
export function gateRequirementFacts(report: ContractGateReport): readonly string[] {
  return report.requirements.map(
    (requirement) =>
      `${gateGlyph(requirement)} ${requirementDisplayName(report.gate, requirement)}${requirement.current.kind === "stale" ? " · stale" : requirement.current.kind === "missing" ? " · missing" : ""}`,
  );
}

/** Every unresolved prerequisite edge names the condition that still blocks the candidate. */
export function afterWording(edge: ContractAfterEdge): string {
  return `blocked by  ${edge.contractId} · ${edge.state}`;
}

export function mergeSummary(workspace: ContractDetailWorkspace): string | undefined {
  if (workspace.kind !== "present" || workspace.merge === undefined) return undefined;
  const count = workspace.merge.length;
  return count > 0 ? `merge conflict in worktree (${count} paths)` : "merge in progress (resolution staged)";
}

export function workspaceState(workspace: ContractDetailWorkspace): string {
  if (workspace.kind === "unappointed") return "workspace  unappointed";
  if (workspace.kind === "unavailable") return "workspace  unavailable";
  const counts = Object.entries(workspace.counts ?? {}).map(([name, count]) => `${name} ${count}`);
  return counts.length === 0 ? "workspace  clean" : `workspace  dirty · ${counts.join(" · ")}`;
}

export function abbreviateGitIds(ids: readonly string[]): ReadonlyMap<string, string> {
  const unique = [...new Set(ids.filter((id) => GIT_OBJECT_ID.test(id)))];
  let length = 7;
  while (length < 40) {
    const prefixes = unique.map((id) => id.slice(0, length).toLowerCase());
    if (new Set(prefixes).size === unique.length) break;
    length += 1;
  }
  return new Map(unique.map((id) => [id, id.slice(0, length)]));
}

/** Every captured Git identity one selected detail states, for collision-aware abbreviation. */
export function gitIdsInDetail(row: {
  delivery?: Readonly<{ candidate: string; integration: string }>;
  targetObservation?: Readonly<{ kind: "moved"; before: string; after: string } | { kind: "unknown" }>;
  workspace: ContractDetailWorkspace;
}): readonly string[] {
  const ids: string[] = [];
  if (row.delivery !== undefined) ids.push(row.delivery.candidate, row.delivery.integration);
  if (row.targetObservation?.kind === "moved") ids.push(row.targetObservation.before, row.targetObservation.after);
  return ids;
}

export function displayGitId(value: string, abbreviations: ReadonlyMap<string, string>): string {
  const rendered = abbreviations.get(value) ?? value;
  return GIT_OBJECT_ID.test(rendered) ? rendered.slice(0, 7) : rendered;
}

/**
 * The Contract owner witnesses target drift; a selected row names both observed identities only when
 * that owner supplied the moved-from identity, never by comparing a head against a current candidate.
 */
export function targetMovementFacts(
  row: Pick<ContractDetail, "targetObservation">,
  abbreviations: ReadonlyMap<string, string>,
): readonly string[] {
  const observation = row.targetObservation;
  if (observation?.kind !== "moved") return [];
  return [
    `target moved  ${displayGitId(observation.before, abbreviations)} -> ${displayGitId(observation.after, abbreviations)}`,
  ];
}

export function targetMoved(row: Pick<ContractDetail, "targetObservation">): boolean {
  return row.targetObservation?.kind === "moved";
}
