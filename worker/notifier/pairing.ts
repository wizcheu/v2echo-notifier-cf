import { digest, parseHome, parseMember } from "../parsers";
import type { Context } from "./context";
import { open, seal, storageReady } from "./crypto";
import { relayRequest, upstream } from "./http";
import { IDENTITY_MAX_AGE, NotifierError, UUID, type Notifier } from "./model";
import { accessWaitMessage } from "./response-errors";

export async function credentialScope(c: Context) {
  const env = await c.credentials();
  return digest(JSON.stringify([env.V2EX_COOKIE ?? "", env.V2EX_PAT ?? ""]));
}
/** Probe a candidate without replacing the active identity or scan progress. */
export async function probeIdentity(c: Context, creating = false) {
  if (!storageReady(c.env))
    throw new NotifierError("请先配置 NOTIFIER_KEY", 0, "", 503);
  const state = creating ? { account_id: 0, verify_until: 0 } : await c.state();
  const control = await c.db.one<{ api_until: number; web_until: number }>(
    "SELECT api_until,web_until FROM control WHERE id=1",
  );
  const accountBudget = creating ? 0 : (await c.db.one<{ api_until: number }>("SELECT api_until FROM notifier WHERE id=?", c.id)).api_until;
  const until = Math.max(control.api_until, control.web_until, accountBudget);
  // Verification needs both channels. Do not spend a PAT request or extend the
  // manual verification interval while either required channel is cooling down.
  if (until > c.now)
    throw new NotifierError(
      accessWaitMessage(control.api_until >= control.web_until, until),
      until,
    );
  if (state.verify_until > c.now)
    throw new NotifierError(
      "账号验证间隔为一分钟，请稍后重试",
      state.verify_until,
    );
  if (!creating) await c.update(
    "UPDATE notifier SET verify_until=? WHERE id=?",
    c.now + 60000, c.id,
  );
  let member: { id: number; username: string };
  try {
    member = parseMember(await upstream(c, "/api/v2/member"));
  } catch (e) {
    if (e instanceof NotifierError) throw e;
    throw new NotifierError("PAT 账号资料无效", 0, "credentials");
  }
  if (state.account_id && state.account_id !== member.id)
    throw new NotifierError(
      "当前 PAT 与此账号不符，请恢复原账号凭据；新增账号请使用添加账号",
      0,
      "credentials",
    );
  let home: Awaited<ReturnType<typeof parseHome>>;
  try {
    home = await parseHome(
      (await upstream(c, "/")) as string,
      member.username,
      member.id,
    );
  } catch (e) {
    if (e instanceof NotifierError) throw e;
    throw new NotifierError(
      "Cookie 首页与 PAT 账号不符，或未读数无法识别",
      0,
      "credentials",
    );
  }
  const scope = await credentialScope(c);
  return { member, count: home.unread, avatar: home.avatar_url, scope };
}

export async function verifyIdentity(c: Context) {
  const { member, count, avatar, scope } = await probeIdentity(c);
  await c.save([
    c.sql(`DELETE FROM notification_candidates WHERE notifier_id=?`, c.id),
    c.sql(
      `UPDATE notifier SET account_id=?,username=?,avatar_url=COALESCE(NULLIF(?,''),avatar_url),credential_scope=?,verified_at=?,unread=?,observed_at=?,scan_stage='idle',scan_id='',scan_collected=0,next_scan=0,scan_until=0,scan_failures=0,scan_error='',blocked=CASE WHEN blocked='credentials' THEN '' ELSE blocked END WHERE id=?`,
      member.id,
      member.username,
      avatar,
      scope,
      c.now,
      count,
      c.now, c.id,
    ),
  ]);
  return member;
}

interface PendingPair {
  sender: string;
  account: number;
  username: string;
}

/** An abandoned request may already have paired remotely despite a lost response. */
export async function retirePendingSender(c: Context, pending: Pick<PendingPair, "sender" | "account">) {
  const state = await c.state();
  if (pending.account !== state.account_id) throw new NotifierError("待完成配对与当前账号不符，原凭据已保留", 0, "storage");
  if (state.sender_enc && pending.sender === await open<string>(c.env, `sender:${state.binding_id}`, state.sender_enc)) return;
  const response = (await relayRequest(c, "/v1/sender", pending.sender, { source_account_id: pending.account }, "DELETE")).data;
  if (!response || typeof response !== "object" || !("revoked" in response) || response.revoked !== true) {
    throw new NotifierError("旧配对凭据的撤销尚未确认，请重试原操作");
  }
}
export async function pairingIdentity(c: Context, prior: Notifier) {
  // A lost exchange response must not depend on another PAT request during rate backoff.
  return prior.account_id &&
    prior.username &&
    prior.verified_at > c.now - IDENTITY_MAX_AGE &&
    prior.blocked !== "credentials" &&
    prior.credential_scope === (await credentialScope(c))
    ? { id: prior.account_id, username: prior.username }
    : verifyIdentity(c);
}

export async function savePairing(
  c: Context,
  pending: PendingPair,
  response: unknown,
  confirmation?: (binding: string) => Promise<D1PreparedStatement>,
) {
  const result = response as {
    paired?: unknown;
    binding_id?: unknown;
    username?: unknown;
  } | null;
  if (
    !result ||
    result.paired !== true ||
    typeof result.binding_id !== "string" ||
    !UUID.test(result.binding_id) ||
    typeof result.username !== "string" ||
    result.username.toLowerCase() !== pending.username.toLowerCase()
  )
    throw new NotifierError("配对响应身份不符，原连接已保留");
  // Switching between manual pairing, QR and source transfer can abandon a
  // request whose remote success response was lost. Retire its durable sender
  // before replacing any local recovery record.
  const prior = await c.state();
  const saved = [
    { purpose: "pending-pair", value: prior.pair_enc },
    ...await Promise.all([
      ["notifier_pairing_invitation", "pairing-invitation"],
      ["notifier_source_transfer", "source-transfer"],
    ].map(async ([table, purpose]) => ({ purpose,
      value: (await c.db.one<{ content_enc: string }>(`SELECT content_enc FROM ${table} WHERE id=?`, c.id))?.content_enc,
    }))),
  ];
  const retired = new Set<string>();
  for (const entry of saved) {
    if (!entry.value) continue;
    const old = await open<PendingPair>(c.env, entry.purpose, entry.value);
    if (old.sender === pending.sender || retired.has(old.sender)) continue;
    await retirePendingSender(c, old);
    retired.add(old.sender);
  }
  await c.save([
    c.sql(
      `UPDATE notification_outbox SET status='cancelled',detail='更换配对后停止跟踪；已尝试事件可能已发送',updated_at=? WHERE (status IN ('pending','submitted') AND binding_id<>?) AND account_id=(SELECT account_id FROM notifier WHERE id=?)`,
      c.now,
      result.binding_id, c.id,
    ),
    c.sql(`DELETE FROM notification_candidates WHERE notifier_id=?`, c.id),
    c.sql(
      `UPDATE notifier SET binding_id=?,sender_enc=?,paired_at=?,blocked='',pair_enc='',pair_expires=0,scan_stage='idle',scan_id='',scan_collected=0,next_scan=?,scan_until=0,scan_error='',relay_error='',relay_failures=0 WHERE id=?`,
      result.binding_id,
      await seal(c.env, `sender:${result.binding_id}`, pending.sender),
      c.now,
      c.now + 1500, c.id,
    ),
    c.sql("DELETE FROM notifier_pairing_invitation WHERE id=?", c.id),
    c.sql("DELETE FROM notifier_source_transfer WHERE id=?", c.id),
    ...(confirmation ? [await confirmation(result.binding_id)] : []),
  ]);
}
