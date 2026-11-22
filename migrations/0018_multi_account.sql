-- Preserve the existing account as local id 1. Upstream member IDs remain immutable identities.

CREATE TABLE notifier_multi (
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
  following_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(following_interval_minutes IN (5,10,15,30)),
  topic_interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(topic_interval_minutes IN (10,15,30,60)),
  history_next_page INTEGER DEFAULT 1
);

INSERT INTO notifier_multi (
  id, enabled, account_id, username, credential_scope, verified_at, verify_until, binding_id,
  sender_enc, paired_at, blocked, pair_enc, pair_expires, pair_until, scan_stage, scan_id,
  scan_page, scan_collected, scan_min, scan_head, unread, observed_at, next_scan, scan_until,
  scan_failures, scan_error, last_scan, relay_until, relay_failures, relay_error, last_sync,
  cleanup_at, history_until, history_at, history_error, check_start_hour, check_end_hour,
  scan_interval_minutes, following_interval_minutes, topic_interval_minutes, history_next_page
)
SELECT
  id, enabled, account_id, username, credential_scope, verified_at, verify_until, binding_id,
  sender_enc, paired_at, blocked, pair_enc, pair_expires, pair_until, scan_stage, scan_id,
  scan_page, scan_collected, scan_min, scan_head, unread, observed_at, next_scan, scan_until,
  scan_failures, scan_error, last_scan, relay_until, relay_failures, relay_error, last_sync,
  cleanup_at, history_until, history_at, history_error, check_start_hour, check_end_hour,
  scan_interval_minutes, following_interval_minutes, topic_interval_minutes, history_next_page
FROM notifier;

DROP TABLE notifier;

ALTER TABLE notifier_multi RENAME TO notifier;

CREATE TABLE notifier_credentials_multi (
  id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO notifier_credentials_multi (
  id, payload, updated_at
)
SELECT
  id, payload, updated_at
FROM notifier_credentials;

DROP TABLE notifier_credentials;

ALTER TABLE notifier_credentials_multi RENAME TO notifier_credentials;

CREATE TABLE notifier_pairing_invitation_multi (
  id INTEGER PRIMARY KEY,
  content_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT INTO notifier_pairing_invitation_multi (
  id, content_enc, expires_at
)
SELECT
  id, content_enc, expires_at
FROM notifier_pairing_invitation;

DROP TABLE notifier_pairing_invitation;

ALTER TABLE notifier_pairing_invitation_multi RENAME TO notifier_pairing_invitation;

CREATE TABLE watch_control_multi (
  id INTEGER PRIMARY KEY,
  assistant_id TEXT NOT NULL DEFAULT '',
  instance_enc TEXT NOT NULL DEFAULT '',
  published_binding TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '',
  next_sync INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  config_owner TEXT NOT NULL DEFAULT 'central',
  ownership_committed INTEGER NOT NULL DEFAULT 0,
  ownership_revision INTEGER NOT NULL DEFAULT 0
);

INSERT INTO watch_control_multi (
  id, assistant_id, instance_enc, published_binding, config, next_sync, last_sync, error,
  config_owner, ownership_committed, ownership_revision
)
SELECT
  id, assistant_id, instance_enc, published_binding, config, next_sync, last_sync, error,
  config_owner, ownership_committed, ownership_revision
FROM watch_control;

DROP TABLE watch_control;

ALTER TABLE watch_control_multi RENAME TO watch_control;

CREATE TABLE notifier_source_transfer_multi (
  id INTEGER PRIMARY KEY,
  content_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT INTO notifier_source_transfer_multi (
  id, content_enc, expires_at
)
SELECT
  id, content_enc, expires_at
FROM notifier_source_transfer;

DROP TABLE notifier_source_transfer;

ALTER TABLE notifier_source_transfer_multi RENAME TO notifier_source_transfer;

CREATE TABLE watch_app_invitation_multi (
  id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL,
  code_enc TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_client TEXT NOT NULL DEFAULT ''
);

INSERT INTO watch_app_invitation_multi (
  id, code_hash, code_enc, profile_id, source_generation, account_id, expires_at, claimed_client
)
SELECT
  id, code_hash, code_enc, profile_id, source_generation, account_id, expires_at, claimed_client
FROM watch_app_invitation;

DROP TABLE watch_app_invitation;

ALTER TABLE watch_app_invitation_multi RENAME TO watch_app_invitation;

CREATE TABLE unread_control_multi (
  id INTEGER PRIMARY KEY,
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

INSERT INTO unread_control_multi (
  id, account_id, username, credential_scope, snapshot_id, total, fetched_at, refresh_id,
  refresh_total, collected, page, min_id, head, stage, started_at, next_refresh, retry_at, error
)
SELECT
  id, account_id, username, credential_scope, snapshot_id, total, fetched_at, refresh_id,
  refresh_total, collected, page, min_id, head, stage, started_at, next_refresh, retry_at, error
FROM unread_control;

DROP TABLE unread_control;

ALTER TABLE unread_control_multi RENAME TO unread_control;

CREATE UNIQUE INDEX notifier_member_identity ON notifier(account_id) WHERE account_id>0;

ALTER TABLE notifier ADD COLUMN next_dispatch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notifier ADD COLUMN api_until INTEGER NOT NULL DEFAULT 0;

ALTER TABLE control ADD COLUMN last_notifier_id INTEGER NOT NULL DEFAULT 0;

CREATE TABLE assistant_instance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  assistant_id TEXT NOT NULL,
  instance_enc TEXT NOT NULL
);

INSERT INTO assistant_instance (id, assistant_id, instance_enc)
SELECT 1, assistant_id, instance_enc FROM watch_control WHERE id=1;

ALTER TABLE notification_candidates ADD COLUMN notifier_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE unread_items ADD COLUMN notifier_id INTEGER NOT NULL DEFAULT 1;

CREATE TABLE watch_targets_multi (
  notifier_id INTEGER NOT NULL DEFAULT 1,
  target_key TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  enabled_at INTEGER NOT NULL,
  state_enc TEXT NOT NULL DEFAULT '',
  next_check INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  checking INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(notifier_id,target_key)
);

INSERT INTO watch_targets_multi(target_key,topic_id,epoch,enabled_at,state_enc,next_check,last_checked,failures,checking,error) SELECT target_key,topic_id,epoch,enabled_at,state_enc,next_check,last_checked,failures,checking,error FROM watch_targets;

DROP TABLE watch_targets;

ALTER TABLE watch_targets_multi RENAME TO watch_targets;

ALTER TABLE notification_checks ADD COLUMN notifier_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE api_usage ADD COLUMN notifier_id INTEGER NOT NULL DEFAULT 1;

CREATE TABLE api_daily_multi (
  notifier_id INTEGER NOT NULL DEFAULT 1,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  responses INTEGER NOT NULL DEFAULT 0,
  http_errors INTEGER NOT NULL DEFAULT 0,
  network_errors INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(notifier_id,day,source,endpoint)
);

INSERT INTO api_daily_multi(day,source,endpoint,attempts,responses,http_errors,network_errors,rate_limited) SELECT day,source,endpoint,attempts,responses,http_errors,network_errors,rate_limited FROM api_daily;

DROP TABLE api_daily;

ALTER TABLE api_daily_multi RENAME TO api_daily;

ALTER TABLE watch_app_clients ADD COLUMN notifier_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX watch_targets_due ON watch_targets(notifier_id,next_check);

CREATE INDEX notifier_checks_time ON notification_checks(notifier_id,started_at DESC,id DESC);

CREATE INDEX notifier_api_usage_time ON api_usage(notifier_id,attempted_at DESC,id DESC);

CREATE INDEX notifier_clients_account ON watch_app_clients(notifier_id,revoked_at);

CREATE INDEX notifier_candidates_account ON notification_candidates(notifier_id,scan_id);

CREATE INDEX notifier_unread_account ON unread_items(notifier_id,snapshot_id);

ALTER TABLE notifier_credentials ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 1;


ALTER TABLE watch_control ADD COLUMN explicit_pairing INTEGER NOT NULL DEFAULT 0;

-- Failed onboarding has its own cooldown and cannot consume an existing account's identity namespace.
ALTER TABLE control ADD COLUMN account_creation_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE control ADD COLUMN account_validation_sequence INTEGER NOT NULL DEFAULT 0;

CREATE INDEX notification_outbox_account_due ON notification_outbox(account_id,status,next_at);
CREATE INDEX notification_outbox_account_created ON notification_outbox(account_id,created_at DESC,event_id DESC);
CREATE INDEX watch_cancellations_binding ON watch_cancellations(binding_id,created_at);
