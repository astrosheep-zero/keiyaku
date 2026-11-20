import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { PauseFact, TellBinding, TellDelivery, TellDeliveryInput, TellFact } from "./facts.js";

type TellRow = Pick<TellFact, "sequence" | "id" | "body" | "recordedAt" | "state"> & {
  schemaJson: string | null;
  initiator: string | null;
  deliveries: string;
  binding: string | null;
};

export const tellStateSql = `CASE WHEN EXISTS (
  SELECT 1 FROM tell_terminal_receipts WHERE tell_id = tells.id
) THEN 'told' ELSE 'pending' END`;

function readTellBatch(database: DatabaseSync, selection: string, ...args: SQLInputValue[]): readonly TellRow[] {
  return database
    .prepare(
      `SELECT sequence, id, body, initiator, schema_json AS schemaJson, recorded_at AS recordedAt,
         ${tellStateSql} AS state,
         (SELECT json_group_array(json_patch(
           json_object('turnSequence', turn_sequence, 'route', route, 'deliveredAt', delivered_at),
           json_object('receipt', receipt)) ORDER BY tell_deliveries.sequence)
          FROM tell_deliveries WHERE tell_id = tells.id) AS deliveries,
         (SELECT json_object('turnSequence', turn_sequence, 'boundAt', bound_at)
          FROM tell_bindings WHERE tell_id = tells.id ORDER BY tell_bindings.sequence DESC LIMIT 1) AS binding
       FROM tells WHERE ${selection} ORDER BY sequence`,
    )
    .all(...args) as unknown as readonly TellRow[];
}

export function decodeTellBatch(batch: readonly TellRow[]): readonly TellFact[] {
  return batch.map(({ initiator, schemaJson, deliveries, binding, ...tell }) => {
    const delivered = JSON.parse(deliveries) as TellDelivery[];
    const bound = binding === null ? undefined : (JSON.parse(binding) as TellBinding);
    if (
      delivered.some(({ turnSequence }) => !Number.isSafeInteger(turnSequence)) ||
      (bound !== undefined && !Number.isSafeInteger(bound.turnSequence))
    )
      throw new RangeError("Akuma Tell references a Turn outside the safe integer range");
    return {
      kind: "tell",
      ...tell,
      ...(initiator === null ? {} : { initiator }),
      ...(schemaJson === null ? {} : { schemaJson }),
      deliveries: delivered,
      ...(bound === undefined ? {} : { binding: bound }),
    };
  });
}

export function tellBatchAtSequences(database: DatabaseSync, sequences: readonly number[]): readonly TellRow[] {
  return sequences.length === 0
    ? []
    : readTellBatch(database, "sequence IN (SELECT value FROM json_each(?))", JSON.stringify(sequences));
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
  return decodeTellBatch(readTellBatch(database, "id = ?", id))[0] ?? null;
}

export function requireTell(database: DatabaseSync, id: string): void {
  if (database.prepare("SELECT 1 FROM tells WHERE id = ?").get(id) === undefined) throw new Error(`unknown tell ${id}`);
}

export function tellWasUndelivered(database: DatabaseSync, id: string): boolean {
  const query = database.prepare(
    "SELECT undelivered FROM tell_terminal_receipts WHERE tell_id = ? AND kind = 'undelivered'",
  );
  return query.get(id)?.undelivered === 1;
}

export function insertTellDeliveryFact(database: DatabaseSync, input: TellDeliveryInput): boolean {
  const { tellId, turnSequence, fence, route, deliveredAt } = input;
  const receipt = input.route === "live" ? input.receipt : null;
  const insert = database.prepare(`INSERT OR IGNORE INTO tell_deliveries
    (tell_id, turn_sequence, fence, route, receipt, delivered_at) VALUES (?, ?, ?, ?, ?, ?)`);
  if (insert.run(tellId, turnSequence, fence, route, receipt, deliveredAt).changes === 0) {
    const existing = database
      .prepare("SELECT route, receipt FROM tell_deliveries WHERE tell_id = ? AND turn_sequence = ? AND fence = ?")
      .get(tellId, turnSequence, fence);
    if (existing?.route !== route || existing?.receipt !== receipt)
      throw new Error(`tell delivery ${tellId} has conflicting evidence`);
    return false;
  }
  if (receipt !== "required") tellTerminalWriter(database, receipt ?? route, deliveredAt)(tellId);
  return true;
}

export function tellTerminalWriter(database: DatabaseSync, kind: string, at: string, exact = false) {
  const insert =
    database.prepare(`INSERT INTO tell_terminal_receipts(tell_id, kind, received_at, undelivered) VALUES (?, ?, ?, ?)
    ON CONFLICT(tell_id, kind) DO UPDATE SET undelivered = 1 WHERE excluded.undelivered > undelivered`);
  return (id: string) => insert.run(id, kind, at, Number(exact && kind === "undelivered")).changes !== 0;
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
  return decodeTellBatch(readTellBatch(database, `${tellStateSql} = 'pending'`));
}

export function insertTellBindingFact(
  database: DatabaseSync,
  input: Readonly<{ tellId: string; turnSequence: number; boundAt: string }>,
): void {
  const insert = database.prepare(`INSERT INTO tell_bindings(tell_id, turn_sequence, bound_at) VALUES (?, ?, ?)
    ON CONFLICT(tell_id, turn_sequence) DO NOTHING`);
  insert.run(input.tellId, input.turnSequence, input.boundAt);
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
