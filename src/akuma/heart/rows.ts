import type { DatabaseSync } from "node:sqlite";
import type { AkuId } from "../identity.js";
import type {
  BodyEnd,
  BodyFact,
  CallFact,
  KillFact,
  PauseFact,
  RequestFact,
  RequestInput,
  ResumeCoordinate,
  SessionFact,
  StopFact,
  TurnFact,
  TurnStartFact,
  TurnEndFact,
  UpstreamRequestService,
} from "./facts.js";
import type { ProviderOptions } from "../provider-recipe.js";
import { decodeResumeCoordinate, encodeResumeCoordinate as encodeCoordinate } from "../coordinate.js";

export type SealRow = Readonly<{ evidence: string; at: string }>;

export type BodyRow = Readonly<{
  sequence: number;
  leash_taken_at: string;
  hung_diagnostic: string | null;
  hung_at: string | null;
  end: BodyEnd | null;
  ended_at: string | null;
}>;

export type SessionRow = Readonly<{
  sequence: number;
  provider: string;
  coordinate_json: string;
  cwd: string;
  options_json: string;
  admitted_at: string;
}>;

export type TurnRow = Readonly<{
  sequence: number;
  body_sequence: number;
  started_at: string;
  end_sequence: number | null;
  outcome: "answered" | "failed" | null;
  history_id: string | null;
  session_json: string | null;
  answer: string | null;
  diagnostic: string | null;
  completed_at: string | null;
}>;

export type CallRow = Readonly<{
  sequence: number;
  turn_sequence: number;
  body: string;
  at: string;
}>;

export type RequestRow = Readonly<{
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

export type ActivityRow = Readonly<{
  sequence: number;
  turn_sequence: number;
  event_json: string;
  at: string;
}>;
export type ActivityFact = Readonly<{
  kind: "activity";
  sequence: number;
  turnSequence: number;
  event: unknown;
  at: string;
}>;
export type KillRow = Readonly<{ sequence: number; body_sequence: number; evidence: "killed"; at: string }>;
type ControlRow = Readonly<{ value_json: string; at: string }>;

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
    throw new Error(`Akuma authority contains an invalid ${input.action.slice("contract.".length)} service reference`);
  }
  return input.action === "contract.deliver"
    ? { action: input.action, repoRoot: input.repoRoot, contractId: input.contractId, deliveryFactId: factId }
    : { action: input.action, repoRoot: input.repoRoot, contractId: input.contractId, reviewFactId: factId };
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

function resumeCoordinate(value: unknown): ResumeCoordinate {
  const coordinate = decodeResumeCoordinate(value);
  if (coordinate === null) throw new Error("Akuma authority contains an invalid resume coordinate");
  return coordinate;
}

export function encodeSessionRow(session: Omit<SessionFact, "sequence">): readonly [string, string, string, string, string] {
  return [session.provider, encodeResumeCoordinate(session.coordinate), session.cwd, json(session.options), session.admittedAt];
}

export function encodeResumeCoordinate(coordinate: ResumeCoordinate): string {
  return json(encodeCoordinate(coordinate));
}

export function decodeSessionRow(row: SessionRow): SessionFact {
  return {
    sequence: row.sequence,
    provider: row.provider,
    coordinate: resumeCoordinate(parsed<unknown>(row.coordinate_json)),
    cwd: row.cwd,
    options: parsed<ProviderOptions>(row.options_json),
    admittedAt: row.admitted_at,
  };
}

export function decodeBodyRow(row: BodyRow): BodyFact {
  return {
    sequence: row.sequence,
    leashTakenAt: row.leash_taken_at,
    ...(row.hung_diagnostic === null ? {} : { hung: { diagnostic: row.hung_diagnostic, at: row.hung_at! } }),
    ...(row.end === null ? {} : { end: row.end }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}

export function decodeTurnRow(row: TurnRow): TurnFact {
  const start: TurnStartFact = {
    kind: "turn-start",
    sequence: row.sequence,
    bodySequence: row.body_sequence,
    startedAt: row.started_at,
  };
  if (row.outcome === null) return start;
  const end: TurnEndFact = {
    kind: "turn-end",
    sequence: row.end_sequence!,
    turnSequence: row.sequence,
    outcome: row.outcome === "answered"
      ? {
          kind: "answered",
          ...(row.history_id === null ? {} : { historyId: row.history_id }),
          session: resumeCoordinate(parsed<unknown>(row.session_json)),
          answer: row.answer!,
        }
      : { kind: "failed", diagnostic: row.diagnostic! },
    completedAt: row.completed_at!,
  };
  return { ...start, end };
}

export function decodeCallRow(row: CallRow): CallFact {
  return { kind: "call", sequence: row.sequence, turnSequence: row.turn_sequence, body: row.body, at: row.at };
}

export function decodeRequestRow(row: RequestRow): RequestFact {
  if (!["akuma.call", "akuma.wait", "akuma.tell", "akuma.kill", "contract.deliver", "contract.review"].includes(row.action)) {
    throw new Error(`Akuma authority contains an unknown request action: ${row.action}`);
  }
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
    return {
      ...input,
      state: row.state,
      service,
    } as Extract<RequestFact, { state: "served"; service: unknown }>;
  }
  if (row.state === "refused") return { ...input, state: row.state, diagnostic: row.diagnostic! };
  if (row.state === "voided") return { ...input, state: row.state, evidence: row.evidence! };
  return { ...input, state: "admitted" };
}

export function encodeActivityEvent(event: unknown): string {
  return json(event);
}

export function decodeActivityRow(row: ActivityRow): ActivityFact {
  return {
    kind: "activity",
    sequence: row.sequence,
    turnSequence: row.turn_sequence,
    event: parsed(row.event_json),
    at: row.at,
  };
}

export function sealExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT singleton FROM seal WHERE singleton = 1").get() !== undefined;
}

export function insertSealFact(database: DatabaseSync, input: Readonly<{ evidence: string; at: string }>): void {
  database.prepare("INSERT OR IGNORE INTO seal(singleton, evidence, at) VALUES (1, ?, ?)")
    .run(input.evidence, input.at);
}

export function deletePauseControl(database: DatabaseSync): void {
  database.prepare("DELETE FROM control WHERE kind = 'pause'").run();
}

export function deleteStopControl(database: DatabaseSync): void {
  database.prepare("DELETE FROM control WHERE kind = 'stop'").run();
}

export function sealFact(database: DatabaseSync): Readonly<{ evidence: string; at: string }> | null {
  const row = database.prepare("SELECT evidence, at FROM seal WHERE singleton = 1").get() as SealRow | undefined;
  return row === undefined ? null : { evidence: row.evidence, at: row.at };
}

export function insertBodyFact(
  database: DatabaseSync,
  input: Readonly<{ leashTakenAt: string }>,
): number {
  const result = database.prepare("INSERT INTO bodies(leash_taken_at) VALUES (?)").run(input.leashTakenAt);
  return Number(result.lastInsertRowid);
}

export function insertSessionFact(database: DatabaseSync, input: Omit<SessionFact, "sequence">): number {
  const result = database.prepare(`INSERT INTO sessions(provider, coordinate_json, cwd, options_json, admitted_at)
    VALUES (?, ?, ?, ?, ?)`).run(...encodeSessionRow(input));
  return Number(result.lastInsertRowid);
}

export function insertActivityFact(
  database: DatabaseSync,
  input: Readonly<{ turnSequence: number; event: unknown; at: string }>,
): number {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('activity')").run().lastInsertRowid);
  database.prepare("INSERT INTO activity(sequence, turn_sequence, event_json, at) VALUES (?, ?, ?, ?)")
    .run(sequence, input.turnSequence, encodeActivityEvent(input.event), input.at);
  return sequence;
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
  const row = database.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`).get(id) as RequestRow | undefined;
  return row === undefined ? null : decodeRequestRow(row);
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

export function insertStopControl(database: DatabaseSync, bodySequence: number, at: string): void {
  database.prepare("INSERT OR IGNORE INTO control(kind, value_json, at) VALUES ('stop', ?, ?)")
    .run(json({ bodySequence }), at);
}

export function insertPauseControl(database: DatabaseSync, at: string): void {
  const body = latestBodyFact(database);
  if (body === null) throw new Error("Akuma has no Body to interrupt");
  database.prepare("INSERT OR IGNORE INTO control(kind, value_json, at) VALUES ('pause', ?, ?)")
    .run(json({ bodySequence: body.sequence }), at);
}

export function stopFact(database: DatabaseSync): StopFact | null {
  const row = database.prepare("SELECT value_json, at FROM control WHERE kind = 'stop'").get() as ControlRow | undefined;
  if (row === undefined) return null;
  const value = parsed<{ bodySequence: unknown }>(row.value_json);
  if (!Number.isSafeInteger(value.bodySequence) || (value.bodySequence as number) <= 0) {
    throw new Error("Akuma stop control has an invalid Body sequence");
  }
  return { bodySequence: value.bodySequence as number, requestedAt: row.at };
}

export function pauseFact(database: DatabaseSync): PauseFact | null {
  const row = database.prepare("SELECT value_json, at FROM control WHERE kind = 'pause'").get() as ControlRow | undefined;
  if (row === undefined) return null;
  const value = parsed<{ bodySequence: unknown }>(row.value_json);
  if (!Number.isSafeInteger(value.bodySequence) || (value.bodySequence as number) <= 0) {
    throw new Error("Akuma pause control has an invalid Body sequence");
  }
  return { bodySequence: value.bodySequence as number, requestedAt: row.at };
}

export function insertKillFact(database: DatabaseSync, bodySequence: number, at: string): void {
  database.prepare("INSERT OR IGNORE INTO kills(body_sequence, evidence, at) VALUES (?, 'killed', ?)")
    .run(bodySequence, at);
}

export function endBodyFact(
  database: DatabaseSync,
  input: Readonly<{ sequence: number; end: BodyEnd; at: string }>,
): void {
  database.prepare("UPDATE bodies SET end = ?, ended_at = ? WHERE sequence = ? AND end IS NULL")
    .run(input.end, input.at, input.sequence);
}

export function markBodyHung(
  database: DatabaseSync,
  input: Readonly<{ sequence: number; diagnostic: string; at: string }>,
): void {
  const result = database.prepare(`UPDATE bodies SET hung_diagnostic = ?, hung_at = ?
    WHERE sequence = ? AND end IS NULL AND hung_diagnostic IS NULL`)
    .run(input.diagnostic, input.at, input.sequence);
  if (result.changes !== 1) throw new Error(`Akuma Body ${input.sequence} cannot record hung custody`);
}

export function insertTurnStartFact(
  database: DatabaseSync,
  input: Readonly<{ bodySequence: number; startedAt: string; call?: string }>,
): TurnStartFact {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('turn-start')").run().lastInsertRowid);
  database.prepare("INSERT INTO turns(sequence, body_sequence, started_at) VALUES (?, ?, ?)")
    .run(sequence, input.bodySequence, input.startedAt);
  if (input.call !== undefined) {
    const callSequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('call')").run().lastInsertRowid);
    database.prepare("INSERT INTO calls(sequence, turn_sequence, body, at) VALUES (?, ?, ?, ?)")
      .run(callSequence, sequence, input.call, input.startedAt);
  }
  return { kind: "turn-start", sequence, bodySequence: input.bodySequence, startedAt: input.startedAt };
}

export function insertTurnEndFact(database: DatabaseSync, input: Omit<TurnEndFact, "sequence">): TurnEndFact {
  const sequence = Number(database.prepare("INSERT INTO timeline(kind) VALUES ('turn-end')").run().lastInsertRowid);
  const result = input.outcome.kind === "answered"
    ? database.prepare(`UPDATE turns SET end_sequence = ?, outcome = 'answered', history_id = ?,
        session_json = ?, answer = ?, completed_at = ? WHERE sequence = ? AND end_sequence IS NULL`).run(
        sequence, input.outcome.historyId ?? null, encodeResumeCoordinate(input.outcome.session), input.outcome.answer,
        input.completedAt, input.turnSequence,
      )
    : database.prepare(`UPDATE turns SET end_sequence = ?, outcome = 'failed', diagnostic = ?, completed_at = ?
        WHERE sequence = ? AND end_sequence IS NULL`).run(
        sequence, input.outcome.diagnostic, input.completedAt, input.turnSequence,
      );
  if (result.changes !== 1) throw new Error(`Akuma Turn ${input.turnSequence} is not open`);
  return { ...input, kind: "turn-end", sequence };
}

export function finishBodyFact(database: DatabaseSync, input: Readonly<{ sequence: number; at: string }>): void {
  database.prepare("UPDATE bodies SET end = 'exited', ended_at = ? WHERE sequence = ? AND end IS NULL")
    .run(input.at, input.sequence);
}

export function latestBodyFact(database: DatabaseSync): BodyFact | null {
  const row = database.prepare(`SELECT sequence, leash_taken_at, hung_diagnostic, hung_at, end, ended_at
    FROM bodies ORDER BY sequence DESC LIMIT 1`).get() as BodyRow | undefined;
  return row === undefined ? null : decodeBodyRow(row);
}

export function latestSessionFact(database: DatabaseSync): SessionFact | null {
  const row = database.prepare(`SELECT sequence, provider, coordinate_json, cwd, options_json, admitted_at
    FROM sessions ORDER BY sequence DESC LIMIT 1`).get() as SessionRow | undefined;
  return row === undefined ? null : decodeSessionRow(row);
}

export function sessionFactForCoordinate(database: DatabaseSync, coordinate: ResumeCoordinate): SessionFact | null {
  const row = database.prepare(`SELECT sequence, provider, coordinate_json, cwd, options_json, admitted_at
    FROM sessions WHERE coordinate_json = ? ORDER BY sequence DESC LIMIT 1`)
    .get(encodeResumeCoordinate(coordinate)) as SessionRow | undefined;
  return row === undefined ? null : decodeSessionRow(row);
}

export function latestKillFact(database: DatabaseSync): KillFact | null {
  const row = database.prepare(`SELECT sequence, body_sequence, evidence, at
    FROM kills ORDER BY sequence DESC LIMIT 1`).get() as KillRow | undefined;
  return row === undefined ? null : {
    sequence: row.sequence,
    bodySequence: row.body_sequence,
    evidence: row.evidence,
    at: row.at,
  };
}

export function killFactForBody(database: DatabaseSync, bodySequence: number): KillFact | null {
  const row = database.prepare(`SELECT sequence, body_sequence, evidence, at
    FROM kills WHERE body_sequence = ?`).get(bodySequence) as KillRow | undefined;
  return row === undefined ? null : {
    sequence: row.sequence,
    bodySequence: row.body_sequence,
    evidence: row.evidence,
    at: row.at,
  };
}

export function lastAnsweredTurnFact(database: DatabaseSync): TurnFact | null {
  const row = database.prepare(`SELECT sequence, body_sequence, started_at, end_sequence, outcome, history_id,
    session_json, answer, diagnostic, completed_at FROM turns WHERE outcome = 'answered' ORDER BY end_sequence DESC LIMIT 1`)
    .get() as TurnRow | undefined;
  return row === undefined ? null : decodeTurnRow(row);
}

export function answeredTurnFact(database: DatabaseSync, historyId: string): TurnFact | null {
  const row = database.prepare(`SELECT sequence, body_sequence, started_at, end_sequence, outcome, history_id,
    session_json, answer, diagnostic, completed_at FROM turns WHERE outcome = 'answered' AND history_id = ?`).get(historyId) as TurnRow | undefined;
  return row === undefined ? null : decodeTurnRow(row);
}
