import { revokeWatchClient, updateWatches } from "./watch-local";
import {
  checkWindow,
  validCheckHours,
  validCheckIntervals,
  checkScheduleLabel,
  type CheckSchedule,
} from "../../shared/check-schedule";
import type { Database } from "../db";
import type { Env, UpstreamFetch } from "../types";
import { Context, locked } from "./context";
import { open, storageReady } from "./crypto";
import {
  NotifierError,
  IDENTITY_MAX_AGE,
  scopeContent,
  type Content,
  type Outbox,
} from "./model";
import { credentialScope, verifyIdentity } from "./pairing";
import { createPairingInvitation } from "./pairing-qr";
import { backoff, relayStep } from "./relay";
import { scanStep } from "./scan";
import { recordCheck } from "./checks";
import { loadHistory } from "./history";
import { refreshUnread } from "./unread";
import { queueTestNotification } from "./test-notifications";
import { SAMPLE_MAX_AGE } from "./sample-cache";
import { syncWatches, watchState } from "./watch-config";
import { refreshWatches, watchStep } from "./watch-scanner";
import { createSourceTransfer, completeSourceTransfer } from "./source-transfer";
import { updateCredentials } from "./credentials";

async function failure(c: Context, channel: "scan" | "relay", error: unknown) {
  const message =
    error instanceof NotifierError
      ? error.message
      : "本轮未完成，已保留状态；请检查服务配置与日志";
  const retryAt = error instanceof NotifierError ? error.retryAt : 0;
  const blocked = error instanceof NotifierError ? error.block : "";
  const s = await c.state();
  // Ordinary 403s already use the persistent per-channel progressive cooldown.
  // A second, scan-wide exponent must not extend that deadline past its cap.
  const until =
    channel === "scan" &&
    error instanceof NotifierError &&
    error.upstreamStatus === 403 &&
    retryAt > c.now
      ? retryAt
      : Math.max(retryAt, c.now + backoff(s[`${channel}_failures`] + 1));
  await c.update(
    `UPDATE notifier SET ${channel}_error=?,${channel}_failures=${channel}_failures+1,${channel}_until=MAX(${channel}_until,?),blocked=CASE WHEN ?<>'' THEN ? ELSE blocked END WHERE id=?`,
    message,
    until,
    blocked,
    blocked, c.id,
  );
}
async function expire(c: Context) {
  const state = await c.state();
  if (!state || state.blocked === "deleting") return;
  await c.update(
    `UPDATE notification_outbox SET status='expired',detail=CASE WHEN status='unclassified' THEN '分类未确认，已过期；未继续发送' ELSE '已超过事件有效期' END,updated_at=? WHERE (status IN ('pending','submitted','unclassified') AND expires_at<=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
    c.now,
    c.now, c.id,
  );
  const s = await c.state();
  if (s.cleanup_at > c.now) return;
  await c.save([
    c.sql(`DELETE FROM notification_samples WHERE (fetched_at<=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.now - SAMPLE_MAX_AGE, c.id),
    c.sql("DELETE FROM watch_app_invitation WHERE expires_at<=? AND id=?", c.now, c.id),
    c.sql(`DELETE FROM watch_cancellations WHERE (created_at<?) AND binding_id=(SELECT binding_id FROM notifier WHERE id=?)`, c.now - 2 * 86400000, c.id),
    c.sql(
      `UPDATE notification_checks SET outcome='interrupted',finished_at=?,detail=CASE WHEN source IN ('following_topic','topic_reply') AND detail<>'' THEN detail || '；执行中断或结果未保存' ELSE '执行中断或结果未保存' END WHERE (outcome='running' AND started_at<?) AND notifier_id=?`,
      c.now,
      c.now - 120000, c.id,
    ),
    c.sql(
      "DELETE FROM notification_checks WHERE id IN (SELECT id FROM notification_checks WHERE notifier_id=? AND started_at<? ORDER BY started_at LIMIT 200)",
      c.id, c.now - 7 * 86400000,
    ),
    c.sql(
      "DELETE FROM notification_checks WHERE id IN (SELECT id FROM notification_checks WHERE notifier_id=? ORDER BY started_at DESC LIMIT 200 OFFSET 5000)", c.id,
    ),
    c.sql(
      "DELETE FROM notification_history WHERE account_id=? AND notification_id IN (SELECT notification_id FROM notification_history WHERE account_id=? AND fetched_at<? ORDER BY fetched_at LIMIT 200)",
      state.account_id, state.account_id, c.now - 7 * 86400000,
    ),
    c.sql(
      "DELETE FROM notification_history WHERE account_id=? AND notification_id IN (SELECT notification_id FROM notification_history WHERE account_id=? ORDER BY fetched_at DESC LIMIT 200 OFFSET 1000)",
      state.account_id, state.account_id,
    ),
    c.sql(
      "DELETE FROM notification_outbox WHERE event_id IN (SELECT event_id FROM notification_outbox WHERE account_id=? AND status NOT IN ('pending','submitted') AND created_at<? ORDER BY created_at LIMIT 200)",
      state.account_id, c.now - 7 * 86400000,
    ),
    c.sql(
      "DELETE FROM notification_outbox WHERE event_id IN (SELECT event_id FROM notification_outbox WHERE account_id=? AND status NOT IN ('pending','submitted') ORDER BY created_at DESC LIMIT 200 OFFSET 10000)", state.account_id,
    ),
    c.sql(
      "UPDATE notifier SET cleanup_at=? WHERE id=?",
      c.now + 3600000, c.id,
    ),
  ]);
}
export async function notifierMaintenance(db: Database, env: Env) {
  const due = await db.one<{ id: number }>("SELECT id FROM notifier WHERE cleanup_at<=? AND blocked<>'deleting' ORDER BY cleanup_at,id LIMIT 1", Date.now());
  if (!due) return;
  try {
    await locked(db, env, expire, undefined, Date.now(), false, due.id);
  } catch (e) {
    if (!(e instanceof NotifierError)) console.error(JSON.stringify({ event: "notifier_cleanup_failed" }));
  }
}
export async function notifierTick(
  db: Database,
  env: Env,
  fetcher?: UpstreamFetch,
  now = Date.now(),
  requestedAccountID?: number,
) {
  const candidates = requestedAccountID === undefined ? await db.all<CheckSchedule & { id: number; enabled: number; control_due: number; delivery_due: number }>(
    `SELECT n.id,n.enabled,n.check_start_hour,n.check_end_hour,
       (w.next_sync<=? AND n.binding_id<>'' AND n.sender_enc<>'' AND n.blocked NOT IN ('pairing','deleting')) AS control_due,
       EXISTS(SELECT 1 FROM notification_outbox o WHERE o.account_id=n.account_id AND o.status IN ('pending','submitted') AND o.next_at<=? AND o.expires_at>?) AS delivery_due
     FROM notifier n JOIN watch_control w ON w.id=n.id CROSS JOIN control c
     WHERE c.id=1 AND n.next_dispatch<=? AND n.blocked<>'deleting'
     ORDER BY n.id<=c.last_notifier_id,n.id`, now, now, now, now) : [];
  const selected = requestedAccountID === undefined
    ? candidates.find(row => row.control_due || row.enabled && (row.delivery_due || checkWindow(now, row).open))
    : { id: requestedAccountID };
  if (!selected) return { handled: false, reason: candidates.some(row => row.enabled && !checkWindow(now, row).open) ? "当前不在检查时段，将在下一时段自动继续" : "暂无到期的账号任务" };
  const accountID = selected.id;
  const settings = await db.one<CheckSchedule & { enabled: number }>(
    "SELECT enabled,check_start_hour,check_end_hour FROM notifier WHERE id=?", accountID,
  );
  const controlDue = await db.one<{ due: number }>(`SELECT 1 AS due FROM watch_control w,notifier n
    WHERE w.id=? AND n.id=w.id AND w.next_sync<=? AND n.binding_id<>'' AND n.sender_enc<>'' AND n.blocked NOT IN ('pairing','deleting')`, accountID, now);
  if (!settings?.enabled && !controlDue) return { handled: false, reason: "真实通知已暂停" };
  if (!controlDue && !checkWindow(now, settings).open) {
    const due = await db.one<{ ready: number }>(
      "SELECT 1 AS ready FROM notification_outbox WHERE status IN ('pending','submitted') AND next_at<=? AND expires_at>? AND account_id=(SELECT account_id FROM notifier WHERE id=?) LIMIT 1",
      now,
      now, accountID,
    );
    // No lease writes or empty check records while an idle assistant waits overnight.
    if (!due)
      return {
        handled: true,
        reason: "当前不在检查时段，将在下一时段自动继续",
      };
  }
  try {
    return await locked(
      db,
      env,
      async (c) => {
        const s = await c.state();
        if (!s) return { handled: false, reason: "账号已移除" };
        const started = c.now;
        await c.save([
          c.sql("UPDATE control SET next_dispatch=?,last_notifier_id=? WHERE id=1", c.now + 60000, c.id),
          c.sql("UPDATE notifier SET next_dispatch=? WHERE id=?", c.now + 60000, c.id),
        ]);
        if (controlDue && storageReady(env) && s.credential_scope === await credentialScope(c)) {
          try { await syncWatches(c); } catch { /* syncWatches persists the diagnostic/backoff. */ }
          // A slow ownership exchange gets its own bounded turn. Routine source
          // checks may share a turn so many accounts cannot starve all scans.
          if (!s.enabled || c.now - started >= 30000)
            return { handled: true, reason: "已检查推送连接，采集继续遵守检查时段与重试等待时间" };
        }
        if (!s.enabled) return { handled: false, reason: "真实通知已暂停" };
        await expire(c);
        if (!storageReady(env) || !s.binding_id)
          return { handled: true, reason: "请先完成加密存储配置与配对" };
        if (s.blocked)
          return { handled: true, reason: "需要处理账号或配对异常" };
        const window = checkWindow(c.now, s);
        const scopeChanged = s.credential_scope !== (await credentialScope(c));
        if (
          window.open &&
          s.scan_until <= c.now &&
          (s.scan_stage !== "idle" ||
            s.next_scan <= c.now ||
            scopeChanged ||
            s.verified_at + IDENTITY_MAX_AGE <= c.now)
        ) {
          try {
            await recordCheck(c, "scan", () => scanStep(c));
          } catch (e) {
            await failure(c, "scan", e);
          }
        }
        // A secret change must be re-verified before old queued content can leave.
        const current = await c.state();
        if (current.credential_scope !== (await credentialScope(c)))
          return { handled: true, reason: "等待重新确认当前账号" };
        try {
          await relayStep(c);
        } catch (e) {
          await failure(c, "relay", e);
        }
        // Ordinary notices and receipts go first. Do not spend the remaining lease on another slow request.
        if (window.open && c.now - started < 40000) await watchStep(c);
        return {
          handled: true,
          reason: window.open
            ? "已执行一轮到期的扫描与投递任务"
            : "当前不在检查时段，仅处理符合条件的已入队推送与回执",
        };
      },
      fetcher,
      now,
      true, accountID,
    );
  } catch (e) {
    if (e instanceof NotifierError) return { handled: true, reason: e.message };
    console.error(JSON.stringify({ event: "notifier_round_failed" }));
    return { handled: true, reason: "本轮未完成，持久化状态将在下一轮继续" };
  }
}

export async function notifierState(db: Database, env: Env, snapshotNow: number, accountID = 1) {
  const [state, events, counts, checkErrors] = await db.batch([
    db.statement(
      `SELECT enabled,check_start_hour,check_end_hour,scan_interval_minutes,following_interval_minutes,topic_interval_minutes,account_id,username,avatar_url,verified_at,verify_until,binding_id,paired_at,blocked,pair_until,scan_stage,scan_page,scan_collected,unread,observed_at,next_scan,scan_until,scan_error,last_scan,relay_until,relay_error,last_sync,history_at,history_until,history_error FROM notifier WHERE id=?`, accountID,
    ),
    db.statement(
      `SELECT event_id,notification_id,type,kind,status,attempts,receipt_attempts,next_at,created_at,expires_at,updated_at,detail,deliveries FROM notification_outbox WHERE account_id=(SELECT account_id FROM notifier WHERE id=?) ORDER BY created_at DESC,event_id DESC LIMIT 50`, accountID,
    ),
    db.statement(
      "SELECT status,COUNT(*) AS count FROM notification_outbox WHERE account_id=(SELECT account_id FROM notifier WHERE id=?) GROUP BY status", accountID,
    ),
    db.statement(
      "SELECT source,COUNT(*) AS count FROM notification_checks WHERE started_at>=? AND started_at<=? AND started_at>(SELECT check_errors_acked_at FROM notifier WHERE id=?) AND source IN ('scan','following_topic','topic_reply') AND outcome IN ('error','interrupted') AND notifier_id=? GROUP BY source ORDER BY source",
      snapshotNow - 86400000,
      snapshotNow, accountID, accountID,
    ),
  ]);
  return {
    ...(state.results[0] as Record<string, unknown>),
    storage_ready: storageReady(env),
    events: events.results,
    counts: counts.results,
    check_errors: checkErrors.results,
    device_ack_available: false,
    watches: await watchState(db, env, accountID),
  };
}

async function sendTestNotification(
  db: Database,
  env: Env,
  kind: unknown,
  fetcher: UpstreamFetch | undefined,
  now: number,
  accountID: number,
) {
  const started = Date.now();
  const created = await locked(
    db,
    env,
    (c) => queueTestNotification(c, kind),
    fetcher,
    now, false, accountID,
  );
  let status = "pending";
  let note = "已入队，后台将继续投递";
  try {
    // Sampling may consume most of its lease. Start a fresh lease for delivery;
    // bypass only the cron interval, never the relay's cooldown or account gates.
    await locked(
      db,
      env,
      async (c) => {
        const before = await c.state();
        if (before.credential_scope !== (await credentialScope(c))) {
          note = "等待重新确认当前账号后投递";
          return;
        }
        try {
          await relayStep(c, created.event_id);
        } catch (error) {
          await failure(c, "relay", error);
        }
        const row = await c.db.one<Pick<Outbox, "status" | "detail">>(
          `SELECT status,detail FROM notification_outbox WHERE (event_id=?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
          created.event_id, c.id,
        );
        status = row?.status ?? "pending";
        const current = await c.state();
        if (status === "submitted")
          note = "已提交推送服务，手机是否收到请以设备为准";
        else if (status === "apns_accepted")
          note = "APNs 已接收，手机是否收到请以设备为准";
        else if (!current.enabled) note = "通知服务已暂停，测试保留在队列中";
        else if (current.blocked) note = "等待处理账号或配对异常后投递";
        else if (current.relay_until > c.now)
          note = "尚未到推送重试时间，后台会继续尝试投递";
        else if (row?.detail) note = row.detail;
      },
      fetcher,
      now + Date.now() - started, false, accountID,
    );
  } catch (error) {
    // Creation already succeeded. Do not report it as failed or encourage a
    // duplicate click if a concurrent cron owns the lease or storage is busy.
    if (!(error instanceof NotifierError))
      console.error(JSON.stringify({ event: "test_delivery_deferred" }));
  }
  return {
    ...created,
    delivery_status: status,
    reason: `${created.reason}；${note}`,
  };
}

export async function notifierAction(
  db: Database,
  env: Env,
  action: string,
  data: Record<string, unknown>,
  fetcher?: UpstreamFetch,
  now = Date.now(),
  accountID = 1,
) {
  if (action === "tick") return notifierTick(db, env, fetcher, now, accountID);
  if (action === "test")
    return sendTestNotification(db, env, data.kind, fetcher, now, accountID);
  if (action === "checks/ack") {
    const current = await db.one<{ blocked: string }>(
      "SELECT blocked FROM notifier WHERE id=?",
      accountID,
    );
    if (!current) throw new NotifierError("账号不存在或已移除", 0, "", 404);
    if (current.blocked === "deleting")
      throw new NotifierError("此账号正在移除，请重试移除以完成撤销", 0, "", 409);
    // Advance only to the latest completed error so an in-flight check that fails later still alerts.
    await db.run(
      "UPDATE notifier SET check_errors_acked_at=MAX(check_errors_acked_at,COALESCE((SELECT MAX(started_at) FROM notification_checks WHERE started_at>=? AND started_at<=? AND source IN ('scan','following_topic','topic_reply') AND outcome IN ('error','interrupted') AND notifier_id=?),0)) WHERE id=?",
      now - 86400000,
      now,
      accountID,
      accountID,
    );
    return { reason: "已清除异常红点，历史日志仍保留" };
  }
  return locked(
    db,
    env,
    async (c) => {
      const current = await c.state();
      if (!current) throw new NotifierError("账号不存在或已移除", 0, "", 404);
      if (current.blocked === "deleting") throw new NotifierError("此账号正在移除，请重试移除以完成撤销", 0, "", 409);
      if (action === "credentials") return updateCredentials(c, data);
      if (action === "verify") {
        try {
          await recordCheck(c, "verify", () => verifyIdentity(c));
          return { reason: "Cookie 与 PAT 已确认属于同一账号" };
        } catch (e) {
          await failure(c, "scan", e);
          throw e;
        }
      }
      if (action === "pair/qr") return createPairingInvitation(c, data.join_existing === true);
      if (action === "transfer") return createSourceTransfer(c);
      if (action === "transfer/complete") return completeSourceTransfer(c, data.code);
      if (action === "history")
        return recordCheck(c, "history", () => loadHistory(c, data));
      if (action === "unread/refresh") return refreshUnread(c, data);
      if (action === "watch/refresh") return refreshWatches(c, data);
      if (action === "watch/sync") {
        await syncWatches(c, true);
        return { reason: "推送连接状态已更新，关注规则保存在本助手" };
      }
      if (action === "watch/clients/revoke") return revokeWatchClient(c, data);
      if (action === "watch/config") return updateWatches(c, data);
      if (action === "schedule") {
        if (!validCheckHours(data.startHour, data.endHour))
          throw new NotifierError(
            "请选择有效且不同的开始与结束时间",
            0,
            "",
            400,
          );
        const hasIntervals = [
          "scanIntervalMinutes",
          "followingIntervalMinutes",
          "topicIntervalMinutes",
        ].some((key) => key in data);
        if (
          hasIntervals &&
          !validCheckIntervals(
            data.scanIntervalMinutes,
            data.followingIntervalMinutes,
            data.topicIntervalMinutes,
          )
        )
          throw new NotifierError("请选择有效的三类检查间隔", 0, "", 400);
        const schedule = {
          check_start_hour: data.startHour as number,
          check_end_hour: data.endHour as number,
        };
        await c.update(
          "UPDATE notifier SET check_start_hour=?,check_end_hour=?,scan_interval_minutes=COALESCE(?,scan_interval_minutes),following_interval_minutes=COALESCE(?,following_interval_minutes),topic_interval_minutes=COALESCE(?,topic_interval_minutes) WHERE id=?",
          schedule.check_start_hour,
          schedule.check_end_hour,
          hasIntervals ? data.scanIntervalMinutes as number : null,
          hasIntervals ? data.followingIntervalMinutes as number : null,
          hasIntervals ? data.topicIntervalMinutes as number : null, c.id,
        );
        return {
          reason: `检查设置已保存：每天 ${checkScheduleLabel(schedule)}（北京时间）`,
        };
      }
      if (action === "config") {
        if (typeof data.enabled !== "boolean")
          throw new NotifierError("通知状态须为布尔值", 0, "", 400);
        const s = await c.state();
        if (data.enabled && (!s.binding_id || !storageReady(env) || s.blocked))
          throw new NotifierError("请先确认账号并完成有效配对");
        await c.save([
          c.sql("UPDATE notifier SET enabled=? WHERE id=?", Number(data.enabled), c.id),
          c.sql("UPDATE watch_control SET next_sync=0 WHERE id=?", c.id),
          ...(s.enabled !== Number(data.enabled) ? [
            // Global pause keeps ordinary notification progress, but watch rules
            // restart at a fresh observation point and never accumulate a backlog.
            c.sql(`UPDATE watch_targets SET state_enc='',last_checked=0,next_check=0,checking=0,failures=0,error='' WHERE notifier_id=?`, c.id),
            c.sql("INSERT OR IGNORE INTO watch_cancellations(event_id,binding_id,created_at) SELECT event_id,binding_id,? FROM notification_outbox WHERE type='watch_update' AND status IN ('pending','submitted') AND account_id=(SELECT account_id FROM notifier WHERE id=?)", c.now, c.id),
            c.sql(`UPDATE notification_outbox SET status='cancelled',detail='助手已暂停，关注提醒不积压补发',updated_at=? WHERE (type='watch_update' AND status IN ('pending','submitted')) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`, c.now, c.id),
          ] : []),
        ]);
        return {
          reason: data.enabled
            ? "真实通知已启动"
            : "真实通知已暂停；队列和重试时间保留",
        };
      }
      throw new NotifierError("通知操作不存在", 0, "", 404);
    },
    fetcher,
    now, false, accountID,
  );
}
export async function eventContent(db: Database, env: Env, id: string, accountID = 1) {
  const row = await db.one<Outbox>(
    "SELECT * FROM notification_outbox WHERE event_id=? AND account_id=(SELECT account_id FROM notifier WHERE id=?)",
    id, accountID,
  );
  if (!row) throw new NotifierError("通知记录不存在或已清理", 0, "", 404);
  if (!row.content_enc)
    return { title: "内容已清理", body: "取消或过期的记录不再保留预览内容。" };
  return open<Content>(
    env,
    scopeContent(row.account_id, row.notification_id ?? row.event_id),
    row.content_enc,
  );
}
