import type { DatabaseSync } from "node:sqlite";
import {
  HeartAuthorityCorruptionError,
  surveillanceFactSchema,
  type SurveillanceAudience,
  type SurveillanceFact,
} from "./facts.js";

export function observeSurveillance(read: () => readonly string[]): SurveillanceAudience {
  try {
    return { kind: "known", owners: read() };
  } catch (error) {
    return { kind: "unavailable", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

export function insertSurveillanceFact(heart: DatabaseSync, owner: string, off: boolean, at: string): void {
  const sequence = Number(heart.prepare("INSERT INTO timeline(kind) VALUES ('surveillance')").run().lastInsertRowid);
  heart
    .prepare(
      `INSERT INTO surveillance (sequence, owner, binding_frontier, at)
      VALUES (?, ?, CASE WHEN ? THEN COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'tell_bindings'), 0) END, ?)`,
    )
    .run(sequence, owner, Number(off), at);
}

export function surveillanceAudience(
  heart: DatabaseSync,
  turn: number | Readonly<{ bodySequence: number }> | "all-open" | null,
  self: string | null = null,
): readonly string[] {
  return heart
    .prepare(
      `WITH selected_turns AS (
      SELECT sequence, initiator FROM turns
      WHERE end_sequence IS NULL AND (sequence = COALESCE(?, (
        SELECT sequence FROM turns WHERE body_sequence = ? ORDER BY sequence DESC LIMIT 1
      )) OR ?)
    ), members(owner) AS (
      SELECT s.owner FROM surveillance s
      WHERE s.binding_frontier IS NULL AND s.sequence = (
        SELECT MAX(sequence) FROM surveillance WHERE owner = s.owner
      )
      UNION
      SELECT t.initiator FROM selected_turns t
      WHERE NOT EXISTS (
        SELECT 1 FROM surveillance s
        WHERE s.owner = t.initiator AND s.binding_frontier IS NOT NULL AND s.sequence > t.sequence
      )
      UNION
      SELECT i.initiator FROM selected_turns t
      JOIN tell_bindings b ON b.turn_sequence = t.sequence JOIN tells i ON i.id = b.tell_id
      WHERE NOT EXISTS (
        SELECT 1 FROM surveillance s WHERE s.owner = i.initiator AND s.binding_frontier >= b.sequence
      )
    ) SELECT owner FROM members WHERE owner <> '' AND (? IS NULL OR owner = ?) ORDER BY owner`,
    )
    .all(
      typeof turn === "number" ? turn : null,
      typeof turn === "object" ? (turn?.bodySequence ?? null) : null,
      Number(turn === "all-open"),
      self,
      self,
    )
    .map(({ owner }) => owner as string);
}

export function changeSurveillanceFact(heart: DatabaseSync, owner: string, off: boolean): boolean {
  const changed = off
    ? surveillanceAudience(heart, "all-open", owner).length !== 0
    : heart
        .prepare(`SELECT binding_frontier FROM surveillance WHERE owner = ? ORDER BY sequence DESC LIMIT 1`)
        .get(owner)?.binding_frontier !== null;
  if (changed) insertSurveillanceFact(heart, owner, off, new Date().toISOString());
  return changed;
}

export function surveillanceFactsAt(heart: DatabaseSync, sequences: string): readonly SurveillanceFact[] {
  return heart
    .prepare(
      `SELECT sequence, owner, binding_frontier IS NOT NULL AS off, at
      FROM surveillance WHERE sequence IN (SELECT value FROM json_each(?))`,
    )
    .all(sequences)
    .map(({ sequence, owner, off, at }) => {
      const fact = surveillanceFactSchema.safeParse({ kind: "surveillance", sequence, owner, off: off === 1, at });
      if (!fact.success)
        throw new HeartAuthorityCorruptionError(`Invalid surveillance fact ${String(sequence)}`, { cause: fact.error });
      return fact.data;
    });
}
