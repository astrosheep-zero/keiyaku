import type { DatabaseSync } from "node:sqlite";
import type {
  AkuId,
  AkumaOrigin,
  BodyEnd,
  BodyFact,
  Collar,
  Confinement,
  DeathFact,
  KillEvidence,
  ProviderOptions,
  RequestFact,
  RequestInput,
  ResumeCoordinate,
  SessionFact,
  Soul,
  TellFact,
  TellState,
  TurnFact,
} from "./facts.js";

const HEART_SCHEMA_VERSION = 2;

export const HEART_SCHEMA = `
  CREATE TABLE IF NOT EXISTS akuma_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = ${HEART_SCHEMA_VERSION})
  ) STRICT;
  INSERT OR IGNORE INTO akuma_schema(singleton, version) VALUES (1, ${HEART_SCHEMA_VERSION});
  CREATE TABLE IF NOT EXISTS soul (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE,
    persona TEXT NOT NULL,
    description TEXT,
    provider TEXT NOT NULL,
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    cwd TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    confinement_json TEXT NOT NULL CHECK (json_valid(confinement_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS bodies (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL CHECK (pid > 0),
    process_group INTEGER NOT NULL CHECK (process_group > 0),
    spawned_at TEXT NOT NULL,
    leash_taken_at TEXT NOT NULL,
    end TEXT CHECK (end IN ('exited', 'broke-off', 'put-down')),
    ended_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    coordinate_json TEXT NOT NULL CHECK (json_valid(coordinate_json)),
    cwd TEXT NOT NULL,
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    admitted_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS turns (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
    outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'failed')),
    history_id TEXT UNIQUE,
    session_json TEXT CHECK (session_json IS NULL OR json_valid(session_json)),
    answer TEXT,
    diagnostic TEXT,
    completed_at TEXT NOT NULL,
    CHECK (
      (outcome = 'answered' AND history_id IS NOT NULL AND session_json IS NOT NULL AND answer IS NOT NULL AND diagnostic IS NULL)
      OR (outcome = 'failed' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL AND diagnostic IS NOT NULL)
    )
  ) STRICT;
  CREATE TABLE IF NOT EXISTS activity (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tells (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('recorded', 'delivered', 'seen', 'consumed', 'voided-by-death')),
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS requests (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    persona TEXT NOT NULL,
    body TEXT NOT NULL,
    cwd TEXT,
    world TEXT NOT NULL,
    admitted_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('admitted', 'reserved', 'served', 'refused', 'voided')),
    child TEXT,
    diagnostic TEXT,
    evidence TEXT,
    CHECK (
      (state = 'admitted' AND child IS NULL AND diagnostic IS NULL AND evidence IS NULL)
      OR (state IN ('reserved', 'served') AND child IS NOT NULL AND diagnostic IS NULL AND evidence IS NULL)
      OR (state = 'refused' AND child IS NULL AND diagnostic IS NOT NULL AND evidence IS NULL)
      OR (state = 'voided' AND child IS NULL AND diagnostic IS NULL AND evidence IS NOT NULL)
    )
  ) STRICT;
  CREATE TABLE IF NOT EXISTS control (
    kind TEXT PRIMARY KEY CHECK (kind IN ('stop', 'pause', 'death')),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    at TEXT NOT NULL
  ) STRICT;
`;

export const LEASH_SCHEMA = `
  PRAGMA journal_mode=DELETE;
  CREATE TABLE IF NOT EXISTS leash_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = ${HEART_SCHEMA_VERSION})
  ) STRICT;
  INSERT OR IGNORE INTO leash_schema(singleton, version) VALUES (1, ${HEART_SCHEMA_VERSION});
  CREATE TABLE IF NOT EXISTS seal (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    evidence TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
`;

export type SoulRow = Readonly<{
  id: string;
  persona: string;
  description: string | null;
  provider: string;
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
  outcome: "answered" | "failed";
  history_id: string | null;
  session_json: string | null;
  answer: string | null;
  diagnostic: string | null;
  completed_at: string;
}>;

export type TellRow = Readonly<{
  id: string;
  body: string;
  state: TellState;
  recorded_at: string;
}>;

export type RequestRow = Readonly<{
  sequence: number;
  id: string;
  persona: string;
  body: string;
  cwd: string | null;
  world: string;
  admitted_at: string;
  state: RequestFact["state"];
  child: string | null;
  diagnostic: string | null;
  evidence: string | null;
}>;

export type ActivityRow = Readonly<{ sequence: number; event_json: string; at: string }>;
export type DeathRow = Readonly<{ value_json: string; at: string }>;

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
    soul.persona,
    soul.description ?? null,
    soul.provider,
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
    persona: row.persona,
    ...(row.description === null ? {} : { description: row.description }),
    provider: row.provider,
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
  return {
    sequence: row.sequence,
    bodySequence: row.body_sequence,
    outcome: row.outcome === "answered"
      ? {
          kind: "answered",
          historyId: row.history_id!,
          session: parsed<ResumeCoordinate>(row.session_json),
          answer: row.answer!,
        }
      : { kind: "failed", diagnostic: row.diagnostic! },
    completedAt: row.completed_at,
  };
}

export function decodeTellRow(row: TellRow): TellFact {
  return { id: row.id, body: row.body, state: row.state, recordedAt: row.recorded_at };
}

export function decodeRequestRow(row: RequestRow): RequestFact {
  const input = {
    id: row.id,
    persona: row.persona,
    body: row.body,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    world: row.world,
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

export function decodeActivityRow(row: ActivityRow): Readonly<{ sequence: number; event: unknown; at: string }> {
  return { sequence: row.sequence, event: parsed(row.event_json), at: row.at };
}

export function encodeDeathRow(death: DeathFact): string {
  return json({ evidence: death.evidence });
}

export function decodeDeathRow(row: DeathRow): DeathFact {
  return { evidence: parsed<{ evidence: KillEvidence }>(row.value_json).evidence, at: row.at };
}

export function soulFact(database: DatabaseSync): Soul | null {
  const row = database.prepare(`SELECT id, persona, description, provider, options_json, cwd,
    origin_json, confinement_json, created_at FROM soul WHERE singleton = 1`).get() as SoulRow | undefined;
  return row === undefined ? null : decodeSoulRow(row);
}

export function sealExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT singleton FROM seal WHERE singleton = 1").get() !== undefined;
}

export function insertSoulFact(database: DatabaseSync, soul: Soul): void {
  database.prepare(`INSERT INTO soul(singleton, id, persona, description, provider, options_json, cwd, origin_json, confinement_json, created_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...encodeSoulRow(soul));
}

export function insertSealFact(database: DatabaseSync, input: Readonly<{ evidence: string; at: string }>): void {
  database.prepare("INSERT OR IGNORE INTO seal(singleton, evidence, at) VALUES (1, ?, ?)")
    .run(input.evidence, input.at);
}

export function deletePauseControl(database: DatabaseSync): void {
  database.prepare("DELETE FROM control WHERE kind = 'pause'").run();
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

export function insertActivityFact(database: DatabaseSync, input: Readonly<{ event: unknown; at: string }>): number {
  const result = database.prepare("INSERT INTO activity(event_json, at) VALUES (?, ?)")
    .run(encodeActivityEvent(input.event), input.at);
  return Number(result.lastInsertRowid);
}

export function pruneActivityFacts(database: DatabaseSync, limit: number): void {
  database.prepare("DELETE FROM activity WHERE sequence <= (SELECT COALESCE(MAX(sequence), 0) - ? FROM activity)")
    .run(limit);
}

export function activityFactsAfter(
  database: DatabaseSync,
  sequence: number,
): readonly Readonly<{ sequence: number; event: unknown; at: string }>[] {
  const rows = database.prepare("SELECT sequence, event_json, at FROM activity WHERE sequence > ? ORDER BY sequence")
    .all(sequence) as unknown as readonly ActivityRow[];
  return rows.map(decodeActivityRow);
}

export function deathExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT kind FROM control WHERE kind = 'death'").get() !== undefined;
}

export function insertTellFact(database: DatabaseSync, tell: Omit<TellFact, "state">): void {
  database.prepare(`INSERT INTO tells(id, body, state, recorded_at)
    VALUES (?, ?, 'recorded', ?)`).run(tell.id, tell.body, tell.recordedAt);
}

export function tellState(database: DatabaseSync, id: string): TellState | null {
  const row = database.prepare("SELECT state FROM tells WHERE id = ?").get(id) as { state: TellState } | undefined;
  return row?.state ?? null;
}

export function updateTellState(database: DatabaseSync, id: string, state: TellState): void {
  database.prepare("UPDATE tells SET state = ? WHERE id = ?").run(state, id);
}

const REQUEST_COLUMNS = `sequence, id, persona, body, cwd, world, admitted_at,
  state, child, diagnostic, evidence`;

export function insertRequestFact(
  database: DatabaseSync,
  input: RequestInput & Readonly<{ admittedAt: string }>,
): void {
  database.prepare(`INSERT OR IGNORE INTO requests(id, persona, body, cwd, world, admitted_at, state)
    VALUES (?, ?, ?, ?, ?, ?, 'admitted')`).run(
    input.id,
    input.persona,
    input.body,
    input.cwd ?? null,
    input.world,
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

export function insertStopControl(database: DatabaseSync, at: string): void {
  database.prepare("INSERT OR IGNORE INTO control(kind, value_json, at) VALUES ('stop', '{}', ?)").run(at);
}

export function insertPauseControl(database: DatabaseSync, at: string): void {
  database.prepare("INSERT OR IGNORE INTO control(kind, value_json, at) VALUES ('pause', '{}', ?)").run(at);
}

export function stopExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT kind FROM control WHERE kind = 'stop'").get() !== undefined;
}

export function pauseExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT kind FROM control WHERE kind = 'pause'").get() !== undefined;
}

export function deleteAbandonedControls(database: DatabaseSync): void {
  database.prepare("DELETE FROM control WHERE kind IN ('stop', 'pause')").run();
}

export function insertDeathFact(database: DatabaseSync, death: DeathFact): void {
  database.prepare("INSERT INTO control(kind, value_json, at) VALUES ('death', ?, ?)")
    .run(encodeDeathRow(death), death.at);
}

export function voidTellsByDeath(database: DatabaseSync): void {
  database.prepare("UPDATE tells SET state = 'voided-by-death' WHERE state NOT IN ('consumed', 'voided-by-death')").run();
}

export function voidRequestsByDeath(database: DatabaseSync, evidence: string): void {
  database.prepare(`UPDATE requests SET state = 'voided',
    evidence = CASE WHEN child IS NULL THEN ? ELSE ? || '; child=' || child END,
    child = NULL
    WHERE state IN ('admitted', 'reserved')`).run(evidence, evidence);
}

export function endBodyFact(
  database: DatabaseSync,
  input: Readonly<{ sequence: number; end: BodyEnd; at: string }>,
): void {
  database.prepare("UPDATE bodies SET end = ?, ended_at = ? WHERE sequence = ? AND end IS NULL")
    .run(input.end, input.at, input.sequence);
}

type AnsweredTurn = Omit<TurnFact, "sequence" | "outcome"> & Readonly<{
  outcome: Extract<TurnFact["outcome"], { kind: "answered" }>;
}>;

export function insertAnsweredTurnFact(database: DatabaseSync, input: AnsweredTurn): number {
  const result = database.prepare(`INSERT INTO turns(body_sequence, outcome, history_id, session_json, answer, completed_at)
    VALUES (?, 'answered', ?, ?, ?, ?)`).run(
    input.bodySequence,
    input.outcome.historyId,
    encodeResumeCoordinate(input.outcome.session),
    input.outcome.answer,
    input.completedAt,
  );
  return Number(result.lastInsertRowid);
}

type FailedTurn = Omit<TurnFact, "sequence" | "outcome"> & Readonly<{
  outcome: Extract<TurnFact["outcome"], { kind: "failed" }>;
}>;

export function insertFailedTurnFact(database: DatabaseSync, input: FailedTurn): number {
  const result = database.prepare(`INSERT INTO turns(body_sequence, outcome, diagnostic, completed_at)
    VALUES (?, 'failed', ?, ?)`).run(input.bodySequence, input.outcome.diagnostic, input.completedAt);
  return Number(result.lastInsertRowid);
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

export function pendingTellFacts(database: DatabaseSync): readonly TellFact[] {
  const rows = database.prepare(`SELECT id, body, state, recorded_at FROM tells
    WHERE state NOT IN ('consumed', 'voided-by-death') ORDER BY recorded_at, id`)
    .all() as unknown as readonly TellRow[];
  return rows.map(decodeTellRow);
}

export function deathFact(database: DatabaseSync): DeathFact | null {
  const row = database.prepare("SELECT value_json, at FROM control WHERE kind = 'death'").get() as DeathRow | undefined;
  return row === undefined ? null : decodeDeathRow(row);
}

export function historyFacts(database: DatabaseSync): readonly TurnFact[] {
  const rows = database.prepare(`SELECT sequence, body_sequence, outcome, history_id, session_json,
    answer, diagnostic, completed_at FROM turns ORDER BY sequence`).all() as unknown as readonly TurnRow[];
  return rows.map(decodeTurnRow);
}

export function answeredTurnFact(database: DatabaseSync, historyId: string): TurnFact | null {
  const row = database.prepare(`SELECT sequence, body_sequence, outcome, history_id, session_json,
    answer, diagnostic, completed_at FROM turns WHERE outcome = 'answered' AND history_id = ?`).get(historyId) as TurnRow | undefined;
  return row === undefined ? null : decodeTurnRow(row);
}
