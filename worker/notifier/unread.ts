import type { UnreadPage, UnreadRecord, UnreadRefreshResult } from "../../shared/unread-contracts";
import type { Database } from "../db";
import { parseHome } from "../parsers";
import type { Env } from "../types";
import { Context } from "./context";
import { open, seal, storageReady } from "./crypto";
import { upstream } from "./http";
import { IDENTITY_MAX_AGE, NotifierError, SCAN_LIMIT, UUID, type Content } from "./model";
import { credentialScope, probeIdentity } from "./pairing";
import { notificationPage, presentation } from "./presentation";

const PROGRESS_MAX_AGE = 10 * 60_000;
interface UnreadControl {
  account_id: number;
  username: string;
  credential_scope: string;
  snapshot_id: string;
  total: number;
  fetched_at: number;
  refresh_id: string;
  refresh_total: number;
  collected: number;
  page: number;
  min_id: number;
  head: string;
  stage: "idle" | "page" | "verify";
  started_at: number;
  next_refresh: number;
  retry_at: number;
  error: string;
}
interface StoredItem extends Omit<UnreadRecord, "title" | "body"> {
  content_enc: string;
}
const read = (db: Database, accountID: number) => db.one<UnreadControl>("SELECT * FROM unread_control WHERE id=?", accountID);
const purpose = (account: number, snapshot: string, id: number) =>
  `unread:${account}:${snapshot}:${id}`;

function cursorValue(raw: string | null): [string, number] | null {
  if (!raw) return null;
  let value: unknown;
  try { value = raw.length <= 128 ? JSON.parse(raw) : null; } catch { value = null; }
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" ||
      !UUID.test(value[0]) || !Number.isSafeInteger(value[1]) || value[1] <= 0)
    throw new NotifierError("未读消息分页参数无效", 0, "", 400);
  return [value[0], value[1]];
}

/** Read only a published snapshot; an in-progress refresh cannot mix into a page. */
export async function unreadPage(db: Database, env: Env, query: URLSearchParams, accountID = 1): Promise<UnreadPage> {
  const cursor = cursorValue(query.get("cursor"));
  const scope = await credentialScope(new Context(db, env, "", undefined, Date.now(), accountID));
  const [metadata, identity, data] = await db.batch([
    db.statement("SELECT * FROM unread_control WHERE id=?", accountID),
    db.statement("SELECT account_id FROM notifier WHERE id=?", accountID),
    db.statement(`SELECT notification_id,kind,avatar_url,created_at,content_enc FROM unread_items
      WHERE snapshot_id=(SELECT snapshot_id FROM unread_control WHERE id=?) AND notifier_id=?
      ${cursor ? "AND notification_id<?" : ""} ORDER BY notification_id DESC LIMIT 21`,
      accountID, accountID, ...(cursor ? [cursor[1]] : [])),
  ]);
  const row = metadata.results[0] as unknown as UnreadControl;
  const account = (identity.results[0] as { account_id: number }).account_id;
  const matches = row.credential_scope === scope && (!account || account === row.account_id);
  if (!matches) {
    if (cursor) throw new NotifierError("账号或访问凭据已变化，请重新获取未读消息");
    return {
      items: [], next_cursor: null, snapshot_id: null, total: null, fetched_at: 0,
      refresh_id: null, refreshing: false, collected: 0, retry_at: 0,
      error: row.credential_scope ? "账号或访问凭据已变化，请重新获取未读消息" : "",
    };
  }
  if (cursor && cursor[0] !== row.snapshot_id)
    throw new NotifierError("未读消息列表已更新，请返回第一页查看");
  const rows = data.results as unknown as StoredItem[];
  const items = await Promise.all(rows.slice(0, 20).map(async ({ content_enc, ...item }) => ({
    ...item,
    ...await open<Content>(env, purpose(row.account_id, row.snapshot_id, item.notification_id), content_enc),
  })));
  const expired = Boolean(row.refresh_id) && row.started_at + PROGRESS_MAX_AGE <= Date.now();
  const refreshing = Boolean(row.refresh_id) && !expired;
  return {
    items,
    next_cursor: rows.length > 20 ? JSON.stringify([row.snapshot_id, items.at(-1)!.notification_id]) : null,
    snapshot_id: row.snapshot_id || null,
    total: row.snapshot_id ? row.total : null,
    fetched_at: row.fetched_at,
    refresh_id: refreshing ? row.refresh_id : null,
    refreshing,
    collected: refreshing ? row.collected : 0,
    error: expired ? "未读消息读取进度已过期，请重新获取最新数据" : row.error,
    retry_at: row.retry_at,
  };
}

async function homeSnapshot(c: Context, username: string, accountID: number) {
  try {
    return await parseHome(String(await upstream(c, "/")), username, accountID);
  } catch (error) {
    if (error instanceof NotifierError) throw error;
    throw new NotifierError("首页身份或未读数校验失败，请检查 Cookie", 0, "credentials");
  }
}

function progress(row: UnreadControl): UnreadRefreshResult {
  return {
    refresh_id: row.refresh_id,
    complete: false,
    collected: row.collected,
    total: row.refresh_total,
    retry_at: row.retry_at,
    reason: row.stage === "verify"
      ? `已读取 ${row.collected} 条未读消息，正在确认列表未发生变化`
      : `已读取 ${row.collected} / ${row.refresh_total} 条未读消息，继续获取下一页`,
  };
}

async function publish(c: Context, row: UnreadControl, avatar = ""): Promise<UnreadRefreshResult> {
  await c.save([
    ...(avatar ? [c.sql("UPDATE notifier SET avatar_url=? WHERE id=? AND account_id=?", avatar, c.id, row.account_id)] : []),
    c.sql(`DELETE FROM unread_items WHERE (snapshot_id<>?) AND notifier_id=?`, row.refresh_id, c.id),
    c.sql(`UPDATE unread_control SET snapshot_id=refresh_id,total=refresh_total,fetched_at=?,
      refresh_id='',stage='idle',collected=0,retry_at=0,error='' WHERE id=?`, c.now, c.id),
  ]);
  return {
    refresh_id: null, complete: true, collected: row.refresh_total, total: row.refresh_total,
    retry_at: 0, reason: `已获取全部 ${row.refresh_total} 条未读消息`,
  };
}

async function invalidate(c: Context, row: UnreadControl, message: string): Promise<never> {
  await c.save([
    c.sql(`DELETE FROM unread_items WHERE (snapshot_id=?) AND notifier_id=?`, row.refresh_id, c.id),
    c.sql("UPDATE unread_control SET refresh_id='',stage='idle',collected=0,error=? WHERE id=?", message, c.id),
  ]);
  throw new NotifierError(message);
}

/** One notification API page per leased call; viewing never advances the push scanner. */
export async function refreshUnread(c: Context, input: Record<string, unknown>): Promise<UnreadRefreshResult> {
  if (Object.keys(input).some(key => key !== "refresh_id") ||
      (input.refresh_id !== undefined && (typeof input.refresh_id !== "string" || !UUID.test(input.refresh_id))))
    throw new NotifierError("未读消息刷新参数无效", 0, "", 400);
  if (!storageReady(c.env)) throw new NotifierError("请先配置 NOTIFIER_KEY 加密密钥", 0, "", 503);
  let row = await read(c.db, c.id);
  const state = await c.state();
  const scope = await credentialScope(c);
  const sameIdentity = row.credential_scope === scope && (!state.account_id || row.account_id === state.account_id);
  if (input.refresh_id) {
    if (!sameIdentity) throw new NotifierError("账号或访问凭据已变化，请重新获取未读消息");
    if (input.refresh_id === row.snapshot_id)
      return { refresh_id: null, complete: true, collected: row.total, total: row.total, retry_at: 0, reason: `已获取全部 ${row.total} 条未读消息` };
    if (input.refresh_id !== row.refresh_id || row.stage === "idle")
      throw new NotifierError("未读消息读取任务已更新，请重新获取最新数据");
    if (row.started_at + PROGRESS_MAX_AGE <= c.now)
      return invalidate(c, row, "未读消息读取进度已过期，请重新获取最新数据");
  } else if (row.next_refresh > c.now) {
    throw new NotifierError("获取未读消息的间隔为一分钟，请稍后再试", row.next_refresh);
  }
  if (sameIdentity && row.retry_at > c.now)
    throw new NotifierError(row.error || "尚未到未读消息重试时间，请稍后再试", row.retry_at);
  try {
    if (!input.refresh_id) {
      await c.update("UPDATE unread_control SET next_refresh=? WHERE id=?", c.now + 60_000, c.id);
      const verified = state.account_id && state.username && state.blocked !== "credentials" &&
        state.verified_at > c.now - IDENTITY_MAX_AGE && state.credential_scope === scope;
      let identity: Awaited<ReturnType<typeof probeIdentity>>;
      if (verified) {
        const home = await homeSnapshot(c, state.username, state.account_id);
        identity = { member: { id: state.account_id, username: state.username }, count: home.unread, avatar: home.avatar_url, scope };
      } else identity = await probeIdentity(c);
      if (identity.count > SCAN_LIMIT)
        throw new NotifierError(`未读消息超过单次 ${SCAN_LIMIT} 条安全上限，未替换原列表；请先在 V2EX 处理部分未读后重试`);
      const refreshID = crypto.randomUUID();
      await c.save([
        ...(identity.avatar ? [c.sql("UPDATE notifier SET avatar_url=? WHERE id=? AND account_id=?", identity.avatar, c.id, identity.member.id)] : []),
        c.sql(`DELETE FROM unread_items WHERE (snapshot_id<>?) AND notifier_id=?`, sameIdentity ? row.snapshot_id : "", c.id),
        c.sql(`UPDATE unread_control SET account_id=?,username=?,credential_scope=?,
          snapshot_id=?,total=?,fetched_at=?,refresh_id=?,refresh_total=?,collected=0,page=1,min_id=0,
          head='[]',stage='page',started_at=?,retry_at=0,error='' WHERE id=?`,
          identity.member.id, identity.member.username, identity.scope,
          sameIdentity ? row.snapshot_id : "", sameIdentity ? row.total : 0, sameIdentity ? row.fetched_at : 0,
          refreshID, identity.count, c.now, c.id),
      ]);
      row = await read(c.db, c.id);
      if (!row.refresh_total) return publish(c, row);
    }
    if (row.stage === "verify") {
      const home = await homeSnapshot(c, row.username, row.account_id);
      if (home.unread !== row.refresh_total)
        return invalidate(c, row, "未读数量在读取期间发生变化，请重新获取最新数据");
      const head = notificationPage(await upstream(c, "/api/v2/notifications?p=1"), row.account_id);
      if (JSON.stringify(head.map(item => item.id)) !== row.head)
        return invalidate(c, row, "通知首页在读取期间发生变化，请重新获取最新数据");
      return publish(c, row, home.avatar_url);
    }
    const page = notificationPage(await upstream(c, `/api/v2/notifications?p=${row.page}`), row.account_id);
    if (!page.length || (row.page > 1 && page[0].id >= row.min_id))
      return invalidate(c, row, "通知分页或未读范围发生变化，请重新获取最新数据");
    const selected = page.slice(0, row.refresh_total - row.collected);
    const collected = row.collected + selected.length;
    const writes: D1PreparedStatement[] = [];
    for (const notification of selected) {
      const formatted = presentation(notification, row.username);
      const created = typeof notification.created === "number" && Number.isSafeInteger(notification.created) &&
        notification.created > 0 && notification.created * 1000 <= c.now + 60_000 ? notification.created * 1000 : null;
      writes.push(c.sql(`INSERT INTO unread_items(snapshot_id,notification_id,kind,avatar_url,created_at,content_enc,notifier_id) VALUES(?,?,?,?,?,?,?)`,
        row.refresh_id, notification.id, formatted.kind, formatted.avatar, created,
        await seal(c.env, purpose(row.account_id, row.refresh_id, notification.id), { title: formatted.title, body: formatted.body }), c.id));
    }
    writes.push(c.sql(`UPDATE unread_control SET collected=?,page=page+1,min_id=?,head=?,stage=?,retry_at=0,error='' WHERE id=?`,
      collected, page.at(-1)!.id, row.page === 1 ? JSON.stringify(page.map(item => item.id)) : row.head,
      collected === row.refresh_total ? "verify" : "page", c.id));
    await c.save(writes);
    return progress(await read(c.db, c.id));
  } catch (error) {
    const message = error instanceof NotifierError ? error.message : "未读消息读取未完成，请稍后重试";
    await c.update("UPDATE unread_control SET error=?,retry_at=MAX(retry_at,?) WHERE id=?", message,
      error instanceof NotifierError ? error.retryAt : 0, c.id);
    throw error;
  }
}
