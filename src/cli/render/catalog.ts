import type { Catalog } from "../../index.js";
import { safeText } from "./terminal.js";

function age(source: string | null | undefined): string {
  if (source === null || source === undefined) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(source)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

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
    return `${safeText(row.id)} - ${row.life} - runtime ${age(row.lifeAt)} - last activity ${age(row.lastActivityAt)}`;
  }).join("\n");
}
