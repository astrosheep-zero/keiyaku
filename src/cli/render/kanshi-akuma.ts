import type { AkumaKanshiRow, AkumaKanshiWorld, KanshiReport, BoardSection } from "../../kanshi/report.js";
import { currentWorkLines } from "./akuma-activity.js";
import { akumaMark } from "./marks.js";
import {
  ageText,
  elapsedMilliseconds,
  emptyCatalogue,
  entityLines,
  identityLine,
  RECENT_TONE_MS,
  renderSectionBlock,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";

const NARROW_COLUMNS = 72;
const ACTIVITY_INDENT = "  ";

function mostRecentTimestamp(...values: readonly (string | null | undefined)[]): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (value === null || value === undefined) return latest;
    return latest === null || value > latest ? value : latest;
  }, null);
}

function akumaStatusTone(row: AkumaKanshiRow, observedAt: string): SemanticTone | null {
  if (row.life === "stillborn" || row.life === "hung" || row.life === "stranded") return "alert";
  if (row.life === "killed") return "dim";
  const lifeAt = "lifeAt" in row ? row.lifeAt : undefined;
  const lastActivityAt = "lastActivityAt" in row ? row.lastActivityAt : undefined;
  const latestAge = elapsedMilliseconds(mostRecentTimestamp(lifeAt, lastActivityAt), observedAt);
  if (row.life === "asleep") return latestAge !== null && latestAge <= RECENT_TONE_MS ? "recent" : "dim";
  if (row.life === "running" && latestAge !== null && latestAge <= RECENT_TONE_MS) return "recent";
  return null;
}

/** The native owner's current actionable row pair, rendered by the shared activity grammar. */
function rowPreviewLines(row: AkumaKanshiRow, context: TextRenderContext): readonly string[] {
  const bounded = { ...context, columns: Math.max(1, context.columns - ACTIVITY_INDENT.length) };
  const work = row.work;
  return (
    work === undefined
      ? []
      : work.kind === "unavailable"
        ? [`! work unavailable · ${work.diagnostic}`]
        : currentWorkLines(work, bounded)
  ).map((line) => `${ACTIVITY_INDENT}${line}`);
}

function akumaLabel(row: Pick<AkumaKanshiRow, "aliases">, aliasesUnavailable: boolean): string {
  const aliases = row.aliases ?? [];
  if (aliases.length > 0) return `(${aliases.join(" ")})`;
  return aliasesUnavailable ? "(aliases unavailable)" : "";
}

function associationFact(contract: NonNullable<AkumaKanshiRow["contract"]>): string {
  if (contract.kind === "unavailable") return "contract association unavailable";
  return contract.contractId;
}

function akumaRowLines(
  row: AkumaKanshiRow,
  aliasesUnavailable: boolean,
  observedAt: string,
  context: TextRenderContext,
  caller?: string,
): readonly string[] {
  const statusTone = akumaStatusTone(row, observedAt);
  const mark = statusTone === null ? akumaMark(row.life) : tone(akumaMark(row.life), statusTone, context.color);
  const lifeAt = "lifeAt" in row ? row.lifeAt : undefined;
  const lifeAge = lifeAt === undefined ? null : formatAge(lifeAt, observedAt);
  const life = lifeAge === null ? row.life : `${row.life} · ${lifeAge}`;
  const lastActivityAt = "lastActivityAt" in row ? row.lastActivityAt : undefined;
  const activityAge = lastActivityAt === undefined ? null : formatAge(lastActivityAt, observedAt);
  const activity = activityAge === null || activityAge === lifeAge ? [] : [`activity ${activityAge}`];
  const key = [life, ...activity];
  const relation = [
    ...(row.contract === undefined ? [] : [associationFact(row.contract)]),
    ...(caller !== undefined &&
    "parentAkumaId" in row &&
    row.parentAkumaId !== undefined &&
    row.parentAkumaId !== caller
      ? [`by ${safeText(row.parentAkumaId)}`]
      : []),
  ];
  const aliases = akumaLabel(row, aliasesUnavailable);
  const previewLines = rowPreviewLines(row, context);
  if (context.columns > NARROW_COLUMNS) {
    const lines = [identityLine(mark, row.id, `${aliases} · ${[...key, ...relation].join(" · ")}`.trim())];
    return [...lines, ...previewLines];
  }
  const identity = aliases.length === 0 ? row.id : `${row.id} ${aliases}`;
  return [
    ...entityLines({
      mark,
      identity,
      state: key[0]!,
      title: "",
      facts: [...key.slice(1), ...relation],
      context,
    }),
    ...previewLines,
  ];
}

function akumaBoardRows(
  board: AkumaKanshiWorld,
  rows: readonly AkumaKanshiRow[],
  observedAt: string,
  context: TextRenderContext,
  caller?: string,
): readonly string[] {
  const aliasesUnavailable = board.aliasesError !== undefined;
  const rendered = renderSectionBlock({
    name: "AKUMA",
    rows: rows.map((row) => akumaRowLines(row, aliasesUnavailable, observedAt, context, caller)),
    hasMore: board.more === true,
  });
  return [`AKUMA // ${rows.length} recent`, ...rendered.slice(1)];
}

/**
 * One Akuma board section. The World board omits an empty section because its other
 * sections already say what the World holds; a standalone catalogue states its
 * own emptiness. A failed Alias observation belongs to the
 * section, so an empty roster still states its emptiness rather than dropping that
 * evidence.
 */
function renderAkumaBoard(
  section: BoardSection<AkumaKanshiWorld>,
  observedAt: string,
  context: TextRenderContext & Readonly<{ caller?: string }>,
  emptyRows: readonly string[] = [emptyCatalogue("akuma")],
): readonly string[] {
  if (section.kind === "absent") return ["AKUMA // absent"];
  if (section.kind === "failed") {
    const failure = ["AKUMA // unavailable", "", tone(`! ${safeText(section.diagnostic)}`, "alert", context.color)];
    return failure;
  }
  const board = section;
  const rows = board.rows ?? [];
  const aliasFailure = board.aliasesError;
  if (rows.length === 0) {
    if (aliasFailure === undefined) return emptyRows;
    return [
      ...(emptyRows.length === 0 ? [emptyCatalogue("akuma")] : emptyRows),
      tone(`! aliases unavailable · ${aliasFailure}`, "alert", context.color),
    ];
  }
  return akumaBoardRows(board, rows, observedAt, context, context.caller);
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): readonly string[] {
  return renderAkumaBoard(report.akumas, report.observedAt, context, []);
}

function formatAge(source: string | null | undefined, observedAt: string): string {
  if (source === null || source === undefined) return "—";
  return ageText(source, observedAt);
}

export { akumaLabel, associationFact, formatAge, NARROW_COLUMNS, renderAkuma, renderAkumaBoard };
