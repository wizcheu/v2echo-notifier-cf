ALTER TABLE watch_control ADD COLUMN config_owner TEXT NOT NULL DEFAULT 'central';
ALTER TABLE watch_control ADD COLUMN ownership_committed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watch_control ADD COLUMN ownership_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE watch_local_operations (
  profile_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,operation_id)
);
CREATE TABLE watch_app_invitation (
  id INTEGER PRIMARY KEY CHECK(id=1),
  code_hash TEXT NOT NULL,
  code_enc TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_client TEXT NOT NULL DEFAULT ''
);
CREATE TABLE watch_app_clients (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  invitation_hash TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE watch_cancellations (
  event_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
