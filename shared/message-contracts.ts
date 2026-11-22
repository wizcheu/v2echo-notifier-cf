export interface MessageRecord {
  notification_id: number;
  kind: string;
  title: string;
  body: string;
  avatar_url: string;
  created_at: number | null;
}

export interface PersonalMessagesPage {
  items: MessageRecord[];
  page: number;
  next_page: number | null;
  fetched_at: number;
  reason: string;
}

export interface CachedMessagesPage {
  items: MessageRecord[];
  next_cursor: string | null;
  fetched_at: number;
  upstream_next_page: number | null;
}
