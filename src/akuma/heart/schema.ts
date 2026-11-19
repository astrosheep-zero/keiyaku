import type { DatabaseSync } from "node:sqlite";
import { HeartAuthorityCorruptionError } from "./facts.js";

const HEART_SCHEMA_VERSION = 32n;
const LEASH_SCHEMA_VERSION = 4;

export class UnsupportedHeartSchemaError extends Error {}
export class UnsupportedHistoricalHeartError extends UnsupportedHeartSchemaError {}
export class HeartNeedsUpgradeError extends UnsupportedHistoricalHeartError {}

function heartSchemaVersion(database: DatabaseSync): bigint | undefined {
  const query = database.prepare("SELECT version FROM akuma_schema WHERE singleton = 1");
  query.setReadBigInts(true);
  const version = query.get()?.version;
  return typeof version === "bigint" ? version : undefined;
}

export function checkHeartSchema(database: DatabaseSync, path: string, allowUpgrade = false): boolean {
  const version = heartSchemaVersion(database);
  if (version === HEART_SCHEMA_VERSION) return false;
  if (allowUpgrade && version === 31n) return true;
  if (version === undefined || version < 1n)
    throw new HeartAuthorityCorruptionError(`Akuma heart schema version is corrupt: ${path}`);
  const diagnostic = `Akuma heart schema version must be ${HEART_SCHEMA_VERSION}; found ${version}: ${path}`;
  if (version === 31n) throw new HeartNeedsUpgradeError(`${diagnostic}. Upgrade requires a Heart write.`);
  if (version !== 29n && version !== 30n) throw new UnsupportedHeartSchemaError(diagnostic);
  throw new UnsupportedHistoricalHeartError(
    `${diagnostic}. No converter in this build. Stop all writers via their owning build before copying the entire ` +
      `custody directory (heart.db, any heart.db-wal/heart.db-shm, leash.db, stdio.log). Leave the original untouched. ` +
      `Read history only on the copy, in a separate World with a previously installed compatible build and the same ` +
      `Akuma identity/layout. It may upgrade the copy. No quiescence or compatible build: leave custody alone.`,
  );
}

export function assertLeashSchemaVersion(database: DatabaseSync): void {
  if (database.prepare("SELECT version FROM leash_schema WHERE singleton = 1").get()?.version !== LEASH_SCHEMA_VERSION)
    throw new Error(`Akuma leash schema version must be ${LEASH_SCHEMA_VERSION}`);
}

const VERSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS akuma_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = ${HEART_SCHEMA_VERSION})
  ) STRICT;
  INSERT OR IGNORE INTO akuma_schema(singleton, version) VALUES (1, ${HEART_SCHEMA_VERSION});
`;

const TERMINAL_TELL_TABLE = `tell_terminal_receipts (
  tell_id TEXT NOT NULL REFERENCES tells(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  received_at TEXT NOT NULL,
  undelivered INTEGER NOT NULL CHECK (undelivered = 0 OR (undelivered = 1 AND kind = 'undelivered')),
  PRIMARY KEY (tell_id, kind)
) STRICT;`;

/** A writer has rechecked the exact predecessor in its transaction. */
export function upgradeHeartSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE ${TERMINAL_TELL_TABLE}
    INSERT INTO tell_terminal_receipts (tell_id, kind, received_at, undelivered)
    SELECT tell_id, kind, MIN(received_at), MAX(undelivered) FROM (
      SELECT tell_id, kind, received_at, kind = 'undelivered' AS undelivered FROM tell_receipts WHERE evidence = 'exact'
      UNION ALL
      SELECT d.tell_id, r.kind, r.received_at, 0 FROM tell_receipts r
        JOIN tell_deliveries d USING (turn_sequence, fence) WHERE r.evidence = 'fence'
      UNION ALL
      SELECT tell_id, COALESCE(receipt, route), delivered_at, 0 FROM tell_deliveries
        WHERE route = 'launch' OR receipt = 'unavailable'
    ) GROUP BY tell_id, kind;
  `);
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined)
    throw new Error("Akuma Heart upgrade found broken foreign key relationships");
  database.exec(`DROP TABLE akuma_schema; ${VERSION_SCHEMA}`);
}

const TURN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS turns (
    sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
    body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
    started_at TEXT NOT NULL,
    initiator TEXT,
    end_sequence INTEGER UNIQUE REFERENCES timeline(sequence) ON DELETE SET NULL,
    outcome TEXT CHECK (outcome IN ('answered', 'failed', 'invalid-output', 'canceled')),
    history_id TEXT UNIQUE,
    session_json TEXT CHECK (session_json IS NULL OR json_valid(session_json)),
    answer TEXT,
    answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    schema_json TEXT CHECK (schema_json IS NULL OR json_valid(schema_json)),
    diagnostic TEXT,
    completed_at TEXT,
    CHECK (
      (outcome = 'answered' AND session_json IS NOT NULL AND answer IS NOT NULL AND diagnostic IS NULL
        AND ((schema_json IS NULL AND answer_json IS NULL) OR (schema_json IS NOT NULL AND answer_json IS NOT NULL)))
      OR (outcome = 'failed' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL
        AND answer_json IS NULL AND diagnostic IS NOT NULL)
      OR (outcome = 'invalid-output' AND answer IS NOT NULL AND answer_json IS NULL
        AND diagnostic IS NOT NULL AND schema_json IS NOT NULL)
      OR (outcome = 'canceled' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL
        AND answer_json IS NULL AND diagnostic IS NULL)
      OR (outcome IS NULL AND end_sequence IS NULL AND history_id IS NULL AND session_json IS NULL
        AND answer IS NULL AND answer_json IS NULL AND diagnostic IS NULL AND completed_at IS NULL)
    )
  ) STRICT;`;

const REPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS reports (
  sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
  body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
  turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
  text TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS reports_by_turn ON reports(turn_sequence);`;

export const HEART_SCHEMA = `
  ${VERSION_SCHEMA}
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
  ${TURN_SCHEMA}
  CREATE TABLE IF NOT EXISTS timeline (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('turn-start', 'call', 'activity', 'tell', 'turn-end', 'report'))
  ) STRICT;
  ${REPORT_SCHEMA}
  CREATE TABLE IF NOT EXISTS activity_retention (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    checked_sequence INTEGER NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO activity_retention(singleton, checked_sequence) VALUES (1, 0);
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
    initiator TEXT,
    schema_json TEXT CHECK (schema_json IS NULL OR json_valid(schema_json)),
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tell_bindings (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tell_id TEXT NOT NULL REFERENCES tells(id) ON DELETE CASCADE,
    turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
    bound_at TEXT NOT NULL,
    UNIQUE (tell_id, turn_sequence)
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
  CREATE TABLE IF NOT EXISTS ${TERMINAL_TELL_TABLE}
  CREATE TABLE IF NOT EXISTS tell_dispositions (
    body_sequence INTEGER PRIMARY KEY REFERENCES bodies(sequence),
    decided_at TEXT NOT NULL,
    resolved_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tell_disposition_members (
    body_sequence INTEGER NOT NULL REFERENCES tell_dispositions(body_sequence) ON DELETE CASCADE,
    tell_id TEXT NOT NULL REFERENCES tells(id),
    PRIMARY KEY (body_sequence, tell_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS calls_by_turn ON calls(turn_sequence);
  CREATE INDEX IF NOT EXISTS activity_by_turn ON activity(turn_sequence);
  CREATE INDEX IF NOT EXISTS tell_bindings_by_turn ON tell_bindings(turn_sequence);
  CREATE INDEX IF NOT EXISTS tell_deliveries_by_turn ON tell_deliveries(turn_sequence);
  CREATE INDEX IF NOT EXISTS tell_disposition_members_by_tell ON tell_disposition_members(tell_id);
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
