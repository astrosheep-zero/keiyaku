import type { ContractAfterEdge, ContractRow, ContractWorkspaceObservation } from "../../index.js";

type GateDisplayCurrent = Readonly<
  { kind: "missing" } | { kind: "stale" } | { kind: "attested"; verdict: "satisfied" | "unsatisfied" }
>;
type GateDisplayReport = Readonly<{
  gate: string;
  current: GateDisplayCurrent;
  requirements: readonly Readonly<{ requirement: string; index?: number; current: GateDisplayCurrent }>[];
}>;

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
export function lifecycleWord(phase: ContractRow["phase"]): string {
  return phase === "claimed" ? "accepted" : phase;
}

function progressChip(mark: " " | "✓" | "×", label: string): string {
  return `[${mark}] ${label}`;
}

/** The one readable projection of delivery and current-candidate gate progress. */
export function progressStrip(row: Pick<ContractRow, "delivery" | "gates">): string {
  const delivery = progressChip(row.delivery === null ? " " : "✓", "delivery");
  const gates = row.gates.reports.map((report) => {
    const mark = report.current.kind !== "attested" ? " " : report.current.verdict === "satisfied" ? "✓" : "×";
    return progressChip(mark, gateDisplayName(report.gate));
  });
  return [delivery, ...gates].join("  ");
}

export function gateGlyph(report: Readonly<{ current: GateDisplayCurrent }>): string {
  if (report.current.kind === "stale") return "!";
  if (report.current.kind === "missing") return "○";
  return report.current.verdict === "satisfied" ? "✓" : "×";
}

export function gateFact(report: GateDisplayReport): string {
  return `${gateGlyph(report)} ${gateDisplayName(report.gate)}${report.current.kind === "stale" ? " · stale" : ""}`;
}

export function requirementDisplayName(
  gate: string,
  requirement: Readonly<{ requirement: string; index?: number | undefined }>,
): string {
  const name = gateDisplayName(gate);
  if (gate === "verified") return `${name} ${requirement.index ?? requirement.requirement}`;
  return requirement.requirement === `gate:${gate}` ? name : `${name} ${requirement.requirement}`;
}

/** Currentness is supplied by the owner for every requirement; rendering never aggregates testimony. */
export function gateRequirementFacts(report: GateDisplayReport): readonly string[] {
  return report.requirements.map(
    (requirement) =>
      `${gateGlyph(requirement)} ${requirementDisplayName(report.gate, requirement)}${requirement.current.kind === "stale" ? " · stale" : requirement.current.kind === "missing" ? " · missing" : ""}`,
  );
}

export function afterWording(edge: ContractAfterEdge): string {
  if (edge.endpoint.kind === "claimed") return `after  ${edge.contractId} · ${lifecycleWord("claimed")}`;
  const condition = edge.endpoint.kind === "active" ? edge.endpoint.phase : edge.endpoint.kind;
  return `blocked by  ${edge.contractId} · ${condition}`;
}

export function mergeSummary(observation: ContractWorkspaceObservation): string | undefined {
  if (observation.kind !== "clean" && observation.kind !== "dirty") return undefined;
  if (observation.merge === null) return undefined;
  const count = observation.merge.unmergedPaths.length;
  return count > 0 ? `merge conflict in worktree (${count} paths)` : "merge in progress (resolution staged)";
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

export function gitIdsInRow(row: ContractRow): readonly string[] {
  const ids: string[] = [];
  if (row.delivery !== null) {
    ids.push(row.delivery.tenderSnapshot, row.delivery.integration.predecessor, row.delivery.integration.snapshot);
  }
  if (row.targetObservation?.head != null) ids.push(row.targetObservation.head);
  const observation = row.workspaceObservation;
  if ((observation.kind === "clean" || observation.kind === "dirty") && observation.merge !== null) {
    ids.push(observation.merge.head);
  }
  return ids;
}

export function displayGitId(value: string, abbreviations: ReadonlyMap<string, string>): string {
  const rendered = abbreviations.get(value) ?? value;
  return GIT_OBJECT_ID.test(rendered) ? rendered.slice(0, 7) : rendered;
}

/** Render the pinned delivery target and the same-epoch observed target head. */
export function targetMovementFacts(row: ContractRow, abbreviations: ReadonlyMap<string, string>): readonly string[] {
  if (row.target === null || row.targetObservation?.drift !== true) return [];
  if (row.delivery === null) return ["target moved  observed"];
  return [
    `target moved  ${displayGitId(row.delivery.integration.snapshot, abbreviations)} -> ${
      row.targetObservation.head === null ? "absent" : displayGitId(row.targetObservation.head, abbreviations)
    }`,
  ];
}
