-- Member feed defaults to 10 minutes, watched-topic replies to 5 minutes.
-- SQLite cannot alter DEFAULT or CHECK in place, so rebuild the table.
-- Existing rows still on the old defaults (5 / 10) move to the new ones;
-- any other explicitly chosen value is preserved.

CREATE TABLE notifier_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  cleanup_at INTEGER NOT NULL DEFAULT 0,
  history_until INTEGER NOT NULL DEFAULT 0,
  history_at INTEGER NOT NULL DEFAULT 0,
  history_error TEXT NOT NULL DEFAULT '',
  check_start_hour INTEGER NOT NULL DEFAULT 8 CHECK(check_start_hour BETWEEN 0 AND 23),
  check_end_hour INTEGER NOT NULL DEFAULT 24 CHECK(check_end_hour BETWEEN 1 AND 24 AND check_end_hour != check_start_hour),
  scan_interval_minutes INTEGER NOT NULL DEFAULT 3 CHECK(scan_interval_minutes IN (3,5,10,15)),
  following_interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(following_interval_minutes IN (5,10,15,30)),
  topic_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(topic_interval_minutes IN (5,10,15,30,60)),
  history_next_page INTEGER DEFAULT 1,
  next_dispatch INTEGER NOT NULL DEFAULT 0,
  api_until INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT NOT NULL DEFAULT ''
);

INSERT INTO notifier_defaults (
  id, enabled, account_id, username, credential_scope, verified_at, verify_until, binding_id,
  sender_enc, paired_at, blocked, pair_enc, pair_expires, pair_until, scan_stage, scan_id,
  scan_page, scan_collected, scan_min, scan_head, unread, observed_at, next_scan, scan_until,
  scan_failures, scan_error, last_scan, relay_until, relay_failures, relay_error, last_sync,
  cleanup_at, history_until, history_at, history_error, check_start_hour, check_end_hour,
  scan_interval_minutes, following_interval_minutes, topic_interval_minutes, history_next_page,
  next_dispatch, api_until, avatar_url
)
SELECT
  id, enabled, account_id, username, credential_scope, verified_at, verify_until, binding_id,
  sender_enc, paired_at, blocked, pair_enc, pair_expires, pair_until, scan_stage, scan_id,
  scan_page, scan_collected, scan_min, scan_head, unread, observed_at, next_scan, scan_until,
  scan_failures, scan_error, last_scan, relay_until, relay_failures, relay_error, last_sync,
  cleanup_at, history_until, history_at, history_error, check_start_hour, check_end_hour,
  scan_interval_minutes, following_interval_minutes, topic_interval_minutes, history_next_page,
  next_dispatch, api_until, avatar_url
FROM notifier;

DROP TABLE notifier;

ALTER TABLE notifier_defaults RENAME TO notifier;

CREATE UNIQUE INDEX notifier_member_identity ON notifier(account_id) WHERE account_id>0;

UPDATE notifier SET following_interval_minutes=10 WHERE following_interval_minutes=5;
UPDATE notifier SET topic_interval_minutes=5 WHERE topic_interval_minutes=10;
