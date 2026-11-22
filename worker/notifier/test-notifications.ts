import { digest } from "../parsers";
import type { Context } from "./context";
import { seal, storageReady } from "./crypto";
import { upstream } from "./http";
import {
  IDENTITY_MAX_AGE,
  NotifierError,
  QUEUE_LIMIT,
  isClassifiedKind,
  isWatchTestKind,
  scopeContent,
  type ClassifiedNotificationKind,
  type Content,
  type Notifier,
} from "./model";
import { credentialScope, probeIdentity, verifyIdentity } from "./pairing";
import { notificationPage, presentation } from "./presentation";
import { cachedSample, sampleStatements } from "./sample-cache";
import { watchTestSample } from "./watch-test-notifications";

const SAMPLE_LIMIT = 100;
const PAGE_LIMIT = 10;
const samples: Record<ClassifiedNotificationKind, Content> = {
  reply: {
    title: "测试用户 回复了《Cloudflare 助手的回复测试》",
    body: "这是一条 Cloudflare 助手加密测试，用于确认回复通知与分类跳转。",
  },
  mention: {
    title: "测试用户 提到了你",
    body: "这是一条 Cloudflare 助手加密测试，用于确认提及通知与分类跳转。",
  },
  thanks_topic: {
    title: "测试用户 感谢了你的主题",
    body: "《Cloudflare 助手的主题感谢测试》",
  },
  thanks_reply: {
    title: "测试用户 感谢了你的回复",
    body: "Cloudflare 助手的回复感谢测试",
  },
  favorite: {
    title: "测试用户 收藏了你的主题",
    body: "《Cloudflare 助手的收藏测试》",
  },
};

/** A bounded sample search, independent of unread scans and dedup. */
async function findSample(
  c: Context,
  s: Notifier,
  kind: ClassifiedNotificationKind,
  deadline: number,
) {
  let count = 0;
  let previous = Number.MAX_SAFE_INTEGER;
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    // Leave room for the existing 12-second request timeout and the lease fence.
    if (c.now + 12000 > deadline)
      throw new NotifierError("真实样本读取超时，未发送测试；请稍后重试");
    const items = notificationPage(
      await upstream(c, `/api/v2/notifications?p=${page}`),
      s.account_id,
    );
    if (!items.length) return { sample: null, count };
    if (items[0].id >= previous)
      throw new NotifierError("通知分页发生变化，未发送测试；请重新读取");
    const selected = items.slice(0, SAMPLE_LIMIT - count);
    const cache = await sampleStatements(c, s, selected);
    if (cache.length) await c.save(cache);
    for (const n of selected) {
      count++;
      const content = presentation(n, s.username);
      if (content.kind === kind)
        return { sample: { id: n.id, ...content }, count };
    }
    if (count >= SAMPLE_LIMIT) return { sample: null, count };
    previous = items.at(-1)!.id;
  }
  // An incomplete search is not evidence that a matching real sample is absent.
  throw new NotifierError("尚未读完最近 100 条通知，未发送测试；请稍后重试");
}

export async function queueTestNotification(c: Context, input: unknown) {
  const kind = input === undefined ? "reply" : input;
  if (!isClassifiedKind(kind) && !isWatchTestKind(kind))
    throw new NotifierError("测试类型无效", 0, "", 400);
  let s = await c.state();
  if (!s.enabled || !s.binding_id || s.blocked)
    throw new NotifierError("请先启用已配对的真实通知");
  if (!storageReady(c.env))
    throw new NotifierError("请先配置 NOTIFIER_KEY", 0, "", 503);
  const recent = await c.db.one<{ count: number; last: number }>(
    `SELECT COUNT(*) AS count,MAX(CASE WHEN type='test' THEN created_at ELSE 0 END) AS last FROM notification_outbox WHERE (status IN ('pending','submitted') OR created_at>?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
    c.now - 60000, c.id,
  );
  if (recent.count >= QUEUE_LIMIT || recent.last > c.now - 60000)
    throw new NotifierError("测试频率或队列达到上限，请稍后再试");
  const deadline = c.now + 60000;
  try {
    if (
      !s.account_id ||
      s.credential_scope !== (await credentialScope(c))
    ) {
      await verifyIdentity(c);
      s = await c.state();
    }
    if (isWatchTestKind(kind)) {
      if (kind !== "following_topic" && s.verified_at <= c.now - IDENTITY_MAX_AGE) {
        const { member, avatar } = await probeIdentity(c);
        // Renew an unchanged identity without replacing unread/scan snapshots.
        await c.update("UPDATE notifier SET username=?,avatar_url=COALESCE(NULLIF(?,''),avatar_url),verified_at=? WHERE id=?",
          member.username, avatar, c.now, c.id);
        s = await c.state();
      }
      const sample = await watchTestSample(c, s, kind);
      const id = await digest(`v2echo-cf:test:${crypto.randomUUID()}`);
      const created = c.now;
      await c.update(`INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,
        avatar_url,content_enc,created_at,expires_at,updated_at,watch_meta) VALUES(?,?,NULL,?,'test',?,0,?,?,?,?,?,?)`,
        id, s.account_id, s.binding_id, kind, sample.avatar,
        await seal(c.env, scopeContent(s.account_id, id), sample.content), created, created + 900000, created,
        JSON.stringify(sample.meta));
      return { event_id: id, sample_source: "real", sample_origin: sample.origin,
        source_notification_id: null, source_topic_id: sample.meta.topic_id,
        source_reply_id: sample.meta.reply_id ?? null, searched_count: 0,
        reason: `已使用主题 #${sample.meta.topic_id} 的真实样本创建加密测试，不改变未读数或关注检查进度` };
    }
    let sample = await cachedSample(c, s, kind);
    const origin = sample ? "cache" : "live";
    let count = 0;
    if (!sample) {
      if (s.verified_at <= c.now - IDENTITY_MAX_AGE) {
        await verifyIdentity(c);
        s = await c.state();
      }
      ({ sample, count } = await findSample(c, s, kind, deadline));
    }
    const content = sample ?? samples[kind];
    const id = await digest(`v2echo-cf:test:${crypto.randomUUID()}`);
    const created = c.now;
    // The source ID stays local: the relay still sends a test without an ID/badge.
    await c.update(
      `INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,avatar_url,content_enc,created_at,expires_at,updated_at) VALUES(?,?,?,?,'test',?,0,?,?,?,?,?)`,
      id,
      s.account_id,
      sample?.id ?? null,
      s.binding_id,
      kind,
      sample?.avatar ?? "",
      await seal(c.env, scopeContent(s.account_id, sample?.id ?? id), {
        title: content.title,
        body: content.body,
      }),
      created,
      created + 900000,
      created,
    );
    return {
      event_id: id,
      sample_source: sample ? "real" : "synthetic",
      sample_origin: origin,
      source_notification_id: sample?.id ?? null,
      searched_count: count,
      reason: sample
        ? `已使用${origin === "cache" ? "缓存" : "实时读取"}的真实通知 #${sample.id} 按当前文案生成加密测试，不改变真实未读数`
        : `最近 ${count} 条通知中没有匹配类型，已使用合成示例创建加密测试，不改变真实未读数`,
    };
  } catch (error) {
    if (error instanceof NotifierError && error.block === "credentials")
      await c.update("UPDATE notifier SET blocked='credentials' WHERE id=?", c.id);
    throw error;
  }
}
