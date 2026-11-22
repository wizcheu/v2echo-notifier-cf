export const MAX_WATCH_TOPICS = 20;
export interface WatchRefreshResult {
  started_at: number;
  complete: boolean;
  remaining: number;
  retry_at: number;
  reason: string;
}

export interface WatchRule {
  topic_id: number;
  enabled: boolean;
  epoch: number;
  enabled_at: number;
}
export interface WatchConfig {
  config_owner?: "central" | "handoff" | "assistant";
  profile_id: string;
  source_account_id: number;
  assistant_id: string;
  revision: number;
  source_generation: number;
  max_topics: number;
  following: { enabled: boolean; epoch: number; enabled_at: number };
  topics: WatchRule[];
  applied_revision: number;
  recipient_count: number;
  capable_recipient_count: number;
  last_seen: number;
  last_checked: number;
  runtime_status: string;
  target_status?: {
    topic_id: number;
    epoch: number;
    last_checked: number;
    state: "baseline" | "checking" | "ready" | "error";
  }[];
}
export interface WatchMeta {
  profile_id: string;
  source_generation: number;
  watch_kind: "topic_reply" | "following_topic";
  watch_epoch: number;
  topic_id: number;
  reply_id?: number;
  reply_floor?: number;
}
export interface WatchState {
  assistant_id: string;
  last_sync: number;
  next_sync: number;
  error: string;
  config: WatchConfig | null;
  targets: WatchTarget[];
  direct_ready: boolean;
  clients: {
    id: string;
    label: string;
    created_at: number;
    last_seen: number;
  }[];
  pending_cancellations: number;
}
export interface FollowedMember {
  username: string;
  avatar_url?: string;
}
export interface MemberFeedTopic {
  id: number;
  title: string;
  author: string;
  avatar_url?: string;
  reply_count: number;
  node_name?: string;
  node_title?: string;
  updated_at?: number;
}
export interface MemberFeedSnapshot {
  topics: MemberFeedTopic[];
  observed_at: number;
}
export interface WatchTarget {
  target_key: string;
  topic_id: number;
  last_checked: number;
  next_check: number;
  checking: number;
  error: string;
  title?: string;
  author?: string;
  avatar_url?: string;
  progress?:
    | { kind: "candidates"; pending_topics: number }
    | {
        kind?: "audit";
        completed_pages: number;
        total_pages: number;
        pending_topics: number;
      };
  member_count?: number;
  followed_members?: FollowedMember[];
  members_observed_at?: number;
  member_feed?: MemberFeedSnapshot;
  member_feed_error?: string;
  recent_topics?: { id: number; title: string; author: string }[];
  observed_at?: number;
}
