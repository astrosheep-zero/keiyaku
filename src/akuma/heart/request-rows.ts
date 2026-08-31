import type { DatabaseSync } from "node:sqlite";
import type { AkuId } from "../identity.js";
import type { RequestFact, RequestInput } from "./facts.js";

type RequestRow = Readonly<{
  sequence: number;
  id: string;
  requester: string;
  action: string;
  payload_json: string;
  admitted_at: string;
  state: RequestFact["state"];
  child: string | null;
  service_json: string | null;
  diagnostic: string | null;
  evidence: string | null;
}>;

function assertJsonText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Akuma authority contains non-text JSON");
  JSON.parse(value);
  return value;
}

export function requestPayloadJson(input: RequestInput): string {
  return assertJsonText(input.payloadJson);
}

function decodeRequestRow(row: RequestRow): RequestFact {
  const input = {
    id: row.id,
    requester: row.requester as AkuId,
    action: row.action,
    payloadJson: assertJsonText(row.payload_json),
    admittedAt: row.admitted_at,
  };
  if (row.state === "reserved") {
    if (row.child === null || row.service_json !== null) {
      throw new Error("Akuma authority contains an invalid reserved request");
    }
    return { ...input, state: row.state, child: row.child as AkuId };
  }
  if (row.state === "begun") {
    if (row.child !== null || row.service_json !== null || row.diagnostic !== null || row.evidence !== null) {
      throw new Error("Akuma authority contains an invalid begun request");
    }
    return { ...input, state: row.state };
  }
  if (row.state === "served") {
    if (row.child !== null && row.service_json === null) {
      return { ...input, state: row.state, child: row.child as AkuId };
    }
    if (row.child === null && row.service_json !== null) {
      return { ...input, state: row.state, serviceJson: assertJsonText(row.service_json) };
    }
    throw new Error("Akuma authority contains an invalid served request");
  }
  if (row.state === "refused") return { ...input, state: row.state, diagnostic: row.diagnostic! };
  if (row.state === "unproven") return { ...input, state: row.state, evidence: row.evidence! };
  if (row.state === "voided") return { ...input, state: row.state, evidence: row.evidence! };
  return { ...input, state: "admitted" };
}

const REQUEST_COLUMNS = `sequence, id, requester, action, payload_json, admitted_at,
  state, child, service_json, diagnostic, evidence`;

export function insertRequestFact(
  database: DatabaseSync,
  input: RequestInput & Readonly<{ requester: AkuId; admittedAt: string; refusal?: string }>,
): void {
  const { id, action, requester, admittedAt, refusal } = input;
  database
    .prepare(
      `INSERT OR IGNORE INTO requests(
    id, requester, action, payload_json, admitted_at, state, diagnostic
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      requester,
      action,
      requestPayloadJson(input),
      admittedAt,
      refusal === undefined ? "admitted" : "refused",
      refusal ?? null,
    );
}

export function requestFact(database: DatabaseSync, id: string): RequestFact | null {
  const row = database.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`).get(id);
  return row === undefined ? null : decodeRequestRow(row as RequestRow);
}

export function nonterminalRequestFacts(database: DatabaseSync): readonly RequestFact[] {
  const rows = database
    .prepare(
      `SELECT ${REQUEST_COLUMNS} FROM requests
    WHERE state IN ('admitted', 'reserved', 'begun') ORDER BY sequence`,
    )
    .all() as unknown as readonly RequestRow[];
  return rows.map(decodeRequestRow);
}

export function updateRequestReserved(database: DatabaseSync, id: string, child: AkuId): void {
  database
    .prepare("UPDATE requests SET state = 'reserved', child = ? WHERE id = ? AND state = 'admitted'")
    .run(child, id);
}

export function updateRequestServed(database: DatabaseSync, id: string, child: AkuId): void {
  database
    .prepare(
      `UPDATE requests SET state = 'served', child = ?
    WHERE id = ? AND state = 'reserved'`,
    )
    .run(child, id);
}

export function updateRequestBegun(database: DatabaseSync, id: string): void {
  database.prepare("UPDATE requests SET state = 'begun' WHERE id = ? AND state = 'admitted'").run(id);
}

export function updateUpstreamRequestServed(database: DatabaseSync, id: string, service: unknown): void {
  database
    .prepare(
      `UPDATE requests SET state = 'served', service_json = ?
    WHERE id = ? AND state = 'begun'`,
    )
    .run(assertJsonText(service), id);
}

export function updateRequestRefused(database: DatabaseSync, id: string, diagnostic: string): void {
  database
    .prepare(
      `UPDATE requests SET state = 'refused', diagnostic = ?
    WHERE id = ? AND state = 'admitted'`,
    )
    .run(diagnostic, id);
}

export function updateRequestVoided(database: DatabaseSync, id: string, evidence: string): void {
  database
    .prepare(
      `UPDATE requests SET state = 'voided', child = NULL, service_json = NULL, diagnostic = NULL, evidence = ?
    WHERE id = ? AND state IN ('admitted', 'reserved', 'begun')`,
    )
    .run(evidence, id);
}

export function updateRequestUnproven(database: DatabaseSync, id: string, evidence: string): void {
  database
    .prepare(
      `UPDATE requests SET state = 'unproven', child = NULL, service_json = NULL, diagnostic = NULL, evidence = ?
    WHERE id = ? AND state = 'begun'`,
    )
    .run(evidence, id);
}
