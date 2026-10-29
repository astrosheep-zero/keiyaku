-- Actual Heart v29 DDL, retained independently of the current schema generator.
CREATE TABLE akuma_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 29)
) STRICT;
INSERT INTO akuma_schema VALUES (1, 29);
CREATE TABLE soul (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  soul_json TEXT NOT NULL CHECK (json_valid(soul_json))
) STRICT;
CREATE TABLE bodies (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  leash_taken_at TEXT NOT NULL,
  hung_diagnostic TEXT,
  hung_at TEXT,
  end TEXT CHECK (end IN ('exited', 'broke-off', 'put-down')),
  ended_at TEXT,
  CHECK ((hung_diagnostic IS NULL AND hung_at IS NULL)
    OR (hung_diagnostic IS NOT NULL AND hung_at IS NOT NULL))
) STRICT;
CREATE TABLE sessions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  coordinate_json TEXT NOT NULL CHECK (json_valid(coordinate_json)),
  cwd TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  admitted_at TEXT NOT NULL
) STRICT;
CREATE TABLE turns (
  sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
  body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
  started_at TEXT NOT NULL,
  initiator TEXT,
  end_sequence INTEGER UNIQUE REFERENCES timeline(sequence) ON DELETE SET NULL,
  outcome TEXT CHECK (outcome IN ('answered', 'failed', 'invalid-output')),
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
    OR (outcome IS NULL AND end_sequence IS NULL AND history_id IS NULL AND session_json IS NULL
      AND answer IS NULL AND answer_json IS NULL AND diagnostic IS NULL AND completed_at IS NULL)
  )
) STRICT;
CREATE TABLE timeline (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('turn-start', 'call', 'activity', 'tell', 'turn-end'))
) STRICT;
CREATE TABLE activity_retention (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  checked_sequence INTEGER NOT NULL
) STRICT;
INSERT INTO activity_retention VALUES (1, 0);
CREATE TABLE calls (
  sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
  turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
  body TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;
CREATE TABLE activity (
  sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
  turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  at TEXT NOT NULL
) STRICT;
CREATE TABLE tells (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE REFERENCES timeline(sequence) ON DELETE CASCADE,
  body TEXT NOT NULL,
  initiator TEXT,
  schema_json TEXT CHECK (schema_json IS NULL OR json_valid(schema_json)),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TABLE tell_bindings (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  tell_id TEXT NOT NULL REFERENCES tells(id) ON DELETE CASCADE,
  turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
  bound_at TEXT NOT NULL,
  UNIQUE (tell_id, turn_sequence)
) STRICT;
CREATE TABLE tell_deliveries (
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
CREATE TABLE tell_receipts (
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
CREATE UNIQUE INDEX tell_receipts_exact ON tell_receipts(tell_id, kind);
CREATE UNIQUE INDEX tell_receipts_fence ON tell_receipts(turn_sequence, fence, kind);
CREATE TABLE tell_dispositions (
  body_sequence INTEGER PRIMARY KEY REFERENCES bodies(sequence),
  decided_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE TABLE tell_disposition_members (
  body_sequence INTEGER NOT NULL REFERENCES tell_dispositions(body_sequence) ON DELETE CASCADE,
  tell_id TEXT NOT NULL REFERENCES tells(id),
  PRIMARY KEY (body_sequence, tell_id)
) STRICT;
CREATE INDEX calls_by_turn ON calls(turn_sequence);
CREATE INDEX activity_by_turn ON activity(turn_sequence);
CREATE INDEX tell_bindings_by_turn ON tell_bindings(turn_sequence);
CREATE INDEX tell_deliveries_by_turn ON tell_deliveries(turn_sequence);
CREATE INDEX tell_disposition_members_by_tell ON tell_disposition_members(tell_id);
CREATE TABLE requests (
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
    OR (state = 'reserved' AND child IS NOT NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NULL)
    OR (state = 'begun' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NULL)
    OR (state = 'served' AND ((child IS NOT NULL AND service_json IS NULL) OR (child IS NULL AND service_json IS NOT NULL))
      AND diagnostic IS NULL AND evidence IS NULL)
    OR (state = 'refused' AND child IS NULL AND service_json IS NULL AND diagnostic IS NOT NULL AND evidence IS NULL)
    OR (state = 'voided' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NOT NULL)
    OR (state = 'unproven' AND child IS NULL AND service_json IS NULL AND diagnostic IS NULL AND evidence IS NOT NULL)
  )
) STRICT;
CREATE TABLE control (
  kind TEXT PRIMARY KEY CHECK (kind IN ('stop', 'pause')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  at TEXT NOT NULL
) STRICT;
CREATE TABLE kills (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  body_sequence INTEGER NOT NULL UNIQUE REFERENCES bodies(sequence),
  evidence TEXT NOT NULL CHECK (evidence = 'killed'),
  at TEXT NOT NULL
) STRICT;
