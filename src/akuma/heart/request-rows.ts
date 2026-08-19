import type { DatabaseSync } from "node:sqlite";
import type { AkuId } from "../identity.js";
import type {
  RequestFact,
  RequestInput,
  UpstreamRequestService,
} from "./facts.js";
import { isTaskMutationAction } from "../../task/mutation.js";

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

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsed<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Akuma authority contains non-text JSON");
  return JSON.parse(value) as T;
}

export function requestPayloadJson(input: RequestInput): string {
  const {
    id: _id,
    action: _action,
    requester: _requester,
    admittedAt: _admittedAt,
    state: _state,
    child: _child,
    service: _service,
    diagnostic: _diagnostic,
    evidence: _evidence,
    refusal: _refusal,
    ...payload
  } = input as RequestInput & Readonly<{
    requester?: AkuId;
    admittedAt?: string;
    state?: RequestFact["state"];
    child?: AkuId;
    service?: UpstreamRequestService;
    diagnostic?: string;
    evidence?: string;
    refusal?: string;
  }>;
  return json(payload);
}

function decodeRequestRow(row: RequestRow): RequestFact {
  const knownAction = [
    "akuma.call", "akuma.wait", "akuma.tell", "akuma.kill", "contract.deliver", "contract.review",
  ].includes(row.action) || isTaskMutationAction(row.action);
  if (!knownAction) throw new Error(`Akuma authority contains an unknown request action: ${row.action}`);
  const payload = parsed<Omit<RequestInput, "action" | "id">>(row.payload_json);
  const input = {
    id: row.id,
    requester: row.requester as AkuId,
    action: row.action,
    ...payload,
    admittedAt: row.admitted_at,
  } as RequestInput & Readonly<{ requester: AkuId; admittedAt: string }>;
  if (row.state === "reserved") {
    if (input.action !== "akuma.call" || row.child === null) {
      throw new Error("Akuma authority contains an invalid reserved request");
    }
    return { ...input, state: row.state, child: row.child as AkuId };
  }
  if (row.state === "served") {
    if (input.action === "akuma.call") {
      if (row.child === null) throw new Error("Akuma authority contains a served call without a child");
      return { ...input, state: row.state, child: row.child as AkuId };
    }
    if (row.service_json === null) {
      throw new Error("Akuma authority contains a served request without a service reference");
    }
    const service = parsed<UpstreamRequestService>(row.service_json);
    return { ...input, state: row.state, service } as Extract<RequestFact, { state: "served" }>;
  }
  if (row.state === "refused") return { ...input, state: row.state, diagnostic: row.diagnostic! };
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
  database.prepare(`INSERT OR IGNORE INTO requests(
    id, requester, action, payload_json, admitted_at, state, diagnostic
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
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
  const rows = database.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests
    WHERE state IN ('admitted', 'reserved') ORDER BY sequence`).all() as unknown as readonly RequestRow[];
  return rows.map(decodeRequestRow);
}

export function updateRequestReserved(database: DatabaseSync, id: string, child: AkuId): void {
  database.prepare("UPDATE requests SET state = 'reserved', child = ? WHERE id = ? AND state = 'admitted'")
    .run(child, id);
}

export function updateRequestServed(database: DatabaseSync, id: string, child: AkuId): void {
  database.prepare(`UPDATE requests SET state = 'served', child = ?
    WHERE id = ? AND state = 'reserved'`).run(child, id);
}

export function updateUpstreamRequestServed(database: DatabaseSync, id: string, service: unknown): void {
  database.prepare(`UPDATE requests SET state = 'served', service_json = ?
    WHERE id = ? AND state = 'admitted' AND action != 'akuma.call'`).run(json(service), id);
}

export function updateRequestRefused(database: DatabaseSync, id: string, diagnostic: string): void {
  database.prepare(`UPDATE requests SET state = 'refused', diagnostic = ?
    WHERE id = ? AND state = 'admitted'`).run(diagnostic, id);
}

export function updateRequestVoided(database: DatabaseSync, id: string, evidence: string): void {
  database.prepare(`UPDATE requests SET state = 'voided', child = NULL, service_json = NULL, evidence = ?
    WHERE id = ? AND state IN ('admitted', 'reserved')`).run(evidence, id);
}
