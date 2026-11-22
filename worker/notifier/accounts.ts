import type { NotifierAccount, NotifierAccounts } from "../../shared/contracts";
import type { Database } from "../db";
import type { Env, UpstreamFetch } from "../types";
import { locked } from "./context";
import { credentialStatus, validateCredentials } from "./credentials";
import { open, seal } from "./crypto";
import { probeIdentity } from "./pairing";
import { NotifierError } from "./model";
import { relayRequest } from "./http";

export async function requireAccount(db: Database, id: number) {
  const row = await db.one<{ id: number; account_id: number }>("SELECT id,account_id FROM notifier WHERE id=?", id);
  if (!row) throw new NotifierError("账号不存在或已移除", 0, "", 404);
  return row;
}

export async function listAccounts(db: Database, env: Env): Promise<NotifierAccounts> {
  const rows = await db.all<Omit<NotifierAccount, "credentials">>(
    "SELECT id,account_id,username,avatar_url,enabled,blocked,paired_at,binding_id FROM notifier ORDER BY id");
  return {
    accounts: await Promise.all(rows.map(async row => ({ ...row, credentials: await credentialStatus(db, env, row.id) }))),
    legacy_credentials_available: Boolean(env.V2EX_COOKIE && env.V2EX_PAT) && rows.some(row => row.id === 1),
  };
}

export async function createAccount(db: Database, env: Env, input: Record<string, unknown>, fetcher?: UpstreamFetch, now = Date.now()) {
  if (Object.keys(input).some(key => !["cookie", "pat"].includes(key)))
    throw new NotifierError("账号内容包含未知字段", 0, "", 400);
  const credentials = validateCredentials(input.cookie, input.pat);
  return locked(db, env, async lease => {
    if ((await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM notifier WHERE account_id>0")).count >= 20)
      throw new NotifierError("最多添加 20 个账号，请先移除不再使用的账号", 0, "", 409);
    const control = await db.one<{ account_creation_until: number; account_validation_sequence: number }>(
      "SELECT account_creation_until,account_validation_sequence FROM control WHERE id=1");
    if (control.account_creation_until > lease.now)
      throw new NotifierError("添加账号验证暂不可用，请等待验证冷却时间结束后重试", control.account_creation_until);
    // Negative diagnostic owners are validation attempts, never real accounts.
    // Failed or duplicate identities cannot donate their PAT budget to a later account.
    const validationID = -(control.account_validation_sequence + 1);
    await lease.update("UPDATE control SET account_creation_until=?,account_validation_sequence=? WHERE id=1", lease.now + 60000, -validationID);
    const c = lease.forAccount(validationID).withCredentials(credentials.cookie, credentials.pat);
    try {
      const { member, count, avatar, scope } = await probeIdentity(c, true);
      if (await db.one("SELECT id FROM notifier WHERE account_id=?", member.id))
        throw new NotifierError("此 V2EX 账号已经添加，请在原账号中更新 Cookie 和 PAT", 0, "", 409);
      const empty = await db.one<{ id: number }>("SELECT id FROM notifier WHERE id=1 AND account_id=0 AND binding_id=''");
      const id = empty?.id ?? Number((await db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='notifier'"))?.seq ?? 0) + 1;
      await c.save([
        c.sql("INSERT INTO notifier(id,account_id,username,avatar_url,credential_scope,verified_at,unread,observed_at,api_until) VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(backoff_until) FROM api_usage WHERE notifier_id=?),0)) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,username=excluded.username,avatar_url=excluded.avatar_url,credential_scope=excluded.credential_scope,verified_at=excluded.verified_at,unread=excluded.unread,observed_at=excluded.observed_at,api_until=excluded.api_until", id, member.id, member.username, avatar, scope, c.now, count, c.now, validationID),
        c.sql("INSERT INTO notifier_credentials(id,payload,updated_at,encryption_version) VALUES(?,?,?,2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,encryption_version=2", id, await seal(env, `v2ex-credentials:${id}`, credentials), c.now),
        c.sql("INSERT OR IGNORE INTO watch_control(id) VALUES(?)", id),
        c.sql("INSERT OR IGNORE INTO unread_control(id) VALUES(?)", id),
        // An unverified legacy placeholder has no established identity to own usage.
        ...(empty ? [c.sql("DELETE FROM api_usage WHERE notifier_id=?", id), c.sql("DELETE FROM api_daily WHERE notifier_id=?", id)] : []),
        c.sql("UPDATE api_usage SET notifier_id=? WHERE notifier_id=?", id, validationID),
        c.sql("UPDATE api_daily SET notifier_id=? WHERE notifier_id=?", id, validationID),
        c.sql("UPDATE control SET account_creation_until=0 WHERE id=1"),
      ]);
      return { id, reason: `已添加账号 @${member.username}，请在 App 登录此账号后配对` };
    } catch (error) {
      if (error instanceof NotifierError && error.retryAt > c.now)
        await c.update("UPDATE control SET account_creation_until=MAX(account_creation_until,?) WHERE id=1", error.retryAt);
      throw error;
    }
  }, fetcher, now);
}

export async function deleteAccount(db: Database, env: Env, id: number, fetcher?: UpstreamFetch, now = Date.now()) {
  return locked(db, env, async c => {
    const result = { reason: "账号已移除，其余账号与设备连接均保留" };
    const state = await c.state();
    if (!state) return result;
    await c.update("UPDATE notifier SET enabled=0,blocked='deleting' WHERE id=?", id);

    const senders = new Set<string>();
    if (state.sender_enc) senders.add(await open<string>(env, `sender:${state.binding_id}`, state.sender_enc));
    // A response may have been lost after the relay completed a pairing. Revoke
    // every durable sender, even for expired invitations, before erasing secrets.
    const pending = [
      { purpose: "pending-pair", value: state.pair_enc },
      ...await Promise.all([
        ["notifier_pairing_invitation", "pairing-invitation"],
        ["notifier_source_transfer", "source-transfer"],
      ].map(async ([table, purpose]) => ({
        purpose,
        value: (await db.one<{ content_enc: string }>(`SELECT content_enc FROM ${table} WHERE id=?`, id))?.content_enc,
      }))),
    ];
    for (const entry of pending) {
      if (!entry.value) continue;
      const value = await open<{ sender: string; account: number }>(env, entry.purpose, entry.value);
      if (value.account !== state.account_id) throw new NotifierError("待完成配对与当前账号不符，删除已暂停并保留凭据", 0, "storage");
      senders.add(value.sender);
    }
    for (const sender of senders) {
      const response = (await relayRequest(c, "/v1/sender", sender, { source_account_id: state.account_id }, "DELETE")).data;
      if (!response || typeof response !== "object" || !("revoked" in response) || response.revoked !== true) {
        throw new NotifierError("推送撤销结果尚未确认，账号已暂停；请重试删除");
      }
    }
    const profiles = `SELECT binding_id FROM notifier WHERE id=?
      UNION SELECT published_binding FROM watch_control WHERE id=?
      UNION SELECT profile_id FROM watch_app_clients WHERE notifier_id=?
      UNION SELECT binding_id FROM notification_outbox WHERE account_id=?`;
    await c.save([
      c.sql(`DELETE FROM watch_local_operations WHERE profile_id IN (${profiles})`, id, id, id, state.account_id),
      c.sql(`DELETE FROM watch_cancellations WHERE binding_id IN (${profiles})`, id, id, id, state.account_id),
      ...["notifier_credentials", "notifier_pairing_invitation", "notifier_source_transfer", "watch_app_invitation", "watch_control", "unread_control", "notifier"].map(table => c.sql(`DELETE FROM ${table} WHERE id=?`, id)),
      ...["notification_candidates", "unread_items", "watch_targets", "notification_checks", "api_usage", "api_daily", "watch_app_clients"].map(table => c.sql(`DELETE FROM ${table} WHERE notifier_id=?`, id)),
      ...["notification_outbox", "notification_dedup", "notification_history", "notification_samples", "watch_dedup"].map(table => c.sql(`DELETE FROM ${table} WHERE account_id=?`, state.account_id)),
    ]);
    return result;
  }, fetcher, now, false, id);
}
