import type { AkumaKanshiRow, KanshiReport } from "../../kanshi/index.js";
import { snapshotActivityLines } from "./akuma-activity.js";
import {
  elapsedMilliseconds,
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
  const lifeAt = "lifeAt" in row ? row.lifeAt : null;
  const lastActivityAt = "lastActivityAt" in row ? row.lastActivityAt : null;
  const latestAge = elapsedMilliseconds(mostRecentTimestamp(lifeAt, lastActivityAt), observedAt);
  if (row.life === "asleep") return latestAge !== null && latestAge <= RECENT_TONE_MS ? "recent" : "dim";
  if (row.life === "running" && latestAge !== null && latestAge <= RECENT_TONE_MS) return "recent";
  return null;
}

function akumaMark(life: string): string {
  return life === "running"
    ? "●"
    : life === "stillborn"
      ? "!"
      : life === "asleep"
        ? "○"
        : life === "killed"
        ? "×"
          : life === "stranded" || life === "stillborn" || life === "untidy"
            ? "!"
            : "?";
}

/** Bounded latest semantic entry, rendered by the same activity renderer as a targeted snapshot. */
function latestActivityLines(
  snapshot: NonNullable<AkumaKanshiRow["snapshot"]>,
  context: TextRenderContext,
): readonly string[] {
  const bounded = { ...context, columns: Math.max(1, context.columns - ACTIVITY_INDENT.length) };
  return snapshotActivityLines(snapshot, bounded, { latest: true }).map((line) => `${ACTIVITY_INDENT}${line}`);
}

function akumaLabel(row: AkumaKanshiRow): string {
  const aliases = row.aliases ?? [];
  return aliases.length === 0 ? "" : `(${aliases.join(" ")})`;
}

function endpointFact(id: string, observed: string | undefined): string {
  return observed === "missing"
    ? `-> ${id} (missing)`
    : observed === "unavailable"
      ? `-> ${id} (unavailable)`
      : `-> ${id}`;
}

function renderAkuma(report: KanshiReport, context: TextRenderContext): readonly string[] {
  const section = report.akuma;
  if (section.kind === "absent") return ["AKUMA // absent", "", "  akuma absent"];
  if (section.kind === "failed")
    return ["AKUMA // unavailable", "", tone(`! ${safeText(section.failure.message)}`, "alert", context.color)];
  const rows = section.value.rows;
  const rowLines = rows.map((row) => {
    const statusTone = akumaStatusTone(row, report.observedAt);
    const mark = statusTone === null ? akumaMark(row.life) : tone(akumaMark(row.life), statusTone, context.color);
    const lifeAt = "lifeAt" in row ? row.lifeAt : null;
    const life = `${row.life} · ${formatAge(lifeAt, report.observedAt)}`;
    const activity =
      "lastActivityAt" in row && row.lastActivityAt !== null
        ? [`activity ${formatAge(row.lastActivityAt, report.observedAt)}`]
        : [];
    const key =
      row.life === "stranded" && "strandedReason" in row && row.strandedReason === "resume-unsupported"
        ? [life, ...activity, "resume unsupported"]
        : [life, ...activity];
    const relation = row.contract === undefined ? ["unbound"] : [endpointFact(row.contract.id, row.contract.observed)];
    const snapshot = row.snapshot;
    const snapshotLines = snapshot === undefined ? [] : latestActivityLines(snapshot, context);
    const aliases = akumaLabel(row);
    if (context.columns > NARROW_COLUMNS) {
      const lines = [identityLine(mark, row.id, `${aliases} · ${[...key, ...relation].join(" · ")}`.trim())];
      return [...lines, ...snapshotLines];
    }
    const identity = aliases.length === 0 ? row.id : `${row.id} ${aliases}`;
    const lines = entityLines({
      mark,
      identity,
      state: key[0]!,
      title: "",
      facts: [...key.slice(1), ...relation],
      context,
    });
    return [...lines, ...snapshotLines];
  });
  const rendered = renderSectionBlock({
    name: "AKUMA",
    rows: rowLines,
    hasMore: section.value.hasMore,
  });
  const header = `AKUMA // ${rows.length} recent`;
  return [header, ...rendered.slice(1)];
}

function formatAge(source: string | null | undefined, observedAt: string): string {
  if (source === null || source === undefined) return "—";
  const sourceMs = Date.parse(source);
  const observedMs = Date.parse(observedAt);
  if (sourceMs > observedMs) return "now";
  const seconds = Math.floor((observedMs - sourceMs) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export { akumaMark, endpointFact, formatAge, NARROW_COLUMNS, renderAkuma };
