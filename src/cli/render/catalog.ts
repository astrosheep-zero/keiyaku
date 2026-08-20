import type { Catalog } from "../../index.js";
import { safeText } from "./terminal.js";

export function renderCatalogText(catalog: Catalog): string {
  if (catalog.kind === "tasks") {
    return catalog.rows.map((row) => `${safeText(row.id)} - P${row.priority} - ${row.disposition} - ${safeText(row.title)}`).join("\n");
  }
  if (catalog.kind === "contracts") {
    return catalog.rows.map((row) => `${safeText(row.id)} - ${row.phase}`).join("\n");
  }
  if (catalog.kind === "archetypes") {
    return catalog.rows.flatMap((row) => [
      `${safeText(row.name)}${row.model === undefined ? "" : ` - ${safeText(row.model)}`}`,
      ...(row.description === undefined ? [] : [`  ${safeText(row.description)}`]),
    ]).join("\n");
  }
  return catalog.rows.map((row) => {
    if (!("lifeAt" in row)) return `${safeText(row.id)} - ${row.life}`;
    return `${safeText(row.id)} - ${row.life} - runtime ${row.lifeAt ?? "-"} - last activity ${row.lastActivityAt ?? "-"}`;
  }).join("\n");
}
