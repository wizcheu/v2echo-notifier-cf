CREATE TABLE api_usage_meta (
  id INTEGER PRIMARY KEY CHECK(id=1), recording_since INTEGER NOT NULL
);
INSERT INTO api_usage_meta VALUES(1,unixepoch('now')*1000);
CREATE TABLE api_usage (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('probe','notifier')),
  endpoint TEXT NOT NULL CHECK(endpoint IN ('member','notifications')),
  attempted_at INTEGER NOT NULL, finished_at INTEGER,
  status INTEGER, network_error INTEGER NOT NULL DEFAULT 0,
  budget_limit INTEGER, remaining INTEGER, reset_at INTEGER,
  retry_after_at INTEGER, backoff_until INTEGER NOT NULL DEFAULT 0,
  backoff_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX api_usage_time ON api_usage(attempted_at);
CREATE INDEX api_usage_backoff ON api_usage(backoff_until DESC,attempted_at DESC);
CREATE INDEX api_usage_budget ON api_usage(attempted_at DESC,id DESC)
  WHERE budget_limit IS NOT NULL OR remaining IS NOT NULL OR reset_at IS NOT NULL;
CREATE TABLE api_daily (
  day TEXT NOT NULL, source TEXT NOT NULL, endpoint TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, responses INTEGER NOT NULL DEFAULT 0,
  http_errors INTEGER NOT NULL DEFAULT 0, network_errors INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,source,endpoint)
);
