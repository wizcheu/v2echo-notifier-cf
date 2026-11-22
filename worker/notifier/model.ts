import type { CheckPolicy } from "../../shared/check-schedule";

export const RELAY = "https://app.v2echo.com/api/push";
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SCAN_LIMIT = 1000;
export const QUEUE_LIMIT = 2000;
export const DEDUP_LIMIT = 100000;
/** Snapshot freshness stays fixed when the user changes routine check intervals. */
export const HOME_REFRESH_INTERVAL = 180000;
export const IDENTITY_MAX_AGE = 6 * 3600000;
const classifiedKinds = [
  "reply",
  "mention",
  "thanks_topic",
  "thanks_reply",
  "favorite",
] as const;
export type ClassifiedNotificationKind = (typeof classifiedKinds)[number];
export type NotificationKind = ClassifiedNotificationKind | "other";
export type WatchTestKind = "topic_reply" | "topic_replies" | "following_topic";
export function isWatchTestKind(value: unknown): value is WatchTestKind {
  return value === "topic_reply" || value === "topic_replies" || value === "following_topic";
}
export function isClassifiedKind(
  value: unknown,
): value is ClassifiedNotificationKind {
  return (
    typeof value === "string" &&
    (classifiedKinds as readonly string[]).includes(value)
  );
}
export interface Notifier extends CheckPolicy {
  enabled: number;
  account_id: number;
  username: string;
  avatar_url: string;
  credential_scope: string;
  verified_at: number;
  verify_until: number;
  binding_id: string;
  sender_enc: string;
  paired_at: number;
  blocked: string;
  pair_enc: string;
  pair_until: number;
  scan_stage: "idle" | "page" | "verify" | "commit";
  scan_id: string;
  scan_page: number;
  scan_collected: number;
  scan_min: number;
  scan_head: string;
  unread: number;
  observed_at: number;
  next_scan: number;
  scan_until: number;
  scan_failures: number;
  scan_error: string;
  last_scan: number;
  relay_until: number;
  relay_failures: number;
  relay_error: string;
  last_sync: number;
  cleanup_at: number;
  history_until: number;
  history_at: number;
  history_error: string;
  check_errors_acked_at: number;
}
export interface Candidate {
  notification_id: number;
  content_enc: string;
  kind: NotificationKind;
  avatar_url: string;
}
export interface Outbox extends Omit<Candidate, "notification_id" | "kind"> {
  kind: NotificationKind | WatchTestKind;
  notification_id: number | null;
  event_id: string;
  account_id: number;
  binding_id: string;
  type: "notification" | "test" | "watch_update";
  watch_meta: string;
  unread: number;
  wire: string | null;
  status: string;
  attempts: number;
  receipt_attempts: number;
  next_at: number;
  created_at: number;
  expires_at: number;
  updated_at: number;
  detail: string;
}
export interface Content {
  title: string;
  body: string;
}
export interface Recipient {
  device_id: string;
  binding_id: string;
  key_id: string;
  public_key: string;
}
export class NotifierError extends Error {
  constructor(
    message: string,
    readonly retryAt = 0,
    readonly block = "",
    readonly status = 409,
    readonly upstreamStatus = 0,
  ) {
    super(message);
  }
}
export const scopeContent = (account: number, id: string | number) =>
  `notification:${account}:${id}`;
