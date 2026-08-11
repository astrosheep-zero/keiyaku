import type { Catalog } from "../../index.js";
import { safeText } from "./terminal.js";

function failed(name: string, message: string): readonly string[] {
  return [`${name} failed`, `! ${safeText(message)}`];
}

export function renderCatalogText(catalog: Catalog): string {
  const lines = [`ls ${catalog.root === null ? "none" : safeText(catalog.root)}`];
  if (catalog.tasks.kind === "present") {
    lines.push(`task ${catalog.tasks.value.rows.length}`, ...catalog.tasks.value.rows.map((row) => `  ${safeText(row.id)}`));
  } else if (catalog.tasks.kind === "absent") lines.push("task absent");
  else lines.push(...failed("task", catalog.tasks.failure.message));
  if (catalog.contracts.kind === "present") {
    lines.push(`keiyaku ${catalog.contracts.value.rows.length}`, ...catalog.contracts.value.rows.map((row) => `  ${safeText(row.id)}`));
  } else if (catalog.contracts.kind === "absent") lines.push("keiyaku absent");
  else lines.push(...failed("keiyaku", catalog.contracts.failure.message));
  if (catalog.archetypes.kind === "present") {
    lines.push(`archetype ${catalog.archetypes.value.rows.length}`, ...catalog.archetypes.value.rows.map((row) => `  ${safeText(row)}`));
  } else if (catalog.archetypes.kind === "absent") lines.push("archetype absent");
  else lines.push(...failed("archetype", catalog.archetypes.failure.message));
  if (catalog.akuma.kind === "present") {
    lines.push(`akuma ${catalog.akuma.value.rows.length}`, ...catalog.akuma.value.rows.map((row) => `  ${safeText(row.id)}`));
  } else if (catalog.akuma.kind === "absent") lines.push("akuma absent");
  else lines.push(...failed("akuma", catalog.akuma.failure.message));
  return lines.join("\n");
}
