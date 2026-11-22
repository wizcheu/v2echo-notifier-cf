import type { RecordsPage } from "./contracts";

export interface UnreadRecord {
  notification_id: number;
  kind: string;
  title: string;
  body: string;
  avatar_url: string;
  created_at: number | null;
}

export interface UnreadPage extends RecordsPage<UnreadRecord> {
  snapshot_id: string | null;
  total: number | null;
  fetched_at: number;
  refresh_id: string | null;
  refreshing: boolean;
  collected: number;
  error: string;
  retry_at: number;
}

export interface UnreadRefreshResult {
  refresh_id: string | null;
  complete: boolean;
  collected: number;
  total: number;
  retry_at: number;
  reason: string;
}
