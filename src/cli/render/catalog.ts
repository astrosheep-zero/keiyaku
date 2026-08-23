import type { Catalog, ContractRow } from "../../index.js";
import {
  abbreviateGitIds,
  afterWording,
  dependentWording,
  displayGitId,
  gateGlyph,
  gateLegend,
  gitIdsInRow,
  mergeSummary,
} from "./contract-observation.js";
import { safeText } from "./terminal.js";

function workspaceLine(row: ContractRow): string {
  const observation = row.workspaceObservation;
  if (observation.kind === "failed") return `worktree unavailable · ${observation.diagnostic}`;
  if (observation.kind === "unappointed") return "worktree unappointed";
  if (observation.kind === "unavailable") return "worktree unavailable";
  if (observation.kind === "clean") return "worktree clean";
  const counts = [
    ...(observation.counts.staged > 0 ? [`staged ${observation.counts.staged}`] : []),
    ...(observation.counts.unstaged > 0 ? [`unstaged ${observation.counts.unstaged}`] : []),
    ...(observation.counts.untracked > 0 ? [`untracked ${observation.counts.untracked}`] : []),
    ...(observation.counts.submodules > 0 ? [`submodules ${observation.counts.submodules}`] : []),
  ];
  return counts.length === 0 ? "worktree dirty" : `worktree dirty · ${counts.join(" · ")}`;
}

function targetLine(row: ContractRow): string {
  if (row.target === null) return "no target";
  const target = row.target.startsWith("refs/heads/") ? row.target.slice("refs/heads/".length) : row.target;
  const lag =
    row.targetLag.kind === "counted"
      ? `${row.targetLag.behind} commits behind ${target}`
      : row.targetLag.kind === "unknown"
        ? `commits behind ${target} unknown`
        : undefined;
  return [
    `target ${target}`,
    ...(lag === undefined ? [] : [lag]),
    ...(row.targetObservation?.drift === true ? ["target moved"] : []),
  ].join(" · ");
}

function renderContractCatalog(catalog: Extract<Catalog, { kind: "contracts" }>): string {
  const abbreviations = abbreviateGitIds([
    ...(catalog.state === null ? [] : [catalog.state]),
    ...catalog.rows.flatMap(gitIdsInRow),
  ]);
  const rows = catalog.rows.filter((row) => row.disposition === "active");
  const candidates = rows.filter((row) => row.delivery !== null).length;
  const header = [
    `${rows.length} active · ${candidates} candidate${candidates === 1 ? "" : "s"}`,
    catalog.state === null
      ? `observedAt ${catalog.observedAt}`
      : `contract state ${displayGitId(catalog.state, abbreviations)} · observedAt ${catalog.observedAt}`,
    "○ no candidate · ● candidate",
    gateLegend(),
  ];
  const blocks = rows.map((row) => {
    const lines = [
      safeText(row.id),
      `  ${safeText(row.title ?? "title unavailable")}`,
      `  ${row.phase}`,
      `  ${targetLine(row)}`,
      ...row.after.map((edge) => `  ${afterWording(edge)}`),
      ...(row.dependents.length === 0 ? [] : [`  dependents ${row.dependents.map(dependentWording).join(" · ")}`]),
      ...(row.gates.reports.length === 0
        ? []
        : [`  ${row.gates.reports.map((report) => `${gateGlyph(report)} ${report.gate}`).join("  ")}`]),
      `  ${workspaceLine(row)}`,
      `  ${row.delivery === null ? "○ no candidate" : "● candidate"}`,
    ];
    const merge = mergeSummary(row.workspaceObservation);
    if (merge !== undefined) lines.push(`  ${merge}`);
    return lines.join("\n");
  });
  return [...header, ...(blocks.length === 0 ? [] : ["", ...blocks])].join("\n");
}
export function renderCatalogText(catalog: Catalog): string {
  if (catalog.kind === "tasks") {
    return catalog.rows
      .map((row) => `${safeText(row.id)} - P${row.priority} - ${row.disposition} - ${safeText(row.title)}`)
      .join("\n");
  }
  if (catalog.kind === "contracts") return renderContractCatalog(catalog);
  if (catalog.kind === "archetypes") {
    return catalog.rows
      .flatMap((row) => [
        `${safeText(row.name)}${row.model === undefined ? "" : ` - ${safeText(row.model)}`}`,
        ...(row.description === undefined ? [] : [`  ${safeText(row.description)}`]),
      ])
      .join("\n");
  }
  return catalog.rows
    .map((row) => {
      if (!("lifeAt" in row)) return `${safeText(row.id)} - ${row.life}`;
      return `${safeText(row.id)} - ${row.life} - runtime ${row.lifeAt ?? "-"} - last activity ${row.lastActivityAt ?? "-"}`;
    })
    .join("\n");
}
