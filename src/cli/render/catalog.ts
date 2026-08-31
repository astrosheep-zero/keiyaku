import type { Catalog, ContractRow } from "../../index.js";
import {
  abbreviateGitIds,
  afterWording,
  candidateFact,
  dependentWording,
  displayGitId,
  gateFact,
  gitIdsInRow,
  targetMovementFacts,
} from "./contract-observation.js";
import { safeText } from "./terminal.js";

function targetLine(row: ContractRow, abbreviations: ReadonlyMap<string, string>): string {
  if (row.target === null) return "no target";
  const target = row.target.startsWith("refs/heads/") ? row.target.slice("refs/heads/".length) : row.target;
  const lag =
    row.targetLag.kind === "counted"
      ? `${row.targetLag.behind} commits behind ${target}`
      : row.targetLag.kind === "unknown"
        ? `commits behind ${target} unknown`
        : undefined;
  return [`target ${target}`, ...(lag === undefined ? [] : [lag]), ...targetMovementFacts(row, abbreviations)].join(
    " · ",
  );
}

function akumaMark(life: string): string {
  if (life === "running") return "●";
  if (life === "asleep" || life === "unborn") return "○";
  if (life === "killed") return "×";
  if (life === "stillborn") return "!";
  return "?";
}

function relativeAge(source: string | null, observedAt: string): string | null {
  if (source === null) return null;
  const seconds = Math.floor((Date.parse(observedAt) - Date.parse(source)) / 1_000);
  if (seconds < 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderAkumaCatalog(catalog: Extract<Catalog, { kind: "akuma" }>): string {
  const rows = catalog.rows;
  const lines = [
    `akuma instances ${rows.length} recent`,
    ...(catalog.archetype === null ? [] : [`  scope ${safeText(catalog.archetype)}`]),
    "",
  ];
  for (const row of rows) {
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const activityAt = "lastActivityAt" in row ? row.lastActivityAt : null;
    const ages = [relativeAge(lifeAt, catalog.observedAt), relativeAge(activityAt, catalog.observedAt)].filter(
      (age): age is string => age !== null,
    );
    lines.push(
      `${akumaMark(row.life)} ${safeText(row.id)} · ${row.life}${ages.length === 0 ? "" : ` · ${ages.join(" · ")}`}`,
    );
  }
  if (catalog.hasMore) lines.push("…");
  return lines.join("\n");
}

function catalogMark(row: ContractRow): string {
  if (row.phase === "claimed") return "✓";
  if (row.phase === "abandoned") return "×";
  if (row.title === null) return "?";
  if (row.gates.reports.some((gate) => gate.current.kind === "attested" && gate.current.verdict === "unsatisfied"))
    return "!";
  if (row.targetLag.kind === "unknown") return "?";
  if (row.phase === "waiting") return "○";
  return "●";
}

function formatAge(source: string, observedAt: string): string {
  const seconds = Math.floor((Date.parse(observedAt) - Date.parse(source)) / 1_000);
  if (seconds < 0) return "future";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function renderContractCatalog(catalog: Extract<Catalog, { kind: "contracts" }>): string {
  const abbreviations = abbreviateGitIds([
    ...(catalog.state === null ? [] : [catalog.state]),
    ...catalog.rows.flatMap(gitIdsInRow),
  ]);
  const rows = catalog.rows;
  const header =
    catalog.state === null
      ? `observedAt ${catalog.observedAt}`
      : `contract state ${displayGitId(catalog.state, abbreviations)} · observedAt ${catalog.observedAt}`;
  const blocks = rows.map((row) => {
    const lines = [
      `${catalogMark(row)} ${safeText(row.id)} · ${row.phase} · ${formatAge(row.phaseAt, catalog.observedAt)} · ${safeText(row.title ?? "title unavailable")}`,
      `  ${candidateFact(row.delivery)} · ${targetLine(row, abbreviations)}`,
      ...row.after.map((edge) => `  ${afterWording(edge)}`),
      ...(row.dependents.length === 0 ? [] : [`  dependents ${row.dependents.map(dependentWording).join(" · ")}`]),
      ...(row.gates.reports.length === 0 ? [] : [`  ${row.gates.reports.map(gateFact).join("  ")}`]),
    ];
    return lines.join("\n");
  });
  return [header, ...(blocks.length === 0 ? [] : ["", ...blocks]), ...(catalog.hasMore ? ["…"] : [])].join("\n");
}
export function renderCatalogText(catalog: Catalog): string {
  if (catalog.kind === "tasks") {
    return [
      ...catalog.rows.map(
        (row) => `${safeText(row.id)} - P${row.priority} - ${row.disposition} - ${safeText(row.title)}`,
      ),
      ...(catalog.hasMore ? ["…"] : []),
    ].join("\n");
  }
  if (catalog.kind === "contracts") return renderContractCatalog(catalog);
  if (catalog.kind === "archetypes") {
    return [
      `available Akuma ${catalog.rows.length}`,
      "",
      ...catalog.rows.flatMap((row) => [
        `${safeText(row.name)}${row.model === undefined ? "" : ` - ${safeText(row.model)}`}`,
        ...(row.description === undefined ? [] : [`  ${safeText(row.description)}`]),
      ]),
    ].join("\n");
  }
  return renderAkumaCatalog(catalog);
}
