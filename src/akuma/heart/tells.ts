import type { DatabaseSync } from "node:sqlite";
import {
  HeartAuthorityCorruptionError,
  type TellBinding,
  type TellDelivery,
  type TellDeliveryInput,
  type TellFact,
  type TellReceiptInput,
} from "./facts.js";

type TellRow = Readonly<{
  sequence: number;
  id: string;
  body: string;
  schema_json: string | null;
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
  const rows = database
    .prepare(
      `SELECT turn_sequence, route, receipt, delivered_at FROM tell_deliveries
    WHERE tell_id = ? ORDER BY sequence`,
    )
    .all(id) as unknown as readonly TellDeliveryRow[];
  return rows.map(
    (row): TellDelivery =>
      row.receipt == null
        ? { turnSequence: row.turn_sequence, route: row.route, deliveredAt: row.delivered_at }
        : { turnSequence: row.turn_sequence, route: row.route, receipt: row.receipt, deliveredAt: row.delivered_at },
  );
}

function tellBinding(database: DatabaseSync, id: string): TellBinding | undefined {
  const row = database
    .prepare(
      "SELECT turn_sequence, bound_at FROM tell_bindings WHERE tell_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .get(id) as
    | { turn_sequence: number; bound_at: string }
    | undefined;
  return row === undefined ? undefined : { turnSequence: row.turn_sequence, boundAt: row.bound_at };
}

function decodeTellRow(database: DatabaseSync, row: TellRow): TellFact {
  const binding = tellBinding(database, row.id);
  return {
    kind: "tell",
    sequence: row.sequence,
    id: row.id,
    body: row.body,
    ...(row.schema_json === null ? {} : { schemaJson: row.schema_json }),
    state: row.state,
    recordedAt: row.recorded_at,
    deliveries: tellDeliveries(database, row.id),
    ...(binding === undefined ? {} : { binding }),
  };
}

export function decodeTellAtSequence(database: DatabaseSync, sequence: number): TellFact {
  const row = database
    .prepare(
      `SELECT sequence, id, body, schema_json, recorded_at, ${tellStateSql} AS state
    FROM tells WHERE sequence = ?`,
    )
    .get(sequence) as TellRow | undefined;
  if (row === undefined) throw new Error(`Akuma timeline references missing tell ${sequence}`);
  return decodeTellRow(database, row);
}

export function insertTellFact(
  database: DatabaseSync,
  tell: Omit<TellFact, "sequence" | "state" | "deliveries">,
): number {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('tell')").run().lastInsertRowid);
  database
    .prepare("INSERT INTO tells(id, sequence, body, schema_json, recorded_at) VALUES (?, ?, ?, ?, ?)")
    .run(tell.id, sequence, tell.body, tell.schemaJson ?? null, tell.recordedAt);
  return sequence;
}

export function tellFact(database: DatabaseSync, id: string): TellFact | null {
  const row = database
    .prepare(
      `SELECT sequence, id, body, schema_json, recorded_at, ${tellStateSql} AS state
    FROM tells WHERE id = ?`,
    )
    .get(id) as TellRow | undefined;
  return row === undefined ? null : decodeTellRow(database, row);
}

export function insertTellDeliveryFact(database: DatabaseSync, input: TellDeliveryInput): void {
  const result = database
    .prepare(
      `INSERT OR IGNORE INTO tell_deliveries(
    tell_id, route, turn_sequence, fence, receipt, delivered_at
  ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tellId,
      input.route,
      input.turnSequence,
      input.fence,
      input.route === "live" ? input.receipt : null,
      input.deliveredAt,
    );
  const row = database
    .prepare(
      `SELECT route, receipt FROM tell_deliveries
    WHERE tell_id = ? AND turn_sequence = ? AND fence = ?`,
    )
    .get(input.tellId, input.turnSequence, input.fence) as { route: string; receipt: string | null } | undefined;
  if (
    row === undefined ||
    (result.changes === 0 &&
      (row.route !== input.route || row.receipt !== (input.route === "live" ? input.receipt : null)))
  ) {
    throw new Error(`tell delivery ${input.tellId} has conflicting evidence`);
  }
}

export function insertTellReceiptFact(database: DatabaseSync, input: TellReceiptInput): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO tell_receipts(
    evidence, tell_id, turn_sequence, fence, kind, received_at
  ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.evidence,
      input.evidence === "exact" ? input.tellId : null,
      input.evidence === "fence" ? input.turnSequence : null,
      input.evidence === "fence" ? input.fence : null,
      input.kind,
      input.receivedAt,
    );
}

export function tellIdsForFence(database: DatabaseSync, turnSequence: number, fence: string): readonly string[] {
  return database
    .prepare(
      `SELECT tell_id FROM tell_deliveries
    WHERE turn_sequence = ? AND fence = ? ORDER BY sequence`,
    )
    .all(turnSequence, fence)
    .map((row) => (row as { tell_id: string }).tell_id);
}

export function pendingTellFacts(database: DatabaseSync): readonly TellFact[] {
  const rows = database
    .prepare(
      `SELECT sequence, id, body, schema_json, recorded_at, ${tellStateSql} AS state FROM tells
    WHERE ${tellStateSql} = 'pending' ORDER BY sequence`,
    )
    .all() as unknown as readonly TellRow[];
  return rows.map((row) => decodeTellRow(database, row));
}

export function openTellDispositionIds(database: DatabaseSync, bodySequence: number): readonly string[] | null {
  const rows = database
    .prepare(
      `SELECT tell_id FROM tell_dispositions
    WHERE body_sequence = ? AND resolved_at IS NULL ORDER BY tell_id`,
    )
    .all(bodySequence) as unknown as readonly { tell_id: string }[];
  return rows.length === 0 ? null : rows.map((row) => row.tell_id);
}

export function latestOpenTellDisposition(
  database: DatabaseSync,
): Readonly<{ bodySequence: number; tellIds: readonly string[] }> | null {
  const row = database
    .prepare(
      `SELECT body_sequence FROM tell_dispositions
    WHERE resolved_at IS NULL ORDER BY body_sequence DESC LIMIT 1`,
    )
    .get() as { body_sequence: number } | undefined;
  if (row === undefined) return null;
  const tellIds = openTellDispositionIds(database, row.body_sequence);
  return tellIds === null ? null : { bodySequence: row.body_sequence, tellIds };
}

export function insertTellDispositionSnapshot(
  database: DatabaseSync,
  bodySequence: number,
  tellIds: readonly string[],
  at: string,
): void {
  const insert = database.prepare(
    `INSERT OR IGNORE INTO tell_dispositions(body_sequence, tell_id, decided_at)
    VALUES (?, ?, ?)`,
  );
  for (const tellId of tellIds) insert.run(bodySequence, tellId, at);
}

export function resolveTellDispositionSnapshot(database: DatabaseSync, bodySequence: number, at: string): void {
  database
    .prepare(
      `UPDATE tell_dispositions SET resolved_at = ?
    WHERE body_sequence = ? AND resolved_at IS NULL`,
    )
    .run(at, bodySequence);
}

function requireDispositionTell(database: DatabaseSync, tellId: string): TellFact {
  const tell = tellFact(database, tellId);
  if (tell === null) {
    throw new HeartAuthorityCorruptionError(`Akuma disposition references missing tell ${tellId}`);
  }
  return tell;
}

/** Heart proof that a disposition snapshot is held: every frozen Tell-id left pending. */
export function dispositionSnapshotProven(
  database: DatabaseSync,
  disposition: Readonly<{ tellIds: readonly string[] }>,
): boolean {
  for (const tellId of disposition.tellIds) {
    if (requireDispositionTell(database, tellId).state === "pending") return false;
  }
  return true;
}

/**
 * Identify the successor Body that took a disposition snapshot by delivery.
 * Returns that Body sequence when every frozen Tell-id has a delivery on a
 * turn owned by one Body after `bodySequence`; otherwise null. An unqualified
 * newer Body or held leash is not proof. A missing Tell row is Heart corruption.
 */
export function successorBodyHoldingDisposition(
  database: DatabaseSync,
  disposition: Readonly<{ bodySequence: number; tellIds: readonly string[] }>,
): number | null {
  let successor: number | null = null;
  for (const tellId of disposition.tellIds) {
    const tell = requireDispositionTell(database, tellId);
    if (tell.state === "pending") return null;
    const row = database
      .prepare(
        `SELECT t.body_sequence AS body_sequence
      FROM tell_deliveries d
      JOIN turns t ON t.sequence = d.turn_sequence
      WHERE d.tell_id = ? AND t.body_sequence > ?
      ORDER BY t.body_sequence ASC LIMIT 1`,
      )
      .get(tellId, disposition.bodySequence) as { body_sequence: number } | undefined;
    if (row === undefined) {
      // Terminal witness without successor delivery (e.g. undelivered) is not successor custody.
      return null;
    }
    if (successor === null) successor = row.body_sequence;
    else if (successor !== row.body_sequence) return null;
  }
  return successor;
}

export function insertUndeliveredTellReceipts(database: DatabaseSync, tellIds: readonly string[], at: string): void {
  for (const tellId of tellIds) {
    const current = requireDispositionTell(database, tellId);
    if (current.state !== "pending") continue;
    insertTellReceiptFact(database, {
      evidence: "exact",
      tellId,
      kind: "undelivered",
      receivedAt: at,
    });
  }
}

export function insertTellBindingFact(
  database: DatabaseSync,
  input: Readonly<{ tellId: string; turnSequence: number; boundAt: string }>,
): void {
  const result = database
    .prepare("INSERT OR IGNORE INTO tell_bindings(tell_id, turn_sequence, bound_at) VALUES (?, ?, ?)")
    .run(input.tellId, input.turnSequence, input.boundAt);
  if (result.changes === 0) {
    const row = database
      .prepare("SELECT 1 FROM tell_bindings WHERE tell_id = ? AND turn_sequence = ?")
      .get(input.tellId, input.turnSequence);
    if (row === undefined) throw new Error(`tell ${input.tellId} binding was not retained`);
  }
}

export function drainPendingTells(
  pending: readonly TellFact[],
  activeTurnSequences: readonly number[] = [],
): readonly TellFact[] {
  const eligible = pending.filter(
    (tell) => tell.binding === undefined || !activeTurnSequences.includes(tell.binding.turnSequence),
  );
  if (eligible.length === 0) return [];
  const first = eligible[0]!;
  const drained: TellFact[] = [first];
  for (const tell of eligible.slice(1)) {
    if (tell.schemaJson !== undefined) break;
    drained.push(tell);
  }
  return drained;
}

export function openBoundTurns(database: DatabaseSync, bodySequence: number): readonly number[] {
  return database
    .prepare(
      `SELECT DISTINCT turns.sequence AS sequence
    FROM turns
    JOIN tell_bindings ON tell_bindings.turn_sequence = turns.sequence
    WHERE turns.body_sequence = ? AND turns.end_sequence IS NULL
    ORDER BY turns.sequence`,
    )
    .all(bodySequence)
    .map((row) => (row as { sequence: number }).sequence);
}
