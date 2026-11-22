import type {
  PairingConfirmation,
  PairingInvitation,
} from "../../shared/contracts";
import type { Context } from "./context";
import { hex, open, randomToken, seal } from "./crypto";
import { relayRequest } from "./http";
import { NotifierError, UUID } from "./model";
import { pairingError, pairingEvent, pairingLog } from "./pairing-log";
import { credentialScope, pairingIdentity, retirePendingSender, savePairing } from "./pairing";
import { syncWatches } from "./watch-config";

const invitationCode = /^V2N-[A-Za-z0-9_-]{24}$/;
const purpose = "pairing-invitation";
interface Invitation {
  code: string;
  sender: string;
  account: number;
  username: string;
  scope: string;
  registered: boolean;
  completedBinding?: string;
  connectionBinding?: string;
  direct?: true;
  directClaim?: { clientID: string; secretHash: string; proofHash: string; deviceID: string; requestHash: string };
  completedDeviceID?: string;
  completedDeviceBinding?: string;
}
interface SavedInvitation {
  content_enc: string;
  expires_at: number;
}
async function load(c: Context) {
  return c.db.one<SavedInvitation | null>(
    "SELECT content_enc,expires_at FROM notifier_pairing_invitation WHERE id=?", c.id,
  );
}
async function save(c: Context, invitation: Invitation, expires: number) {
  return c.sql(
    "INSERT INTO notifier_pairing_invitation(id,content_enc,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET content_enc=excluded.content_enc,expires_at=excluded.expires_at",
    c.id,
    await seal(c.env, purpose, invitation),
    expires,
  );
}
async function request(
  c: Context,
  path: string,
  invitation: Invitation,
  body: unknown,
) {
  await c.update("UPDATE notifier SET pair_until=? WHERE id=?", c.now + 30000, c.id);
  try {
    const response = await relayRequest(c, path, invitation.sender, body);
    pairingEvent("relay", "ok", { path });
    return response;
  } catch (error) {
    pairingEvent("relay", "error", { path, ...pairingError(error) });
    if (error instanceof NotifierError) {
      // A dead invitation can never be retried: drop it and relax the cooldown
      // to any upstream Retry-After exactly (the pre-set 30s pause is meant for
      // a live request), so the next click generates a fresh QR at once.
      await c.save(
        error.status === 410
          ? [
              c.sql("UPDATE notifier SET pair_until=? WHERE id=?", error.retryAt, c.id),
              c.sql("DELETE FROM notifier_pairing_invitation WHERE id=?", c.id),
            ]
          : [
              c.sql(
                "UPDATE notifier SET pair_until=MAX(pair_until,?) WHERE id=?",
                error.retryAt, c.id,
              ),
            ],
      );
    }
    throw error;
  }
}
const view = (invitation: Invitation, expires: number): PairingInvitation => ({
  code: invitation.code,
  expires_at: expires,
  direct: true,
});

export function createPairingInvitation(
  c: Context,
  joinExisting = false,
): Promise<PairingInvitation> {
  return pairingLog(
    c,
    "qr",
    { join: joinExisting },
    () => createPairingInvitationInner(c, joinExisting),
    () => "已生成配对二维码，等待 App 扫码",
  );
}

async function createPairingInvitationInner(
  c: Context,
  joinExisting: boolean,
): Promise<PairingInvitation> {
  const prior = await c.state();
  if (prior.pair_until > c.now)
    throw new NotifierError("配对请求已暂停，请稍后重试", prior.pair_until);
  const member = await pairingIdentity(c, prior);
  const health = (await relayRequest(c, "/v1/health")).data as { notifier_direct_pairing?: unknown } | null;
  if (health?.notifier_direct_pairing !== 1) throw new NotifierError("请先升级推送服务，再生成 App 连接二维码");
  if (joinExisting && (!prior.binding_id || !await syncWatches(c, true)))
    throw new NotifierError("请先完成助手来源登记，再添加接收设备");
  const scope = await credentialScope(c);
  const saved = await load(c);
  const old = saved ? await open<Invitation>(c.env, purpose, saved.content_enc) : undefined;
  let invitation: Invitation | undefined;
  let expires = c.now + 600000;
  if (saved && old && saved.expires_at > c.now) {
    if (
      !old.completedBinding &&
      old.account === member.id &&
      old.username === member.username &&
      old.scope === scope
      && Boolean(old.connectionBinding) === joinExisting
      && old.direct === true
      && (!joinExisting || old.connectionBinding === prior.binding_id)
    ) {
      invitation = old;
      expires = saved.expires_at;
    }
  }
  // Reloading the page and explicitly generating again recovers the same QR.
  if (invitation?.registered) return view(invitation, expires);
  if (old && !invitation) await retirePendingSender(c, old);
  invitation ??= {
    code: `V2N-${randomToken(18)}`,
    sender: joinExisting ? await open<string>(c.env, `sender:${prior.binding_id}`, prior.sender_enc) : randomToken(),
    account: member.id,
    username: member.username,
    scope,
    registered: false,
    direct: true,
    ...(joinExisting ? { connectionBinding: prior.binding_id } : {}),
  };
  // Both secrets exist durably before the first network attempt.
  await c.save([await save(c, invitation, expires)]);
  const { data } = await request(c, joinExisting ? "/v1/connection-invitations" : "/v1/invitations", invitation, {
    code: invitation.code,
    ...(!joinExisting ? { source_account_id: invitation.account, source_username: invitation.username } : {}),
  });
  const remote = data as { expires_at?: unknown } | null;
  const remoteExpires =
    typeof remote?.expires_at === "string"
      ? Date.parse(remote.expires_at)
      : NaN;
  if (
    !Number.isFinite(remoteExpires) ||
    remoteExpires <= c.now ||
    remoteExpires > c.now + 600000
  )
    throw new NotifierError("邀请码有效期响应无效，请重试原请求");
  // A retry cannot extend the original local lifetime.
  expires = Math.min(expires, remoteExpires);
  invitation.registered = true;
  await c.save([
    await save(c, invitation, expires),
    c.sql("UPDATE notifier SET pair_until=0 WHERE id=?", c.id),
  ]);
  return view(invitation, expires);
}

type DirectPairing = {
  pairingCode: string;
  deviceID: string;
  clientID: string;
  secretHash: string;
  requestHash: string;
};

export function completePairingInvitation(
  c: Context,
  code: unknown,
  direct: DirectPairing,
): Promise<PairingConfirmation & { device_id?: string; device_binding_id?: string }> {
  return pairingLog(
    // The App request wraps this step and records the whole attempt once.
    null,
    "complete",
    {},
    () => completePairingInvitationInner(c, code, direct),
    (result) => result.paired ? "配对确认成功" : "通知绑定尚未确认",
    (result) => ({ paired: result.paired }),
  );
}

/** Read-only check usable before the App request competes for the shared lease. */
export async function readPairingInvitation(
  c: Context,
  code: unknown,
  direct: DirectPairing,
) {
  if (typeof code !== "string" || !invitationCode.test(code))
    throw new NotifierError("请使用当前助手生成的二维码", 0, "", 400);
  const saved = await load(c);
  if (!saved) throw new NotifierError("二维码已过期，请重新生成并扫码", 0, "", 400);
  const invitation = await open<Invitation>(c.env, purpose, saved.content_enc);
  if (saved.expires_at <= c.now && !(invitation.completedBinding && invitation.directClaim))
    throw new NotifierError("二维码已过期，请重新生成并扫码", 0, "", 400);
  const prior = await c.state();
  if (
    !prior || invitation.code !== code ||
    !invitation.registered ||
    invitation.account !== prior.account_id ||
    invitation.username !== prior.username ||
    invitation.scope !== (await credentialScope(c))
    || (invitation.connectionBinding !== undefined && invitation.connectionBinding !== prior.binding_id)
  )
    throw new NotifierError(
      "二维码或账号凭据已变更，请重新生成并扫码",
      0,
      "",
      400,
    );
  if (invitation.direct !== true)
    throw new NotifierError("请在通知助手重新生成 App 连接二维码", 0, "", 400);
  const claim = { clientID: direct.clientID, secretHash: direct.secretHash,
    proofHash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(direct.pairingCode))),
    deviceID: direct.deviceID, requestHash: direct.requestHash };
  const previousClaim = invitation.directClaim;
  if (previousClaim && (Object.keys(claim) as (keyof typeof claim)[]).some(key => claim[key] !== previousClaim[key]))
    throw new NotifierError("二维码已由另一台设备使用，请重新生成", 0, "", 403);
  return { saved, invitation, prior, claim };
}

async function completePairingInvitationInner(
  c: Context,
  code: unknown,
  direct: DirectPairing,
): Promise<PairingConfirmation & { device_id?: string; device_binding_id?: string }> {
  const { saved, invitation, prior, claim } = await readPairingInvitation(c, code, direct);
  if (!invitation.directClaim) {
    // Persist the claimant before any remote operation; failed/late retries
    // cannot hand this invitation to a second device or credential.
    invitation.directClaim = claim;
    await c.save([await save(c, invitation, saved.expires_at)]);
  }
  if (invitation.completedBinding) {
    if (prior.binding_id !== invitation.completedBinding)
      throw new NotifierError("接收设备已变更，请重新生成二维码", 0, "", 400);
    return { paired: true, reason: "已完成绑定，无需重复确认。",
      device_id: invitation.completedDeviceID, device_binding_id: invitation.completedDeviceBinding };
  }
  if (prior.pair_until > c.now)
    throw new NotifierError("配对请求已暂停，请稍后重试", prior.pair_until);
  const member = await pairingIdentity(c, prior);
  if (
    member.id !== invitation.account ||
    member.username.toLowerCase() !== invitation.username.toLowerCase()
  )
    throw new NotifierError("账号状态已变更，请重新生成二维码", 0, "", 400);
  const { data } = await request(c, invitation.connectionBinding ? "/v1/connection-invitations/exchange" : "/v1/invitations/exchange", invitation, {
    code,
    pairing_code: direct.pairingCode,
  });
  if (
    data &&
    typeof data === "object" &&
    "paired" in data &&
    data.paired === false
  )
    return {
      paired: false,
      reason: "通知绑定尚未确认，请在 App 重试原请求。",
    };
  const device = data as { device_id?: unknown; device_binding_id?: unknown } | null;
  if (device?.device_id !== direct.deviceID || typeof device.device_binding_id !== "string" || !UUID.test(device.device_binding_id))
    throw new NotifierError("设备绑定回执不匹配，请重试原连接请求");
  invitation.completedDeviceID = device.device_id;
  invitation.completedDeviceBinding = device.device_binding_id;
  // The local success receipt, connection and queue changes commit together.
  if (invitation.connectionBinding) {
    const result = data as { paired?: unknown; joined?: unknown; binding_id?: unknown; username?: unknown } | null;
    if (result?.paired !== true || result.joined !== true || result.binding_id !== prior.binding_id ||
        typeof result.username !== "string" || result.username.toLowerCase() !== prior.username.toLowerCase())
      throw new NotifierError("添加设备的响应不匹配，原连接已保留");
    await c.save([await save(c, { ...invitation, completedBinding: prior.binding_id }, saved.expires_at),
      c.sql("UPDATE notifier SET pair_until=0 WHERE id=?", c.id)]);
    return { paired: true, reason: "设备已加入现有连接；原设备、关注规则与通知进度均保留。",
      device_id: device.device_id, device_binding_id: device.device_binding_id };
  }
  await savePairing(c, invitation, data, (binding) =>
    save(c, { ...invitation, completedBinding: binding }, saved.expires_at),
  );
  return {
    paired: true,
    reason: "配对成功，可以启动真实通知。原有去重记录已保留。",
    device_id: device.device_id, device_binding_id: device.device_binding_id,
  };
}
