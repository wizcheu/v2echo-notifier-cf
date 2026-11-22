import type { Client } from "tunnelfetch";
/* eslint-disable no-control-regex -- Proxy addresses and Basic credentials must reject control bytes. */

import type { HttpProxyConfig } from "../shared/proxy-types";
export type { HttpProxyConfig, HttpProxyStatus } from "../shared/proxy-types";

export class ProxySettingsError extends Error {}
export class HttpProxyRequestError extends Error {}

// Only fixed codes/reasons may reach logs or the UI; never forward library messages/details.
const proxyFailureReasons = new Map(
  [
    ["PROXY_AUTH_REQUIRED PROXY_AUTH_FAILED", "代理认证失败，请检查账号密码"],
    ["SOCKS5_NO_ACCEPTABLE_AUTH", "SOCKS5 代理不接受当前认证方式"],
    ["SOCKS5_REPLY", "SOCKS5 代理拒绝建立隧道"],
    ["PROXY_CONNECT_REFUSED", "代理拒绝建立 CONNECT 隧道"],
    [
      "PROXY_UNREACHABLE ECONNREFUSED EHOSTUNREACH ENETUNREACH",
      "无法连接代理服务器",
    ],
    ["PROXY_PROTOCOL", "代理握手响应不完整或格式无效"],
    ["TIMEOUT_CONNECT ETIMEDOUT", "连接代理服务器超时"],
    ["TIMEOUT_HANDSHAKE", "HTTPS 握手超时"],
    ["TIMEOUT_HEADERS TIMEOUT_IDLE TIMEOUT_TOTAL", "等待上游响应超时"],
    [
      "TLS_RECORD TLS_ALERT TLS_HANDSHAKE TLS_TRUNCATED TLS_VERSION_UNSUPPORTED TLS_CIPHER_UNSUPPORTED TLS_GROUP_UNSUPPORTED TLS_SIGALG_UNSUPPORTED TLS_EXTENSION_UNSUPPORTED TLS_ALPN TLS_PSK TLS_TICKET",
      "隧道内 HTTPS 握手失败",
    ],
    [
      "CERT_PARSE CERT_CHAIN_INCOMPLETE CERT_UNTRUSTED_ROOT CERT_SIGNATURE_INVALID CERT_SIGNATURE_WEAK CERT_SIGNATURE_UNSUPPORTED CERT_EXPIRED CERT_NOT_YET_VALID CERT_NAME_MISMATCH CERT_CONSTRAINT CERT_PIN_MISMATCH OCSP_PARSE OCSP_UNVERIFIED OCSP_MISMATCH OCSP_STALE OCSP_REVOKED OCSP_UNKNOWN OCSP_REQUIRED",
      "HTTPS 证书验证失败",
    ],
    [
      "HTTP_REQUEST_LINE HTTP_STATUS_LINE HTTP_HEADER HTTP_FRAMING_AMBIGUOUS HTTP_CHUNK HTTP_BODY_TRUNCATED HTTP_TRAILER HTTP_UPGRADE_UNEXPECTED HTTP_CONTENT_ENCODING HTTP_CHARSET HTTP2_PROTOCOL HTTP2_FRAME_SIZE HTTP2_SETTINGS HTTP2_FLOW_CONTROL HTTP2_STREAM_STATE HTTP2_STREAM_CLOSED HTTP2_GOAWAY HTTP2_COMPRESSION HTTP2_HEADER HTTP2_PUSH_UNEXPECTED HTTP2_TRAILER",
      "隧道内 HTTP 数据处理失败",
    ],
    ["CONNECTION_CLOSED UNEXPECTED_EOF ECONNRESET EPIPE", "代理连接提前关闭"],
    ["LIMIT_BODY LIMIT_HEADER LIMIT_REDIRECTS", "上游响应超过限制"],
    ["CONFIG_INVALID CONFIG_UNSATISFIABLE POOL_CLOSED", "代理传输配置不可用"],
  ].flatMap(([codes, reason]) =>
    codes.split(" ").map((code) => [code, reason] as const),
  ),
);

export function parseProxyUpdate(input: unknown): {
  enabled: boolean;
  remove: boolean;
  config?: HttpProxyConfig;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProxySettingsError("代理设置参数无效");
  const value = input as Record<string, unknown>;
  if (
    typeof value.enabled !== "boolean" ||
    (value.remove !== undefined && typeof value.remove !== "boolean")
  )
    throw new ProxySettingsError("代理设置参数无效");
  if (value.remove === true) {
    if (value.enabled) throw new ProxySettingsError("清除代理时需要同时停用");
    return { enabled: false, remove: true };
  }
  if (
    value.address === undefined &&
    value.username === undefined &&
    value.password === undefined
  )
    return { enabled: value.enabled, remove: false };
  if (
    typeof value.address !== "string" ||
    value.address.length > 2048 ||
    typeof value.username !== "string" ||
    value.username.length > 256 ||
    typeof value.password !== "string" ||
    value.password.length > 512
  )
    throw new ProxySettingsError("请填写代理地址，账号密码可留空");
  let url: URL;
  try {
    url = new URL(value.address.trim());
  } catch {
    throw new ProxySettingsError(
      "代理地址格式应为 http://主机:端口 或 socks5://主机:端口",
    );
  }
  if (
    !["http:", "socks5:"].includes(url.protocol) ||
    !url.hostname ||
    (url.port !== "" && Number(url.port) < 1) ||
    url.username ||
    url.password ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash ||
    /[\x00-\x20\x7f]/.test(value.address.trim())
  )
    throw new ProxySettingsError(
      "仅支持 http:// 或 socks5:// 代理地址；账号密码请填在独立输入框",
    );
  if (
    /[\x00-\x1f\x7f:]/.test(value.username) ||
    /[\x00-\x1f\x7f]/.test(value.password) ||
    (!value.username && value.password)
  )
    throw new ProxySettingsError("代理账号密码格式无效");
  if (
    url.protocol === "socks5:" &&
    [value.username, value.password].some(
      (text) => new TextEncoder().encode(text).length > 255,
    )
  )
    throw new ProxySettingsError("SOCKS5 账号和密码各不能超过 255 字节");
  return {
    enabled: value.enabled,
    remove: false,
    config: {
      // URL.origin is "null" for SOCKS5, a non-special URL scheme.
      address: `${url.protocol}//${url.host}`,
      username: value.username,
      password: value.password,
    },
  };
}

type ProxyClient = Pick<Client, "fetch" | "close">;

async function openClient(config: HttpProxyConfig): Promise<ProxyClient> {
  const [{ Client }, { connect }] = await Promise.all([
    import("tunnelfetch"),
    import("cloudflare:sockets"),
  ]);
  const url = new URL(config.address);
  url.username = config.username;
  url.password = config.password;
  return new Client({
    connect: (address, options) =>
      connect(address, {
        secureTransport: options?.secureTransport ?? "off",
        allowHalfOpen: options?.allowHalfOpen ?? false,
      }),
    proxy: url.href,
    forceTunnel: true,
    trust: { mode: "system" },
    cookies: false,
    keepAlive: true,
    maxRedirects: 5,
    maxBodyBytes: 4 * 1024 * 1024,
    timeouts: {
      connectMs: 10_000,
      handshakeMs: 10_000,
      headersMs: 15_000,
      idleMs: 15_000,
      totalMs: 30_000,
    },
  });
}

function proxyFailure(cause: unknown, signal?: AbortSignal | null): Error {
  if (signal?.aborted)
    return new DOMException("代理请求已取消或超时", "AbortError");
  const error =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown; detail?: { status?: unknown } })
      : undefined;
  const code = typeof error?.code === "string" ? error.code : "";
  const reason = proxyFailureReasons.get(code);
  if (!reason)
    return new HttpProxyRequestError(
      "代理请求失败，请检查代理地址、认证和连接",
    );
  const status = error?.detail?.status;
  const responseStatus =
    code === "PROXY_CONNECT_REFUSED" &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? `，HTTP ${status}`
      : "";
  return new HttpProxyRequestError(
    `代理请求失败：${reason}（${code}${responseStatus}）`,
  );
}

/** One transport per invocation; all bodies are consumed before close(). No isolate-wide sockets. */
export function createHttpTransport(
  load: () => Promise<HttpProxyConfig | null>,
  factory: (config: HttpProxyConfig) => Promise<ProxyClient> = openClient,
) {
  let config: Promise<HttpProxyConfig | null> | undefined;
  let client: Promise<ProxyClient> | undefined;
  const settings = () => (config ??= load());
  return {
    async isProxied() {
      return (await settings()) !== null;
    },
    async fetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const proxy = await settings();
      if (!proxy) return globalThis.fetch(input, init);
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      try {
        const transport = await (client ??= factory(proxy));
        const response = await transport.fetch(input, init);
        const reader = response.body?.getReader();
        const body = reader
          ? new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    reader.releaseLock();
                    controller.close();
                  } else controller.enqueue(chunk.value);
                } catch (error) {
                  reader.releaseLock();
                  controller.error(proxyFailure(error, signal));
                }
              },
              async cancel() {
                try {
                  await reader.cancel();
                } catch {
                  /* Closing failed transports is best effort. */
                } finally {
                  reader.releaseLock();
                }
              },
            })
          : null;
        const result = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        Object.defineProperties(result, {
          url: { value: response.url },
          redirected: { value: response.redirected },
        });
        return result;
      } catch (error) {
        throw proxyFailure(error, signal);
      }
    },
    async close() {
      if (client) {
        try {
          await (await client).close();
        } catch {
          /* No credentials in close diagnostics. */
        }
      }
    },
  };
}

export type HttpTransport = ReturnType<typeof createHttpTransport>;
