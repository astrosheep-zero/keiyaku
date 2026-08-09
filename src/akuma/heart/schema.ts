import type { DatabaseSync } from "node:sqlite";

const HEART_SCHEMA_VERSION = 4;

function assertSchemaVersion(database: DatabaseSync, table: "akuma_schema" | "leash_schema"): void {
  const row = database.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as { version: number } | undefined;
  if (row?.version !== HEART_SCHEMA_VERSION) throw new Error(
    `Akuma ${table === "akuma_schema" ? "heart" : "leash"} schema version must be ${HEART_SCHEMA_VERSION}`,
  );
}

export function assertHeartSchemaVersion(database: DatabaseSync): void {
  assertSchemaVersion(database, "akuma_schema");
}

export function assertLeashSchemaVersion(database: DatabaseSync): void {
  assertSchemaVersion(database, "leash_schema");
}

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
    provider_json TEXT NOT NULL CHECK (json_valid(provider_json)),
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    cwd TEXT NOT NULL,
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    confinement_json TEXT NOT NULL CHECK (json_valid(confinement_json)),
    contract TEXT,
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
    contract TEXT,
    world TEXT NOT NULL,
    recipe_json TEXT NOT NULL CHECK (json_valid(recipe_json)),
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
