CREATE TABLE unread_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  account_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  credential_scope TEXT NOT NULL DEFAULT '',
  snapshot_id TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL DEFAULT 0,
  refresh_id TEXT NOT NULL DEFAULT '',
  refresh_total INTEGER NOT NULL DEFAULT 0,
  collected INTEGER NOT NULL DEFAULT 0,
  page INTEGER NOT NULL DEFAULT 1,
  min_id INTEGER NOT NULL DEFAULT 0,
  head TEXT NOT NULL DEFAULT '[]',
  stage TEXT NOT NULL DEFAULT 'idle' CHECK(stage IN ('idle','page','verify')),
  started_at INTEGER NOT NULL DEFAULT 0,
  next_refresh INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
INSERT INTO unread_control(id) VALUES(1);

CREATE TABLE unread_items (
  snapshot_id TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER,
  content_enc TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, notification_id)
);
