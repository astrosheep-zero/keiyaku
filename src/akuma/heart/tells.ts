import type { DatabaseSync } from "node:sqlite";
import type {
  CallFact,
  TellDelivery,
  TellDeliveryInput,
  TellFact,
  TellReceiptInput,
  TurnEndFact,
  TurnFact,
  TurnStartFact,
} from "./facts.js";
import type { ActivityFact } from "./rows.js";

export type TimelineFact = TurnStartFact | CallFact | ActivityFact | TellFact | TurnEndFact;
export type ActivityFactSlice = Readonly<{
  rows: readonly TimelineFact[];
  lowestRetained: number | null;
  highest: number | null;
}>;

type TellRow = Readonly<{
  sequence: number;
  id: string;
  body: string;
  recorded_at: string;
  state: TellFact["state"];
}>;

type TellDeliveryRow = Readonly<{
  turn_sequence: number;
  route: TellDelivery["route"];
  receipt: TellDelivery["receipt"] | null;
  delivered_at: string;
}>;

type ActivityRow = Readonly<{ sequence: number; turn_sequence: number; event_json: string; at: string }>;
type CallRow = Readonly<{ sequence: number; turn_sequence: number; body: string; at: string }>;
type TurnRow = Readonly<{ sequence: number; body_sequence: number; started_at: string; end_sequence: number | null; outcome: "answered" | "failed" | null; history_id: string | null; session_json: string | null; answer: string | null; diagnostic: string | null; completed_at: string | null }>;

function parsed<T>(value: string): T { return JSON.parse(value) as T; }
function decodeActivityRow(row: ActivityRow): ActivityFact {
  return { kind: "activity", sequence: row.sequence, turnSequence: row.turn_sequence, event: parsed(row.event_json), at: row.at };
}
function decodeCallRow(row: CallRow): CallFact {
  return { kind: "call", sequence: row.sequence, turnSequence: row.turn_sequence, body: row.body, at: row.at };
}
function decodeTurnRow(row: TurnRow): TurnFact {
  const start: TurnStartFact = { kind: "turn-start", sequence: row.sequence, bodySequence: row.body_sequence, startedAt: row.started_at };
  if (row.outcome === null) return start;
  const end: TurnEndFact = {
    kind: "turn-end", sequence: row.end_sequence!, turnSequence: row.sequence,
    outcome: row.outcome === "answered"
      ? { kind: "answered", historyId: row.history_id!, session: parsed(row.session_json!), answer: row.answer! }
      : { kind: "failed", diagnostic: row.diagnostic! },
    completedAt: row.completed_at!,
  };
  return { ...start, end };
}

const TELL_STATE_SQL = `CASE
  WHEN EXISTS (
    SELECT 1 FROM tell_deliveries d
    WHERE d.tell_id = tells.id AND (d.route = 'launch' OR d.receipt = 'unavailable')
  ) THEN 'told'
  WHEN EXISTS (SELECT 1 FROM tell_receipts r WHERE r.evidence = 'exact' AND r.tell_id = tells.id) THEN 'told'
  WHEN EXISTS (
    SELECT 1 FROM tell_receipts r
    JOIN tell_deliveries d ON d.turn_sequence = r.turn_sequence AND d.fence = r.fence
    WHERE r.evidence = 'fence' AND d.tell_id = tells.id
  ) THEN 'told'
  ELSE 'pending'
END`;

const PENDING_TELL_SEQUENCES = `SELECT tells.sequence FROM tells WHERE ${TELL_STATE_SQL} = 'pending'`;

function tellDeliveries(database: DatabaseSync, id: string): readonly TellDelivery[] {
  const rows = database.prepare(`SELECT turn_sequence, route, receipt, delivered_at FROM tell_deliveries
    WHERE tell_id = ? ORDER BY sequence`).all(id) as unknown as readonly TellDeliveryRow[];
  return rows.map((row): TellDelivery => row.receipt == null
    ? { turnSequence: row.turn_sequence, route: row.route, deliveredAt: row.delivered_at }
    : { turnSequence: row.turn_sequence, route: row.route, receipt: row.receipt, deliveredAt: row.delivered_at });
}

function decodeTellRow(database: DatabaseSync, row: TellRow): TellFact {
  return {
    kind: "tell",
    sequence: row.sequence,
    id: row.id,
    body: row.body,
    state: row.state,
    recordedAt: row.recorded_at,
    deliveries: tellDeliveries(database, row.id),
  };
}

export function pruneActivityFacts(database: DatabaseSync, limit: number): void {
  const count = database.prepare("SELECT COUNT(*) AS count FROM timeline").get() as { count: number };
  if (count.count <= limit + 500) return;
  const cutoff = database.prepare(`SELECT sequence FROM timeline ORDER BY sequence DESC LIMIT 1 OFFSET ?`)
    .get(limit - 1) as { sequence: number } | undefined;
  if (cutoff === undefined) return;
  database.prepare(`WITH protected_turns(sequence) AS (
      SELECT sequence FROM turns WHERE end_sequence IS NULL
      UNION SELECT turn_sequence FROM calls WHERE sequence >= ?
      UNION SELECT turn_sequence FROM activity WHERE sequence >= ?
      UNION SELECT sequence FROM turns WHERE end_sequence >= ?
      UNION SELECT d.turn_sequence FROM tell_deliveries d
        JOIN tells ON tells.id = d.tell_id WHERE ${TELL_STATE_SQL} = 'pending'
    ), protected(sequence) AS (
      SELECT sequence FROM protected_turns
      UNION SELECT sequence FROM calls WHERE turn_sequence IN (SELECT sequence FROM protected_turns)
      UNION SELECT end_sequence FROM turns WHERE sequence IN (SELECT sequence FROM protected_turns) AND end_sequence IS NOT NULL
      UNION ${PENDING_TELL_SEQUENCES}
    )
    DELETE FROM timeline WHERE sequence < ? AND sequence NOT IN protected`)
    .run(cutoff.sequence, cutoff.sequence, cutoff.sequence, cutoff.sequence);
}

type TimelineRow = Readonly<{
  sequence: number;
  kind: "turn-start" | "call" | "activity" | "tell" | "turn-end";
}>;

function turn(database: DatabaseSync, sequence: number): TurnFact {
  const row = database.prepare(`SELECT sequence, body_sequence, started_at, end_sequence, outcome,
    history_id, session_json, answer, diagnostic, completed_at FROM turns WHERE sequence = ?`)
    .get(sequence) as TurnRow | undefined;
  if (row === undefined) throw new Error(`Akuma timeline references missing Turn ${sequence}`);
  return decodeTurnRow(row);
}

function turnStart(database: DatabaseSync, sequence: number): TurnStartFact {
  const row = database.prepare("SELECT sequence, body_sequence, started_at FROM turns WHERE sequence = ?")
    .get(sequence) as { sequence: number; body_sequence: number; started_at: string } | undefined;
  if (row === undefined) throw new Error(`Akuma timeline references missing Turn ${sequence}`);
  return { kind: "turn-start", sequence: row.sequence, bodySequence: row.body_sequence, startedAt: row.started_at };
}

function decodeTimelineRow(database: DatabaseSync, row: TimelineRow): TimelineFact {
  if (row.kind === "turn-start") return turnStart(database, row.sequence);
  if (row.kind === "turn-end") {
    const source = database.prepare("SELECT sequence FROM turns WHERE end_sequence = ?").get(row.sequence) as
      { sequence: number } | undefined;
    const fact = source === undefined ? undefined : turn(database, source.sequence).end;
    if (fact === undefined) throw new Error(`Akuma timeline references missing Turn end ${row.sequence}`);
    return fact;
  }
  if (row.kind === "call") {
  const value = database.prepare("SELECT sequence, turn_sequence, body, at FROM calls WHERE sequence = ?")
      .get(row.sequence) as CallRow | undefined;
    if (value === undefined) throw new Error(`Akuma timeline references missing call ${row.sequence}`);
    return decodeCallRow(value);
  }
  if (row.kind === "activity") {
    const value = database.prepare("SELECT sequence, turn_sequence, event_json, at FROM activity WHERE sequence = ?")
      .get(row.sequence) as ActivityRow | undefined;
    if (value === undefined) throw new Error(`Akuma timeline references missing activity ${row.sequence}`);
    return decodeActivityRow(value);
  }
  const value = database.prepare(`SELECT sequence, id, body, recorded_at, ${TELL_STATE_SQL} AS state
    FROM tells WHERE sequence = ?`).get(row.sequence) as TellRow | undefined;
  if (value === undefined) throw new Error(`Akuma timeline references missing tell ${row.sequence}`);
  return decodeTellRow(database, value);
}

export function activityFactSlice(
  database: DatabaseSync,
  input: Readonly<{ before?: number; since?: number; limit: number }>,
): ActivityFactSlice {
  const bounds = database.prepare("SELECT MIN(sequence) AS lowest, MAX(sequence) AS highest FROM timeline")
    .get() as { lowest: number | null; highest: number | null };
  let rows: readonly TimelineRow[];
  if (input.before !== undefined) {
    rows = database.prepare(`SELECT * FROM (
      SELECT sequence, kind FROM timeline WHERE sequence < ? ORDER BY sequence DESC LIMIT ?
    ) ORDER BY sequence`).all(input.before, input.limit) as unknown as readonly TimelineRow[];
  } else if (input.since !== undefined) {
    rows = database.prepare(`SELECT sequence, kind FROM timeline WHERE sequence > ? ORDER BY sequence LIMIT ?`)
      .all(input.since, input.limit) as unknown as readonly TimelineRow[];
  } else {
    rows = database.prepare(`SELECT * FROM (
      SELECT sequence, kind FROM timeline ORDER BY sequence DESC LIMIT ?
    ) ORDER BY sequence`).all(input.limit) as unknown as readonly TimelineRow[];
  }
  return { rows: rows.map((row) => decodeTimelineRow(database, row)), lowestRetained: bounds.lowest, highest: bounds.highest };
}

export function insertTellFact(database: DatabaseSync, tell: Omit<TellFact, "sequence" | "state" | "deliveries">): number {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('tell')").run().lastInsertRowid);
  database.prepare("INSERT INTO tells(id, sequence, body, recorded_at) VALUES (?, ?, ?, ?)")
    .run(tell.id, sequence, tell.body, tell.recordedAt);
  return sequence;
}

export function tellFact(database: DatabaseSync, id: string): TellFact | null {
  const row = database.prepare(`SELECT sequence, id, body, recorded_at, ${TELL_STATE_SQL} AS state
    FROM tells WHERE id = ?`).get(id) as TellRow | undefined;
  return row === undefined ? null : decodeTellRow(database, row);
}

export function insertTellDeliveryFact(database: DatabaseSync, input: TellDeliveryInput): void {
  const result = database.prepare(`INSERT OR IGNORE INTO tell_deliveries(
    tell_id, route, turn_sequence, fence, receipt, delivered_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).run(
    input.tellId, input.route, input.turnSequence, input.fence,
    input.route === "live" ? input.receipt : null, input.deliveredAt,
  );
  const row = database.prepare(`SELECT route, receipt FROM tell_deliveries
    WHERE tell_id = ? AND turn_sequence = ? AND fence = ?`)
    .get(input.tellId, input.turnSequence, input.fence) as { route: string; receipt: string | null } | undefined;
  if (row === undefined || (result.changes === 0
    && (row.route !== input.route || row.receipt !== (input.route === "live" ? input.receipt : null)))) {
    throw new Error(`tell delivery ${input.tellId} has conflicting evidence`);
  }
}

export function insertTellReceiptFact(database: DatabaseSync, input: TellReceiptInput): void {
  database.prepare(`INSERT OR IGNORE INTO tell_receipts(
    evidence, tell_id, turn_sequence, fence, kind, received_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).run(
    input.evidence,
    input.evidence === "exact" ? input.tellId : null,
    input.evidence === "fence" ? input.turnSequence : null,
    input.evidence === "fence" ? input.fence : null,
    input.kind,
    input.receivedAt,
  );
}

export function tellIdsForFence(database: DatabaseSync, turnSequence: number, fence: string): readonly string[] {
  return database.prepare(`SELECT tell_id FROM tell_deliveries
    WHERE turn_sequence = ? AND fence = ? ORDER BY sequence`)
    .all(turnSequence, fence).map((row) => (row as { tell_id: string }).tell_id);
}

export function pendingTellFacts(database: DatabaseSync): readonly TellFact[] {
  const rows = database.prepare(`SELECT sequence, id, body, recorded_at, ${TELL_STATE_SQL} AS state FROM tells
    WHERE ${TELL_STATE_SQL} = 'pending' ORDER BY sequence`).all() as unknown as readonly TellRow[];
  return rows.map((row) => decodeTellRow(database, row));
}
