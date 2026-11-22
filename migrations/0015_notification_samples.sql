CREATE TABLE notification_samples (
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('reply','mention','thanks_topic','thanks_reply','favorite')),
  notification_id INTEGER NOT NULL,
  raw_enc TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,kind)
);
CREATE INDEX notification_samples_fetched ON notification_samples(fetched_at);
