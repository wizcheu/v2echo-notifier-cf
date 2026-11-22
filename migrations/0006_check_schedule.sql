ALTER TABLE notifier ADD COLUMN check_start_hour INTEGER NOT NULL DEFAULT 8 CHECK(check_start_hour BETWEEN 0 AND 23);
ALTER TABLE notifier ADD COLUMN check_end_hour INTEGER NOT NULL DEFAULT 24 CHECK(check_end_hour BETWEEN 1 AND 24 AND check_end_hour != check_start_hour);
