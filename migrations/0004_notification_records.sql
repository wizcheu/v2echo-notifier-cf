ALTER TABLE notifier ADD COLUMN history_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifier ADD COLUMN history_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifier ADD COLUMN history_error TEXT NOT NULL DEFAULT '';
CREATE TABLE notification_history (
  account_id INTEGER NOT NULL, notification_id INTEGER NOT NULL,
  kind TEXT NOT NULL, created_at INTEGER, fetched_at INTEGER NOT NULL,
  content_enc TEXT NOT NULL,
  PRIMARY KEY(account_id,notification_id)
);
CREATE INDEX notification_history_fetched ON notification_history(fetched_at);
CREATE INDEX notification_history_kind ON notification_history(account_id,kind,notification_id DESC);
CREATE TABLE notification_checks (
  id TEXT PRIMARY KEY, source TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'running',
  unread INTEGER NOT NULL DEFAULT 0,
  stage_before TEXT NOT NULL, stage_after TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0, api_requests INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX notification_checks_time ON notification_checks(started_at DESC,id DESC);
CREATE INDEX notification_checks_outcome ON notification_checks(outcome,started_at DESC,id DESC);
CREATE INDEX notification_outbox_notification ON notification_outbox(account_id,notification_id) WHERE type='notification';
CREATE INDEX notification_outbox_type_time ON notification_outbox(type,created_at DESC,event_id DESC);
CREATE INDEX notification_outbox_status_time ON notification_outbox(status,created_at DESC,event_id DESC);
