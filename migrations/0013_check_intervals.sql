ALTER TABLE notifier ADD COLUMN scan_interval_minutes INTEGER NOT NULL DEFAULT 3 CHECK(scan_interval_minutes IN (3,5,10,15));
ALTER TABLE notifier ADD COLUMN following_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(following_interval_minutes IN (5,10,15,30));
ALTER TABLE notifier ADD COLUMN topic_interval_minutes INTEGER NOT NULL DEFAULT 10 CHECK(topic_interval_minutes IN (10,15,30,60));
