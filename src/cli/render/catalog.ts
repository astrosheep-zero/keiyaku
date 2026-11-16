import type { AkumaNameCatalog, ContractCatalogue, ContractSummary } from "../../index.js";
import { contractAttentionFacts, lifecycleWord, progressStrip } from "./contract-observation.js";
import { ageText, emptyCatalogue, safeText } from "./terminal.js";
import { contractMark } from "./marks.js";

/** One summary row names identity, age, title, and a terminal outcome or the current candidate strip. */
function contractCatalogueBlock(row: ContractSummary, observedAt: string): string {
  const head = `${contractMark(row)} ${safeText(row.id)} · ${ageText(row.phaseAt, observedAt, "future")} · ${safeText(row.title ?? "title unavailable")}`;
  const state = row.phase === "bound" ? progressStrip(row) : lifecycleWord(row.phase);
  return [head, `  ${state}`, ...contractAttentionFacts(row).map((fact) => `  ${safeText(fact)}`)].join("\n");
}

export function renderContractCatalogue(list: ContractCatalogue): string {
  const rows = list.rows ?? [];
  if (rows.length === 0) return emptyCatalogue("contracts");
  return [
    "CONTRACTS // recent",
    "",
    ...rows.map((row) => contractCatalogueBlock(row, list.observedAt)),
    ...(list.more === true ? ["…"] : []),
  ].join("\n");
}

export function renderAkumaNameCatalogue(list: AkumaNameCatalog): string {
  const rows = list.rows ?? [];
  if (rows.length === 0) return emptyCatalogue("akuma names");
  return [
    "AKUMA NAMES // available",
    "",
    ...rows.flatMap((row) => {
      const facts = [
        ...(row.model === undefined ? [] : [safeText(row.model)]),
        ...(row.description === undefined ? [] : [safeText(row.description)]),
      ];
      return [safeText(row.name), ...(facts.length === 0 ? [] : [`  ${facts.join(" — ")}`])];
    }),
    ...(list.more === true ? ["…"] : []),
  ].join("\n");
}
