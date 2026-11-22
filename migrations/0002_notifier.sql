CREATE TABLE notifier (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  credential_scope TEXT NOT NULL DEFAULT '',
  verified_at INTEGER NOT NULL DEFAULT 0,
  verify_until INTEGER NOT NULL DEFAULT 0,
  binding_id TEXT NOT NULL DEFAULT '',
  sender_enc TEXT NOT NULL DEFAULT '',
  paired_at INTEGER NOT NULL DEFAULT 0,
  blocked TEXT NOT NULL DEFAULT '',
  pair_enc TEXT NOT NULL DEFAULT '',
  pair_expires INTEGER NOT NULL DEFAULT 0,
  pair_until INTEGER NOT NULL DEFAULT 0,
  scan_stage TEXT NOT NULL DEFAULT 'idle',
  scan_id TEXT NOT NULL DEFAULT '',
  scan_page INTEGER NOT NULL DEFAULT 1,
  scan_collected INTEGER NOT NULL DEFAULT 0,
  scan_min INTEGER NOT NULL DEFAULT 0,
  scan_head TEXT NOT NULL DEFAULT '[]',
  unread INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL DEFAULT 0,
  next_scan INTEGER NOT NULL DEFAULT 0,
  scan_until INTEGER NOT NULL DEFAULT 0,
  scan_failures INTEGER NOT NULL DEFAULT 0,
  scan_error TEXT NOT NULL DEFAULT '',
  last_scan INTEGER NOT NULL DEFAULT 0,
  relay_until INTEGER NOT NULL DEFAULT 0,
  relay_failures INTEGER NOT NULL DEFAULT 0,
  relay_error TEXT NOT NULL DEFAULT '',
  last_sync INTEGER NOT NULL DEFAULT 0,
  cleanup_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO notifier(id) VALUES(1);
-- A failing CHECK makes a whole D1 batch roll back if its lease expired.
CREATE TABLE notifier_fence(id INTEGER PRIMARY KEY CHECK(id=1));
CREATE TABLE notification_candidates (
  scan_id TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  content_enc TEXT NOT NULL,
  kind TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  queued INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scan_id, notification_id)
);
CREATE TABLE notification_dedup (
  account_id INTEGER NOT NULL,
  notification_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY(account_id,notification_id)
);
CREATE TABLE notification_outbox (
  event_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  notification_id INTEGER,
  binding_id TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  unread INTEGER NOT NULL,
  avatar_url TEXT NOT NULL,
  content_enc TEXT NOT NULL,
  wire TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt_attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  deliveries TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX notification_outbox_due ON notification_outbox(status,next_at);
CREATE INDEX notification_outbox_created ON notification_outbox(created_at DESC);
CREATE INDEX notification_outbox_expiry ON notification_outbox(expires_at);
CREATE TABLE notification_key_pins (
  device_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL
);
