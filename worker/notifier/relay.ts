import type { Context } from "./context";
import { encryptContent, open, validateRecipients } from "./crypto";
import { relayRequest } from "./http";
import { senderAvatar } from "./avatar";
import { cachedWatchConfig, currentWatch } from "./watch-config";
import type { WatchMeta } from "../../shared/watch-contracts";
import {
  NotifierError,
  HOME_REFRESH_INTERVAL,
  isClassifiedKind,
  isWatchTestKind,
  scopeContent,
  type Content,
  type Notifier,
  type Outbox,
} from "./model";

const wait = (seconds: unknown) =>
  typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.min(172800, Math.max(0, seconds)) * 1000
    : 0;
export const backoff = (attempt: number) =>
  Math.min(3600000, 30000 * 2 ** Math.min(8, Math.max(0, attempt - 1)));
const jitter = () => (crypto.getRandomValues(new Uint8Array(1))[0] % 16) * 1000;
const isWatchEvent = (row: Outbox) => row.type === "watch_update" || row.type === "test" && isWatchTestKind(row.kind);
async function capabilities(c: Context) {
  const health = (await relayRequest(c, "/v1/health")).data as Record<
    string,
    unknown
  >;
  const minimums = {
    notification_details: 1,
    notification_body_encryption: 2,
    notification_routing: 1,
    notification_test_samples: 1,
    max_events: 1,
    max_receipts: 1,
    max_sync_bytes: 1024,
    sync_interval: 1,
  };
  if (
    !health ||
    Object.entries(minimums).some(
      ([key, min]) =>
        !Number.isSafeInteger(health[key]) || Number(health[key]) < min,
    )
  )
    throw new NotifierError(
      "推送服务尚未声明加密通知与分类跳转能力，等待服务升级",
      c.now + 180000,
    );
  return {
    watches: health.watch_notifications === 1,
    watchComments: health.watch_comment_details === 1,
    watchTests: health.watch_test_notifications === 1,
    testAvatars:
      Number.isSafeInteger(health.notification_test_avatars) &&
      Number(health.notification_test_avatars) >= 1,
    events: Math.min(20, Number(health.max_events)),
    receipts: Math.min(50, Number(health.max_receipts)),
    bytes: Math.min(65536, Number(health.max_sync_bytes)),
    interval: Math.max(30000, wait(health.sync_interval)),
  };
}
async function prepare(c: Context, s: Notifier, row: Outbox, sender: string) {
  const recipients = await validateRecipients(
    (await relayRequest(c, isWatchEvent(row) ? "/v1/recipient-keys?purpose=watch" : "/v1/recipient-keys", sender)).data,
    s.account_id,
  );
  if (isWatchEvent(row) && !recipients.length)
    throw new NotifierError("没有支持关注提醒的接收设备，保留事件等待设备升级", c.now + 300000);
  const pins = await c.db.all<{ device_id: string; public_key: string }>(
    "SELECT * FROM notification_key_pins",
  );
  for (const r of recipients) {
    const old = pins.find((p) => p.device_id === r.device_id);
    if (old && old.public_key !== r.public_key)
      throw new NotifierError(
        "已知设备的公钥发生变化，停止准备密文；请重新注册接收设备",
        c.now + 180000,
      );
  }
  if (
    pins.length +
      recipients.filter((r) => !pins.some((p) => p.device_id === r.device_id))
        .length >
    100
  )
    throw new NotifierError("已达设备公钥固定记录上限", c.now + 3600000);
  if (recipients.length)
    await c.save(
      recipients.map((r) =>
        c.sql(
          "INSERT OR IGNORE INTO notification_key_pins(device_id,public_key) VALUES(?,?)",
          r.device_id,
          r.public_key,
        ),
      ),
    );
  const content = await open<Content>(
    c.env,
    scopeContent(s.account_id, row.notification_id ?? row.event_id),
    row.content_enc,
  );
  const avatar =
    row.avatar_url ||
    (row.type === "notification" || row.notification_id !== null
      ? await senderAvatar(c, content.title)
      : "");
  const envelopes = [];
  for (const r of recipients)
    envelopes.push(
      await encryptContent(row.event_id, s.account_id, content, r),
    );
  const wire = {
    event_id: row.event_id,
    type: row.type,
    source_account_id: s.account_id,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    encrypted_bodies: envelopes,
    ...(row.type === "watch_update" ? { ...JSON.parse(row.watch_meta) as WatchMeta, ...(avatar ? { avatar_url: avatar } : {}) } : row.type === "test"
      ? {
          test_kind: row.kind,
          body_encryption: 2,
          ...(isWatchTestKind(row.kind) ? { ...JSON.parse(row.watch_meta) as WatchMeta, avatar_url: avatar }
            : row.notification_id !== null ? { avatar_url: avatar } : {}),
        }
      : {
          notification_id: row.notification_id,
          notification_kind: row.kind,
          details_version: 3,
          unread_count: row.unread,
          ...(avatar ? { avatar_url: avatar } : {}),
        }),
  };
  // Immutable projection is committed before any sync attempt. Never regenerate on retry.
  const writes = [
    c.sql(
      `UPDATE notification_outbox SET wire=?,avatar_url=?,updated_at=? WHERE (event_id=? AND wire IS NULL AND attempts=0 AND status='pending') AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
      JSON.stringify(wire),
      avatar,
      c.now,
      row.event_id, c.id,
    ),
  ];
  if (!row.avatar_url && avatar && row.notification_id !== null) {
    writes.push(
      c.sql(
        `UPDATE notification_samples SET avatar_url=? WHERE (account_id=? AND notification_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        avatar,
        s.account_id,
        row.notification_id, c.id,
      ),
      c.sql(
        `UPDATE notification_history SET avatar_url=? WHERE (account_id=? AND notification_id=? AND avatar_url='') AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        avatar,
        s.account_id,
        row.notification_id, c.id,
      ),
    );
  }
  await c.save(writes);
}

interface Receipt {
  event_id: string;
  status: string;
  reason?: string;
  retry_after_seconds?: number;
  deliveries?: { device_id?: string; status?: string; reason?: string }[];
}
function receipts(value: unknown, rows: Outbox[]) {
  const data = value as { receipts?: Receipt[]; retry_after_seconds?: number };
  if (
    !data ||
    !Array.isArray(data.receipts) ||
    data.receipts.length !== rows.length
  )
    throw new NotifierError("批量回执数量不匹配，保留原事件重试");
  const seen = new Set<string>();
  for (const r of data.receipts) {
    const row = rows.find((x) => x.event_id === r?.event_id);
    if (
      !row ||
      seen.has(r.event_id) ||
      ![
        "pending",
        "apns_accepted",
        "rejected",
        "expired",
        ...(row.status === "submitted" ? ["not_found"] : []),
      ].includes(r.status)
    )
      throw new NotifierError("批量回执 ID 或状态不匹配，保留原事件重试");
    seen.add(r.event_id);
  }
  return { receipts: data.receipts, retry: wait(data.retry_after_seconds) };
}
function safeDeliveries(value: Receipt["deliveries"]) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 10)
    .filter(
      (x) =>
        x &&
        ["pending", "apns_accepted", "rejected", "expired"].includes(
          x.status ?? "",
        ),
    )
    .map((x) => ({ status: x.status }));
}
const reason = (value?: string) =>
  [
    "before_binding",
    "no_active_devices",
    "one_or_more_deliveries_rejected",
    "connection_revoked",
    "event_expired",
    "device_revoked",
    "invalid_device_token",
  ].includes(value ?? "")
    ? value!
    : "";

function classifiedWire(row: Outbox): boolean {
  if (!isClassifiedKind(row.kind)) return false;
  if (!row.wire) return row.attempts === 0;
  try {
    const wire = JSON.parse(row.wire);
    return (
      wire?.type === "notification" &&
      wire.event_id === row.event_id &&
      wire.notification_id === row.notification_id &&
      wire.notification_kind === row.kind
    );
  } catch {
    return false;
  }
}

/** Pending means remote receipt is confirmed: future rounds query IDs, never resend. */
export async function relayStep(c: Context, testEventID = "") {
  const s = await c.state();
  if (!s.enabled || s.blocked || !s.sender_enc || s.relay_until > c.now) return;
  const fresh =
    s.scan_stage === "idle" &&
    !s.scan_error &&
    s.last_scan > c.now - 2 * HOME_REFRESH_INTERVAL &&
    s.unread > 0;
  const candidates = await c.db.all<Outbox>(
    `SELECT * FROM notification_outbox WHERE (binding_id=? AND status IN ('pending','submitted') AND next_at<=? AND expires_at>? AND (status='submitted' OR attempts>0 OR type IN ('test','watch_update') OR ?=1) AND (?='' OR (type='test' AND event_id=?))) AND account_id=(SELECT account_id FROM notifier WHERE id=?) ORDER BY type='watch_update',created_at,event_id LIMIT 70`,
    s.binding_id,
    c.now,
    c.now,
    Number(fresh),
    testEventID,
    testEventID, c.id,
  );
  const held = candidates.filter(
    (row) =>
      row.type === "notification" &&
      row.status === "pending" &&
      !classifiedWire(row),
  );
  if (held.length)
    await c.save(
      held.map((row) =>
        c.sql(
          `UPDATE notification_outbox SET status='unclassified',detail=?,updated_at=? WHERE (event_id=? AND status='pending') AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
          row.attempts > 0
            ? "推送分类缺失或不一致，已停止重试；此前请求可能已送达，保留原请求且不重新生成"
            : "推送分类缺失或不一致，暂不发送；等待最新未读扫描重新确认",
          c.now,
          row.event_id, c.id,
        ),
      ),
    );
  let due = candidates.filter((row) => !held.includes(row));
  const config = await cachedWatchConfig(c.db, c.id);
  const cancelled = due.filter(row => isWatchEvent(row) && row.status === "pending" && row.attempts === 0 &&
    !currentWatch(config, JSON.parse(row.watch_meta) as WatchMeta));
  if (cancelled.length) await c.save(cancelled.map(row => c.sql(
    `UPDATE notification_outbox SET status='cancelled',detail='关注规则已关闭或来源已更换',updated_at=? WHERE (event_id=? AND attempts=0) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.now, row.event_id, c.id,
  )));
  due = due.filter(row => !cancelled.includes(row));
  if (!due.length) return;
  const sender = await open<string>(
    c.env,
    `sender:${s.binding_id}`,
    s.sender_enc,
  );
  let caps = {
    events: 20,
    receipts: 50,
    bytes: 65536,
    interval: 30000,
    testAvatars: false,
    watches: false,
    watchComments: false,
    watchTests: false,
  };
  const needsContent = due.some((r) => r.status === "pending");
  if (needsContent) caps = await capabilities(c);
  if (!caps.watches) {
    const waiting = due.filter(row => isWatchEvent(row) && row.status === "pending");
    if (waiting.length) await c.save(waiting.map(row => c.sql(
      `UPDATE notification_outbox SET next_at=?,detail='等待推送服务支持关注提醒' WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.now + 300000, row.event_id, c.id,
    )));
    due = due.filter(row => !waiting.includes(row));
    if (!due.length) return;
  }
  if (!caps.watchTests) {
    const waiting = due.filter(row => row.type === "test" && isWatchTestKind(row.kind) && row.status === "pending");
    if (waiting.length) await c.save(waiting.map(row => c.sql(
      `UPDATE notification_outbox SET next_at=?,detail='等待推送服务支持关注测试通知，请先更新推送服务' WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
      c.now + 300000, row.event_id, c.id,
    )));
    due = due.filter(row => !waiting.includes(row));
    if (!due.length) return;
  }
  if (!caps.testAvatars) {
    const waiting = due.filter(
      (row) =>
        row.type === "test" &&
        row.notification_id !== null &&
        row.status === "pending",
    );
    if (waiting.length)
      await c.save(
        waiting.map((row) =>
          c.sql(
            `UPDATE notification_outbox SET next_at=?,updated_at=?,detail='等待推送服务支持真实测试头像，请先更新推送服务' WHERE (event_id=? AND status='pending') AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
            c.now + 180000,
            c.now,
            row.event_id, c.id,
          ),
        ),
      );
    due = due.filter((row) => !waiting.includes(row));
    if (!due.length) return;
  }
  if (!caps.watchComments) {
    const waiting = due.filter(row => isWatchEvent(row) && row.status === "pending" && !row.wire &&
      (JSON.parse(row.watch_meta) as WatchMeta).watch_kind === "topic_reply");
    if (waiting.length) await c.save(waiting.map(row => c.sql(
      `UPDATE notification_outbox SET next_at=?,detail='等待推送服务支持评论内容与头像' WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.now + 300000, row.event_id, c.id,
    )));
    due = due.filter(row => !waiting.includes(row));
    if (!due.length) return;
  }
  const unprepared = due.find(
    (r) => r.status === "pending" && !r.wire && r.attempts === 0,
  );
  if (unprepared) {
    await prepare(c, s, unprepared, sender);
    // Keep encryption work bounded to one event per invocation. Already-prepared
    // events can still be sent in this invocation without another key lookup.
    unprepared.wire = (
      await c.db.one<{ wire: string }>(
        `SELECT wire FROM notification_outbox WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        unprepared.event_id, c.id,
      )
    ).wire;
  }
  const selected: Outbox[] = [],
    events: unknown[] = [],
    ids: string[] = [];
  for (const row of due) {
    if (row.status === "submitted") {
      if (ids.length >= caps.receipts) continue;
      ids.push(row.event_id);
    } else {
      if (!row.wire || events.length >= caps.events) continue;
      events.push(JSON.parse(row.wire));
    }
    if (
      new TextEncoder().encode(JSON.stringify({ events, receipts: ids }))
        .length > caps.bytes
    ) {
      if (row.status === "submitted") ids.pop();
      else events.pop();
      continue;
    }
    selected.push(row);
  }
  if (!selected.length)
    throw new NotifierError("没有可安全发送的批次，保留原事件", c.now + 180000);
  const next =
    c.now + Math.max(caps.interval, backoff(s.relay_failures + 1)) + jitter();
  await c.save([
    c.sql(
      "UPDATE notifier SET relay_until=?,relay_failures=relay_failures+1 WHERE id=?",
      next, c.id,
    ),
    ...selected.map((r) =>
      c.sql(
        `UPDATE notification_outbox SET attempts=attempts+?,receipt_attempts=receipt_attempts+?,next_at=?,updated_at=?,detail=? WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        Number(r.status !== "submitted"),
        Number(r.status === "submitted"),
        next,
        c.now,
        r.status === "submitted"
          ? "正在查询回执"
          : "已开始发送；未确认结果时会重试同一密文",
        r.event_id, c.id,
      ),
    ),
  ]);
  let response: Awaited<ReturnType<typeof relayRequest>>;
  try {
    response = await relayRequest(c, "/v1/sync", sender, {
      events,
      receipts: ids,
    });
  } catch (error) {
    if (
      error instanceof NotifierError &&
      error.upstreamStatus >= 400 &&
      error.upstreamStatus < 500 &&
      ![400, 401, 403, 404, 413, 429].includes(error.upstreamStatus)
    ) {
      await c.save(
        selected.map((r) =>
          c.sql(
            `UPDATE notification_outbox SET status='rejected',detail=?,updated_at=? WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
            `推送服务拒绝事件（HTTP ${error.upstreamStatus}）`,
            c.now,
            r.event_id, c.id,
          ),
        ),
      );
    }
    throw error;
  }
  const result = receipts(response.data, selected);
  const nextSync = Math.max(
    response.retryAt,
    c.now + Math.max(caps.interval, result.retry) + jitter(),
  );
  const writes = [
    c.sql(
      "UPDATE notifier SET relay_until=?,relay_failures=0,relay_error='',last_sync=? WHERE id=?",
      nextSync,
      c.now, c.id,
    ),
  ];
  for (const r of result.receipts) {
    const row = selected.find((x) => x.event_id === r.event_id)!;
    const status = ["pending", "not_found"].includes(r.status)
      ? "submitted"
      : r.status;
    const detail =
      r.status === "apns_accepted"
        ? "APNs 已接收；设备是否收到仍未知"
        : r.status === "pending"
          ? "服务端已收件，等待查询投递结果"
          : r.status === "not_found"
            ? "已收件事件的回执暂未找到，继续查询"
            : r.status === "expired"
              ? "服务端事件已过期"
              : `推送服务拒绝事件${reason(r.reason) ? `（${reason(r.reason)}）` : ""}`;
    const dueAt = Math.max(
      nextSync,
      c.now + wait(r.retry_after_seconds),
      r.status === "not_found" ? c.now + backoff(row.receipt_attempts + 1) : 0,
    );
    writes.push(
      c.sql(
        `UPDATE notification_outbox SET status=?,detail=?,deliveries=?,next_at=?,updated_at=? WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        status,
        detail,
        JSON.stringify(safeDeliveries(r.deliveries)),
        dueAt,
        c.now,
        r.event_id, c.id,
      ),
    );
  }
  await c.save(writes);
}
