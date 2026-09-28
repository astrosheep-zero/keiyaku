import type { Catalog } from "../catalog.js";
import { abbreviateGitIds, contractBall, displayGitId, gitIdsInRow } from "./contract-observation.js";
import { ageText, renderBoundedPayload, safeText } from "./terminal.js";
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
    const terminal = row.phase === "claimed" || row.phase === "abandoned";
    const outcome =
      row.phase === "claimed"
        ? `✓ claimed${row.delivery === null ? "" : ` · landed ${displayGitId(row.delivery.integration.snapshot, abbreviations)}`}`
        : "× abandoned";
    const review = row.gates.reports.find((gate) => gate.gate === "reviewed");
    const testimony =
      row.phase === "claimed" && review?.current.kind === "attested"
        ? review.current.summary
        : row.phase === "abandoned"
          ? row.abandonNote
          : undefined;
    const lines = [
      `${contractMark(row)} ${safeText(row.id)} · ${row.phase} · ${formatAge(row.phaseAt, catalog.observedAt)} · ${safeText(row.title ?? "title unavailable")}`,
      `  ${terminal ? outcome : contractBall(row, abbreviations)}`,
      ...(testimony === undefined
        ? []
        : renderBoundedPayload({
            text: testimony,
            first: `  ${row.phase === "claimed" ? "review" : "note"}  `,
            continuation: "    │ ",
            columns: 100,
            maxLines: 3,
            quote: "“",
            openQuote: false,
            truncated: false,
          })),
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
    const head = "AKUMA NAMES // available";
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
