import type { AkumaList, ListedAkuma } from "../../akuma/akuma.js";
import type { AkumaCaller } from "../../akuma/caller.js";
import type { ArchetypeCatalog, ContractCatalogue, ContractSummary } from "../../index.js";
import { contractAttentionFacts, progressStrip } from "./contract-observation.js";
import { ageText, emptyCatalogue, safeText } from "./terminal.js";
import { akumaMark, contractMark } from "./marks.js";

function relativeAge(source: string | undefined, observedAt: string): string | null {
  return source === undefined ? null : ageText(source, observedAt);
}

function akumaAgeFacts(row: ListedAkuma, observedAt: string): readonly string[] {
  const lifeAge = relativeAge("lifeAt" in row ? row.lifeAt : undefined, observedAt);
  const activityAge = relativeAge("lastActivityAt" in row ? row.lastActivityAt : undefined, observedAt);
  return [
    ...(lifeAge === null ? [] : [lifeAge]),
    ...(activityAge === null || activityAge === lifeAge ? [] : [`activity ${activityAge}`]),
  ];
}

function akumaCatalogueRow(row: ListedAkuma, observedAt: string, root: string | undefined): string {
  const ages = akumaAgeFacts(row, observedAt);
  const aliases = row.aliases === undefined ? "" : ` (${row.aliases.map((alias) => safeText(alias)).join(" ")})`;
  const by =
    root !== undefined && "parentAkumaId" in row && row.parentAkumaId !== undefined && row.parentAkumaId !== root
      ? ` · by ${safeText(row.parentAkumaId)}`
      : "";
  return `${akumaMark(row.life)} ${safeText(row.id)}${aliases} · ${row.life}${ages.length === 0 ? "" : ` · ${ages.join(" · ")}`}${by}`;
}

export function renderAkumaCatalogue(list: AkumaList, akumaName: string | null, caller?: AkumaCaller): string {
  const rows = list.rows ?? [];
  if (rows.length === 0) return emptyCatalogue("akuma");
  const root = caller === undefined ? undefined : caller.kind === "akuma" ? caller.akumaId : "external";
  return [
    akumaName === null ? "AKUMA // recent" : `AKUMA // ${safeText(akumaName)}`,
    "",
    ...rows.map((row) => akumaCatalogueRow(row, list.observedAt, root)),
    ...(list.more === true ? ["…"] : []),
  ].join("\n");
}

function formatAge(source: string, observedAt: string): string {
  return ageText(source, observedAt, "future");
}

/** One summary row names identity, age, title, and a terminal outcome or the current candidate strip. */
function contractCatalogueBlock(row: ContractSummary, observedAt: string): string {
  const head = `${contractMark(row)} ${safeText(row.id)} · ${formatAge(row.phaseAt, observedAt)} · ${safeText(row.title ?? "title unavailable")}`;
  return [head, `  ${progressStrip(row)}`, ...contractAttentionFacts(row).map((fact) => `  ${safeText(fact)}`)].join(
    "\n",
  );
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

export function renderArchetypeCatalogue(list: ArchetypeCatalog): string {
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
