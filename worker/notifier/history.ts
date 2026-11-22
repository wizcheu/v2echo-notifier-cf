import type {
  MessageRecord,
  PersonalMessagesPage,
} from "../../shared/message-contracts";
import { parseMember } from "../parsers";
import type { Context } from "./context";
import { senderAvatar, senderUsername } from "./avatar";
import { seal, storageReady } from "./crypto";
import { upstream } from "./http";
import { IDENTITY_MAX_AGE, NotifierError, scopeContent } from "./model";
import { credentialScope } from "./pairing";
import { sampleStatements } from "./sample-cache";
import {
  avatarURL,
  notificationPage,
  presentation,
  type Notification,
} from "./presentation";

function createdAt(c: Context, n: Notification) {
  return typeof n.created === "number" &&
    Number.isSafeInteger(n.created) &&
    n.created > 0 &&
    n.created * 1000 <= c.now + 60000
      ? n.created * 1000
      : null;
}

export function historyStatement(
  c: Context,
  account: number,
  n: Notification,
  kind: string,
  encrypted: string,
  avatar: string,
) {
  return c.sql(
    `INSERT INTO notification_history(account_id,notification_id,kind,created_at,fetched_at,content_enc,avatar_url) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(account_id,notification_id) DO UPDATE SET kind=excluded.kind,created_at=COALESCE(excluded.created_at,notification_history.created_at),fetched_at=excluded.fetched_at,content_enc=excluded.content_enc,avatar_url=COALESCE(NULLIF(excluded.avatar_url,''),notification_history.avatar_url)`,
    account,
    n.id,
    kind,
    createdAt(c, n),
    c.now,
    encrypted,
    avatar,
  );
}

/** Read one API page, including read messages, without changing personal push state. */
export async function loadHistory(
  c: Context,
  input: Record<string, unknown> = {},
): Promise<PersonalMessagesPage> {
  const avatarDeadline = c.now + 25000;
  const page = input.page === undefined ? 1 : input.page;
  if (
    Object.keys(input).some((key) => key !== "page") ||
    typeof page !== "number" ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 9999
  )
    throw new NotifierError(
      "个人消息页码须为 1–9999 的整数，且不能包含其他参数",
      0,
      "",
      400,
    );
  if (!storageReady(c.env))
    throw new NotifierError("请先配置 NOTIFIER_KEY", 0, "", 503);
  try {
    const s = await c.state();
    let account = { account_id: s.account_id, username: s.username };
    if (
      !s.account_id ||
      !s.username ||
      s.blocked === "credentials" ||
      s.verified_at <= c.now - IDENTITY_MAX_AGE ||
      s.credential_scope !== (await credentialScope(c))
    ) {
      let member: { id: number; username: string };
      try {
        member = parseMember(await upstream(c, "/api/v2/member"));
      } catch (error) {
        if (error instanceof NotifierError) throw error;
        throw new NotifierError("PAT 账号资料无效", 0, "credentials");
      }
      if (s.account_id && s.account_id !== member.id)
        throw new NotifierError(
          "当前 PAT 与此账号不符，请恢复原账号凭据",
          0,
          "credentials",
        );
      // PAT-only verification must not refresh Cookie verification or reset scanning.
      account = { account_id: member.id, username: member.username };
    }
    const items = notificationPage(
      await upstream(c, `/api/v2/notifications?p=${page}`),
      account.account_id,
    );
    const ids = JSON.stringify(items.map((n) => n.id));
    const cached = items.length ? await c.db.all<{
      notification_id: number;
      avatar_url: string;
    }>(
      `SELECT notification_id,avatar_url,0 AS priority,fetched_at AS updated FROM notification_history
       WHERE account_id=? AND notification_id IN (SELECT value FROM json_each(?)) AND avatar_url<>''
       UNION ALL
       SELECT notification_id,avatar_url,1 AS priority,updated_at AS updated FROM notification_outbox
       WHERE account_id=? AND notification_id IN (SELECT value FROM json_each(?)) AND type='notification' AND avatar_url<>'' ORDER BY priority,updated DESC`,
      account.account_id, ids, account.account_id, ids,
    ) : [];
    const avatars = new Map<number, string>();
    for (const row of cached) {
      const avatar = avatarURL(row.avatar_url);
      if (avatar && !avatars.has(row.notification_id)) avatars.set(row.notification_id, avatar);
    }
    const messages = items.map((n) => {
      const content = presentation(n, account.username);
      return { notification: n, content, username: senderUsername(content.title).toLowerCase(), avatar: avatars.get(n.id) || content.avatar };
    });
    const senderAvatars = new Map<string, string>();
    for (const { username, avatar } of messages)
      if (username && avatar && !senderAvatars.has(username)) senderAvatars.set(username, avatar);
    const records: MessageRecord[] = [];
    const statements = await sampleStatements(c, account, items);
    let avatarRequests = 0;
    for (const { notification: n, content: p, username, avatar: cachedAvatar } of messages) {
      let avatar = cachedAvatar || senderAvatars.get(username) || "";
      // Public profile requests are optional, take at most 3s each, and share this page's budget.
      if (!avatar && username && !senderAvatars.has(username) && avatarRequests < 10 && c.now + 3000 <= avatarDeadline) {
        avatarRequests++;
        avatar = await senderAvatar(c, p.title);
        senderAvatars.set(username, avatar);
      }
      records.push({
        notification_id: n.id,
        kind: p.kind,
        title: p.title,
        body: p.body,
        avatar_url: avatar,
        created_at: createdAt(c, n),
      });
      statements.push(
        historyStatement(
          c,
          account.account_id,
          n,
          p.kind,
          await seal(c.env, scopeContent(account.account_id, n.id), {
            title: p.title,
            body: p.body,
          }),
          avatar,
        ),
      );
    }
    const fetchedAt = c.now;
    const nextPage = records.length && page < 9999 ? page + 1 : null;
    if (!s.account_id) {
      // Establish the legacy placeholder identity without promoting PAT-only identity to full verification.
      statements.push(c.sql(
        "UPDATE notifier SET account_id=?,username=? WHERE id=?",
        account.account_id,
        account.username, c.id,
      ));
    }
    statements.push(
      c.sql(
        // Refreshing cached pages must not rewind progress or reopen an exhausted history.
        "UPDATE notifier SET history_at=?,history_next_page=CASE WHEN history_next_page IS NULL OR history_next_page>? THEN history_next_page ELSE ? END,history_until=0,history_error='' WHERE id=?",
        fetchedAt,
        page,
        nextPage, c.id,
      ),
    );
    await c.save(statements);
    return {
      items: records,
      page,
      next_page: nextPage,
      fetched_at: fetchedAt,
      reason: `已读取第 ${page} 页的 ${items.length} 条个人消息，包含已读消息`,
    };
  } catch (e) {
    const error =
      e instanceof NotifierError
        ? e
        : new NotifierError("个人消息读取未完成，已保留原记录");
    await c.update(
      "UPDATE notifier SET history_error=?,history_until=MAX((SELECT api_until FROM control WHERE id=1),api_until,?) WHERE id=?",
      error.message,
      error.retryAt, c.id,
    );
    throw error;
  }
}
