ALTER TABLE watch_app_clients ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE watch_app_clients ADD COLUMN binding_id TEXT NOT NULL DEFAULT '';
ALTER TABLE watch_app_clients ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
