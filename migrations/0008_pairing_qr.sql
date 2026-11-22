-- A single encrypted invitation, including a short-lived completion receipt.
CREATE TABLE notifier_pairing_invitation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
