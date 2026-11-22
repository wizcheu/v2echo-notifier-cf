CREATE TABLE control (
  id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, lease TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
  next_dispatch INTEGER NOT NULL DEFAULT 0, api_until INTEGER NOT NULL DEFAULT 0, web_until INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 7, cleanup_at INTEGER NOT NULL DEFAULT 0,
  credential_scope TEXT NOT NULL DEFAULT ''
);
INSERT INTO control(id) VALUES(1);
CREATE TABLE probes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, topic_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
  interval_sec INTEGER NOT NULL DEFAULT 300, next_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  baseline TEXT, last_outcome TEXT
);
INSERT INTO probes(id, kind) VALUES ('home','home'), ('notifications','notifications'), ('following','following');
CREATE INDEX probes_due ON probes(enabled, next_at);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, probe_id TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL,
  finished_at INTEGER, outcome TEXT NOT NULL DEFAULT 'running', status INTEGER,
  duration_ms INTEGER, bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', colo TEXT,
  remaining INTEGER, retry_at INTEGER NOT NULL DEFAULT 0, access_mode TEXT NOT NULL DEFAULT 'public'
);
CREATE INDEX runs_started ON runs(started_at);
CREATE INDEX runs_probe ON runs(probe_id, started_at);
CREATE INDEX runs_outcome ON runs(outcome, started_at);
CREATE TABLE daily (
  day TEXT PRIMARY KEY, invocations INTEGER NOT NULL DEFAULT 0, http INTEGER NOT NULL DEFAULT 0,
  cron INTEGER NOT NULL DEFAULT 0, outbound INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
  queries INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, database_bytes INTEGER NOT NULL DEFAULT 0
);
