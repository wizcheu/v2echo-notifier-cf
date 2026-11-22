import { MAX_BODY } from "../types";
import type { Context } from "./context";
import { open, seal } from "./crypto";
import {
  isClassifiedKind,
  NotifierError,
  type ClassifiedNotificationKind,
  type Notifier,
} from "./model";
import {
  avatarURL,
  notificationPage,
  presentation,
  type Notification,
} from "./presentation";

export const SAMPLE_MAX_AGE = 7 * 86400000;
type SampleAccount = Pick<Notifier, "account_id" | "username">;
const scope = (account: number, id: number) => `sample:${account}:${id}`;

export async function sampleStatements(
  c: Context,
  s: SampleAccount,
  items: Notification[],
): Promise<D1PreparedStatement[]> {
  const latest = new Map<
    ClassifiedNotificationKind,
    { notification: Notification; avatar: string }
  >();
  for (const notification of items) {
    const content = presentation(notification, s.username);
    if (!isClassifiedKind(content.kind)) continue;
    const previous = latest.get(content.kind);
    if (!previous || notification.id > previous.notification.id)
      latest.set(content.kind, { notification, avatar: content.avatar });
  }

  const now = c.now;
  const statements: D1PreparedStatement[] = [];
  for (const [kind, { notification: n, avatar }] of latest) {
    const raw: Notification = {
      id: n.id,
      for_member_id: n.for_member_id,
      text: n.text,
      ...(typeof n.created === "number" ? { created: n.created } : {}),
      ...(n.payload !== undefined ? { payload: n.payload } : {}),
      ...(n.payload_rendered !== undefined
        ? { payload_rendered: n.payload_rendered }
        : {}),
    };
    if (n.member) {
      raw.member = {};
      for (const field of [
        "username",
        "avatar_large",
        "avatar_normal",
        "avatar_mini",
      ] as const) {
        const value = n.member[field];
        if (typeof value === "string") raw.member[field] = value;
      }
    }
    statements.push(
      c.sql(
        `INSERT INTO notification_samples(account_id,kind,notification_id,raw_enc,avatar_url,fetched_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET
        notification_id=excluded.notification_id,raw_enc=excluded.raw_enc,
        avatar_url=CASE WHEN excluded.notification_id=notification_samples.notification_id AND excluded.avatar_url=''
          THEN notification_samples.avatar_url ELSE excluded.avatar_url END,
        fetched_at=excluded.fetched_at
        WHERE excluded.notification_id>=notification_samples.notification_id OR notification_samples.fetched_at<=?`,
        s.account_id,
        kind,
        n.id,
        await seal(c.env, scope(s.account_id, n.id), raw),
        avatar,
        now,
        now - SAMPLE_MAX_AGE,
      ),
    );
  }
  return statements;
}

export async function cachedSample(
  c: Context,
  s: SampleAccount,
  kind: ClassifiedNotificationKind,
): Promise<({ id: number } & ReturnType<typeof presentation>) | null> {
  const rows = await c.db.all<{
    notification_id: number;
    raw_enc: string;
    avatar_url: string;
  }>(
    `SELECT notification_id,raw_enc,avatar_url FROM notification_samples
    WHERE (account_id=? AND fetched_at>?) AND account_id=(SELECT account_id FROM notifier WHERE id=?) ORDER BY notification_id DESC,fetched_at DESC LIMIT 5`,
    s.account_id,
    c.now - SAMPLE_MAX_AGE, c.id,
  );
  for (const row of rows) {
    const raw = await open<Notification>(
      c.env,
      scope(s.account_id, row.notification_id),
      row.raw_enc,
      MAX_BODY,
    );
    const [notification] = notificationPage(
      { success: true, result: [raw] },
      s.account_id,
    );
    if (notification.id !== row.notification_id)
      throw new NotifierError("缓存通知编号与原始样本不符", 0, "storage");
    const content = presentation(notification, s.username);
    if (content.kind === kind)
      return {
        id: notification.id,
        ...content,
        avatar: avatarURL(row.avatar_url) || content.avatar,
      };
  }
  return null;
}
