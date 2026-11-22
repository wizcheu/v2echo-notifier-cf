import { digest, parseHome } from "../parsers";
import type { Context } from "./context";
import { seal } from "./crypto";
import { upstream } from "./http";
import {
  DEDUP_LIMIT,
  IDENTITY_MAX_AGE,
  NotifierError,
  QUEUE_LIMIT,
  HOME_REFRESH_INTERVAL,
  SCAN_LIMIT,
  isClassifiedKind,
  scopeContent,
  type Candidate,
  type Notifier,
} from "./model";
import { notificationPage, presentation } from "./presentation";
import { credentialScope, verifyIdentity } from "./pairing";
import { historyStatement } from "./history";
import { sampleStatements } from "./sample-cache";

async function home(c: Context, s: Notifier) {
  let snapshot: Awaited<ReturnType<typeof parseHome>>;
  try {
    snapshot = await parseHome(
      (await upstream(c, "/")) as string,
      s.username,
      s.account_id,
    );
  } catch (e) {
    if (e instanceof NotifierError) throw e;
    throw new NotifierError(
      "首页身份或未读数校验失败，请检查 Cookie",
      0,
      "credentials",
    );
  }
  const { unread, avatar_url: avatar } = snapshot;
  if (unread < 0 || unread > 1000000)
    throw new NotifierError("首页未读数超出有效范围");
  const reset = s.scan_stage === "idle" || unread !== s.unread;
  const writes = [
    c.sql(
      "UPDATE notifier SET unread=?,avatar_url=COALESCE(NULLIF(?,''),avatar_url),observed_at=?,scan_error='',scan_failures=0 WHERE id=?",
      unread,
      avatar,
      c.now, c.id,
    ),
  ];
  if (reset) {
    writes.push(c.sql(`DELETE FROM notification_candidates WHERE notifier_id=?`, c.id));
    writes.push(
      c.sql(
        `UPDATE notifier SET scan_id=?,scan_stage=?,scan_page=1,scan_collected=0,scan_head='[]',scan_min=0,next_scan=? WHERE id=?`,
        crypto.randomUUID(),
        unread ? "page" : "idle",
        c.now + s.scan_interval_minutes * 60000, c.id,
      ),
    );
  }
  if (!unread) {
    writes.push(
      c.sql(
        `UPDATE notification_outbox SET status='cancelled',detail='最新首页已无未读，取消尚未尝试的通知',content_enc='',wire=NULL,updated_at=? WHERE (type='notification' AND status IN ('pending','unclassified') AND attempts=0) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        c.now, c.id,
      ),
    );
    writes.push(c.sql("UPDATE notifier SET last_scan=? WHERE id=?", c.now, c.id));
  }
  await c.save(writes);
  if (unread > SCAN_LIMIT)
    throw new NotifierError(
      `未读数超过单轮 ${SCAN_LIMIT} 条上限；保留状态，请先在 V2EX 处理部分未读`,
      c.now + 3600000,
    );
  return c.state();
}
async function restart(c: Context, reason: string): Promise<never> {
  await c.save([
    c.sql(`DELETE FROM notification_candidates WHERE notifier_id=?`, c.id),
    c.sql(
      "UPDATE notifier SET scan_stage='idle',scan_id='',scan_collected=0,next_scan=0 WHERE id=?", c.id,
    ),
  ]);
  throw new NotifierError(reason);
}
async function commit(c: Context, s: Notifier) {
  if (c.now <= s.paired_at + 1000) return;
  const [rows, remaining, capacity] = await Promise.all([
    c.db.all<Candidate>(
      `SELECT * FROM notification_candidates WHERE (scan_id=? AND queued=0) AND notifier_id=? ORDER BY notification_id DESC LIMIT 20`,
      s.scan_id, c.id,
    ),
    c.db.one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM notification_candidates WHERE (scan_id=? AND queued=0) AND notifier_id=?`,
      s.scan_id, c.id,
    ),
    c.db.one<{ dedup: number; queued: number }>(
      "SELECT (SELECT COUNT(*) FROM notification_dedup WHERE account_id=?) AS dedup,(SELECT COUNT(*) FROM notification_outbox WHERE account_id=? AND status IN ('pending','submitted')) AS queued", s.account_id, s.account_id,
    ),
  ]);
  const classifiedCount = rows.filter((row) =>
    isClassifiedKind(row.kind),
  ).length;
  if (
    capacity.dedup + classifiedCount > DEDUP_LIMIT ||
    capacity.queued + classifiedCount > QUEUE_LIMIT
  )
    throw new NotifierError(
      "去重库或待发送队列已到容量上限，保留扫描进度",
      c.now + 3600000,
    );
  const writes: D1PreparedStatement[] = [];
  const created = c.now;
  for (const row of rows) {
    const id = await digest(`v2ex:${s.account_id}:${row.notification_id}`);
    const classified = isClassifiedKind(row.kind);
    const detail = classified
      ? ""
      : "通知类型未识别，暂不推送；后续未读扫描确认类型后再发送";
    // Only a fresh unread scan may release a classification hold or recover an
    // old pairing's never-attempted event. Attempted wires remain immutable.
    if (classified)
      writes.push(
        c.sql(
          `UPDATE notification_outbox SET binding_id=?,kind=?,unread=?,avatar_url=?,content_enc=?,wire=NULL,status='pending',next_at=0,created_at=?,expires_at=?,updated_at=?,detail='最新未读扫描已确认类型，等待首次发送',deliveries='[]'
        WHERE (event_id=? AND account_id=? AND notification_id=? AND type='notification'
          AND attempts=0 AND receipt_attempts=0
          AND ((binding_id<>? AND status IN ('cancelled','expired')) OR status='unclassified'
            OR (kind='other' AND status IN ('pending','cancelled','expired')))) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
          s.binding_id,
          row.kind,
          s.unread,
          row.avatar_url,
          row.content_enc,
          created,
          created + 86400000,
          created,
          id,
          s.account_id,
          row.notification_id,
          s.binding_id, c.id,
        ),
      );
    else
      writes.push(
        c.sql(
          `UPDATE notification_outbox SET kind='other',status='unclassified',wire=NULL,content_enc=?,updated_at=?,detail=?
          WHERE (event_id=? AND type='notification' AND status='pending' AND attempts=0 AND receipt_attempts=0) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
          row.content_enc,
          c.now,
          detail,
          id, c.id,
        ),
      );
    writes.push(
      c.sql(
        `INSERT OR IGNORE INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,avatar_url,content_enc,created_at,expires_at,updated_at,status,detail)
      SELECT ?,?,?,?,'notification',?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM notification_dedup WHERE account_id=? AND notification_id=?)`,
        id,
        s.account_id,
        row.notification_id,
        s.binding_id,
        row.kind,
        s.unread,
        row.avatar_url,
        row.content_enc,
        created,
        created + 86400000,
        created,
        classified ? "pending" : "unclassified",
        detail,
        s.account_id,
        row.notification_id,
      ),
    );
    // Unclassified observations have never been sent; do not permanently dedup
    // them if their local preview expires before the parser can identify them.
    if (classified)
      writes.push(
        c.sql(
          "INSERT OR IGNORE INTO notification_dedup(account_id,notification_id,event_id) VALUES(?,?,?)",
          s.account_id,
          row.notification_id,
          id,
        ),
      );
    writes.push(
      c.sql(
        `UPDATE notification_candidates SET queued=1 WHERE (scan_id=? AND notification_id=?) AND notifier_id=?`,
        s.scan_id,
        row.notification_id, c.id,
      ),
    );
  }
  if (remaining.count <= rows.length) {
    writes.push(
      c.sql(
        `UPDATE notification_outbox SET status='cancelled',detail='已不在最新未读候选范围，取消未尝试事件',wire=NULL,content_enc='',updated_at=? WHERE (type='notification' AND status IN ('pending','unclassified') AND attempts=0 AND account_id=? AND notification_id NOT IN(SELECT notification_id FROM notification_candidates WHERE scan_id=?)) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
        c.now,
        s.account_id,
        s.scan_id, c.id,
      ),
    );
    writes.push(
      c.sql(
        "UPDATE notifier SET scan_stage='idle',last_scan=?,next_scan=?,scan_error='',scan_failures=0,scan_until=0 WHERE id=?",
        c.now,
        c.now + s.scan_interval_minutes * 60000, c.id,
      ),
    );
  }
  await c.save(writes);
}

/** One persisted API page per invocation; a moving first page never advances the queue. */
export async function scanStep(c: Context) {
  let s = await c.state();
  if (!s.enabled || s.blocked || !s.binding_id || s.scan_until > c.now) return;
  if (
    s.credential_scope !== (await credentialScope(c)) ||
    s.verified_at + IDENTITY_MAX_AGE <= c.now
  ) {
    await verifyIdentity(c);
    return;
  }
  if (s.scan_stage === "idle" && s.next_scan > c.now) return;
  if (s.scan_stage === "idle" || s.observed_at + HOME_REFRESH_INTERVAL <= c.now)
    s = await home(c, s);
  if (!s.unread || s.scan_stage === "idle") return;
  if (s.scan_stage === "commit") {
    await commit(c, s);
    return;
  }
  const page = notificationPage(
    await upstream(
      c,
      `/api/v2/notifications?p=${s.scan_stage === "verify" ? 1 : s.scan_page}`,
    ),
    s.account_id,
  );
  const ids = page.map((n) => n.id);
  if (s.scan_stage === "verify") {
    if (JSON.stringify(ids) !== s.scan_head)
      return restart(c, "通知首屏发生变化，重新读取未读范围");
    await c.update("UPDATE notifier SET scan_stage='commit' WHERE id=?", c.id);
    await commit(c, await c.state());
    return;
  }
  if (s.scan_page > 1 && page.length && page[0].id >= s.scan_min)
    return restart(c, "通知分页发生位移，重新读取未读范围");
  const selected = page.slice(0, Math.max(0, s.unread - s.scan_collected));
  const collected = s.scan_collected + selected.length;
  if (collected > SCAN_LIMIT || s.scan_page > 100)
    throw new NotifierError("扫描已到安全上限，保留进度", c.now + 3600000);
  const complete = collected >= s.unread || !page.length;
  const stage = complete ? (s.scan_page > 1 ? "verify" : "commit") : "page";
  const writes = await sampleStatements(c, s, selected);
  for (const n of selected) {
    const p = presentation(n, s.username);
    const encrypted = await seal(c.env, scopeContent(s.account_id, n.id), {
      title: p.title,
      body: p.body,
    });
    writes.push(historyStatement(c, s.account_id, n, p.kind, encrypted, p.avatar));
    writes.push(
      c.sql(
        `INSERT OR IGNORE INTO notification_candidates(scan_id,notification_id,content_enc,kind,avatar_url,notifier_id) VALUES(?,?,?,?,?,?)`,
        s.scan_id,
        n.id,
        encrypted,
        p.kind,
        p.avatar, c.id,
      ),
    );
  }
  writes.push(
    c.sql(
      "UPDATE notifier SET scan_stage=?,scan_collected=?,scan_min=?,scan_page=?,scan_head=?,scan_error='',scan_failures=0,scan_until=0 WHERE id=?",
      stage,
      collected,
      ids.at(-1) ?? s.scan_min,
      s.scan_page + 1,
      s.scan_page === 1 ? JSON.stringify(ids) : s.scan_head, c.id,
    ),
  );
  await c.save(writes);
  if (stage === "commit") await commit(c, await c.state());
}
