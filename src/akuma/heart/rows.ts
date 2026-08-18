import type { DatabaseSync } from "node:sqlite";
import type {
  BodyEnd,
  BodyFact,
  CallFact,
  KillFact,
  PauseFact,
  ResumeCoordinate,
  SessionFact,
  StopFact,
  TurnFact,
  TurnStartFact,
  TurnEndFact,
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
