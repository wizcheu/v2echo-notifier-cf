CREATE TABLE watch_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  assistant_id TEXT NOT NULL DEFAULT '',
  instance_enc TEXT NOT NULL DEFAULT '',
  published_binding TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '',
  next_sync INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
INSERT INTO watch_control(id) VALUES(1);
CREATE TABLE watch_targets (
  target_key TEXT PRIMARY KEY,
  topic_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  enabled_at INTEGER NOT NULL,
  state_enc TEXT NOT NULL DEFAULT '',
  next_check INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  checking INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX watch_targets_due ON watch_targets(next_check);
CREATE TABLE watch_dedup (
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  content_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY(account_id,kind,topic_id,content_id)
);
ALTER TABLE notification_outbox ADD COLUMN watch_meta TEXT NOT NULL DEFAULT '';
CREATE TABLE notifier_source_transfer (
  id INTEGER PRIMARY KEY CHECK(id=1),
  content_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
