import type { Database } from "../db";
import type { Env } from "../types";
import type {
  CheckRecord,
  HistoryRecord,
  NotificationRecord,
  RecordsPage,
} from "../../shared/contracts";
import type { CachedMessagesPage } from "../../shared/message-contracts";
import { open } from "./crypto";
import { NotifierError, scopeContent, type Content } from "./model";

const choose = (query: URLSearchParams, key: string, allowed: string[]) => {
  const value = query.get(key) ?? "all";
  if (!allowed.includes(value))
    throw new NotifierError("记录筛选条件无效", 0, "", 400);
  return value;
};
function recordCursor(query: URLSearchParams) {
  let cursor: [number, string] | undefined;
  const raw = query.get("cursor");
  if (raw) {
    if (raw.length > 128) throw new NotifierError("记录游标无效", 0, "", 400);
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      parsed[0] <= 0 ||
      typeof parsed[1] !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(parsed[1])
    )
      throw new NotifierError("记录游标无效", 0, "", 400);
    cursor = [parsed[0], parsed[1]];
  }
  return cursor;
}

async function historyRecords(
  db: Database,
  env: Env,
  account: number,
  kind: string,
  cursor: [number, string] | undefined,
): Promise<RecordsPage<HistoryRecord>> {
  const where = ["h.account_id=?"],
    args: (number | string)[] = [account];
  if (kind !== "all") {
    where.push("h.kind=?");
    args.push(kind);
  }
  if (cursor) {
    where.push("h.notification_id<?");
    args.push(cursor[0]);
  }
  const rows = await db.all<{
    notification_id: number;
    kind: string;
    avatar_url: string;
    created_at: number | null;
    fetched_at: number;
    push_status: string | null;
    content_enc: string;
  }>(
    `SELECT h.notification_id,h.kind,h.avatar_url,h.created_at,h.fetched_at,h.content_enc,o.status AS push_status FROM notification_history h LEFT JOIN notification_outbox o ON o.account_id=h.account_id AND o.notification_id=h.notification_id AND o.type='notification' WHERE ${where.join(" AND ")} ORDER BY h.notification_id DESC LIMIT 21`,
    ...args,
  );
  const items: HistoryRecord[] = [];
  for (const row of rows.slice(0, 20)) {
    const { content_enc, ...visible } = row;
    const content = await open<Content>(
      env,
      scopeContent(account, row.notification_id),
      content_enc,
    );
    items.push({ ...visible, title: content.title, body: content.body });
  }
  return {
    items,
    next_cursor:
      rows.length > 20
        ? JSON.stringify([items.at(-1)!.notification_id, "history"])
        : null,
  };
}

/** Cached personal messages never require upstream credentials or identity requests. */
export async function cachedMessages(
  db: Database,
  env: Env,
  query: URLSearchParams,
  accountID = 1,
): Promise<CachedMessagesPage> {
  if ([...query.keys()].some((key) => key !== "cursor"))
    throw new NotifierError("个人消息查询参数无效", 0, "", 400);
  const cursor = recordCursor(query);
  if (cursor && cursor[1] !== "history")
    throw new NotifierError("记录游标无效", 0, "", 400);
  const state = await db.one<{
    account_id: number;
    history_at: number;
    history_next_page: number | null;
  }>("SELECT account_id,history_at,history_next_page FROM notifier WHERE id=?", accountID);
  const result = await historyRecords(db, env, state.account_id, "all", cursor);
  return {
    items: result.items.map(({ notification_id, kind, avatar_url, created_at, title, body }) => ({
      notification_id, kind, avatar_url, created_at, title, body,
    })),
    next_cursor: result.next_cursor,
    fetched_at: Math.max(state.history_at, ...result.items.map((item) => item.fetched_at)),
    upstream_next_page: state.history_next_page,
  };
}

export async function notificationRecords(
  db: Database,
  env: Env,
  query: URLSearchParams,
  accountID = 1,
): Promise<RecordsPage<HistoryRecord | CheckRecord | NotificationRecord>> {
  const view = query.get("view") ?? "history";
  if (!["history", "checks", "deliveries"].includes(view))
    throw new NotifierError("记录类型无效", 0, "", 400);
  const cursor = recordCursor(query);
  if (view === "history") {
    const kind = choose(query, "kind", [
      "all",
      "reply",
      "mention",
      "thanks_topic",
      "thanks_reply",
      "favorite",
      "other",
    ]);
    const account = await db.one<{ account_id: number }>(
      "SELECT account_id FROM notifier WHERE id=?", accountID,
    );
    return historyRecords(db, env, account.account_id, kind, cursor);
  }
  const where: string[] = [],
    args: (number | string)[] = [];
  const checks = view === "checks";
  where.push(checks ? "notifier_id=?" : "account_id=(SELECT account_id FROM notifier WHERE id=?)");
  args.push(accountID);
  const filter = checks
    ? choose(query, "outcome", [
        "all",
        "issues",
        "running",
        "ok",
        "waiting",
        "error",
        "interrupted",
      ])
    : choose(query, "status", [
        "all",
        "pending",
        "submitted",
        "unclassified",
        "apns_accepted",
        "rejected",
        "expired",
        "cancelled",
      ]);
  if (filter !== "all") {
    if (checks && filter === "issues") {
      where.push("outcome IN ('error','interrupted')");
    } else {
      where.push(checks ? "outcome=?" : "status=?");
      args.push(filter);
    }
  }
  if (checks) {
    const source = choose(query, "source", ["all", "scan", "verify", "history", "following_topic", "topic_reply", "pairing"]);
    if (source !== "all") {
      where.push("source=?");
      args.push(source);
    }
  } else {
    const type = choose(query, "type", ["all", "notification", "test", "watch_update"]);
    if (type !== "all") {
      where.push("type=?");
      args.push(type);
    }
    const watchKind = choose(query, "watch_kind", ["all", "topic_reply", "following_topic"]);
    if (watchKind !== "all") {
      where.push("type='watch_update' AND json_extract(NULLIF(watch_meta,''),'$.watch_kind')=?");
      args.push(watchKind);
    }
  }
  const at = checks ? "started_at" : "created_at",
    id = checks ? "id" : "event_id";
  if (cursor) {
    where.push(`(${at}<? OR (${at}=? AND ${id}<?))`);
    args.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = await db.all<CheckRecord | NotificationRecord>(
    `SELECT ${checks ? "id,source,started_at,finished_at,outcome,unread,stage_before,stage_after,requests,api_requests,detail" : "event_id,notification_id,type,kind,status,attempts,receipt_attempts,next_at,created_at,expires_at,updated_at,detail,deliveries"} FROM ${checks ? "notification_checks" : "notification_outbox"} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${at} DESC,${id} DESC LIMIT 21`,
    ...args,
  );
  const items = rows.slice(0, 20),
    last = items.at(-1);
  const next = !last
    ? null
    : "id" in last
      ? [last.started_at, last.id]
      : [last.created_at, last.event_id];
  return { items, next_cursor: rows.length > 20 ? JSON.stringify(next) : null };
}
