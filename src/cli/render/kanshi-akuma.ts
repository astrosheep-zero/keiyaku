import type { AkumaKanshiRow, KanshiReport } from "../../kanshi/index.js";
import {
  boundedActivity,
  elapsedMilliseconds,
  entityLines,
  identityLine,
  plumbFacts,
  RECENT_TONE_MS,
  renderSectionBlock,
  safeText,
  tone,
  type SemanticTone,
  type TextRenderContext,
} from "./terminal.js";

const PLUMB = "  │ ";
const NARROW_COLUMNS = 72;

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
          : "?";
}

function activitySnapshotLine(row: AkumaKanshiRow): string | undefined {
  const snapshot = row.snapshot;
  if (snapshot === undefined) return undefined;
  const latest = snapshot.entries.flatMap((entry) => (entry.kind === "row" ? [entry.row] : [])).at(-1);
  if (latest === undefined) {
    if (snapshot.kind !== "idle" || snapshot.outcome === undefined) return undefined;
    return snapshot.outcome.outcome.kind === "answered"
      ? snapshot.outcome.outcome.answer
      : snapshot.outcome.outcome.diagnostic;
  }
  if (latest.kind === "tool") return latest.name;
  return "text" in latest ? latest.text : "activity";
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
  if (section.kind === "absent") return ["AKUMA // absent", "", `${PLUMB}akuma absent`];
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
    const snapshot = activitySnapshotLine(row);
    const aliases = akumaLabel(row);
    if (context.columns > NARROW_COLUMNS) {
      const lines = [identityLine(mark, row.id, `${aliases} · ${[...key, ...relation].join(" · ")}`.trim())];
      return snapshot === undefined
        ? lines
        : [...lines, ...plumbFacts([boundedActivity(snapshot, context.columns, PLUMB)], context.columns)];
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
    return snapshot === undefined
      ? lines
      : [...lines, ...plumbFacts([boundedActivity(snapshot, context.columns, PLUMB)], context.columns)];
  });
  const header = `AKUMA // ${rows.length} recent`;
  const rendered = renderSectionBlock({
    name: "AKUMA",
    rows: rowLines,
    hasMore: section.value.hasMore,
  });
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
