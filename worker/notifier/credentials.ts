import type { CredentialStatus } from "../../shared/contracts";
import type { Database } from "../db";
import type { Env } from "../types";
import type { Context } from "./context";
import { open, seal, storageReady } from "./crypto";
import { cookieHeader } from "./http";
import { NotifierError } from "./model";
import { probeIdentity } from "./pairing";

interface Credentials {
  cookie: string;
  pat: string;
}
interface StoredCredentials {
  payload: string;
  updated_at: number;
  encryption_version: number;
}
const purpose = "v2ex-credentials";
const read = (db: Database, id: number) =>
  db.one<StoredCredentials | undefined>(
    "SELECT payload,updated_at,encryption_version FROM notifier_credentials WHERE id=?", id,
  );

function parseCookie(value: unknown): string {
  if (typeof value !== "string")
    throw new NotifierError("请输入完整的 Cookie 请求头", 0, "", 400);
  try {
    return cookieHeader(value);
  } catch {
    throw new NotifierError("Cookie 请求头格式无效", 0, "", 400);
  }
}
function parsePAT(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value))
    throw new NotifierError("PAT 须为不含空白的有效文本，最多 4096 字符", 0, "", 400);
  return value;
}
export function validateCredentials(cookie: unknown, pat: unknown): Credentials {
  const credentials = { cookie: parseCookie(cookie), pat: parsePAT(pat) };
  if (new TextEncoder().encode(JSON.stringify(credentials)).length > 32768)
    throw new NotifierError("Cookie 与 PAT 合计内容超出 32 KiB 存储限制", 0, "", 400);
  return credentials;
}

export async function credentialStatus(db: Database, env: Env, id = 1): Promise<CredentialStatus> {
  const row = await read(db, id);
  // Presence is configuration metadata; the management page never decrypts a secret.
  return row
    ? { cookie: true, pat: true, source: "settings", updated_at: row.updated_at }
    : { cookie: id === 1 && Boolean(env.V2EX_COOKIE), pat: id === 1 && Boolean(env.V2EX_PAT), source: "secrets", updated_at: 0 };
}

export async function loadCredentialEnv(db: Database, env: Env, id = 1): Promise<Env> {
  const row = await read(db, id);
  if (!row) return id === 1 ? env : { ...env, V2EX_COOKIE: undefined, V2EX_PAT: undefined };
  try {
    if (row.encryption_version !== 2 && !(id === 1 && row.encryption_version === 1)) throw new Error("credential format");
    const saved = await open<Credentials>(env, row.encryption_version === 2 ? `${purpose}:${id}` : purpose, row.payload, 32768);
    const credentials = validateCredentials(saved?.cookie, saved?.pat);
    return { ...env, V2EX_COOKIE: credentials.cookie, V2EX_PAT: credentials.pat };
  } catch {
    // A saved override must never silently fall back to older deployment secrets.
    // This record alone cannot prove a global key failure. Credential loading
    // already stops the operation; retain any independently known storage block.
    throw new NotifierError("已保存的 Cookie 和 PAT 无法读取，请恢复原 NOTIFIER_KEY 或重新保存两项凭据");
  }
}

export async function updateCredentials(c: Context, data: Record<string, unknown>) {
  const hasCookie = Object.hasOwn(data, "cookie");
  const hasPAT = Object.hasOwn(data, "pat");
  if ((!hasCookie && !hasPAT) || Object.keys(data).some(key => !["cookie", "pat"].includes(key)))
    throw new NotifierError("请至少填写一项要更新的凭据", 0, "", 400);
  const cookie = hasCookie ? parseCookie(data.cookie) : undefined;
  const pat = hasPAT ? parsePAT(data.pat) : undefined;
  if (!storageReady(c.env))
    throw new NotifierError("请先配置 NOTIFIER_KEY 加密密钥", 0, "", 503);
  // Supplying both fields can repair a damaged saved record without reading it.
  const current = hasCookie && hasPAT ? c.env : await c.credentials();
  const credentials = validateCredentials(
    cookie ?? current.V2EX_COOKIE,
    pat ?? current.V2EX_PAT,
  );
  const candidate = c.withCredentials(credentials.cookie, credentials.pat);
  const { member, count, avatar, scope } = await probeIdentity(candidate);
  const updatedAt = c.now;
  const payload = await seal(c.env, `${purpose}:${c.id}`, credentials);
  await c.save([
    c.sql(
      "INSERT INTO notifier_credentials(id,payload,updated_at,encryption_version) VALUES(?,?,?,2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,encryption_version=2",
      c.id,
      payload,
      updatedAt,
    ),
    c.sql("DELETE FROM notification_candidates WHERE notifier_id=?", c.id),
    c.sql(
      `UPDATE notifier SET account_id=?,username=?,avatar_url=COALESCE(NULLIF(?,''),avatar_url),credential_scope=?,verified_at=?,unread=?,observed_at=?,scan_stage='idle',scan_id='',scan_page=1,scan_collected=0,scan_head='[]',scan_min=0,next_scan=0,last_scan=0,blocked=CASE WHEN blocked='credentials' THEN '' ELSE blocked END WHERE id=?`,
      member.id,
      member.username,
      avatar,
      scope,
      updatedAt,
      count,
      updatedAt,
      c.id,
    ),
  ]);
  return { reason: "Cookie 与 PAT 已验证并加密保存" };
}
