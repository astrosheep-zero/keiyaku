import type { DatabaseSync } from "node:sqlite";
import type { AkuId } from "../identity.js";
import type {
  RequestFact,
  RequestInput,
  TaskRequestInput,
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

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const KILL_EVIDENCE = [
  "already-killed",
  "already-stopped",
  "hung",
  "killed",
  "untidy",
  "unavailable",
] as const;

function decodeContractRequestService(
  input: Extract<RequestInput, { action: "contract.deliver" | "contract.review" }>,
  service: Readonly<Record<string, unknown>>,
): UpstreamRequestService {
  const factField = input.action === "contract.deliver" ? "deliveryFactId" : "reviewFactId";
  const factId = service[factField];
  const expected = ["action", "contractId", "repoRoot", factField].sort();
  if (!exactKeys(service, expected)
    || service.repoRoot !== input.repoRoot
    || service.contractId !== input.contractId
    || typeof factId !== "string"
    || factId.trim().length === 0) {
    const serviceName = input.action.slice("contract.".length);
    throw new Error(`Akuma authority contains an invalid ${serviceName} service reference`);
  }
  return input.action === "contract.deliver"
    ? { action: input.action, repoRoot: input.repoRoot, contractId: input.contractId, deliveryFactId: factId }
    : { action: input.action, repoRoot: input.repoRoot, contractId: input.contractId, reviewFactId: factId };
}

function isTaskRequest(input: RequestInput): input is TaskRequestInput {
  return input.action.startsWith("task.");
}

function decodeRequestService(
  value: unknown,
  input: Exclude<RequestInput, { action: "akuma.call" }>,
): UpstreamRequestService {
  const service = object(value);
  if (service === null || service.action !== input.action) {
    throw new Error("Akuma authority contains a mismatched request service reference");
  }
  if (input.action === "contract.deliver" || input.action === "contract.review") {
    return decodeContractRequestService(input, service);
  }
  if (input.action === "akuma.wait") {
    if (!exactKeys(service, ["action"])) {
      throw new Error("Akuma authority contains an invalid wait service reference");
    }
    return { action: input.action };
  }
  if (input.action === "akuma.tell") {
    if (!exactKeys(service, ["action", "target", "tellId"])
      || service.target !== input.target
      || service.tellId !== input.id) {
      throw new Error("Akuma authority contains an invalid tell service reference");
    }
    return { action: input.action, target: input.target, tellId: input.id };
  }
  if (isTaskRequest(input)) {
    if (!exactKeys(service, ["action"])) {
      throw new Error("Akuma authority contains an invalid Task service reference");
    }
    return { action: input.action };
  }
  if (!exactKeys(service, ["action", "results"]) || !Array.isArray(service.results)) {
    throw new Error("Akuma authority contains an invalid kill service reference");
  }
  let targetIndex = -1;
  const results = service.results.map((value) => {
    const result = object(value);
    if (result === null
      || !exactKeys(result, ["evidence", "id"])
      || typeof result.id !== "string"
      || !KILL_EVIDENCE.includes(result.evidence as typeof KILL_EVIDENCE[number])) {
      throw new Error("Akuma authority contains an invalid kill service reference");
    }
    const index = input.targets.indexOf(result.id as AkuId);
    if (index <= targetIndex) {
      throw new Error("Akuma authority contains an invalid kill service reference");
    }
    targetIndex = index;
    return {
      id: result.id as AkuId,
      evidence: result.evidence as typeof KILL_EVIDENCE[number],
    };
  });
  return { action: input.action, results };
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
    const service = decodeRequestService(
      parsed<unknown>(row.service_json),
      input as Exclude<RequestInput, { action: "akuma.call" }>,
    );
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
  const { id, action, requester, admittedAt, refusal, ...payload } = input;
  database.prepare(`INSERT OR IGNORE INTO requests(
    id, requester, action, payload_json, admitted_at, state, diagnostic
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    requester,
    action,
    json(payload),
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
