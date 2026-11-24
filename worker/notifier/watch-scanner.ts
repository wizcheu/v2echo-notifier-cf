import type { FollowedMember, MemberFeedSnapshot, WatchConfig, WatchMeta, WatchRefreshResult } from "../../shared/watch-contracts";
import type { Context } from "./context";
import { recordCheck } from "./checks";
import { hex, open, seal } from "./crypto";
import { upstream } from "./http";
import { DEDUP_LIMIT, IDENTITY_MAX_AGE, NotifierError, QUEUE_LIMIT, scopeContent, type Content, type Notifier } from "./model";
import { credentialScope, verifyIdentity } from "./pairing";
import { accessWaitMessage } from "./response-errors";
import { backoff } from "./relay";
import { cachedWatchConfig } from "./watch-config";
import { followingTopicContent, topicRepliesContent } from "./watch-content";
import { parseFollowedMembers, parseMembersFeed, parseWatchedTopic, type FollowingTopic, type WatchReply } from "./watch-parsers";

interface Target {
  target_key: string; topic_id: number; epoch: number; enabled_at: number;
  state_enc: string; next_check: number; last_checked: number; failures: number; checking: number;
  error: string;
}
export interface FollowingState {
  boundary: number;
  members: Record<string, number>;
  seen: number[];
  recent?: FollowingTopic[];
  observed_at?: number;
  followed_members?: FollowedMember[];
  members_observed_at?: number;
  member_feed?: MemberFeedSnapshot;
  member_feed_error?: string;
  feed_checked_at?: number;
  feed_retry_at?: number;
  feed_monitor?: { baseline: boolean; pending: FollowingTopic[]; scan?: { started: number; phase: "members" | "feed" | "candidates" } };
  incremental?: { page: number; pages: number; pending: FollowingTopic[] };
  scan?: {
    started: number; page: number; pages: number; verified: boolean;
    members: Record<string, number>; ids: number[]; candidates: FollowingTopic[];
    fastDone?: boolean; auditDone?: boolean; unavailable?: number;
  };
}
export interface ReplyState {
  high: number;
  checked: number;
  quiet: number;
  title?: string;
  author?: string;
  avatar?: string;
  scan?: { presentation: 2; high: number; before: number; page: number; started: number; title: string;
    topicAvatar: string; count: number; first?: WatchReply; ids: number[] };
}
interface NewEvent { meta: WatchMeta; ids: number[]; content: Content; avatar?: string; }
const scope = (account: number, target: Target) => `watch:${account}:${target.target_key}:${target.epoch}`;

/** A single due target gets at most three web requests per turn. Progress is encrypted at rest. */
export async function watchStep(c: Context) {
  const s = await c.state(), config = await cachedWatchConfig(c.db, c.id);
  if (!s.enabled || s.blocked || !config || !config.capable_recipient_count ||
      config.profile_id !== s.binding_id || config.source_account_id !== s.account_id ||
      s.credential_scope !== await credentialScope(c)) return;
  const target = await c.db.one<Target>(
    `SELECT * FROM watch_targets WHERE (next_check<=?) AND notifier_id=? ORDER BY next_check,last_checked,target_key LIMIT 1`, c.now, c.id,
  );
  if (!target) return;
  await checkWatchTarget(c, s, config, target);
}

async function checkWatchTarget(c: Context, s: Notifier, config: WatchConfig, target: Target, refreshStartedAt?: number) {
  const interval = s.topic_interval_minutes * 60000;
  let requests = 0;
  let consecutiveFailures = target.failures;
  let checkStage = "watch_scan";
  let checkDetail = "本轮检查尚未完成，等待继续";
  let queuedEvents = 0;
  const started = c.now;
  const fetchPage = async (path: string) => {
    if (requests >= 3 || c.now - started > 25000) return null;
    requests++;
    return String(await upstream(c, path));
  };
  const meta = (topic: number, reply?: WatchReply): WatchMeta => ({
    profile_id: config.profile_id, source_generation: config.source_generation, watch_epoch: target.epoch,
    watch_kind: target.topic_id ? "topic_reply" : "following_topic", topic_id: topic,
    ...(reply ? { reply_id: reply.id, reply_floor: reply.floor } : {}),
  });
  const save = async (value: FollowingState | ReplyState, due: number, complete: boolean, events: NewEvent[] = [], note = "") => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024) {
      throw new NotifierError("关注检查进度超过单项存储范围，尚未确认完整列表", c.now + 3600000);
    }
    const writes: D1PreparedStatement[] = [];
    const count = await c.db.one<{ pending: number; dedup: number }>(
      "SELECT (SELECT COUNT(*) FROM notification_outbox WHERE account_id=? AND status IN ('pending','submitted')) AS pending,(SELECT COUNT(*) FROM watch_dedup WHERE account_id=?) AS dedup", s.account_id, s.account_id,
    );
    if (count.pending + events.length > QUEUE_LIMIT || count.dedup + events.reduce((n, e) => n + e.ids.length, 0) > DEDUP_LIMIT) {
      throw new NotifierError("关注提醒队列或去重记录已达上限，保留检查进度", c.now + 3600000);
    }
    let addedEvents = 0;
    for (const event of events) {
      const known: { content_id: number }[] = [];
      for (let offset = 0; offset < event.ids.length; offset += 90) {
        const part = event.ids.slice(offset, offset + 90);
        known.push(...await c.db.all<{ content_id: number }>(
          `SELECT content_id FROM watch_dedup WHERE (account_id=? AND kind=? AND topic_id=? AND content_id IN (${part.map(() => "?").join(",")})) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
          s.account_id, event.meta.watch_kind, event.meta.topic_id, ...part, c.id,
        ));
      }
      const ids = event.ids.filter(id => !known.some(row => row.content_id === id));
      if (!ids.length) continue;
      addedEvents++;
      const id = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
        s.account_id, event.meta, ids,
      ]))));
      for (const contentID of ids) writes.push(c.sql("INSERT INTO watch_dedup VALUES(?,?,?,?,?)",
        s.account_id, event.meta.watch_kind, event.meta.topic_id, contentID, id));
      writes.push(c.sql(`INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,
        avatar_url,content_enc,created_at,expires_at,updated_at,watch_meta) VALUES(?,?,NULL,?,'watch_update','other',0,?,?,?,?,?,?)`,
        id, s.account_id, s.binding_id, event.avatar ?? "", await seal(c.env, scopeContent(s.account_id, id), event.content),
        c.now, c.now + 86400000, c.now, JSON.stringify(event.meta)));
    }
    writes.push(c.sql(`UPDATE watch_targets SET state_enc=?,next_check=?,last_checked=CASE WHEN ?=1 THEN ? ELSE last_checked END,
      failures=0,checking=?,error=? WHERE (target_key=? AND epoch=?) AND notifier_id=?`,
      await seal(c.env, scope(s.account_id, target), value), due, Number(complete), c.now, Number(!complete), note, target.target_key, target.epoch, c.id));
    await c.save(writes);
    consecutiveFailures = 0;
    queuedEvents += addedEvents;
    checkStage = complete ? "idle" : "watch_scan";
    checkDetail = note || (complete
      ? queuedEvents ? `检查完成，新增 ${queuedEvents} 条关注推送` : "检查完成，未发现需要推送的新内容"
      : queuedEvents ? `分页进度已保存，新增 ${queuedEvents} 条关注推送，等待继续检查` : "分页进度已保存，等待继续检查");
  };
  async function checkTarget() {
    if (!target.topic_id) {
      const state: FollowingState = target.state_enc ? await open<FollowingState>(c.env, scope(s.account_id, target), target.state_enc, 512 * 1024) : { boundary: 0, members: {}, seen: [] };
      const feedInterval = s.following_interval_minutes * 60000;
      if (!state.feed_monitor) {
        const legacy = state.scan;
        const baseline = !state.boundary && !legacy && !state.incremental && !Object.keys(state.members).length && !state.seen.length;
        state.members = { ...legacy?.members, ...state.members };
        state.feed_monitor = { baseline, pending: [...new Map([
          ...(legacy?.candidates ?? []), ...(state.incremental?.pending ?? []),
        ].map(topic => [topic.id, topic])).values()] };
        delete state.scan;
        delete state.incremental;
        delete state.feed_checked_at;
        delete state.feed_retry_at;
      }
      const monitor = state.feed_monitor;
      // Source snapshots and candidate checkpoints are not notification events.
      // A full outbox must not prevent retaining a successfully observed source.
      const checkpoint = async (complete = false, failed = false) => {
        if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 512 * 1024)
          throw new NotifierError("关注检查进度超过单项存储范围，保留旧进度", c.now + 3600000);
        if (failed) {
          await c.update("UPDATE watch_targets SET state_enc=? WHERE target_key=? AND epoch=? AND notifier_id=?",
            await seal(c.env, scope(s.account_id, target), state), target.target_key, target.epoch, c.id);
          return;
        }
        await c.update(`UPDATE watch_targets SET state_enc=?,next_check=?,last_checked=CASE WHEN ?=1 THEN ? ELSE last_checked END,
          failures=0,checking=?,error='' WHERE target_key=? AND epoch=? AND notifier_id=?`,
          await seal(c.env, scope(s.account_id, target), state), c.now + (complete ? feedInterval : 60000),
          Number(complete), c.now, Number(!complete), target.target_key, target.epoch, c.id);
        consecutiveFailures = 0;
        checkStage = complete ? "idle" : "watch_scan";
        checkDetail = complete ? `关注页检查完成，新增 ${queuedEvents} 条关注推送` : "关注页进度已保存，等待继续核验候选";
      };
      const needsFreshSource = monitor.scan && (
        monitor.scan.phase === "candidates" && (state.observed_at ?? monitor.scan.started) + feedInterval <= c.now ||
        monitor.scan.phase === "feed" && (state.members_observed_at ?? monitor.scan.started) + feedInterval <= c.now ||
        monitor.scan.phase !== "members" && refreshStartedAt !== undefined && monitor.scan.started < refreshStartedAt
      );
      if (!monitor.scan || needsFreshSource) {
        monitor.scan = { started: c.now, phase: "members" };
      }
      while (c.now - started <= 25000) {
        const scan = monitor.scan!;
        if (scan.phase === "members") {
          const raw = await fetchPage("/my/following?p=1");
          if (raw === null) return;
          const members = parseFollowedMembers(raw, s.username);
          state.members = Object.fromEntries(members.map(person => {
            const name = person.username.toLowerCase();
            return [name, state.members[name] ?? Math.floor(c.now / 1000) * 1000];
          }));
          state.followed_members = members;
          state.members_observed_at = c.now;
          monitor.pending = monitor.pending.filter(topic => state.members[topic.author.toLowerCase()] !== undefined && !state.seen.includes(topic.id));
          scan.phase = "feed";
          await checkpoint();
          continue;
        }
        if (scan.phase === "feed") {
          let topics: ReturnType<typeof parseMembersFeed>;
          try {
            const raw = await fetchPage("/?tab=members");
            if (raw === null) return;
            topics = parseMembersFeed(raw, s.username);
          } catch (error) {
            if (!(error instanceof NotifierError)) throw error;
            state.member_feed_error = error.message;
            await checkpoint(false, true);
            throw error;
          }
          state.member_feed = { topics, observed_at: c.now };
          state.member_feed_error = "";
          state.observed_at = c.now;
          const snapshot: FollowingTopic[] = topics.map(topic => ({ id: topic.id, author: topic.author, title: topic.title,
            ...(topic.updated_at === undefined ? {} : { updatedAt: topic.updated_at }) }));
          state.recent = snapshot.slice(0, 30);
          if (monitor.baseline) {
            state.seen = [...new Set([...state.seen, ...topics.map(topic => topic.id)])];
            monitor.baseline = false;
          } else {
            const pending = new Set(monitor.pending.map(topic => topic.id));
            const fresh = snapshot.filter(topic => {
              const since = state.members[topic.author.toLowerCase()];
              return since !== undefined && !state.seen.includes(topic.id) && !pending.has(topic.id) &&
                (topic.updatedAt === undefined || topic.updatedAt >= since);
            });
            monitor.pending = [...fresh, ...monitor.pending];
          }
          if (!monitor.pending.length) {
            state.boundary = scan.started;
            delete monitor.scan;
            await checkpoint(true);
            return;
          }
          scan.phase = "candidates";
          await checkpoint();
          continue;
        }
        const candidate = monitor.pending[0];
        if (!candidate) {
          state.boundary = scan.started;
          delete monitor.scan;
          await checkpoint(true);
          return;
        }
        let topic: ReturnType<typeof parseWatchedTopic>;
        try {
          const raw = await fetchPage(`/t/${candidate.id}?p=1`);
          if (raw === null) return;
          topic = parseWatchedTopic(raw, s.username, candidate.id);
          if (topic.author.toLowerCase() !== candidate.author.toLowerCase()) throw new NotifierError("关注主题作者与列表不符");
          if (topic.created > c.now) throw new NotifierError("关注主题创建时间晚于当前时间，保留候选等待核验", topic.created);
        } catch (error) {
          if (error instanceof NotifierError && [404, 410].includes(error.upstreamStatus)) {
            monitor.pending.shift();
            await checkpoint();
            continue;
          }
          if (error instanceof NotifierError && !error.block && !error.retryAt) {
            monitor.pending.push(monitor.pending.shift()!);
            await checkpoint(false, true);
          }
          throw error;
        }
        const since = state.members[topic.author.toLowerCase()];
        const events: NewEvent[] = since !== undefined && topic.created >= since && topic.author.toLowerCase() !== s.username.toLowerCase()
          ? [{ meta: meta(topic.id), ids: [topic.id], avatar: topic.avatar, content: followingTopicContent(topic.author, topic.title) }] : [];
        monitor.pending.shift();
        if (!state.seen.includes(topic.id)) state.seen.push(topic.id);
        if (events.length) await save(state, c.now + 60000, false, events);
        else await checkpoint();
      }
    } else {
      const state: ReplyState = target.state_enc ? await open<ReplyState>(c.env, scope(s.account_id, target), target.state_enc, 512 * 1024) : { high: 0, checked: 0, quiet: 0 };
      // Older progress omitted content and the earliest reply above 200 items.
      // Restart only the unfinished range, keeping the committed high-water mark.
      if (state.scan && state.scan.presentation !== 2) state.scan = undefined;
      if (state.checked && c.now - state.checked > 86400000) { state.checked = 0; state.scan = undefined; }
      if (!state.scan) {
        const raw = await fetchPage(`/t/${target.topic_id}?p=1`);
        if (raw === null) return;
        let tail = parseWatchedTopic(raw, s.username, target.topic_id);
        state.title = tail.title; state.author = tail.author; state.avatar = tail.avatar;
        if (tail.pages > 1) {
          const rawTail = await fetchPage(`/t/${target.topic_id}?p=${tail.pages}`);
          if (rawTail === null) return;
          tail = parseWatchedTopic(rawTail, s.username, target.topic_id, tail.pages);
        }
        const high = tail.replies.at(-1)?.id ?? 0;
        if (!state.checked || high <= state.high) {
          const baseline = !state.checked;
          state.high = Math.max(state.high, high); state.checked = c.now; state.quiet++;
          await save(state, c.now + Math.max(interval, state.quiet >= 12 ? 3600000 : state.quiet >= 6 ? 1800000 : 0), true);
          if (baseline) checkDetail = "已建立帖子评论起点，不补发已有评论";
          return;
        }
        state.scan = { presentation: 2, high, before: high + 1, page: tail.pages, started: c.now, title: tail.title, topicAvatar: tail.avatar, count: 0, ids: [] };
        await acceptPage(tail.replies);
      }
      while (state.scan && state.scan.page > 0) {
        const raw = await fetchPage(`/t/${target.topic_id}?p=${state.scan.page}`);
        if (raw === null) return;
        const page = parseWatchedTopic(raw, s.username, target.topic_id, state.scan.page);
        await acceptPage(page.replies);
      }
      async function acceptPage(replies: WatchReply[]) {
        const scan = state.scan!;
        const fresh = replies.filter(r => r.id > state.high && r.id < scan.before && r.id <= scan.high);
        if (scan.page > 1 && !replies.length) throw new NotifierError("主题分页暂不可用，保留检查进度");
        if (replies.length && replies[0]!.id >= scan.before) throw new NotifierError("主题分页重复，保留检查进度等待重试");
        for (const reply of fresh) {
          if (reply.author.toLowerCase() === s.username.toLowerCase()) continue;
          scan.count++;
          if (!scan.first || reply.id < scan.first.id) scan.first = reply;
          // Count every checked reply while retaining only bounded dedup anchors.
          // The high-water mark and event commit atomically, so the rest cannot replay.
          if (scan.ids.length < 200) scan.ids.push(reply.id);
        }
        scan.before = Math.min(scan.before, replies[0]?.id ?? scan.before);
        scan.page = replies.some(r => r.id <= state.high) ? 0 : scan.page - 1;
        if (scan.page > 0) { await save(state, c.now + 60000, false); return; }
        const first = scan.first;
        const events: NewEvent[] = first ? [{
          meta: meta(target.topic_id, first), ids: [...new Set([...scan.ids, first.id])],
          avatar: scan.count === 1 ? first.avatar : scan.topicAvatar,
          content: topicRepliesContent(target.topic_id, scan.title, scan.count, first),
        }] : [];
        state.avatar ??= scan.topicAvatar;
        state.high = scan.high; state.checked = scan.started; state.quiet = 0; state.scan = undefined;
        await save(state, c.now + interval, true, events);
      }
    }
  }
  try {
    await recordCheck(c, {
      source: target.topic_id ? "topic_reply" : "following_topic",
      topicId: target.topic_id || null,
      stageBefore: target.checking ? "watch_scan" : "idle",
      result: () => ({ stage: checkStage, detail: checkDetail }),
    }, checkTarget);
  } catch (error) {
    const message = error instanceof NotifierError ? error.message : "关注检查未完成，保留进度等待重试";
    await c.save([
      c.sql(`UPDATE watch_targets SET failures=failures+1,error=?,next_check=? WHERE (target_key=? AND epoch=?) AND notifier_id=?`,
        message, Math.max(c.now + backoff(consecutiveFailures + 1), error instanceof NotifierError ? error.retryAt : 0), target.target_key, target.epoch, c.id),
      ...(error instanceof NotifierError && error.block ? [c.sql("UPDATE notifier SET blocked=? WHERE id=?", error.block, c.id)] : []),
    ]);
  }
}

/** Manual refresh ignores routine scheduling, but preserves failed attempts and pagination. */
export async function refreshWatches(c: Context, input: Record<string, unknown> = {}): Promise<WatchRefreshResult> {
  if (Object.keys(input).some(key => key !== "started_at") ||
      (input.started_at !== undefined && (!Number.isSafeInteger(input.started_at) ||
        Number(input.started_at) <= 0 || Number(input.started_at) > c.now)))
    throw new NotifierError("关注刷新参数无效", 0, "", 400);
  const started_at = input.started_at === undefined ? c.now : Number(input.started_at);
  if (started_at < c.now - 30 * 60000)
    throw new NotifierError("本次关注刷新已过期，请重新获取最新数据");
  let s = await c.state();
  const config = await cachedWatchConfig(c.db, c.id);
  if (!s.account_id || !s.binding_id || s.blocked === "pairing" || !config ||
      config.profile_id !== s.binding_id || config.source_account_id !== s.account_id)
    throw new NotifierError("请先验证账号并连接 App，再获取关注最新数据");
  if (!config.capable_recipient_count)
    throw new NotifierError("暂无支持关注提醒的设备，请先同步连接状态");
  if (s.blocked === "credentials" || s.verified_at <= c.now - IDENTITY_MAX_AGE ||
      s.credential_scope !== await credentialScope(c)) {
    try {
      // Preserve the existing credential-change contract: stale personal scan
      // candidates must be discarded before the verified scope can advance.
      await verifyIdentity(c);
      s = await c.state();
    } catch (error) {
      if (error instanceof NotifierError && error.block === "credentials")
        await c.update("UPDATE notifier SET blocked='credentials' WHERE id=?", c.id);
      throw error;
    }
  }
  const control = await c.db.one<{ web_until: number }>("SELECT web_until FROM control WHERE id=1");
  if (control.web_until > c.now)
    throw new NotifierError(accessWaitMessage(false, control.web_until), control.web_until);

  const pending = async () => {
    const targets = await c.db.all<Target>(`SELECT * FROM watch_targets WHERE notifier_id=? ORDER BY target_key`, c.id);
    const remaining: Target[] = [];
    for (const target of targets) {
      if (target.last_checked < started_at || target.checking || !target.state_enc) {
        remaining.push(target);
        continue;
      }
      const state = await open<FollowingState | ReplyState>(c.env, scope(s.account_id, target), target.state_enc, 512 * 1024);
      const checked = "checked" in state ? state.checked : state.boundary;
      // Completing an older page range does not prove the latest head was checked.
      if (checked < started_at) remaining.push(target);
    }
    return { targets, remaining };
  };
  let status = await pending();
  const target = status.remaining.find(target => !target.failures || target.next_check <= c.now);
  if (target) {
    await checkWatchTarget(c, s, config, target, started_at);
    status = await pending();
  }
  const remaining = status.remaining.length;
  const retry_at = remaining && status.remaining.every(target => target.failures && target.next_check > c.now)
    ? Math.min(...status.remaining.map(target => target.next_check)) : 0;
  const failed = status.remaining.find(target => target.failures);
  const following = remaining ? undefined : status.targets.find(target => !target.topic_id);
  const feedState = following?.state_enc
    ? await open<FollowingState>(c.env, scope(s.account_id, following), following.state_enc, 512 * 1024) : undefined;
  const feedWarning = following && (!feedState?.member_feed || feedState.member_feed.observed_at < started_at)
    ? feedState?.member_feed_error || "本次尚未重新获取动态，请等待下次检查或重试" : "";
  return {
    started_at,
    complete: remaining === 0,
    remaining,
    retry_at,
    reason: !status.targets.length ? "没有已启用的关注规则" : !remaining
      ? feedWarning ? `关注检查已完成，成员动态缓存未更新：${feedWarning}` : `已获取 ${status.targets.length} 项关注的最新数据`
      : retry_at
        ? `还有 ${remaining} 项关注等待重试${failed?.error ? `：${failed.error}` : ""}`
        : `已更新 ${status.targets.length - remaining}/${status.targets.length} 项关注，继续获取剩余数据`,
  };
}
