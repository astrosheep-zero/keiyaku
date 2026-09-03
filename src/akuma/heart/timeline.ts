import type { DatabaseSync } from "node:sqlite";
import type { CallFact, TellFact, TurnEndFact, TurnFact, TurnStartFact } from "./facts.js";
import {
  decodeActivityRow,
  decodeCallRow,
  decodeTurnRow,
  type ActivityFact,
  type ActivityRow,
  type CallRow,
  type TurnRow,
} from "./rows.js";
import { decodeTellAtSequence, pendingTellProtectionSql, pendingTellSequencesSql } from "./tells.js";

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

export function pruneActivityFacts(database: DatabaseSync, limit: number): void {
  const count = database.prepare("SELECT COUNT(*) AS count FROM timeline").get() as { count: number };
  if (count.count <= limit + 500) return;
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

function turn(database: DatabaseSync, sequence: number): TurnFact {
  const row = database
    .prepare(
      `SELECT sequence, body_sequence, started_at, end_sequence, outcome,
    history_id, session_json, answer, answer_json, schema_json, diagnostic, completed_at FROM turns WHERE sequence = ?`,
    )
    .get(sequence) as TurnRow | undefined;
  if (row === undefined) throw new Error(`Akuma timeline references missing Turn ${sequence}`);
  return decodeTurnRow(row);
}

function turnStart(database: DatabaseSync, sequence: number): TurnStartFact {
  const row = database
    .prepare("SELECT sequence, body_sequence, started_at, schema_json FROM turns WHERE sequence = ?")
    .get(sequence) as {
    sequence: number;
    body_sequence: number;
    started_at: string;
    schema_json: string | null;
  } | undefined;
  if (row === undefined) throw new Error(`Akuma timeline references missing Turn ${sequence}`);
  return {
    kind: "turn-start",
    sequence: row.sequence,
    bodySequence: row.body_sequence,
    startedAt: row.started_at,
    ...(row.schema_json === null ? {} : { schemaJson: row.schema_json }),
  };
}

function decodeTimelineRow(database: DatabaseSync, row: TimelineRow): TimelineFact {
  if (row.kind === "turn-start") return turnStart(database, row.sequence);
  if (row.kind === "turn-end") {
    const source = database.prepare("SELECT sequence FROM turns WHERE end_sequence = ?").get(row.sequence) as
      | { sequence: number }
      | undefined;
    const fact = source === undefined ? undefined : turn(database, source.sequence).end;
    if (fact === undefined) throw new Error(`Akuma timeline references missing Turn end ${row.sequence}`);
    return fact;
  }
  if (row.kind === "call") {
    const value = database
      .prepare("SELECT sequence, turn_sequence, body, at FROM calls WHERE sequence = ?")
      .get(row.sequence) as CallRow | undefined;
    if (value === undefined) throw new Error(`Akuma timeline references missing call ${row.sequence}`);
    return decodeCallRow(value);
  }
  if (row.kind === "activity") {
    const value = database
      .prepare("SELECT sequence, turn_sequence, event_json, at FROM activity WHERE sequence = ?")
      .get(row.sequence) as ActivityRow | undefined;
    if (value === undefined) throw new Error(`Akuma timeline references missing activity ${row.sequence}`);
    return decodeActivityRow(value);
  }
  return decodeTellAtSequence(database, row.sequence);
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
    rows: rows.map((row) => decodeTimelineRow(database, row)),
    lowestRetained: bounds.lowest,
    highest: bounds.highest,
  };
}
