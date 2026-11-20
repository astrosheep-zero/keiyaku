import type { AkumaKanshiRow, KanshiReport } from "../../kanshi/report.js";
import type { AkumaList } from "../../index.js";
import { currentWorkLines } from "./akuma-activity.js";
import { akumaMark } from "./marks.js";
import { ageText, emptyCatalogue, identityLine, safeText, type TextRenderContext } from "./terminal.js";

export function akumaLabel({ aliases }: Pick<AkumaKanshiRow, "aliases">): string {
  return aliases === undefined ? "" : `(${aliases.join(" ")})`;
}

export function associationFact(contract: NonNullable<AkumaKanshiRow["contract"]>): string {
  if (contract.kind === "unavailable") return "contract association unavailable";
  return contract.contractId;
}

function akumaRowLines(row: AkumaKanshiRow, observedAt: string, caller?: string): readonly string[] {
  const lifeAge = row.lifeAt === undefined ? undefined : ageText(row.lifeAt, observedAt);
  const activityAge = row.lastActivityAt === undefined ? undefined : ageText(row.lastActivityAt, observedAt);
  const work = row.work;
  const pending = work?.kind === "unavailable" ? undefined : work?.pending;
  const facts = [
    row.life,
    ...(lifeAge === undefined ? [] : [lifeAge]),
    ...(activityAge === undefined || activityAge === lifeAge ? [] : [`activity ${activityAge}`]),
    ...(row.pending === undefined || pending !== undefined ? [] : [`pending input ${row.pending}`]),
    ...(row.diagnostic === undefined ? [] : [`diagnostic ${row.diagnostic}`]),
    ...(row.contract === undefined ? [] : [associationFact(row.contract)]),
    ...(caller !== undefined && row.parentAkumaId !== undefined && row.parentAkumaId !== caller
      ? [`by ${row.parentAkumaId}`]
      : []),
  ];
  const preview =
    work === undefined
      ? []
      : work.kind === "unavailable"
        ? [`! work unavailable · ${safeText(work.diagnostic)}`]
        : currentWorkLines(work);
  return [
    identityLine(akumaMark(row.life), row.id, `${akumaLabel(row)} · ${facts.join(" · ")}`.trim()),
    ...preview.map((line) => `  ${line}`),
  ];
}

/** World omits empty sections; standalone catalogues name their surface. */
export function renderAkumaBoard(
  section: KanshiReport["akumas"] | AkumaList,
  observedAt: string,
  context: TextRenderContext & Readonly<{ caller?: string }>,
  standalone = true,
): readonly string[] {
  if ("kind" in section && section.kind === "absent") return ["AKUMA // absent"];
  const diagnostics =
    section.aliasesError === undefined ? [] : [`! aliases unavailable · ${safeText(section.aliasesError)}`];
  if ("kind" in section && section.kind === "failed")
    return ["AKUMA // unavailable", "", `! ${safeText(section.diagnostic)}`, ...diagnostics];
  const rows = section.rows ?? [];
  if (rows.length === 0 && diagnostics.length === 0 && section.more !== true)
    return standalone ? [emptyCatalogue("akuma")] : [];
  return [
    "AKUMA",
    "",
    ...rows.flatMap((row) => akumaRowLines(row, observedAt, context.caller)),
    ...diagnostics,
    ...(section.more === true ? ["…"] : []),
  ];
}
