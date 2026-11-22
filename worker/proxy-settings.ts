import type { Database } from "./db";
import type { Env } from "./types";
import { open, seal, storageReady } from "./notifier/crypto";
import {
  parseProxyUpdate,
  ProxySettingsError,
  type HttpProxyConfig,
  type HttpProxyStatus,
} from "./http-proxy";

interface StoredProxy {
  enabled: number;
  address: string;
  authenticated: number;
  payload: string;
}
const read = (db: Database) =>
  db.one<StoredProxy>("SELECT * FROM http_proxy WHERE id=1");
const purpose = "outbound-http-proxy";

function status(row: StoredProxy, env: Env): HttpProxyStatus {
  return {
    enabled: Boolean(row.enabled),
    configured: Boolean(row.payload),
    encryption_ready: storageReady(env),
    address: row.address,
    authenticated: Boolean(row.authenticated),
  };
}
async function decrypt(row: StoredProxy, env: Env): Promise<HttpProxyConfig> {
  try {
    const input = await open<HttpProxyConfig>(env, purpose, row.payload);
    const config = parseProxyUpdate({ ...input, enabled: true }).config;
    if (!config) throw new Error();
    return config;
  } catch {
    throw new ProxySettingsError(
      "代理设置无法解密，请恢复加密密钥或重新保存代理",
    );
  }
}
export async function proxySettings(
  db: Database,
  env: Env,
): Promise<HttpProxyStatus> {
  return status(await read(db), env);
}
export async function loadHttpProxy(
  db: Database,
  env: Env,
): Promise<HttpProxyConfig | null> {
  const row = await read(db);
  return row.enabled ? decrypt(row, env) : null;
}

/** Test a draft or the saved proxy without saving it or changing its enabled state. */
export async function proxyTestConfig(
  db: Database,
  env: Env,
  input: unknown,
): Promise<HttpProxyConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["address", "username", "password"].includes(key)))
    throw new ProxySettingsError("代理测试参数无效");
  const update = parseProxyUpdate({ ...input, enabled: true });
  if (update.config) return update.config;
  const row = await read(db);
  if (!row.payload) throw new ProxySettingsError("请先填写或保存代理配置");
  return decrypt(row, env);
}

export async function updateHttpProxy(
  db: Database,
  env: Env,
  input: unknown,
): Promise<HttpProxyStatus> {
  const update = parseProxyUpdate(input);
  if (update.remove) {
    await db.run(
      "UPDATE http_proxy SET enabled=0,address='',authenticated=0,payload='' WHERE id=1",
    );
    return proxySettings(db, env);
  }
  if (update.config) {
    if (!storageReady(env))
      throw new ProxySettingsError("请先配置有效的 NOTIFIER_KEY 加密密钥");
    const payload = await seal(env, purpose, update.config);
    await db.run(
      "UPDATE http_proxy SET enabled=?,address=?,authenticated=?,payload=? WHERE id=1",
      Number(update.enabled),
      update.config.address,
      Number(Boolean(update.config.username)),
      payload,
    );
  } else if (update.enabled) {
    const row = await read(db);
    if (!row.payload) throw new ProxySettingsError("请先保存 HTTP 代理");
    await decrypt(row, env);
    const result = await db.run(
      "UPDATE http_proxy SET enabled=1 WHERE id=1 AND payload=?",
      row.payload,
    );
    if (!result.meta.changes)
      throw new ProxySettingsError("代理设置已变更，请刷新后重试");
  } else {
    await db.run("UPDATE http_proxy SET enabled=0 WHERE id=1");
  }
  return proxySettings(db, env);
}
