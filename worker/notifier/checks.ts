import type { Context } from "./context";
import { NotifierError } from "./model";

interface WatchCheck {
  source: "following_topic" | "topic_reply";
  topicId: number | null;
  stageBefore: string;
  result: () => { stage: string; detail: string };
}

/** Diagnostic writes cannot fail an otherwise valid notification operation. */
export async function recordCheck<T>(
  c: Context,
  source: "scan" | "verify" | "history" | WatchCheck,
  job: () => Promise<T>,
) {
  const id = crypto.randomUUID(),
    started = c.now;
  const watch = typeof source === "object" ? source : null;
  const targetPrefix = watch?.topicId ? `帖子 #${watch.topicId} · ` : "";
  const before = watch ? null : await c.state();
  const requests = c.db.outbound,
    api = c.db.apiRequests;
  let inserted = false,
    failed = false,
    failure: unknown;
  try {
    await c.db.run(
      `INSERT INTO notification_checks(id,source,started_at,stage_before,unread,detail,notifier_id) VALUES(?,?,?,?,?,?,?)`,
      id,
      typeof source === "string" ? source : source.source,
      started,
      watch ? watch.stageBefore : before!.scan_stage,
      before?.unread ?? 0,
      watch ? `${targetPrefix}正在检查` : "", c.id,
    );
    inserted = true;
  } catch {
    console.error(JSON.stringify({ event: "check_log_write_failed" }));
  }
  try {
    return await job();
  } catch (e) {
    failed = true;
    failure = e;
    throw e;
  } finally {
    if (inserted)
      try {
        const after = watch ? null : await c.state();
        const watchResult = watch?.result();
        const outcome = failed
          ? failure instanceof NotifierError &&
            failure.retryAt > c.now &&
            c.db.outbound === requests
            ? "waiting"
            : "error"
          : "ok";
        const detail = failed
          ? failure instanceof NotifierError
            ? failure.message
            : "本轮执行未完成，已保留状态"
          : watchResult
            ? watchResult.detail
            : source === "history"
              ? "已读取历史，仅保存展示，不加入推送队列"
              : source === "verify"
                ? "Cookie 与 PAT 身份已确认"
                : after!.unread === 0
                  ? "首页未读为 0，未读取通知 API"
                  : after!.scan_stage === "idle"
                    ? "未读候选扫描已完成"
                    : "分页进度已持久化，将继续扫描";
        await c.db.run(
          `UPDATE notification_checks SET finished_at=?,outcome=?,unread=?,stage_after=?,requests=?,api_requests=?,detail=? WHERE (id=?) AND notifier_id=?`,
          c.now,
          outcome,
          after?.unread ?? 0,
          watchResult ? watchResult.stage : after!.scan_stage,
          c.db.outbound - requests,
          c.db.apiRequests - api,
          targetPrefix + detail,
          id, c.id,
        );
      } catch {
        console.error(JSON.stringify({ event: "check_log_write_failed" }));
      }
  }
}
