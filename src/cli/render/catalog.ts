import type { Catalog } from "../catalog.js";
import {
  abbreviateGitIds,
  afterWording,
  candidateIntegrationFacts,
  dependentWording,
  gateFact,
  gitIdsInRow,
  targetFacts,
} from "./contract-observation.js";
import { ageText, safeText } from "./terminal.js";
import { akumaMark, contractMark } from "./marks.js";
import { dispositionText, taskFrameHead, taskMark } from "./task.js";

function relativeAge(source: string | null, observedAt: string): string | null {
  if (source === null) return null;
  return ageText(source, observedAt);
}

function renderAkumaCatalog(catalog: Extract<Catalog, { kind: "akuma" }>): string {
  const rows = catalog.rows;
  if (rows.length === 0) {
    return catalog.archetype === null ? "AKUMA // recent" : `AKUMA // ${safeText(catalog.archetype)}`;
  }
  const lines = [catalog.archetype === null ? "AKUMA // recent" : `AKUMA // ${safeText(catalog.archetype)}`, ""];
  for (const row of rows) {
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const activityAt = "lastActivityAt" in row ? row.lastActivityAt : null;
    const lifeAge = relativeAge(lifeAt, catalog.observedAt);
    const activityAge = relativeAge(activityAt, catalog.observedAt);
    const ages = [
      ...(lifeAge === null ? [] : [lifeAge]),
      ...(activityAge === null || activityAge === lifeAge ? [] : [`activity ${activityAge}`]),
    ];
    const aliases = row.aliases.length === 0 ? "" : ` (${row.aliases.map((alias) => safeText(alias)).join(" ")})`;
    lines.push(
      `${akumaMark(row.life)} ${safeText(row.id)}${aliases} · ${row.life}${ages.length === 0 ? "" : ` · ${ages.join(" · ")}`}`,
    );
  }
  if (catalog.hasMore) lines.push("…");
  return lines.join("\n");
}

function formatAge(source: string, observedAt: string): string {
  return ageText(source, observedAt, "future");
}

function renderContractCatalog(catalog: Extract<Catalog, { kind: "contracts" }>): string {
  const abbreviations = abbreviateGitIds([
    ...(catalog.state === null ? [] : [catalog.state]),
    ...catalog.rows.flatMap(gitIdsInRow),
  ]);
  const rows = catalog.rows;
  const header = "CONTRACTS // recent";
  const blocks = rows.map((row) => {
    const lines = [
      `${contractMark(row)} ${safeText(row.id)} · ${row.phase} · ${formatAge(row.phaseAt, catalog.observedAt)} · ${safeText(row.title ?? "title unavailable")}`,
      ...candidateIntegrationFacts(row.delivery, row.verification, abbreviations).map((fact) => `  ${safeText(fact)}`),
      ...targetFacts(row, abbreviations).map((fact) => `  ${safeText(fact)}`),
      ...[],
      ...row.after.map((edge) => `  ${afterWording(edge)}`),
      ...(row.dependents.length === 0 ? [] : [`  dependents  ${row.dependents.map(dependentWording).join(" · ")}`]),
      ...(row.gates.reports.length === 0 ? [] : [`  ${row.gates.reports.map(gateFact).join("  ")}`]),
    ];
    return lines.join("\n");
  });
  return [header, ...(blocks.length === 0 ? [] : ["", ...blocks]), ...(catalog.hasMore ? ["…"] : [])].join("\n");
}
export function renderCatalogText(catalog: Catalog): string {
  if (catalog.kind === "tasks") {
    const namespace = catalog.namespace ?? [];
    const scope = namespace.length === 0 ? "root" : `namespace ${namespace.join("/")}`;
    const head = taskFrameHead("tasks", scope);
    return [
      head,
      ...(catalog.rows.length === 0
        ? []
        : catalog.rows.map(
            (row) =>
              `${taskMark(row.disposition)} ${safeText(row.id)} · ${dispositionText(row.disposition)} · P${row.priority} — ${safeText(row.title)}`,
          )),
      ...(catalog.hasMore ? ["…"] : []),
    ].join("\n");
  }
  if (catalog.kind === "contracts") return renderContractCatalog(catalog);
  if (catalog.kind === "archetypes") {
    const head = "ARCHETYPES // available";
    return [
      head,
      ...(catalog.rows.length === 0
        ? []
        : [
            "",
            ...catalog.rows.flatMap((row) => [
              `${safeText(row.name)}${row.model === undefined ? "" : `  ${safeText(row.model)}`}`,
              ...(row.description === undefined ? [] : [`  ${safeText(row.description)}`]),
            ]),
            ...(catalog.hasMore ? ["…"] : []),
          ]),
    ].join("\n");
  }
  return renderAkumaCatalog(catalog);
}
