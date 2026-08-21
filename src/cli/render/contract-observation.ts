import type {
  ContractAfterEdge,
  ContractDependent,
  ContractGateReport,
  ContractRow,
  ContractWorkspaceObservation,
} from "../../index.js";

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/iu;

export function gateGlyph(report: ContractGateReport): string {
  if (report.current.kind === "stale") return "[~]";
  if (report.current.kind === "missing") return "[ ]";
  return report.current.verdict === "satisfied" ? "[✓]" : "[✗]";
}

export function gateLegend(): string {
  return "[✓] satisfied  [✗] unsatisfied  [~] stale  [ ] missing";
}

export function afterWording(edge: ContractAfterEdge): string {
  if (edge.endpoint.kind === "claimed") return `after ${edge.contractId} (claimed)`;
  const condition = edge.endpoint.kind === "active" ? edge.endpoint.phase : edge.endpoint.kind;
  return `blocked by ${edge.contractId} (${condition})`;
}

export function dependentWording(dependent: ContractDependent): string {
  return `${dependent.contractId} (${dependent.phase})`;
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
  return abbreviations.get(value) ?? value;
}
