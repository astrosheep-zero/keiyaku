import type { DatabaseSync } from "node:sqlite";
import type { TellDelivery, TellDeliveryInput, TellFact, TellReceiptInput } from "./facts.js";

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

export const tellStateSql = `CASE
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

export const pendingTellSequencesSql = `SELECT tells.sequence FROM tells WHERE ${tellStateSql} = 'pending'`;
export const pendingTellProtectionSql = `SELECT d.turn_sequence FROM tell_deliveries d
  JOIN tells ON tells.id = d.tell_id WHERE ${tellStateSql} = 'pending'`;

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

export function decodeTellAtSequence(database: DatabaseSync, sequence: number): TellFact {
  const row = database.prepare(`SELECT sequence, id, body, recorded_at, ${tellStateSql} AS state
    FROM tells WHERE sequence = ?`).get(sequence) as TellRow | undefined;
  if (row === undefined) throw new Error(`Akuma timeline references missing tell ${sequence}`);
  return decodeTellRow(database, row);
}

export function insertTellFact(database: DatabaseSync, tell: Omit<TellFact, "sequence" | "state" | "deliveries">): number {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('tell')").run().lastInsertRowid);
  database.prepare("INSERT INTO tells(id, sequence, body, recorded_at) VALUES (?, ?, ?, ?)")
    .run(tell.id, sequence, tell.body, tell.recordedAt);
  return sequence;
}

export function tellFact(database: DatabaseSync, id: string): TellFact | null {
  const row = database.prepare(`SELECT sequence, id, body, recorded_at, ${tellStateSql} AS state
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
  const rows = database.prepare(`SELECT sequence, id, body, recorded_at, ${tellStateSql} AS state FROM tells
    WHERE ${tellStateSql} = 'pending' ORDER BY sequence`).all() as unknown as readonly TellRow[];
  return rows.map((row) => decodeTellRow(database, row));
}
