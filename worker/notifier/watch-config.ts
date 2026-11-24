import { MAX_WATCH_TOPICS, type WatchConfig, type WatchMeta, type WatchState, type WatchTarget } from "../../shared/watch-contracts";
import type { Database } from "../db";
import type { Env } from "../types";
import type { FollowingState, ReplyState } from "./watch-scanner";
import type { Context } from "./context";
import { open, randomToken, seal } from "./crypto";
import { relayRequest } from "./http";
import { NotifierError, UUID } from "./model";
import { credentialScope } from "./pairing";

interface Control {
  assistant_id: string; instance_enc: string; published_binding: string; config: string;
  next_sync: number; last_sync: number; error: string;
  explicit_pairing: number; config_owner: string; ownership_committed: number; ownership_revision: number;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

export async function watchInstance(c: Context) {
  let instance = await c.db.one<{ assistant_id: string; instance_enc: string }>("SELECT assistant_id,instance_enc FROM assistant_instance WHERE id=1");
  if (!instance.assistant_id) {
    const id = crypto.randomUUID();
    await c.update("UPDATE assistant_instance SET assistant_id=?,instance_enc=? WHERE id=1", id,
      await seal(c.env, `watch-instance:${id}`, randomToken()));
    instance = await c.db.one<{ assistant_id: string; instance_enc: string }>("SELECT assistant_id,instance_enc FROM assistant_instance WHERE id=1");
  }
  return { id: instance.assistant_id, secret: await open<string>(c.env, `watch-instance:${instance.assistant_id}`, instance.instance_enc) };
}

export function parseWatchConfig(value: unknown, account: number, binding: string): WatchConfig {
  const v = value as WatchConfig | null;
  if (!v || typeof v !== "object" || v.source_account_id !== account || v.profile_id !== binding ||
      !UUID.test(v.assistant_id ?? "") || !natural(v.revision) || !natural(v.source_generation) || !v.source_generation ||
      v.max_topics !== MAX_WATCH_TOPICS || !v.following || typeof v.following.enabled !== "boolean" ||
      !natural(v.following.epoch) || !natural(v.following.enabled_at) ||
      (v.following.enabled && !v.following.epoch) || !Array.isArray(v.topics) || v.topics.length > MAX_WATCH_TOPICS ||
      v.topics.some(t => !t || !natural(t.topic_id) || !t.topic_id || typeof t.enabled !== "boolean" ||
        !natural(t.epoch) || !t.epoch || !natural(t.enabled_at)) ||
      new Set(v.topics.map(t => t.topic_id)).size !== v.topics.length ||
      !natural(v.applied_revision) || v.applied_revision > v.revision ||
      !natural(v.recipient_count) || v.recipient_count > 10 || !natural(v.capable_recipient_count) || v.capable_recipient_count > v.recipient_count ||
      !natural(v.last_seen) || !natural(v.last_checked) || typeof v.runtime_status !== "string") {
    throw new NotifierError("关注配置响应无效，保留原配置并暂停本轮检查");
  }
  return v;
}

export function currentWatch(config: WatchConfig | null, meta: WatchMeta): boolean {
  if (!config || config.profile_id !== meta.profile_id || config.source_generation !== meta.source_generation) return false;
  const rule = meta.watch_kind === "following_topic" ? config.following : config.topics.find(t => t.topic_id === meta.topic_id);
  return Boolean(rule?.enabled && rule.epoch === meta.watch_epoch);
}

export async function cachedWatchConfig(db: Database, accountID = 1): Promise<WatchConfig | null> {
  const row = await db.one<Control>("SELECT * FROM watch_control WHERE id=?", accountID);
  return row?.config ? JSON.parse(row.config) as WatchConfig : null;
}

export async function watchState(db: Database, env: Env, accountID = 1): Promise<WatchState> {
  const row = await db.one<Control>("SELECT * FROM watch_control WHERE id=?", accountID);
  const config = await localWatchConfig(db, accountID);
  const raw = await db.all<WatchTarget & { epoch: number; state_enc: string }>(
    "SELECT target_key,topic_id,epoch,state_enc,last_checked,next_check,checking,error FROM watch_targets WHERE notifier_id=? ORDER BY topic_id", accountID);
  const targets = await Promise.all(raw.map(async ({ epoch, state_enc, ...target }) => {
    if (!state_enc || !config) return target;
    try {
      const purpose = `watch:${config.source_account_id}:${target.target_key}:${epoch}`;
      if (target.topic_id) {
        const state = await open<ReplyState>(env, purpose, state_enc, 512 * 1024);
        target.title = state.title ?? state.scan?.title;
        target.author = state.author;
        target.avatar_url = state.avatar ?? state.scan?.topicAvatar;
      } else {
        const state = await open<FollowingState>(env, purpose, state_enc, 512 * 1024);
        const names = Object.keys(state.scan?.members ?? state.members ?? {});
        target.followed_members = state.followed_members ?? (names.length || state.boundary || state.scan
          ? names.map(username => ({ username })) : undefined);
        target.members_observed_at = state.members_observed_at;
        target.member_feed = state.member_feed;
        target.member_feed_error = state.member_feed_error;
        target.member_count = target.followed_members?.length ?? names.length;
        target.recent_topics = (state.recent ?? []).map(({ id, title, author }) => ({ id, title, author }));
        target.observed_at = state.observed_at ?? 0;
        const pending = state.feed_monitor?.pending ?? [...new Map([
          ...(state.scan?.candidates ?? []), ...(state.incremental?.pending ?? []),
        ].map(topic => [topic.id, topic])).values()];
        if (state.feed_monitor?.scan || target.checking || pending.length)
          target.progress = { kind: "candidates", pending_topics: pending.length };
      }
    } catch {
      target.error ||= "本机检查详情暂时无法读取，请核对加密存储配置";
    }
    return target;
  }));
  const pending = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM watch_cancellations WHERE binding_id=(SELECT binding_id FROM notifier WHERE id=?)", accountID);
  const instance = await db.one<{ assistant_id: string }>("SELECT assistant_id FROM assistant_instance WHERE id=1");
  return { assistant_id: instance.assistant_id, last_sync: row.last_sync, next_sync: row.next_sync,
    error: row.error, config, targets, direct_ready: row.config_owner === "assistant" && Boolean(row.ownership_committed),
    clients: await db.all("SELECT id,label,created_at,last_seen FROM watch_app_clients WHERE revoked_at=0 AND notifier_id=? ORDER BY created_at DESC", accountID),
    pending_cancellations: pending.n };
}

interface SourceStatus {
  profile_id: string; source_account_id: number; assistant_id: string; source_generation: number;
  config_owner: "handoff" | "assistant"; recipient_count: number; capable_recipient_count: number;
  legacy_config?: WatchConfig | null;
}

export async function localWatchConfig(db: Database, accountID = 1): Promise<WatchConfig | null> {
  const config = await cachedWatchConfig(db, accountID);
  if (!config) return null;
  const state = await db.one<{ enabled: number; blocked: string }>("SELECT enabled,blocked FROM notifier WHERE id=?", accountID);
  const targets = await db.all<{ topic_id: number; epoch: number; last_checked: number; state: "baseline" | "checking" | "ready" | "error" }>(
    `SELECT topic_id,epoch,CAST(last_checked/1000 AS INTEGER) AS last_checked,
      CASE WHEN failures>0 THEN 'error' WHEN checking=1 THEN 'checking' WHEN last_checked=0 THEN 'baseline' ELSE 'ready' END AS state FROM watch_targets WHERE notifier_id=?`, accountID);
  return { ...config, applied_revision: config.config_owner === "assistant" ? config.revision : config.applied_revision,
    last_seen: Math.floor(Date.now() / 1000), last_checked: Math.max(0, ...targets.map(t => t.last_checked)), target_status: targets,
    runtime_status: !state.enabled ? "paused" : state.blocked ? "credentials" : !config.capable_recipient_count ? "waiting" : targets.some(t => t.state === "error") ? "error" :
      targets.some(t => t.state !== "ready") ? "scanning" : "ready" };
}

/** Only push identity/capabilities cross the control plane after the one-time import. */
export async function syncWatches(c: Context, force = false): Promise<WatchConfig | null> {
  const s = await c.state();
  const instance = await watchInstance(c);
  let control = await c.db.one<Control>("SELECT * FROM watch_control WHERE id=?", c.id);
  if (!s.binding_id || !s.sender_enc || !s.account_id || ["pairing", "deleting"].includes(s.blocked) ||
      s.credential_scope !== await credentialScope(c)) return null;
  if (!force && control.next_sync > c.now) return localWatchConfig(c.db, c.id);
  await c.update("UPDATE watch_control SET next_sync=? WHERE id=?", c.now + 300000, c.id);
  try {
    const sender = await open<string>(c.env, `sender:${s.binding_id}`, s.sender_enc);
    if (control.published_binding !== s.binding_id || !control.explicit_pairing) {
      const health = (await relayRequest(c, "/v1/health")).data as { watch_direct?: unknown; notifier_explicit_pairing?: unknown } | null;
      if (health?.watch_direct !== 1 || health.notifier_explicit_pairing !== 1) throw new NotifierError("推送服务需先升级直连兼容协议", c.now + 3600000);
      const result = (await relayRequest(c, `/v1/assistants/${instance.id}/accounts`, instance.secret, {
        source_account_id: s.account_id, username: s.username, sender_token: sender, watch_version: 1, pairing_policy: "explicit",
      })).data as { published?: unknown; ready?: unknown; connection_id?: unknown };
      if (result?.published !== true || result.ready !== true || result.connection_id !== s.binding_id)
        throw new NotifierError("助手来源登记尚未完成");
      await c.update("UPDATE watch_control SET config_owner=CASE WHEN published_binding<>? THEN 'central' ELSE config_owner END,ownership_committed=CASE WHEN published_binding<>? THEN 0 ELSE ownership_committed END,published_binding=?,explicit_pairing=1 WHERE id=?", s.binding_id, s.binding_id, s.binding_id, c.id);
      control = await c.db.one<Control>("SELECT * FROM watch_control WHERE id=?", c.id);
    }
    let config = await cachedWatchConfig(c.db, c.id);
    const validate = (value: unknown): SourceStatus => {
      const source = value as SourceStatus | null;
      if (!source || source.profile_id !== s.binding_id || source.source_account_id !== s.account_id ||
          source.assistant_id !== instance.id || !natural(source.source_generation) || !source.source_generation ||
          !["handoff", "assistant"].includes(source.config_owner) || !natural(source.recipient_count) || source.recipient_count > 10 ||
          !natural(source.capable_recipient_count) || source.capable_recipient_count > source.recipient_count)
        throw new NotifierError("推送来源响应不匹配，保留本机规则");
      return source;
    };
    let source: SourceStatus | undefined;
    if (control.config_owner !== "assistant") {
      source = validate((await relayRequest(c, "/v1/watches/ownership", sender, { phase: "prepare" })).data);
      if (!source.legacy_config) throw new NotifierError("关注规则已迁出推送服务，请恢复这台助手的数据库备份");
      const imported = parseWatchConfig(source.legacy_config, s.account_id, s.binding_id);
      if (imported.assistant_id !== instance.id || imported.source_generation !== source.source_generation)
        throw new NotifierError("待迁移规则不属于当前助手");
      config = { ...imported, config_owner: "assistant", applied_revision: imported.revision };
      await c.save([...await watchConfigWrites(c, await cachedWatchConfig(c.db, c.id), config),
        c.sql("UPDATE watch_control SET config_owner='assistant',ownership_committed=0,ownership_revision=? WHERE id=?", imported.revision, c.id)]);
      control = await c.db.one<Control>("SELECT * FROM watch_control WHERE id=?", c.id);
    }
    if (!config) throw new NotifierError("本机关注规则缺失，请恢复助手数据库");
    if (!control.ownership_committed) {
      source = validate((await relayRequest(c, "/v1/watches/ownership", sender, {
        phase: "commit", source_generation: config.source_generation, revision: control.ownership_revision,
      })).data);
      if (source.config_owner !== "assistant") throw new NotifierError("关注规则迁移尚未完成");
    } else source = validate((await relayRequest(c, "/v1/watches/source", sender)).data);
    if (source.config_owner !== "assistant" || source.source_generation !== config.source_generation)
      throw new NotifierError("助手来源已变化，请重新配对关注管理", 0, "pairing");
    config = { ...config, recipient_count: source.recipient_count, capable_recipient_count: source.capable_recipient_count };
    await c.update("UPDATE watch_control SET config=?,ownership_committed=1,last_sync=?,next_sync=?,error='' WHERE id=?",
      JSON.stringify(config), c.now, c.now + 300000, c.id);
    const cancellations = await c.db.all<{ event_id: string }>(
      `SELECT event_id FROM watch_cancellations WHERE (binding_id=?) AND binding_id=(SELECT binding_id FROM notifier WHERE id=?) ORDER BY created_at LIMIT 50`, s.binding_id, c.id);
    if (cancellations.length) {
      const ids = cancellations.map(row => row.event_id);
      const receipt = (await relayRequest(c, "/v1/watch-events/cancel", sender, { event_ids: ids })).data as { cancelled?: unknown };
      const cancelled = receipt.cancelled;
      if (!Array.isArray(cancelled) || cancelled.length !== ids.length || ids.some(id => !cancelled.includes(id)))
        throw new NotifierError("取消提醒的回执无效，后台将继续重试");
      await c.save(ids.map(id => c.sql(`DELETE FROM watch_cancellations WHERE (event_id=? AND binding_id=?) AND binding_id=(SELECT binding_id FROM notifier WHERE id=?)`, id, s.binding_id, c.id)));
      const remaining = await c.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM watch_cancellations WHERE (binding_id=?) AND binding_id=(SELECT binding_id FROM notifier WHERE id=?)`, s.binding_id, c.id);
      if (remaining.n) await c.update("UPDATE watch_control SET next_sync=? WHERE id=?", c.now + 60000, c.id);
    }
    return localWatchConfig(c.db, c.id);
  } catch (e) {
    await c.save([c.sql("UPDATE watch_control SET next_sync=?,error=? WHERE id=?",
      Math.max(c.now + 60000, e instanceof NotifierError ? e.retryAt : 0),
      e instanceof NotifierError ? e.message : "推送连接检查未完成，本机规则已保留", c.id),
      ...(e instanceof NotifierError && e.block === "pairing" ? [
        c.sql("UPDATE notifier SET blocked='pairing' WHERE id=?", c.id),
        c.sql(`UPDATE watch_app_clients SET revoked_at=? WHERE (revoked_at=0) AND notifier_id=?`, c.now, c.id),
      ] : [])]);
    throw e;
  }
}

export async function watchConfigWrites(c: Context, previous: WatchConfig | null, config: WatchConfig) {
  const writes: D1PreparedStatement[] = [];
  if (previous && (previous.profile_id !== config.profile_id || previous.source_generation !== config.source_generation)) {
    writes.push(c.sql(`DELETE FROM watch_targets WHERE notifier_id=?`, c.id), c.sql(`UPDATE watch_app_clients SET revoked_at=? WHERE (revoked_at=0) AND notifier_id=?`, c.now, c.id), c.sql("DELETE FROM watch_app_invitation WHERE id=?", c.id));
  }
  const targets = [
    ...(config.following.enabled ? [{ key: "following", topic: 0, ...config.following }] : []),
    ...config.topics.filter(t => t.enabled).map(t => ({ key: `topic:${t.topic_id}`, topic: t.topic_id, ...t })),
  ];
  writes.push(c.sql(`DELETE FROM watch_targets WHERE (target_key NOT IN (${targets.map(() => "?").join(",") || "''"})) AND notifier_id=?`, ...targets.map(t => t.key), c.id));
  for (const t of targets) writes.push(c.sql(`INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at,notifier_id)
    VALUES(?,?,?,?,?) ON CONFLICT(notifier_id,target_key) DO UPDATE SET epoch=excluded.epoch,enabled_at=excluded.enabled_at,
    state_enc='',next_check=0,last_checked=0,failures=0,checking=0,error='' WHERE epoch<>excluded.epoch`,
    t.key, t.topic, t.epoch, t.enabled_at * 1000, c.id));
  const pending = await c.db.all<{ event_id: string; watch_meta: string; binding_id: string }>(
    `SELECT event_id,watch_meta,binding_id FROM notification_outbox WHERE ((type='watch_update' OR (type='test' AND watch_meta<>'')) AND status IN ('pending','submitted')) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.id,
  );
  for (const row of pending) if (!currentWatch(config, JSON.parse(row.watch_meta) as WatchMeta)) writes.push(
    c.sql(`UPDATE notification_outbox SET status='cancelled',detail='关注规则已关闭或来源已更换',updated_at=? WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.now, row.event_id, c.id),
    c.sql("INSERT OR IGNORE INTO watch_cancellations(event_id,binding_id,created_at) VALUES(?,?,?)", row.event_id, row.binding_id, c.now),
  );
  writes.push(c.sql("UPDATE watch_control SET config=?,last_sync=?,next_sync=?,error='' WHERE id=?",
    JSON.stringify(config), c.now, c.now + 300000, c.id));
  return writes;
}
