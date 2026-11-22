-- Applied after the notification-only Worker is deployed. Keep the existing lease,
-- dispatch interval, upstream cooldowns and usage totals unchanged.
DROP TABLE runs;
DROP TABLE probes;
ALTER TABLE control DROP COLUMN enabled;
ALTER TABLE control DROP COLUMN revision;
ALTER TABLE control DROP COLUMN retention_days;
ALTER TABLE control DROP COLUMN credential_scope;
