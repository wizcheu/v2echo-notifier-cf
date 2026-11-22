import type { PairingConfirmation, PairingInvitation } from "../../shared/contracts";
import type { Context } from "./context";
import { open, randomToken, seal } from "./crypto";
import { relayRequest } from "./http";
import { NotifierError } from "./model";
import { credentialScope, pairingIdentity, retirePendingSender, savePairing } from "./pairing";
import { watchInstance } from "./watch-config";

interface PendingTransfer { code: string; sender: string; account: number; username: string; scope: string; registered: boolean; completed?: string; }
const purpose = "source-transfer";
const read = (c: Context) => c.db.one<{ content_enc: string; expires_at: number }>("SELECT * FROM notifier_source_transfer WHERE id=?", c.id);
const persist = async (c: Context, value: PendingTransfer, expires: number) => c.sql(
  "INSERT INTO notifier_source_transfer(id,content_enc,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET content_enc=excluded.content_enc,expires_at=excluded.expires_at",
  c.id, await seal(c.env, purpose, value), expires,
);

export async function createSourceTransfer(c: Context): Promise<PairingInvitation> {
  const prior = await c.state();
  if (prior.binding_id) throw new NotifierError("此助手已经绑定；请在新的未绑定助手上生成更换码");
  if (prior.pair_until > c.now) throw new NotifierError("请求已暂停，请稍后重试", prior.pair_until);
  const account = await pairingIdentity(c, prior), scope = await credentialScope(c);
  const saved = await read(c);
  let pending = saved ? await open<PendingTransfer>(c.env, purpose, saved.content_enc) : null;
  if (pending && (pending.account !== account.id || pending.scope !== scope)) throw new NotifierError("账号凭据已变更，请恢复原凭据后检查更换结果");
  let expires = saved?.expires_at ?? c.now + 600000;
  if (pending && expires <= c.now && !pending.completed) {
    // A completed transfer can outlive the invitation. Recover its durable receipt before replacing secrets.
    try {
      const result = await completeSourceTransfer(c, pending.code);
      if (result.paired) throw new NotifierError("已恢复更换结果，请启动通知服务并同步规则");
    } catch (error) {
      if (!(error instanceof NotifierError) || error.upstreamStatus !== 403) throw error;
    }
    await retirePendingSender(c, pending);
    pending = null; expires = c.now + 600000;
  }
  pending ??= { code: `V2T-${randomToken(18)}`, sender: randomToken(), account: account.id, username: account.username, scope, registered: false };
  const instance = await watchInstance(c);
  if (!pending.registered) {
    await c.save([await persist(c, pending, expires), c.sql("UPDATE notifier SET pair_until=? WHERE id=?", c.now + 30000, c.id)]);
    const result = (await relayRequest(c, "/v1/source-transfers", instance.secret, {
      code: pending.code, assistant_id: instance.id, sender_token: pending.sender, source_account_id: account.id, username: account.username, pairing_policy: "explicit",
    })).data as { expires_at?: string };
    const remote = Date.parse(result.expires_at ?? "");
    if (!Number.isFinite(remote) || remote <= c.now || remote > c.now + 600000) throw new NotifierError("更换码有效期响应无效");
    expires = Math.min(expires, remote); pending.registered = true;
    await c.save([await persist(c, pending, expires), c.sql("UPDATE notifier SET pair_until=0 WHERE id=?", c.id)]);
  }
  return { code: pending.code, payload: `v2echo://push-pair?code=${pending.code}`, expires_at: expires };
}

export async function completeSourceTransfer(c: Context, code: unknown): Promise<PairingConfirmation> {
  const saved = await read(c);
  if (!saved || typeof code !== "string") throw new NotifierError("请先生成更换助手码");
  const pending = await open<PendingTransfer>(c.env, purpose, saved.content_enc), prior = await c.state();
  if (pending.code !== code || !pending.registered || pending.scope !== await credentialScope(c) || pending.account !== prior.account_id) {
    throw new NotifierError("更换码或账号不匹配，原状态已保留");
  }
  if (pending.completed && prior.binding_id === pending.completed) return { paired: true, reason: "更换已完成" };
  if (prior.pair_until > c.now) throw new NotifierError("请求已暂停，请稍后重试", prior.pair_until);
  await c.update("UPDATE notifier SET pair_until=? WHERE id=?", c.now + 30000, c.id);
  const instance = await watchInstance(c);
  const response = (await relayRequest(c, "/v1/source-transfers/exchange", instance.secret, { code })).data as { paired?: boolean };
  if (response.paired === false) return { paired: false, reason: "请先在已绑定旧助手的 App 上确认更换，再检查结果" };
  await savePairing(c, pending, response, binding => persist(c, { ...pending, completed: binding }, saved.expires_at));
  await c.save([c.sql("UPDATE watch_control SET published_binding='',config='',next_sync=0 WHERE id=?", c.id), c.sql(`DELETE FROM watch_targets WHERE notifier_id=?`, c.id), c.sql(`UPDATE watch_app_clients SET revoked_at=? WHERE (revoked_at=0) AND notifier_id=?`, c.now, c.id), c.sql("DELETE FROM watch_app_invitation WHERE id=?", c.id)]);
  return { paired: true, reason: "助手已更换，接收设备已保留；请连接 App 关注管理以迁入已确认规则，再启动检查" };
}
