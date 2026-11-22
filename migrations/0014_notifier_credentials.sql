CREATE TABLE notifier_credentials (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
