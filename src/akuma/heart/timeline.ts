import type { DatabaseSync } from "node:sqlite";
import type { CallFact, TellFact, TurnEndFact, TurnStartFact } from "./facts.js";
import {
  decodeActivityRow,
  decodeCallRow,
  decodeTurnRow,
  type ActivityFact,
  type ActivityRow,
  type CallRow,
  type TurnRow,
} from "./rows.js";
import {
  decodeTellBatch,
  tellBatchAtSequences,
  tellStateSql,
  pendingTellProtectionSql,
  pendingTellSequencesSql,
} from "./tells.js";

export type TimelineFact = TurnStartFact | CallFact | ActivityFact | TellFact | TurnEndFact;
export type ActivityFactSlice = Readonly<{
  rows: readonly TimelineFact[];
  lowestRetained: number | null;
  highest: number | null;
}>;

export function lastActivityAt(database: DatabaseSync): string | null {
  const row = database
    .prepare(
      `SELECT CASE timeline.kind
      WHEN 'turn-start' THEN started_turn.started_at
      WHEN 'call' THEN calls.at
      WHEN 'activity' THEN activity.at
      WHEN 'tell' THEN tells.recorded_at
      WHEN 'turn-end' THEN ended_turn.completed_at
    END AS at
    FROM timeline
    LEFT JOIN turns AS started_turn ON timeline.kind = 'turn-start' AND started_turn.sequence = timeline.sequence
    LEFT JOIN calls ON timeline.kind = 'call' AND calls.sequence = timeline.sequence
    LEFT JOIN activity ON timeline.kind = 'activity' AND activity.sequence = timeline.sequence
    LEFT JOIN tells ON timeline.kind = 'tell' AND tells.sequence = timeline.sequence
    LEFT JOIN turns AS ended_turn ON timeline.kind = 'turn-end' AND ended_turn.end_sequence = timeline.sequence
    ORDER BY timeline.sequence DESC LIMIT 1`,
    )
    .get() as { at: string | null } | undefined;
  if (row === undefined || row.at === null) return null;
  return row.at;
}

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
  database
    .prepare(
      `WITH protected_turns(sequence) AS (
      SELECT sequence FROM turns WHERE end_sequence IS NULL
      UNION SELECT turn_sequence FROM calls WHERE sequence >= ?
      UNION SELECT turn_sequence FROM activity WHERE sequence >= ?
      UNION SELECT sequence FROM turns WHERE end_sequence >= ?
      UNION ${pendingTellProtectionSql}
    ), protected(sequence) AS (
      SELECT sequence FROM protected_turns
      UNION SELECT sequence FROM calls WHERE turn_sequence IN (SELECT sequence FROM protected_turns)
      UNION SELECT end_sequence FROM turns WHERE sequence IN (SELECT sequence FROM protected_turns) AND end_sequence IS NOT NULL
      UNION ${pendingTellSequencesSql}
    )
    DELETE FROM timeline WHERE sequence < ? AND sequence NOT IN protected`,
    )
    .run(cutoff.sequence, cutoff.sequence, cutoff.sequence, cutoff.sequence);
}

type TimelineRow = Readonly<{
  sequence: number;
  kind: "turn-start" | "call" | "activity" | "tell" | "turn-end";
}>;

type TimelineBatch = Readonly<{
  rows: readonly TimelineRow[];
  turns: readonly TurnRow[];
  calls: readonly CallRow[];
  activity: readonly ActivityRow[];
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
  const tells = tellBatchAtSequences(
    database,
    rows.filter((row) => row.kind === "tell").map((row) => row.sequence),
  );
  return { rows, turns, calls, activity, tells };
}

export function decodeTimelineBatch(batch: TimelineBatch): readonly TimelineFact[] {
  const facts = new Map<number, TimelineFact>();
  for (const row of batch.turns) {
    const { end, ...start } = decodeTurnRow(row);
    facts.set(start.sequence, start);
    if (end !== undefined) facts.set(end.sequence, end);
  }
  for (const row of batch.calls) facts.set(row.sequence, decodeCallRow(row));
  for (const row of batch.activity) facts.set(row.sequence, decodeActivityRow(row));
  for (const fact of decodeTellBatch(batch.tells)) facts.set(fact.sequence, fact);
  return batch.rows.map((row) => {
    const fact = facts.get(row.sequence);
    if (fact === undefined || fact.kind !== row.kind)
      throw new Error(`Akuma timeline references missing ${row.kind} ${row.sequence}`);
    return fact;
  });
}

export type StatusFactInput = Readonly<{ aperture: "monitoring" | "receipt"; admittedTellId?: string }>;

/** Select the frontier and its delivered Tells, plus aperture-required Tell pins. */
export function readStatusBatch(database: DatabaseSync, input: StatusFactInput) {
  const frontier = database.prepare("SELECT sequence FROM turns ORDER BY sequence DESC LIMIT 1").get() as
    | { sequence: number }
    | undefined;
  const rows = database
    .prepare(
      `WITH selected(sequence) AS (
      SELECT sequence FROM turns WHERE sequence = ?
      UNION SELECT end_sequence FROM turns WHERE sequence = ? AND end_sequence IS NOT NULL
      UNION SELECT sequence FROM calls WHERE turn_sequence = ?
      UNION SELECT sequence FROM activity WHERE turn_sequence = ?
      UNION SELECT tells.sequence FROM tells
      JOIN tell_deliveries ON tell_deliveries.tell_id = tells.id
      WHERE tell_deliveries.turn_sequence = ?
      UNION SELECT sequence FROM tells WHERE id = ?
      UNION SELECT sequence FROM tells WHERE ? AND ${tellStateSql} = 'pending'
    ) SELECT timeline.sequence, timeline.kind FROM timeline JOIN selected USING(sequence) ORDER BY sequence`,
    )
    .all(
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      frontier?.sequence ?? null,
      input.admittedTellId ?? null,
      input.aperture === "monitoring" || input.admittedTellId === undefined ? 1 : 0,
    ) as unknown as readonly TimelineRow[];
  return { frontier: frontier?.sequence ?? null, ...readTimelineBatch(database, rows) };
}

export function statusFacts(database: DatabaseSync, input: StatusFactInput): readonly TimelineFact[] {
  return decodeTimelineBatch(readStatusBatch(database, input));
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
