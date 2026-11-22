import type { Env } from "../types";
import { NotifierError, UUID, type Content, type Recipient } from "./model";
const utf8 = new TextEncoder();
export function base64(bytes: Uint8Array) {
  // Encrypted scan progress can be hundreds of KiB; avoid the argument-count limit.
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function unbase64(value: string, length?: number, maxLength = 16384) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > maxLength)
    throw new NotifierError("加密数据格式无效");
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (
    base64(bytes) !== value ||
    (length !== undefined && bytes.length !== length)
  )
    throw new NotifierError("加密数据长度无效");
  return bytes;
}
export const randomToken = (length = 32) =>
  base64(crypto.getRandomValues(new Uint8Array(length)));
export const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export function storageReady(env: Env) {
  return /^[0-9a-f]{64}$/.test(env.NOTIFIER_KEY ?? "");
}
async function storageKey(env: Env) {
  if (!storageReady(env))
    throw new NotifierError(
      "请先配置独立的 NOTIFIER_KEY（32 字节十六进制密钥）",
      0,
      "",
      503,
    );
  const bytes = Uint8Array.from(env.NOTIFIER_KEY!.match(/../g)!, (x) =>
    parseInt(x, 16),
  );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(env: Env, purpose: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: utf8.encode(`V2EchoCF/1/${purpose}`),
    },
    await storageKey(env),
    utf8.encode(JSON.stringify(value)),
  );
  return `1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function open<T>(
  env: Env,
  purpose: string,
  value: string,
  maxPlaintextBytes = 12272,
): Promise<T> {
  try {
    const [version, iv, ciphertext, extra] = value.split(".");
    if (version !== "1" || extra) throw new Error();
    const raw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64(iv, 12),
        additionalData: utf8.encode(`V2EchoCF/1/${purpose}`),
      },
      await storageKey(env),
      unbase64(ciphertext, undefined, Math.ceil((maxPlaintextBytes + 16) * 4 / 3)),
    );
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new NotifierError(
      "持久化数据解密失败；请恢复原 NOTIFIER_KEY",
      0,
      "storage",
    );
  }
}
export const excerpt = (value: string, fallback: string, limit: number) => {
  const chars = [...(value.trim() ? value : fallback)];
  return chars.length > limit
    ? chars.slice(0, limit).join("") + "…"
    : chars.join("");
};
export async function validateRecipients(
  value: unknown,
  account: number,
): Promise<Recipient[]> {
  const data = value as {
    source_account_id?: number;
    recipients?: Recipient[];
  };
  if (
    !data ||
    data.source_account_id !== account ||
    !Array.isArray(data.recipients) ||
    data.recipients.length > 10
  )
    throw new NotifierError("收件设备目录无效，保留队列等待重试");
  const seen = new Set<string>();
  for (const r of data.recipients) {
    if (
      !r ||
      !UUID.test(r.device_id) ||
      !UUID.test(r.binding_id) ||
      seen.has(r.device_id) ||
      typeof r.public_key !== "string"
    )
      throw new NotifierError("收件设备公钥格式无效");
    const bytes = unbase64(r.public_key, 32);
    if (
      bytes.every((b) => b === 0) ||
      r.key_id !== hex(await crypto.subtle.digest("SHA-256", bytes))
    )
      throw new NotifierError("收件设备公钥校验失败");
    seen.add(r.device_id);
  }
  return data.recipients;
}
/** Byte-compatible with the Docker helper and Apple notification extension. */
export async function encryptContent(
  eventID: string,
  account: number,
  content: Content,
  r: Recipient,
) {
  const recipientBytes = unbase64(r.public_key, 32);
  const recipient = await crypto.subtle.importKey(
    "raw",
    recipientBytes,
    "X25519",
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey("X25519", true, [
    "deriveBits",
  ]);
  if (!("privateKey" in ephemeral))
    throw new Error("X25519 did not return a key pair");
  const agreement = { name: "X25519", public: recipient };
  const shared = await crypto.subtle.deriveBits(
    agreement,
    ephemeral.privateKey,
    256,
  );
  const aad = utf8.encode(
    `V2EchoPushContent/v2\n${eventID}\n${account}\n${r.device_id}\n${r.binding_id}\n${r.key_id}`,
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: await crypto.subtle.digest("SHA-256", recipientBytes),
      info: aad,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const title = utf8.encode(excerpt(content.title, "V2Echo 通知", 100));
  const body = utf8.encode(excerpt(content.body, "打开应用查看详情", 180));
  const plaintext = new Uint8Array(2 + title.length + body.length);
  new DataView(plaintext.buffer).setUint16(0, title.length, false);
  plaintext.set(title, 2);
  plaintext.set(body, 2 + title.length);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    plaintext,
  );
  const publicBytes = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  if (!(publicBytes instanceof ArrayBuffer))
    throw new Error("X25519 raw key export failed");
  return {
    device_id: r.device_id,
    binding_id: r.binding_id,
    key_id: r.key_id,
    ephemeral_key: base64(new Uint8Array(publicBytes)),
    nonce: base64(nonce),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}
