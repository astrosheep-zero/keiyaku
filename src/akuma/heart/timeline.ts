import type { DatabaseSync } from "node:sqlite";
import type { CallFact, ReportFact, SurveillanceFact, TellFact, TurnEndFact, TurnStartFact } from "./facts.js";
import { surveillanceFactsAt } from "./surveillance.js";
import {
  decodeReportRow,
  decodeActivityRow,
  decodeCallRow,
  decodeTurnRow,
  type ActivityFact,
  type ReportRow,
  type ActivityRow,
  type CallRow,
  type TurnRow,
} from "./rows.js";
import { decodeTellBatch, tellBatchAtSequences, tellStateSql } from "./tells.js";

export type TimelineFact =
  | TurnStartFact
  | CallFact
  | ReportFact
  | ActivityFact
  | TellFact
  | TurnEndFact
  | SurveillanceFact;
export type ActivityFactSlice = Readonly<{
  rows: readonly TimelineFact[];
  lowestRetained: number | null;
  highest: number | null;
}>;

export function lastActivityAt(database: DatabaseSync): string | null {
  const row = database
    .prepare(
      `SELECT CASE timeline.kind
      WHEN 'call' THEN calls.at
      WHEN 'activity' THEN activity.at
      WHEN 'report' THEN reports.at
      WHEN 'tell' THEN tells.recorded_at
    END AS at
    FROM timeline
    LEFT JOIN calls ON timeline.kind = 'call' AND calls.sequence = timeline.sequence
    LEFT JOIN activity ON timeline.kind = 'activity' AND activity.sequence = timeline.sequence
    LEFT JOIN reports ON timeline.kind = 'report' AND reports.sequence = timeline.sequence
    LEFT JOIN tells ON timeline.kind = 'tell' AND tells.sequence = timeline.sequence
    WHERE timeline.kind IN ('call', 'activity', 'report', 'tell')
    ORDER BY timeline.sequence DESC LIMIT 1`,
    )
    .get() as { at: string | null } | undefined;
  if (row === undefined || row.at === null) return null;
  return row.at;
}

export function waitReportFrontier(database: DatabaseSync, after: number | null) {
  if (after === null) {
    const row = database.prepare("SELECT sequence FROM reports ORDER BY sequence DESC LIMIT 1").get() as
      | { sequence: number }
      | undefined;
    return { sequence: row?.sequence ?? 0, report: undefined };
  }
  const row = database
    .prepare(
      `SELECT sequence, body_sequence, turn_sequence, text, at
      FROM reports WHERE sequence > ? ORDER BY sequence DESC LIMIT 1`,
    )
    .get(after) as ReportRow | undefined;
  return row === undefined ? undefined : { sequence: row.sequence, report: decodeReportRow(row) };
}

export const ACTIVITY_LIMIT = 5_000;

export function pruneActivityFacts(database: DatabaseSync, limit: number, protectionReleased = false): void {
  const highest = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM timeline").get() as {
    value: number;
  };
  const checked = database.prepare("SELECT checked_sequence FROM activity_retention WHERE singleton = 1").get() as
    | { checked_sequence: number }
    | undefined;
  if (!protectionReleased && highest.value <= Math.max(limit + 500, (checked?.checked_sequence ?? 0) + 500)) return;
  // This cursor records attempted maintenance, including sweeps that delete no
  // protected facts. It never determines the retention window or lifecycle.
  database
    .prepare("INSERT OR REPLACE INTO activity_retention(singleton, checked_sequence) VALUES (1, ?)")
    .run(highest.value);
  const cutoff = database
    .prepare(`SELECT sequence FROM timeline ORDER BY sequence DESC LIMIT 1 OFFSET ?`)
    .get(limit - 1) as { sequence: number } | undefined;
  if (cutoff === undefined) return;
  // Pending and open-bound input keep their exact delivery and audience proof.
  // Historical disposition members retain storage integrity only; no decision
  // or resolution state is consulted.
  database
    .prepare(
      `WITH open_turns AS (
      SELECT sequence, initiator FROM turns WHERE end_sequence IS NULL
    ), open_bindings AS (
      SELECT b.sequence, i.sequence AS tell, i.initiator
      FROM open_turns t JOIN tell_bindings b ON b.turn_sequence = t.sequence JOIN tells i ON i.id = b.tell_id
    ), protected_tells(sequence) AS (
      SELECT sequence FROM tells WHERE ${tellStateSql} = 'pending'
      UNION SELECT tells.sequence FROM tells JOIN tell_disposition_members m ON m.tell_id = tells.id
      UNION SELECT tell FROM open_bindings
    ), protected_turns(sequence) AS (
      SELECT sequence FROM open_turns
      UNION SELECT turn_sequence FROM calls WHERE sequence >= ?
      UNION SELECT turn_sequence FROM activity WHERE sequence >= ?
      UNION SELECT turn_sequence FROM reports WHERE sequence >= ?
      UNION SELECT sequence FROM turns WHERE end_sequence >= ?
      UNION SELECT d.turn_sequence FROM tell_deliveries d
        JOIN tells ON tells.id = d.tell_id
        WHERE tells.sequence IN (SELECT sequence FROM protected_tells)
    ), openers AS (
      SELECT initiator AS owner, MIN(sequence) AS first_turn FROM open_turns GROUP BY initiator
    ), binders AS (
      SELECT initiator AS owner, MIN(sequence) AS first_binding FROM open_bindings GROUP BY initiator
    ), protected(sequence) AS (
      SELECT sequence FROM protected_turns
      UNION SELECT MAX(sequence) FROM activity
        WHERE turn_sequence IN (SELECT sequence FROM open_turns)
        AND json_extract(event_json, '$.type') = 'permission' GROUP BY turn_sequence
      UNION SELECT sequence FROM calls WHERE turn_sequence IN (SELECT sequence FROM protected_turns)
      UNION SELECT end_sequence FROM turns WHERE sequence IN (SELECT sequence FROM protected_turns) AND end_sequence IS NOT NULL
      UNION SELECT sequence FROM protected_tells
      UNION SELECT s.sequence FROM surveillance s WHERE s.binding_frontier IS NULL
        AND s.sequence = (SELECT MAX(sequence) FROM surveillance WHERE owner = s.owner)
      UNION SELECT MAX(s.sequence) FROM surveillance s
        LEFT JOIN openers o USING(owner) LEFT JOIN binders b USING(owner)
        WHERE s.binding_frontier IS NOT NULL AND (o.first_turn < s.sequence OR b.first_binding <= s.binding_frontier)
        GROUP BY s.owner
    )
    DELETE FROM timeline WHERE sequence < ? AND sequence NOT IN protected`,
    )
    .run(cutoff.sequence, cutoff.sequence, cutoff.sequence, cutoff.sequence, cutoff.sequence);
}

type TimelineRow = Readonly<{
  sequence: number;
  kind: TimelineFact["kind"];
}>;

type TimelineBatch = Readonly<{
  rows: readonly TimelineRow[];
  turns: readonly TurnRow[];
  calls: readonly CallRow[];
  reports: readonly ReportRow[];
  activity: readonly ActivityRow[];
  surveillance: readonly SurveillanceFact[];
  tells: ReturnType<typeof tellBatchAtSequences>;
}>;

function readTimelineBatch(database: DatabaseSync, rows: readonly TimelineRow[]): TimelineBatch {
  const sequences = (kind: TimelineRow["kind"]) =>
    JSON.stringify(rows.filter((row) => row.kind === kind).map((row) => row.sequence));
  const turns = database
    .prepare(
      `SELECT sequence, body_sequence, started_at, end_sequence, outcome,
    history_id, session_json, answer, answer_json, schema_json, initiator, diagnostic, completed_at FROM turns
    WHERE sequence IN (SELECT value FROM json_each(?)) OR end_sequence IN (SELECT value FROM json_each(?))
    ORDER BY sequence`,
    )
    .all(sequences("turn-start"), sequences("turn-end")) as unknown as readonly TurnRow[];
  const calls = database
    .prepare(
      `SELECT sequence, turn_sequence, body, at FROM calls
    WHERE sequence IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(sequences("call")) as unknown as readonly CallRow[];
  const activity = database
    .prepare(
      `SELECT sequence, turn_sequence, event_json, at FROM activity
    WHERE sequence IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(sequences("activity")) as unknown as readonly ActivityRow[];
  const reports = database
    .prepare(
      `SELECT sequence, body_sequence, turn_sequence, text, at
    FROM reports WHERE sequence IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(sequences("report")) as unknown as readonly ReportRow[];
  const tells = tellBatchAtSequences(
    database,
    rows.filter((row) => row.kind === "tell").map((row) => row.sequence),
  );
  const surveillance = rows.some((row) => row.kind === "surveillance")
    ? surveillanceFactsAt(database, sequences("surveillance"))
    : [];
  return { rows, turns, calls, reports, activity, surveillance, tells };
}

export function decodeTimelineBatch(batch: TimelineBatch): readonly TimelineFact[] {
  const facts = new Map<number, TimelineFact>();
  for (const row of batch.turns) {
    const { end, ...start } = decodeTurnRow(row);
    facts.set(start.sequence, start);
    if (end !== undefined) facts.set(end.sequence, end);
  }
  for (const row of batch.calls) facts.set(row.sequence, decodeCallRow(row));
  for (const row of batch.reports) facts.set(row.sequence, decodeReportRow(row));
  for (const fact of batch.surveillance) facts.set(fact.sequence, fact);
  for (const row of batch.activity) facts.set(row.sequence, decodeActivityRow(row));
  for (const fact of decodeTellBatch(batch.tells)) facts.set(fact.sequence, fact);
  return batch.rows.map((row) => {
    const fact = facts.get(row.sequence);
    if (fact === undefined || fact.kind !== row.kind)
      throw new Error(`Akuma timeline references missing ${row.kind} ${row.sequence}`);
    return fact;
  });
}

/** Select the latest Turn, its delivered input, pending input and latest retained outcome. */
export function statusFacts(database: DatabaseSync): readonly TimelineFact[] {
  const frontier = database.prepare("SELECT sequence FROM turns ORDER BY sequence DESC LIMIT 1").get() as
    | { sequence: number }
    | undefined;
  const rows = database
    .prepare(
      `WITH selected(sequence) AS (
      SELECT sequence FROM turns WHERE sequence = ?
      UNION SELECT MAX(end_sequence) FROM turns WHERE end_sequence IS NOT NULL
      UNION SELECT sequence FROM calls WHERE turn_sequence = ?
      UNION SELECT sequence FROM reports WHERE turn_sequence = ?
      UNION SELECT sequence FROM activity WHERE turn_sequence = ?
      UNION SELECT tells.sequence FROM tells
      JOIN tell_deliveries ON tell_deliveries.tell_id = tells.id
      WHERE tell_deliveries.turn_sequence = ?
      UNION SELECT sequence FROM tells WHERE ${tellStateSql} = 'pending'
    ) SELECT timeline.sequence, timeline.kind FROM timeline JOIN selected USING(sequence) ORDER BY sequence`,
    )
    .all(
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
    ) as unknown as readonly TimelineRow[];
  return decodeTimelineBatch(readTimelineBatch(database, rows));
}

export function activityFactSlice(database: DatabaseSync): ActivityFactSlice {
  const bounds = database.prepare("SELECT MIN(sequence) AS lowest, MAX(sequence) AS highest FROM timeline").get() as {
    lowest: number | null;
    highest: number | null;
  };
  const rows = database
    .prepare("SELECT sequence, kind FROM timeline ORDER BY sequence")
    .all() as unknown as readonly TimelineRow[];
  return {
    rows: decodeTimelineBatch(readTimelineBatch(database, rows)),
    lowestRetained: bounds.lowest,
    highest: bounds.highest,
  };
}

/**
 * SQLite's cross-connection change counter, sampled inside the read
 * transaction. It identifies exactly the snapshot that transaction decodes: a
 * commit from another connection during the read cannot be mistaken for this
 * one and skipped, because the next transaction reports a new counter.
 */
export function timelineDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: number } | undefined;
  return row?.data_version ?? 0;
}
