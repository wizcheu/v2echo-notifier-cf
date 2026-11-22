import { digest } from "./parsers";
import type { Env } from "./types";

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_NAME = "v2echo_notifier_session";
const encoder = new TextEncoder();
type SessionEnv = Pick<Env, "ADMIN_TOKEN">;

export async function validAdminToken(value: unknown, env: SessionEnv) {
  if (
    !env.ADMIN_TOKEN ||
    env.ADMIN_TOKEN.length < 32 ||
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 505
  )
    return false;
  const [actual, expected] = await Promise.all([
    digest(value),
    digest(env.ADMIN_TOKEN),
  ]);
  let different = 0;
  for (let i = 0; i < actual.length; i++)
    different |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return different === 0;
}

async function signingKey(env: SessionEnv) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.ADMIN_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSession(env: SessionEnv, now = Date.now()) {
  const payload = `v1.${Math.floor(now / 1000) + SESSION_SECONDS}.${crypto.randomUUID()}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(env),
      encoder.encode(payload),
    ),
  );
  return `${payload}.${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function validSession(
  value: string,
  env: SessionEnv,
  now = Date.now(),
) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const match = /^(v1\.(\d{1,12})\.[0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(value);
  const seconds = Math.floor(now / 1000);
  if (
    !match ||
    Number(match[2]) <= seconds ||
    Number(match[2]) > seconds + SESSION_SECONDS
  )
    return false;
  const signature = Uint8Array.from(match[3].match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(env),
    signature,
    encoder.encode(match[1]),
  );
}

export function sessionCookie(value: string, secure: boolean) {
  return `${COOKIE_NAME}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${value ? SESSION_SECONDS : 0}${secure ? "; Secure" : ""}`;
}

export async function authorized(request: Request, env: SessionEnv) {
  const header = request.headers.get("Authorization");
  // Keep explicit Bearer authentication for existing API clients.
  if (header !== null)
    return (
      header.startsWith("Bearer ") &&
      (await validAdminToken(header.slice(7), env))
    );
  const cookie =
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1) ?? "";
  return validSession(cookie, env);
}

export function sameOriginSessionRequest(request: Request) {
  return (
    request.headers.get("Origin") === new URL(request.url).origin &&
    request.headers.get("X-Notifier-Request") === "1"
  );
}
