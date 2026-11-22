import { MAX_WATCH_TOPICS, type WatchConfig } from "../../shared/watch-contracts";
import type { Database } from "../db";
import { Context, locked } from "./context";
import { hex } from "./crypto";
import { NotifierError, UUID } from "./model";
import { localWatchConfig, syncWatches, watchConfigWrites } from "./watch-config";
import { completePairingInvitation, readPairingInvitation } from "./pairing-qr";
import { pairingLog } from "./pairing-log";

export class WatchError extends NotifierError {
  constructor(readonly code: string, message: string, status = 409) { super(message, 0, "", status); }
}
const digest = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const token = /^[A-Za-z0-9_-]{43}$/;

export function isAppPairingRequest(method: string, path: string) {
  return method === "POST" && path === "/api/app/v1/pair";
}

export async function directConfig(db: Database, accountID = 1): Promise<WatchConfig> {
  const state = await db.one<{ config_owner: string; ownership_committed: number; binding_id: string; account_id: number; blocked: string }>(
    "SELECT w.config_owner,w.ownership_committed,n.binding_id,n.account_id,n.blocked FROM watch_control w JOIN notifier n ON n.id=w.id WHERE w.id=?", accountID);
  const config = await localWatchConfig(db, accountID);
  if (!config || state.config_owner !== "assistant" || !state.ownership_committed || config.profile_id !== state.binding_id ||
      config.source_account_id !== state.account_id || ["pairing", "deleting"].includes(state.blocked))
    throw new WatchError("watch_direct_not_ready", "请先完成通知配对并更新助手连接状态");
  return config;
}

interface Client {
  notifier_id: number; id: string; token_hash: string; invitation_hash: string; profile_id: string; source_generation: number;
  account_id: number; label: string; revoked_at: number;
  device_id: string; binding_id: string; request_hash: string;
}

function notifierReceipt(config: WatchConfig, client: Pick<Client, "device_id" | "binding_id">) {
  return { paired: true, watch_management: true, device_id: client.device_id, binding_id: client.binding_id,
    connection_id: config.profile_id, source_account_id: config.source_account_id,
    assistant_id: config.assistant_id, source_generation: config.source_generation };
}

/** Normalize the allowed import fields before hashing: JSON object key order
 * may change when a persisted native request is encoded after an App restart. */
function pairingImport(value: unknown) {
  if (value === undefined) return undefined;
  const input = value as { profile_id: string; source_account_id: number; source_generation: number;
    following: boolean; topics: { topic_id: number; enabled: boolean }[] } | null;
  if (!input || typeof input !== "object" ||
      Object.keys(input).some(k => !["profile_id", "source_account_id", "source_generation", "following", "topics"].includes(k)) ||
      typeof input.profile_id !== "string" || !UUID.test(input.profile_id) || !positive(input.source_account_id) ||
      !positive(input.source_generation) || typeof input.following !== "boolean" || !Array.isArray(input.topics) ||
      input.topics.length > MAX_WATCH_TOPICS || input.topics.some(t => !t || typeof t !== "object" ||
        Object.keys(t).some(k => !["topic_id", "enabled"].includes(k)) || !positive(t.topic_id) || typeof t.enabled !== "boolean") ||
      new Set(input.topics.map(t => t.topic_id)).size !== input.topics.length)
    throw new WatchError("invalid_watch_import", "待迁移规则格式无效，尚未提交配对", 400);
  return { profile_id: input.profile_id, source_account_id: input.source_account_id, source_generation: input.source_generation,
    following: input.following, topics: input.topics.map(t => ({ topic_id: t.topic_id, enabled: t.enabled })) };
}

/** One App request completes personal delivery pairing and its direct management grant. */
export function pairNotifierApp(c: Context, data: Record<string, unknown>) {
  return pairingLog(
    c,
    "app",
    {},
    () => pairNotifierAppInner(c, data),
    () => "App 已连接助手",
  );
}

async function readNotifierPairing(c: Context, data: Record<string, unknown>) {
  if (Object.keys(data).some(k => !["code", "pairing_code", "device_id", "client_id", "client_secret", "source_account_id", "label", "import_config"].includes(k)) ||
      typeof data.code !== "string" || !/^V2N-[A-Za-z0-9_-]{24}$/.test(data.code) ||
      typeof data.pairing_code !== "string" || !/^V2E-[A-Za-z0-9_-]{24}$/.test(data.pairing_code) ||
      typeof data.client_id !== "string" || !UUID.test(data.client_id) || typeof data.device_id !== "string" || !UUID.test(data.device_id) ||
      typeof data.client_secret !== "string" || !token.test(data.client_secret) || !positive(data.source_account_id) ||
      typeof data.label !== "string" || !data.label.trim() || data.label.length > 80 ||
      [...data.label].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new WatchError("invalid_notifier_pairing", "通知助手连接内容无效", 400);
  const input = pairingImport(data.import_config);
  const state = await c.state();
  if (state?.blocked === "deleting") throw new WatchError("notifier_account_removing", "此账号正在移除，请重试移除以完成撤销", 409);
  if (state?.account_id !== data.source_account_id) throw new WatchError("notifier_account_mismatch", "App 与助手必须使用同一 V2EX 账号", 403);
  const secretHash = await digest(data.client_secret), codeHash = await digest(data.code), requestHash = await digest(JSON.stringify([data.pairing_code, data.device_id, data.source_account_id, data.label, input ?? null]));
  const existing = await c.db.one<Client | null>("SELECT * FROM watch_app_clients WHERE id=? OR token_hash=?", data.client_id, secretHash);
  if (existing) {
    const config = await directConfig(c.db, c.id);
    if (existing.notifier_id !== c.id || existing.id !== data.client_id || existing.revoked_at || existing.token_hash !== secretHash || existing.invitation_hash !== codeHash ||
        existing.request_hash !== requestHash || existing.device_id !== data.device_id || existing.profile_id !== config.profile_id ||
        existing.account_id !== config.source_account_id || existing.source_generation !== config.source_generation || !UUID.test(existing.binding_id))
      throw new WatchError("notifier_pairing_changed", "连接已变更或撤销，请重新生成二维码", 403);
    // Completed receipts survive QR expiry and replacement. The same secret
    // recovers a lost response; it cannot recreate a revoked management grant.
    return { receipt: notifierReceipt(config, existing) };
  }
  const direct = { pairingCode: data.pairing_code, deviceID: data.device_id, clientID: data.client_id, secretHash, requestHash };
  return { code: data.code, direct, input, codeHash, label: data.label.trim(), accountID: state.account_id };
}

async function pairNotifierAppInner(c: Context, data: Record<string, unknown>) {
  const pairing = await readNotifierPairing(c, data);
  if (pairing.receipt) return pairing.receipt;
  const { code, direct, input, codeHash, label, accountID } = pairing;
  if ((await c.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM watch_app_clients WHERE (revoked_at=0 AND device_id<>?) AND notifier_id=?`, direct.deviceID, c.id)).n >= 20)
    throw new WatchError("watch_client_limit", "管理设备已达 20 台，请先移除旧管理连接");
  const paired = await completePairingInvitation(c, code, direct);
  if (!paired.paired || !paired.device_id || !paired.device_binding_id)
    throw new WatchError("notifier_pairing_pending", "通知绑定尚未确认，请重试原连接请求");
  if (!await syncWatches(c, true)) throw new WatchError("notifier_pairing_pending", "通知绑定已提交，助手管理连接尚未确认，请重试原请求");
  let config = await directConfig(c.db, c.id);
  if (config.source_account_id !== accountID) throw new WatchError("notifier_account_mismatch", "助手账号已变更", 403);
  // A same-group source transfer may carry the App's last confirmed rules.
  // Existing rules or any edit history always win; ordinary re-pairing never
  // imports a different group's snapshot or revives an intentionally empty list.
  const untouched = !config.topics.length && !config.following.enabled &&
    !(await c.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM watch_local_operations WHERE (profile_id=?) AND profile_id=(SELECT binding_id FROM notifier WHERE id=?)`, config.profile_id, c.id)).n;
  const imported = untouched && input?.profile_id === config.profile_id && input.source_account_id === config.source_account_id &&
    positive(input.source_generation) && input.source_generation < config.source_generation
    ? importedConfig(input, config, Math.floor(c.now / 1000)) : null;
  await c.save([
    ...(imported ? await watchConfigWrites(c, config, imported) : []),
    // A new confirmed pairing replaces only this device's older management
    // credentials. Other clients and the existing notification queue remain.
    c.sql(`UPDATE watch_app_clients SET revoked_at=? WHERE (device_id=? AND revoked_at=0) AND notifier_id=?`, c.now, paired.device_id, c.id),
    c.sql(`INSERT INTO watch_app_clients(id,token_hash,invitation_hash,profile_id,source_generation,account_id,label,
      created_at,last_seen,device_id,binding_id,request_hash,notifier_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      direct.clientID, direct.secretHash, codeHash, config.profile_id, config.source_generation, config.source_account_id,
      label, c.now, c.now, paired.device_id, paired.device_binding_id, direct.requestHash, c.id),
  ]);
  if (imported) config = imported;
  return notifierReceipt(config, { device_id: paired.device_id, binding_id: paired.device_binding_id });
}
export async function authorizeWatchClient(db: Database, authorization: string | null) {
  const secret = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const client = secret ? await db.one<Client>("SELECT * FROM watch_app_clients WHERE token_hash=? AND revoked_at=0", await digest(secret)) : null;
  if (!client) throw new WatchError("watch_client_unauthorized", "关注管理连接已失效，请重新扫码连接助手", 401);
  const config = await directConfig(db, client.notifier_id);
  if (client.profile_id !== config.profile_id || client.account_id !== config.source_account_id || client.source_generation !== config.source_generation)
    throw new WatchError("watch_client_unauthorized", "助手或账号已更换，请重新扫码连接关注管理", 401);
  return client;
}

function importedConfig(value: unknown, config: WatchConfig, now: number): WatchConfig | null {
  if (value === undefined) return null;
  const input = value as { profile_id?: unknown; source_account_id?: unknown; source_generation?: unknown; following?: unknown; topics?: unknown } | null;
  if (!input || input.profile_id !== config.profile_id || input.source_account_id !== config.source_account_id ||
      !positive(input.source_generation) || input.source_generation > config.source_generation || typeof input.following !== "boolean" ||
      !Array.isArray(input.topics) || input.topics.length > MAX_WATCH_TOPICS ||
      input.topics.some(t => !t || !positive(t.topic_id) || typeof t.enabled !== "boolean" || Object.keys(t).some(k => !["topic_id", "enabled"].includes(k))) ||
      new Set(input.topics.map(t => t.topic_id)).size !== input.topics.length)
    throw new WatchError("invalid_watch_import", "待迁移规则与当前账号或助手来源不匹配", 400);
  if (input.source_generation === config.source_generation) return null;
  if (config.topics.length || config.following.enabled)
    throw new WatchError("watch_import_conflict", "新助手已有关注规则，未覆盖；请连接后手动核对规则");
  const revision = config.revision + 1;
  return { ...config, revision, applied_revision: revision,
    following: { enabled: input.following, epoch: revision, enabled_at: now },
    topics: input.topics.map(t => ({ topic_id: t.topic_id, enabled: t.enabled, epoch: revision, enabled_at: now })) };
}

export async function revokeWatchClient(c: Context, data: Record<string, unknown>) {
  if (typeof data.client_id !== "string" || !UUID.test(data.client_id)) throw new WatchError("invalid_watch_client", "连接编号无效", 400);
  await c.update(`UPDATE watch_app_clients SET revoked_at=? WHERE (id=? AND revoked_at=0) AND notifier_id=?`, c.now, data.client_id, c.id);
  return { reason: "关注管理连接已移除，该设备不能再读写规则" };
}

/** Lease fencing, rules, target resets and the idempotency receipt commit in one D1 transaction. */
export async function updateLocalWatches(c: Context, data: Record<string, unknown>) {
  const config = await directConfig(c.db, c.id);
  if (Object.keys(data).some(k => !["operation_id", "profile_id", "source_generation", "base_revision", "action", "topic_id", "enabled"].includes(k)) ||
      typeof data.operation_id !== "string" || !UUID.test(data.operation_id) || data.profile_id !== config.profile_id ||
      !positive(data.source_generation) || !natural(data.base_revision) ||
      !["add_topic", "remove_topic", "set_topic", "set_following"].includes(String(data.action)))
    throw new WatchError("invalid_watch_operation", "关注操作格式无效", 400);
  if (data.action === "set_following" ? data.topic_id !== undefined : !positive(data.topic_id))
    throw new WatchError("invalid_watch_topic", "请输入有效主题编号", 400);
  if (["set_topic", "set_following"].includes(String(data.action)) ? typeof data.enabled !== "boolean" : data.enabled !== undefined)
    throw new WatchError("invalid_watch_enabled", "关注状态格式无效", 400);
  const payloadHash = await digest(JSON.stringify([data.profile_id, data.source_generation, data.base_revision, data.action, data.topic_id ?? null, data.enabled ?? null]));
  const prior = await c.db.one<{ payload_hash: string; revision: number }>(
    `SELECT payload_hash,revision FROM watch_local_operations WHERE (profile_id=? AND operation_id=?) AND profile_id=(SELECT binding_id FROM notifier WHERE id=?)`, config.profile_id, data.operation_id, c.id);
  if (prior) {
    if (prior.payload_hash !== payloadHash) throw new WatchError("idempotency_conflict", "同一请求编号的内容不一致，未修改规则");
    return { ...config, operation_revision: prior.revision };
  }
  if (config.source_generation !== data.source_generation || config.revision !== data.base_revision)
    throw new WatchError("watch_revision_conflict", "规则已更新，请读取最新状态后重试");
  const next = structuredClone(config), revision = config.revision + 1, now = Math.floor(c.now / 1000);
  const topic = next.topics.find(t => t.topic_id === data.topic_id);
  if (data.action === "add_topic" && !topic) {
    if (next.topics.length >= MAX_WATCH_TOPICS) throw new WatchError("watch_topic_limit", "最多关注 20 篇帖子，暂停项也占名额");
    next.topics.push({ topic_id: Number(data.topic_id), enabled: true, epoch: revision, enabled_at: now });
  } else if (data.action === "remove_topic") next.topics = next.topics.filter(t => t.topic_id !== data.topic_id);
  else if (data.action === "set_topic") {
    if (!topic) throw new WatchError("watch_topic_missing", "这篇帖子已被移除，请刷新后核对", 404);
    if (topic.enabled !== data.enabled) { topic.enabled = Boolean(data.enabled); topic.epoch = revision; topic.enabled_at = now; }
  } else if (data.action === "set_following" && next.following.enabled !== data.enabled)
    next.following = { enabled: Boolean(data.enabled), epoch: revision, enabled_at: now };
  next.revision = revision; next.applied_revision = revision; next.topics.sort((a, b) => a.topic_id - b.topic_id);
  await c.save([
    ...await watchConfigWrites(c, config, next),
    c.sql("INSERT INTO watch_local_operations(profile_id,operation_id,payload_hash,revision,created_at) VALUES(?,?,?,?,?)",
      config.profile_id, data.operation_id, payloadHash, revision, c.now),
    c.sql("UPDATE watch_control SET next_sync=CASE WHEN EXISTS(SELECT 1 FROM watch_cancellations) THEN 0 ELSE next_sync END WHERE id=?", c.id),
  ]);
  return { ...await directConfig(c.db, c.id), operation_revision: revision };
}

export async function updateWatches(c: Context, data: Record<string, unknown>) {
  return { ...await updateLocalWatches(c, data), reason: "助手已保存关注规则" };
}

export async function watchAppRequest(request: Request, c: Context, readBody: () => Promise<Record<string, unknown>>) {
  const path = new URL(request.url).pathname;
  if (isAppPairingRequest(request.method, path)) {
    const data = await readBody();
    if (!positive(data.source_account_id)) throw new WatchError("invalid_notifier_pairing", "通知助手连接内容无效", 400);
    const account = await c.db.one<{ id: number }>("SELECT id FROM notifier WHERE account_id=?", data.source_account_id);
    if (!account) throw new WatchError("notifier_account_mismatch", "请先在助手中添加 App 当前登录的 V2EX 账号", 403);
    const accountContext = c.forAccount(account.id);
    // Invalid requests must never take the lease. Mutating claims recheck
    // the same state under the lease in case the invitation changed.
    const pairing = await readNotifierPairing(accountContext, data);
    if (pairing.receipt) return pairing.receipt;
    await readPairingInvitation(accountContext, pairing.code, pairing.direct);
    return locked(c.db, c.env, context => pairNotifierApp(context, data), c.fetcher, c.now, false, account.id);
  }
  if (path !== "/api/app/v1/watches") throw new WatchError("not_found", "接口不存在", 404);
  const authorized = await authorizeWatchClient(c.db, request.headers.get("Authorization"));
  if (request.method === "GET") return directConfig(c.db, authorized.notifier_id);
  if (request.method !== "PUT") throw new WatchError("method_not_allowed", "请求方法无效", 405);
  const data = await readBody();
  return locked(c.db, c.env, async lockedContext => {
    const client = await authorizeWatchClient(c.db, request.headers.get("Authorization"));
    if (client.notifier_id !== lockedContext.id) throw new WatchError("watch_client_unauthorized", "关注管理连接已变更", 401);
    const result = await updateLocalWatches(lockedContext, data);
    await lockedContext.update("UPDATE watch_app_clients SET last_seen=? WHERE id=? AND notifier_id=?", lockedContext.now, client.id, client.notifier_id);
    return result;
  }, undefined, c.now, false, authorized.notifier_id);
}
