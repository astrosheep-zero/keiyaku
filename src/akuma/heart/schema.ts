import type { DatabaseSync } from "node:sqlite";

const HEART_SCHEMA_VERSION = 23;
const LEASH_SCHEMA_VERSION = 4;

function assertSchemaVersion(database: DatabaseSync, table: "akuma_schema" | "leash_schema", expected: number): void {
  const row = database.prepare(`SELECT version FROM ${table} WHERE singleton = 1`).get() as
    | { version: number }
    | undefined;
  if (row?.version !== expected)
    throw new Error(`Akuma ${table === "akuma_schema" ? "heart" : "leash"} schema version must be ${expected}`);
}

export function assertHeartSchemaVersion(database: DatabaseSync): void {
  assertSchemaVersion(database, "akuma_schema", HEART_SCHEMA_VERSION);
}

export function assertLeashSchemaVersion(database: DatabaseSync): void {
  assertSchemaVersion(database, "leash_schema", LEASH_SCHEMA_VERSION);
}

export function heartSchemaIsCurrent(database: DatabaseSync): boolean {
  try {
    const row = database.prepare(`SELECT version FROM akuma_schema WHERE singleton = 1`).get() as
      | { version: number }
      | undefined;
    return row?.version === HEART_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

export const HEART_SCHEMA = `
  CREATE TABLE IF NOT EXISTS akuma_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = ${HEART_SCHEMA_VERSION})
  ) STRICT;
  INSERT OR IGNORE INTO akuma_schema(singleton, version) VALUES (1, ${HEART_SCHEMA_VERSION});
  CREATE TABLE IF NOT EXISTS soul (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    soul_json TEXT NOT NULL CHECK (json_valid(soul_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS bodies (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    leash_taken_at TEXT NOT NULL,
    hung_diagnostic TEXT,
    hung_at TEXT,
    end TEXT CHECK (end IN ('exited', 'broke-off', 'put-down')),
    ended_at TEXT,
    CHECK ((hung_diagnostic IS NULL AND hung_at IS NULL)
      OR (hung_diagnostic IS NOT NULL AND hung_at IS NOT NULL))
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
    sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
    body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
    started_at TEXT NOT NULL,
    end_sequence INTEGER UNIQUE REFERENCES timeline(sequence) ON DELETE SET NULL,
    outcome TEXT CHECK (outcome IN ('answered', 'failed')),
    history_id TEXT UNIQUE,
    session_json TEXT CHECK (session_json IS NULL OR json_valid(session_json)),
    answer TEXT,
    diagnostic TEXT,
    completed_at TEXT,
    CHECK (
      (outcome = 'answered' AND session_json IS NOT NULL AND answer IS NOT NULL AND diagnostic IS NULL)
      OR (outcome = 'failed' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL AND diagnostic IS NOT NULL)
      OR (outcome IS NULL AND end_sequence IS NULL AND history_id IS NULL AND session_json IS NULL AND answer IS NULL AND diagnostic IS NULL AND completed_at IS NULL)
    )
  ) STRICT;
  CREATE TABLE IF NOT EXISTS timeline (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('turn-start', 'call', 'activity', 'tell', 'turn-end'))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS calls (
    sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
    turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
    body TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS activity (
    sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
    turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tells (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL UNIQUE REFERENCES timeline(sequence) ON DELETE CASCADE,
    body TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tell_deliveries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tell_id TEXT NOT NULL REFERENCES tells(id) ON DELETE CASCADE,
    route TEXT NOT NULL CHECK (route IN ('launch', 'live')),
    turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
    fence TEXT NOT NULL,
    receipt TEXT CHECK (receipt IN ('unavailable', 'required')),
    delivered_at TEXT NOT NULL,
    CHECK ((route = 'launch' AND receipt IS NULL) OR (route = 'live' AND receipt IS NOT NULL)),
    UNIQUE (tell_id, turn_sequence, fence)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tell_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence TEXT NOT NULL CHECK (evidence IN ('exact', 'fence')),
    tell_id TEXT REFERENCES tells(id) ON DELETE CASCADE,
    turn_sequence INTEGER REFERENCES turns(sequence) ON DELETE CASCADE,
    fence TEXT,
    kind TEXT NOT NULL,
    received_at TEXT NOT NULL,
    CHECK (
      (evidence = 'exact' AND tell_id IS NOT NULL AND turn_sequence IS NULL AND fence IS NULL)
      OR (evidence = 'fence' AND tell_id IS NULL AND turn_sequence IS NOT NULL AND fence IS NOT NULL)
    )
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS tell_receipts_exact
    ON tell_receipts(tell_id, kind) WHERE evidence = 'exact';
  CREATE UNIQUE INDEX IF NOT EXISTS tell_receipts_fence
    ON tell_receipts(turn_sequence, fence, kind) WHERE evidence = 'fence';
  CREATE TABLE IF NOT EXISTS tell_dispositions (
    body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
    tell_id TEXT NOT NULL REFERENCES tells(id),
    decided_at TEXT NOT NULL,
    resolved_at TEXT,
    PRIMARY KEY (body_sequence, tell_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS requests (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    requester TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    admitted_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('admitted', 'reserved', 'begun', 'served', 'refused', 'voided', 'unproven')),
    child TEXT,
    service_json TEXT CHECK (service_json IS NULL OR json_valid(service_json)),
    diagnostic TEXT,
    evidence TEXT,
    CHECK (
      (state = 'admitted' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NULL)
      OR (state = 'reserved' AND child IS NOT NULL AND service_json IS NULL
        AND diagnostic IS NULL AND evidence IS NULL)
      OR (state = 'begun' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NULL)
      OR (state = 'served'
        AND ((child IS NOT NULL AND service_json IS NULL)
          OR (child IS NULL AND service_json IS NOT NULL))
        AND diagnostic IS NULL AND evidence IS NULL)
      OR (state = 'refused' AND child IS NULL AND service_json IS NULL AND diagnostic IS NOT NULL AND evidence IS NULL)
      OR (state = 'voided' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NOT NULL)
      OR (state = 'unproven' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NOT NULL)
    )
  ) STRICT;
  CREATE TABLE IF NOT EXISTS control (
    kind TEXT PRIMARY KEY CHECK (kind IN ('stop', 'pause')),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS kills (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    body_sequence INTEGER NOT NULL UNIQUE REFERENCES bodies(sequence),
    evidence TEXT NOT NULL CHECK (evidence = 'killed'),
    at TEXT NOT NULL
  ) STRICT;
`;

export const LEASH_SCHEMA = `
  PRAGMA journal_mode=DELETE;
  CREATE TABLE IF NOT EXISTS leash_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = ${LEASH_SCHEMA_VERSION})
  ) STRICT;
  INSERT OR IGNORE INTO leash_schema(singleton, version) VALUES (1, ${LEASH_SCHEMA_VERSION});
  CREATE TABLE IF NOT EXISTS seal (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    evidence TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
`;
