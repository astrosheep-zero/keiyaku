import type { DatabaseSync } from "node:sqlite";
import type { PauseFact, TellBinding, TellDelivery, TellDeliveryInput, TellFact, TellReceiptInput } from "./facts.js";

type TellRow = Readonly<{
  sequence: number;
  id: string;
  body: string;
  schema_json: string | null;
  initiator: string | null;
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

type TellBatch = Readonly<{
  rows: readonly TellRow[];
  deliveries: readonly (TellDeliveryRow & { sequence: number; tell_id: string; fence: string })[];
  bindings: readonly { sequence: number; tell_id: string; turn_sequence: number; bound_at: string }[];
}>;

function readTellBatch(database: DatabaseSync, rows: readonly TellRow[]): TellBatch {
  if (rows.length === 0) return { rows, deliveries: [], bindings: [] };
  const ids = JSON.stringify(rows.map((row) => row.id));
  const deliveries = database
    .prepare(
      `SELECT sequence, tell_id, turn_sequence, fence, route, receipt, delivered_at
    FROM tell_deliveries WHERE tell_id IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(ids) as unknown as TellBatch["deliveries"];
  const bindings = database
    .prepare(
      `SELECT sequence, tell_id, turn_sequence, bound_at FROM tell_bindings
    WHERE sequence IN (
      SELECT MAX(sequence) FROM tell_bindings
      WHERE tell_id IN (SELECT value FROM json_each(?)) GROUP BY tell_id
    ) ORDER BY sequence`,
    )
    .all(ids) as unknown as TellBatch["bindings"];
  return { rows, deliveries, bindings };
}

export function decodeTellBatch(batch: TellBatch): readonly TellFact[] {
  const deliveries = new Map<string, TellDelivery[]>();
  for (const row of batch.deliveries) {
    const group = deliveries.get(row.tell_id) ?? [];
    group.push({
      turnSequence: row.turn_sequence,
      route: row.route,
      deliveredAt: row.delivered_at,
      ...(row.receipt == null ? {} : { receipt: row.receipt }),
    });
    deliveries.set(row.tell_id, group);
  }
  const bindings = new Map<string, TellBinding>();
  for (const row of batch.bindings)
    bindings.set(row.tell_id, { turnSequence: row.turn_sequence, boundAt: row.bound_at });
  return batch.rows.map((row) => ({
    kind: "tell",
    sequence: row.sequence,
    id: row.id,
    body: row.body,
    ...(row.initiator === null ? {} : { initiator: row.initiator }),
    ...(row.schema_json === null ? {} : { schemaJson: row.schema_json }),
    state: row.state,
    recordedAt: row.recorded_at,
    deliveries: deliveries.get(row.id) ?? [],
    ...(bindings.has(row.id) ? { binding: bindings.get(row.id)! } : {}),
  }));
}

function decodeTellRows(database: DatabaseSync, rows: readonly TellRow[]): readonly TellFact[] {
  return decodeTellBatch(readTellBatch(database, rows));
}

export function tellBatchAtSequences(database: DatabaseSync, sequences: readonly number[]): TellBatch {
  if (sequences.length === 0) return { rows: [], deliveries: [], bindings: [] };
  const rows = database
    .prepare(
      `SELECT sequence, id, body, initiator, schema_json, recorded_at, ${tellStateSql} AS state
    FROM tells WHERE sequence IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(JSON.stringify(sequences)) as unknown as readonly TellRow[];
  return readTellBatch(database, rows);
}

export function hasPendingTell(database: DatabaseSync): boolean {
  return database.prepare(`SELECT 1 FROM tells WHERE ${tellStateSql} = 'pending' LIMIT 1`).get() !== undefined;
}

export function insertTellFact(
  database: DatabaseSync,
  tell: Omit<TellFact, "sequence" | "state" | "deliveries">,
): number {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('tell')").run().lastInsertRowid);
  database
    .prepare("INSERT INTO tells(id, sequence, body, initiator, schema_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(tell.id, sequence, tell.body, tell.initiator ?? null, tell.schemaJson ?? null, tell.recordedAt);
  return sequence;
}

export function tellFact(database: DatabaseSync, id: string): TellFact | null {
  const row = database
    .prepare(
      `SELECT sequence, id, body, initiator, schema_json, recorded_at, ${tellStateSql} AS state
    FROM tells WHERE id = ?`,
    )
    .get(id) as TellRow | undefined;
  return row === undefined ? null : decodeTellRows(database, [row])[0]!;
}

export function sameTellInput(
  existing: TellFact,
  tell: Omit<TellFact, "sequence" | "state" | "deliveries" | "binding">,
): boolean {
  return (
    existing.body === tell.body &&
    existing.recordedAt === tell.recordedAt &&
    existing.schemaJson === tell.schemaJson &&
    existing.initiator === tell.initiator
  );
}

export function insertTellDeliveryFact(database: DatabaseSync, input: TellDeliveryInput): boolean {
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
  return result.changes !== 0;
}

export function insertTellReceiptFact(database: DatabaseSync, input: TellReceiptInput): boolean {
  const result = database
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
  return result.changes !== 0;
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
      `SELECT sequence, id, body, initiator, schema_json, recorded_at, ${tellStateSql} AS state FROM tells
    WHERE ${tellStateSql} = 'pending' ORDER BY sequence`,
    )
    .all() as unknown as readonly TellRow[];
  return decodeTellRows(database, rows);
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

export function turnParticipants(database: DatabaseSync, turnSequence: number): readonly string[] {
  const rows = database
    .prepare(
      `SELECT turns.initiator AS owner, tells.initiator AS teller
       FROM turns
       LEFT JOIN tell_bindings ON tell_bindings.turn_sequence = turns.sequence
       LEFT JOIN tells ON tells.id = tell_bindings.tell_id
       WHERE turns.sequence = ?
       ORDER BY tell_bindings.sequence`,
    )
    .all(turnSequence) as { owner: string | null; teller: string | null }[];
  const participants = new Set<string>();
  for (const row of rows) {
    if (row.owner) participants.add(row.owner);
    if (row.teller) participants.add(row.teller);
  }
  return [...participants];
}

export function drainPendingTells(
  pending: readonly TellFact[],
  activeTurnSequences: readonly number[] = [],
  pause?: PauseFact | null,
  bodySequence?: number,
): readonly TellFact[] {
  let available = pending;
  if (pause !== undefined && pause !== null && pause.bodySequence === bodySequence) {
    if (pause.frontierTellId === undefined) {
      available = [];
    } else {
      const frontier = pending.find((tell) => tell.id === pause.frontierTellId);
      available = frontier === undefined ? [] : pending.filter((tell) => tell.sequence < frontier.sequence);
    }
  }
  const eligible = available.filter(
    (tell) => tell.binding === undefined || !activeTurnSequences.includes(tell.binding.turnSequence),
  );
  if (eligible.length === 0) return [];
  const first = eligible[0]!;
  if (first.schemaJson !== undefined) return [first];
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
