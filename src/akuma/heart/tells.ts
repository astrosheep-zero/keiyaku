import type { DatabaseSync } from "node:sqlite";
import type { TellDeliveryInput, TellFact, TellReceiptInput } from "./facts.js";
import { decodeActivityRow, type ActivityFact } from "./rows.js";

export type TimelineFact = ActivityFact | TellFact;
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

const TELL_STATE_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM tell_voids v WHERE v.tell_id = tells.id) THEN 'voided'
  WHEN EXISTS (
    SELECT 1 FROM tell_deliveries d
    WHERE d.tell_id = tells.id AND (d.route = 'launch' OR d.receipt = 'unavailable')
  ) THEN 'told'
  WHEN EXISTS (SELECT 1 FROM tell_receipts r WHERE r.evidence = 'exact' AND r.tell_id = tells.id) THEN 'told'
  WHEN EXISTS (
    SELECT 1 FROM tell_receipts r
    JOIN tell_deliveries d ON d.body_sequence = r.body_sequence AND d.fence = r.fence
    WHERE r.evidence = 'fence' AND d.tell_id = tells.id
  ) THEN 'told'
  ELSE 'pending'
END`;

const PENDING_TELL_SEQUENCES = `SELECT tells.sequence FROM tells WHERE ${TELL_STATE_SQL} = 'pending'`;

function decodeTellRow(row: TellRow): TellFact {
  return { sequence: row.sequence, id: row.id, body: row.body, state: row.state, recordedAt: row.recorded_at };
}

export function pruneActivityFacts(database: DatabaseSync, limit: number): void {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM timeline
    WHERE sequence NOT IN (${PENDING_TELL_SEQUENCES})`).get() as { count: number };
  if (row.count <= limit + 500) return;
  database.prepare(`DELETE FROM timeline
    WHERE sequence NOT IN (
      SELECT sequence FROM timeline
      WHERE sequence NOT IN (${PENDING_TELL_SEQUENCES})
      ORDER BY sequence DESC LIMIT ?
    ) AND sequence NOT IN (${PENDING_TELL_SEQUENCES})`).run(limit);
}

const TIMELINE_COLUMNS = `timeline.sequence, timeline.kind,
  activity.body_sequence, activity.event_json, activity.at,
  tells.id, tells.body, tells.recorded_at,
  ${TELL_STATE_SQL} AS state`;

type TimelineRow = Readonly<{
  sequence: number;
  kind: "activity" | "tell";
  body_sequence: number | null;
  event_json: string | null;
  at: string | null;
  id: string | null;
  body: string | null;
  recorded_at: string | null;
  state: TellFact["state"] | null;
}>;

function decodeTimelineRow(row: TimelineRow): TimelineFact {
  if (row.kind === "activity") {
    return decodeActivityRow({
      sequence: row.sequence,
      body_sequence: row.body_sequence!,
      event_json: row.event_json!,
      at: row.at!,
    });
  }
  return decodeTellRow({
    sequence: row.sequence,
    id: row.id!,
    body: row.body!,
    recorded_at: row.recorded_at!,
    state: row.state!,
  });
}

export function activityFactSlice(
  database: DatabaseSync,
  input: Readonly<{ before?: number; since?: number; limit: number }>,
): ActivityFactSlice {
  const bounds = database.prepare("SELECT MIN(sequence) AS lowest, MAX(sequence) AS highest FROM timeline")
    .get() as { lowest: number | null; highest: number | null };
  let rows: readonly TimelineRow[];
  const from = `FROM timeline
    LEFT JOIN activity ON activity.sequence = timeline.sequence
    LEFT JOIN tells ON tells.sequence = timeline.sequence`;
  if (input.before !== undefined) {
    rows = database.prepare(`SELECT * FROM (
      SELECT ${TIMELINE_COLUMNS} ${from}
      WHERE timeline.sequence < ? ORDER BY timeline.sequence DESC LIMIT ?
    ) ORDER BY sequence`).all(input.before, input.limit) as unknown as readonly TimelineRow[];
  } else if (input.since !== undefined) {
    rows = database.prepare(`SELECT ${TIMELINE_COLUMNS} ${from}
      WHERE timeline.sequence > ? ORDER BY timeline.sequence LIMIT ?`)
      .all(input.since, input.limit) as unknown as readonly TimelineRow[];
  } else {
    rows = database.prepare(`SELECT * FROM (
      SELECT ${TIMELINE_COLUMNS} ${from} ORDER BY timeline.sequence DESC LIMIT ?
    ) ORDER BY sequence`).all(input.limit) as unknown as readonly TimelineRow[];
  }
  return { rows: rows.map(decodeTimelineRow), lowestRetained: bounds.lowest, highest: bounds.highest };
}

export function insertTellFact(database: DatabaseSync, tell: Omit<TellFact, "sequence" | "state">): number {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('tell')").run().lastInsertRowid);
  database.prepare("INSERT INTO tells(id, sequence, body, recorded_at) VALUES (?, ?, ?, ?)")
    .run(tell.id, sequence, tell.body, tell.recordedAt);
  return sequence;
}

export function tellFact(database: DatabaseSync, id: string): TellFact | null {
  const row = database.prepare(`SELECT sequence, id, body, recorded_at, ${TELL_STATE_SQL} AS state
    FROM tells WHERE id = ?`).get(id) as TellRow | undefined;
  return row === undefined ? null : decodeTellRow(row);
}

export function insertTellDeliveryFact(database: DatabaseSync, input: TellDeliveryInput): void {
  const result = database.prepare(`INSERT OR IGNORE INTO tell_deliveries(
    tell_id, route, body_sequence, fence, receipt, delivered_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).run(
    input.tellId, input.route, input.bodySequence, input.fence,
    input.route === "live" ? input.receipt : null, input.deliveredAt,
  );
  const row = database.prepare(`SELECT route, receipt FROM tell_deliveries
    WHERE tell_id = ? AND body_sequence = ? AND fence = ?`)
    .get(input.tellId, input.bodySequence, input.fence) as { route: string; receipt: string | null } | undefined;
  if (row === undefined || (result.changes === 0
    && (row.route !== input.route || row.receipt !== (input.route === "live" ? input.receipt : null)))) {
    throw new Error(`tell delivery ${input.tellId} has conflicting evidence`);
  }
}

export function insertTellReceiptFact(database: DatabaseSync, input: TellReceiptInput): void {
  database.prepare(`INSERT OR IGNORE INTO tell_receipts(
    evidence, tell_id, body_sequence, fence, kind, received_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).run(
    input.evidence,
    input.evidence === "exact" ? input.tellId : null,
    input.evidence === "fence" ? input.bodySequence : null,
    input.evidence === "fence" ? input.fence : null,
    input.kind,
    input.receivedAt,
  );
}

export function tellIdsForFence(database: DatabaseSync, bodySequence: number, fence: string): readonly string[] {
  return database.prepare(`SELECT tell_id FROM tell_deliveries
    WHERE body_sequence = ? AND fence = ? ORDER BY sequence`)
    .all(bodySequence, fence).map((row) => (row as { tell_id: string }).tell_id);
}

export function voidTellsByDeath(database: DatabaseSync, evidence: string, at: string): void {
  database.prepare(`INSERT OR IGNORE INTO tell_voids(tell_id, evidence, voided_at)
    SELECT tells.id, ?, ? FROM tells WHERE ${TELL_STATE_SQL} = 'pending'`).run(evidence, at);
}

export function pendingTellFacts(database: DatabaseSync): readonly TellFact[] {
  const rows = database.prepare(`SELECT sequence, id, body, recorded_at, ${TELL_STATE_SQL} AS state FROM tells
    WHERE ${TELL_STATE_SQL} = 'pending' ORDER BY sequence`).all() as unknown as readonly TellRow[];
  return rows.map(decodeTellRow);
}
