import type { DatabaseSync } from "node:sqlite";
import type { AkuId } from "../identity.js";
import type {
  AkumaOrigin,
  BodyEnd,
  BodyFact,
  CallFact,
  Collar,
  Confinement,
  KillFact,
  ProviderExecution,
  ProviderOptions,
  RequestFact,
  RequestInput,
  RequestRecipe,
  ResumeCoordinate,
  SessionFact,
  Soul,
  StopFact,
  TurnFact,
  TurnStartFact,
  TurnEndFact,
} from "./facts.js";

export type SoulRow = Readonly<{
  id: string;
  archetype: string;
  description: string | null;
  provider_json: string;
  options_json: string;
  cwd: string;
  origin_json: string;
  confinement_json: string;
  created_at: string;
}>;

export type SealRow = Readonly<{ evidence: string; at: string }>;

export type BodyRow = Readonly<{
  sequence: number;
  pid: number;
  process_group: number;
  spawned_at: string;
  leash_taken_at: string;
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
  archetype: string;
  body: string;
  cwd: string | null;
  world: string;
  recipe_json: string;
  admitted_at: string;
  state: RequestFact["state"];
  child: string | null;
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

export function encodeSoulRow(soul: Soul): readonly [
  AkuId,
  string,
  string | null,
  string,
  string,
  string,
  string,
  string,
  string,
] {
  return [
    soul.id,
    soul.archetype,
    soul.description ?? null,
    json(soul.provider),
    json(soul.options),
    soul.cwd,
    json(soul.origin),
    json(soul.confinement),
    soul.createdAt,
  ];
}

export function decodeSoulRow(row: SoulRow): Soul {
  return {
    id: row.id as AkuId,
    archetype: row.archetype,
    ...(row.description === null ? {} : { description: row.description }),
    provider: parsed<ProviderExecution>(row.provider_json),
    options: parsed<ProviderOptions>(row.options_json),
    cwd: row.cwd,
    origin: parsed<AkumaOrigin>(row.origin_json),
    confinement: parsed<Confinement>(row.confinement_json),
    createdAt: row.created_at,
  };
}

export function encodeSessionRow(session: Omit<SessionFact, "sequence">): readonly [string, string, string, string, string] {
  return [session.provider, json(session.coordinate), session.cwd, json(session.options), session.admittedAt];
}

export function encodeResumeCoordinate(coordinate: ResumeCoordinate): string {
  return json(coordinate);
}

export function decodeSessionRow(row: SessionRow): SessionFact {
  return {
    sequence: row.sequence,
    provider: row.provider,
    coordinate: parsed<ResumeCoordinate>(row.coordinate_json),
    cwd: row.cwd,
    options: parsed<ProviderOptions>(row.options_json),
    admittedAt: row.admitted_at,
  };
}

export function decodeBodyRow(row: BodyRow): BodyFact {
  return {
    sequence: row.sequence,
    collar: { pid: row.pid, processGroup: row.process_group, spawnedAt: row.spawned_at },
    leashTakenAt: row.leash_taken_at,
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
          historyId: row.history_id!,
          session: parsed<ResumeCoordinate>(row.session_json),
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
  const input = {
    id: row.id,
    archetype: row.archetype,
    body: row.body,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    world: row.world,
    recipe: parsed<RequestRecipe>(row.recipe_json),
    admittedAt: row.admitted_at,
  };
  if (row.state === "reserved" || row.state === "served") {
    return { ...input, state: row.state, child: row.child! as AkuId };
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

export function soulFact(database: DatabaseSync): Soul | null {
  const row = database.prepare(`SELECT id, archetype, description, provider_json, options_json, cwd,
    origin_json, confinement_json, created_at FROM soul WHERE singleton = 1`).get() as SoulRow | undefined;
  return row === undefined ? null : decodeSoulRow(row);
}

export function sealExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT singleton FROM seal WHERE singleton = 1").get() !== undefined;
}

export function insertSoulFact(database: DatabaseSync, soul: Soul): void {
  database.prepare(`INSERT INTO soul(singleton, id, archetype, description, provider_json, options_json, cwd, origin_json, confinement_json, created_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...encodeSoulRow(soul));
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
  input: Readonly<{ collar: Collar; leashTakenAt: string }>,
): number {
  const result = database.prepare(`INSERT INTO bodies(pid, process_group, spawned_at, leash_taken_at)
    VALUES (?, ?, ?, ?)`).run(input.collar.pid, input.collar.processGroup, input.collar.spawnedAt, input.leashTakenAt);
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

const REQUEST_COLUMNS = `sequence, id, archetype, body, cwd, world, recipe_json, admitted_at,
  state, child, diagnostic, evidence`;

export function insertRequestFact(
  database: DatabaseSync,
  input: RequestInput & Readonly<{ admittedAt: string }>,
): void {
  database.prepare(`INSERT OR IGNORE INTO requests(id, archetype, body, cwd, world, recipe_json, admitted_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted')`).run(
    input.id,
    input.archetype,
    input.body,
    input.cwd ?? null,
    input.world,
    json(input.recipe),
    input.admittedAt,
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

export function updateRequestRefused(database: DatabaseSync, id: string, diagnostic: string): void {
  database.prepare(`UPDATE requests SET state = 'refused', diagnostic = ?
    WHERE id = ? AND state = 'admitted'`).run(diagnostic, id);
}

export function updateRequestVoided(database: DatabaseSync, id: string, evidence: string): void {
  database.prepare(`UPDATE requests SET state = 'voided', child = NULL, evidence = ?
    WHERE id = ? AND state IN ('admitted', 'reserved')`).run(evidence, id);
}

export function insertStopControl(database: DatabaseSync, bodySequence: number, at: string): void {
  database.prepare("INSERT OR IGNORE INTO control(kind, value_json, at) VALUES ('stop', ?, ?)")
    .run(json({ bodySequence }), at);
}

export function insertPauseControl(database: DatabaseSync, at: string): void {
  database.prepare("INSERT OR IGNORE INTO control(kind, value_json, at) VALUES ('pause', '{}', ?)").run(at);
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

export function pauseExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT kind FROM control WHERE kind = 'pause'").get() !== undefined;
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
        sequence, input.outcome.historyId, encodeResumeCoordinate(input.outcome.session), input.outcome.answer,
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
  const row = database.prepare(`SELECT sequence, pid, process_group, spawned_at, leash_taken_at, end, ended_at
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
