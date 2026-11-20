import type { AkumaNameCatalog, ContractCatalogue } from "../../index.js";
import type { ContractKanshiBoard } from "../../kanshi/report.js";
import { contractAttentionFacts, lifecycleWord, progressStrip } from "./contract-observation.js";
import { ageText, emptyCatalogue, safeText } from "./terminal.js";

/** Native catalogue facts shared by standalone lists and World. */
export function contractRowLines(
  row: NonNullable<ContractKanshiBoard["rows"]>[number],
  observedAt: string,
): readonly string[] {
  const associations = (row.associations ?? []).flatMap((association) => {
    if ("debtId" in association) return [`debt  ${association.debtId}`];
    return "kind" in association && association.source !== "aliases"
      ? [`${association.source} association unavailable · ${association.diagnostic}`]
      : [];
  });
  return [
    `${safeText(row.id)} · ${lifecycleWord(row.phase)} · ${ageText(row.phaseAt, observedAt, "future")} · ${safeText(row.title ?? "title unavailable")}`,
    ...[progressStrip(row), ...contractAttentionFacts(row), ...associations].map((fact) => `  ${safeText(fact)}`),
  ];
}

export function renderContractCatalogue(list: ContractCatalogue): string {
  const rows = list.rows ?? [];
  const skipped =
    list.skipped === undefined ? [] : [`! ${list.skipped} journal${list.skipped === 1 ? "" : "s"} skipped`];
  if (rows.length === 0) {
    return skipped.length === 0 ? emptyCatalogue("contracts") : ["CONTRACTS", "", ...skipped].join("\n");
  }
  return [
    "CONTRACTS",
    ...(skipped.length === 0 ? [] : ["", ...skipped]),
    "",
    ...rows.flatMap((row) => contractRowLines(row, list.observedAt)),
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
