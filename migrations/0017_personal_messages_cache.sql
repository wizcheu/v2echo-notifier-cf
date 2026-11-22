ALTER TABLE notification_history ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
ALTER TABLE notifier ADD COLUMN history_next_page INTEGER DEFAULT 1;

UPDATE notification_history
SET avatar_url=COALESCE((
  SELECT o.avatar_url FROM notification_outbox o
  WHERE o.account_id=notification_history.account_id
    AND o.notification_id=notification_history.notification_id
    AND o.type='notification' AND o.avatar_url<>''
  ORDER BY o.updated_at DESC LIMIT 1
),'');
