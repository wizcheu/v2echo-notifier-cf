import type { CheckPolicy } from "./check-schedule";
import type { WatchState } from "./watch-contracts";

/** Short-lived code only; sender credentials never reach the management browser. */
export interface PairingInvitation {
  direct?: true;
  code: string;
  payload?: string;
  expires_at: number;
}
export interface PairingConfirmation {
  paired: boolean;
  reason: string;
}

export interface CredentialStatus {
  cookie: boolean;
  pat: boolean;
  source: "secrets" | "settings";
  updated_at: number;
}

export interface ApiUsageRecord {
  id: string;
  endpoint: "member" | "notifications";
  attempted_at: number;
  finished_at: number | null;
  status: number | null;
  network_error: number;
  budget_limit: number | null;
  remaining: number | null;
  reset_at: number | null;
  retry_after_at: number | null;
  backoff_until: number;
  backoff_reason: string;
}
export interface ApiUsageDay {
  day: string;
  endpoint: "member" | "notifications";
  attempts: number;
  responses: number;
  http_errors: number;
  network_errors: number;
  rate_limited: number;
}
export interface ApiUsageState {
  recording_since: number;
  hour_attempts: number;
  daily: ApiUsageDay[];
  recent: ApiUsageRecord[];
  latest_budget: ApiUsageRecord | null;
  active_backoff: ApiUsageRecord | null;
}
export interface NotificationRecord {
  event_id: string;
  notification_id: number | null;
  type: "notification" | "test" | "watch_update";
  kind: string;
  status: string;
  attempts: number;
  receipt_attempts: number;
  next_at: number;
  created_at: number;
  expires_at: number;
  updated_at: number;
  detail: string;
  deliveries: string;
}
export interface NotifierState extends CheckPolicy {
  history_at: number;
  history_until: number;
  history_error: string;
  enabled: number;
  account_id: number;
  username: string;
  avatar_url: string;
  verified_at: number;
  verify_until: number;
  binding_id: string;
  paired_at: number;
  blocked: string;
  pair_until: number;
  scan_stage: string;
  scan_page: number;
  scan_collected: number;
  unread: number;
  observed_at: number;
  next_scan: number;
  scan_until: number;
  scan_error: string;
  last_scan: number;
  relay_until: number;
  relay_error: string;
  last_sync: number;
  storage_ready: boolean;
  device_ack_available: false;
  events: NotificationRecord[];
  counts: { status: string; count: number }[];
  check_errors: {
    source: "scan" | "following_topic" | "topic_reply";
    count: number;
  }[];
  watches: WatchState;
}

export interface HistoryRecord {
  notification_id: number;
  kind: string;
  avatar_url: string;
  created_at: number | null;
  fetched_at: number;
  push_status: string | null;
  title: string;
  body: string;
}
export interface CheckRecord {
  id: string;
  source: string;
  started_at: number;
  finished_at: number | null;
  outcome: string;
  unread: number;
  stage_before: string;
  stage_after: string;
  requests: number;
  api_requests: number;
  detail: string;
}
export interface RecordsPage<T> {
  items: T[];
  next_cursor: string | null;
}

/** Local id is stable; account_id is the verified V2EX member identity. */
export interface NotifierAccount {
  id: number;
  account_id: number;
  username: string;
  avatar_url: string;
  enabled: number;
  blocked: string;
  paired_at: number;
  binding_id: string;
  credentials: CredentialStatus;
}
export interface AccountsState {
  accounts: NotifierAccount[];
  legacy_credentials_available: boolean;
}

export interface VersionCheckResult {
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  release_url: string;
  published_at: string | null;
  checked_at: number;
  note?: string;
}

export type NotifierAccounts = AccountsState;
