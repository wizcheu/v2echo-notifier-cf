import { retryAfter } from "../api-budget";
import { MAX_BODY } from "../types";
import type { Context } from "./context";
import { NotifierError, RELAY } from "./model";
import { apiBudget } from "../api-budget";
import { recordApiBackoff, withApiUsage } from "../api-usage";
import { HttpProxyRequestError } from "../http-proxy";
import {
  accessRestriction,
  accessWaitMessage,
  errorObject,
  invalidPAT,
  responseDiagnostic,
} from "./response-errors";

export const USER_AGENT = "V2Echo-CF-Notifier/0.1 (+https://v2echo.com)";
const FORBIDDEN_DELAYS = [60000, 120000, 300000, 900000];

export function cookieHeader(value: string): string {
  // Accept one complete request Cookie header, never multiple pasted headers.
  if (value.length > 16_384 || /[^\x20-\x7e]/.test(value))
    throw new NotifierError("Cookie 请求头格式无效", 0, "credentials");
  const header = value.trim().replace(/^cookie:\s*/i, "");
  const pairs = header
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean);
  if (
    !pairs.length ||
    pairs.some((pair) => !/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+=/.test(pair))
  )
    throw new NotifierError("Cookie 请求头格式无效", 0, "credentials");
  return header;
}

export async function bounded(response: Response, max: number, c: Pick<Context, "db">) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new NotifierError("上游响应超出大小限制");
  }
  if (!response.body) throw new NotifierError("上游返回空响应");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      c.db.bytes += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new NotifierError("上游响应超出大小限制");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof NotifierError) throw error;
    if (error instanceof HttpProxyRequestError)
      throw new NotifierError(error.message);
    throw new NotifierError("上游响应读取失败");
  } finally {
    reader.releaseLock();
  }
}
export async function upstream(c: Context, path: string) {
  const publicMember =
    /^\/api\/members\/show\.json\?username=[A-Za-z0-9_]{1,100}$/.test(path);
  const api = publicMember || path.startsWith("/api/v2/");
  if (
    !publicMember &&
    !/^\/(?:$|\?tab=members$|api\/v2\/member$|api\/v2\/notifications\?p=[1-9]\d{0,3}$|my\/following\?p=[1-9]\d{0,3}$|t\/[1-9]\d{0,15}\?p=[1-9]\d{0,3}$)/.test(
      path,
    )
  )
    throw new Error("invalid upstream path");
  const channel = api ? "api_until" : "web_until";
  const failures = api ? "api_forbidden_failures" : "web_forbidden_failures";
  const control = await c.db.one<{ until: number; failures: number }>(
    `SELECT ${channel} AS until,${failures} AS failures FROM control WHERE id=1`,
  );
  const budget = api && !publicMember ? await c.db.one<{ api_until: number }>("SELECT api_until FROM notifier WHERE id=?", c.id) : null;
  control.until = Math.max(control.until, budget?.api_until ?? 0);
  if (control.until > c.now)
    throw new NotifierError(
      accessWaitMessage(api, control.until),
      control.until,
    );
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: api ? "application/json" : "text/html",
  };
  if (!publicMember) {
    const env = await c.credentials();
    if (!env.V2EX_PAT || !env.V2EX_COOKIE)
      throw new NotifierError("请配置 Cookie 和 PAT", 0, "credentials");
    if (api) headers.Authorization = `Bearer ${env.V2EX_PAT}`;
    else headers.Cookie = cookieHeader(env.V2EX_COOKIE);
  }
  c.db.outbound++;
  let response: Response;
  let usageId: string | undefined;
  try {
    response = await withApiUsage(
      c.db,
      c.fetcher,
      () => c.now,
      (id) => {
        usageId = id;
      }, c.id,
    )(`https://www.v2ex.com${path}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(publicMember ? 3000 : 12000),
    });
  } catch (error) {
    throw new NotifierError(
      (api ? "V2EX API 网络请求失败" : "V2EX 网页网络请求失败") +
        (error instanceof HttpProxyRequestError ? `：${error.message}` : ""),
    );
  }
  let until = api
    ? apiBudget(response, c.now).backoff_until
    : Math.min(
        c.now + 48 * 3600000,
        retryAfter(response.headers.get("retry-after"), c.now),
      );
  if (!api && response.status === 429) until = Math.max(until, c.now + 900000);
  if (until > c.now) {
    if (api && !publicMember) await c.update("UPDATE notifier SET api_until=MAX(api_until,?) WHERE id=?", until, c.id);
    else await c.update(`UPDATE control SET ${channel}=MAX(${channel},?) WHERE id=1`, until);
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new NotifierError(api ? "V2EX API 限流" : "V2EX 网页限流", until);
  }
  if (
    response.status === 401 ||
    [301, 302, 303, 307, 308].includes(response.status)
  ) {
    await response.body?.cancel();
    if (publicMember)
      throw new NotifierError("V2EX 公开成员资料暂不可用", until);
    throw new NotifierError(
      api ? "PAT 身份已失效" : "Cookie 身份已失效",
      0,
      "credentials",
    );
  }
  const text = await bounded(response, MAX_BODY, c);
  const restriction = accessRestriction(response, text);
  if (restriction) {
    until = Math.max(until, c.now + 900000);
    await c.update(
      `UPDATE control SET ${channel}=MAX(${channel},?) WHERE id=1`,
      until,
    );
    if (api) await recordApiBackoff(c.db, usageId, until, "access_restricted");
    throw new NotifierError(
      `V2EX ${api ? "API" : "网页"}${restriction}${responseDiagnostic(response)}，等待后重试；不能据此判定凭据失效`,
      until,
    );
  }
  if (api && !publicMember && invalidPAT(text))
    throw new NotifierError(
      "PAT 身份已失效（已过期、无效或被撤销），请在设置中更新 PAT",
      0,
      "credentials",
    );
  if (response.status === 403) {
    until = Math.max(
      until,
      c.now +
        FORBIDDEN_DELAYS[
          Math.min(control.failures, FORBIDDEN_DELAYS.length - 1)
        ],
    );
    await c.update(
      `UPDATE control SET ${channel}=MAX(${channel},?),${failures}=MIN(${failures}+1,?) WHERE id=1`,
      until,
      FORBIDDEN_DELAYS.length,
    );
    if (api) await recordApiBackoff(c.db, usageId, until, "http_403");
    throw new NotifierError(
      `V2EX ${api ? "API" : "网页"}返回 HTTP 403${responseDiagnostic(response)}：访问被拒绝，尚不能判定 ${api ? "PAT" : "Cookie"} 失效；等待后重试`,
      until,
      "",
      409,
      403,
    );
  }
  if (!response.ok)
    throw new NotifierError(
      `V2EX ${api ? "API" : "网页"} 返回 HTTP ${response.status}`,
      until, "", 409, response.status,
    );
  let result: unknown = text;
  if (api) {
    try {
      result = JSON.parse(text) as unknown;
    } catch {
      throw new NotifierError("V2EX API JSON 无效");
    }
  }
  if (control.failures)
    await c.update(`UPDATE control SET ${failures}=0 WHERE id=1`);
  return result;
}

export async function relayRequest(
  c: Context,
  path: string,
  sender = "",
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  if (
    ![
      "/v1/health",
      "/v1/sender",
      "/v1/recipient-keys",
      "/v1/recipient-keys?purpose=watch",
      "/v1/watches/sync",
      "/v1/watches/config",
      "/v1/watches/source",
      "/v1/watches/ownership",
      "/v1/watch-events/cancel",
      "/v1/connection-invitations",
      "/v1/connection-invitations/exchange",
      "/v1/source-transfers",
      "/v1/source-transfers/exchange",
      "/v1/sync",
      "/v1/invitations",
      "/v1/invitations/exchange",
    ].includes(path) && !/^\/v1\/assistants\/[0-9a-f-]{36}\/accounts(?:\/[1-9]\d*)?$/.test(path)
  )
    throw new Error("invalid relay path");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (sender) headers.Authorization = `Bearer ${sender}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const raw = body === undefined ? undefined : JSON.stringify(body);
  if (raw && new TextEncoder().encode(raw).length > 65536)
    throw new NotifierError("发送批次超过 64 KiB，已保留待处理");
  c.db.outbound++;
  let response: Response;
  try {
    const request = new Request(RELAY + path, {
      method,
      headers,
      body: raw,
      redirect: "manual",
      signal: AbortSignal.timeout(17000),
    });
    // Direct same-zone fetch uses the binding. With a proxy, the public HTTPS endpoint
    // must also use that exit; a service binding would silently bypass the setting.
    response =
      c.env.PUSH_SERVICE && !(await c.env.outbound?.isProxied())
        ? await c.env.PUSH_SERVICE.fetch(request)
        : await c.fetcher(request.url, {
            method: request.method,
            headers: request.headers,
            body: raw,
            redirect: "manual",
            signal: request.signal,
          });
  } catch (error) {
    throw new NotifierError(
      "推送服务网络请求失败，原事件将重试" +
        (error instanceof HttpProxyRequestError ? `：${error.message}` : ""),
    );
  }
  const retryAt = Math.min(
    c.now + 48 * 3600000,
    retryAfter(response.headers.get("retry-after"), c.now),
  );
  if (!response.ok) {
    const text = response.body ? await bounded(response, 262144, c) : "";
    const restriction = accessRestriction(response, text);
    if (restriction)
      throw new NotifierError(
        `推送服务${restriction}${responseDiagnostic(response)}，保留配对并等待重试`,
        Math.max(retryAt, c.now + 900000),
        "",
        409,
        response.status,
      );
    const problem = errorObject(text);
    if (path === "/v1/watches/config") {
      const messages: Record<string, string> = {
        watch_revision_conflict: "规则已在 App 或其他页面更新，已尝试同步，请核对后重新操作",
        watch_topic_limit: "最多关注 20 篇帖子，暂停项也占名额，请先移除一篇",
        watch_topic_missing: "这篇帖子已被移除，请同步后核对",
        invalid_watch_topic: "请输入有效的 V2EX 主题编号",
        invalid_watch_operation: "关注操作无效，请同步后重试",
      };
      const message = messages[String(problem?.error)];
      if (message) throw new NotifierError(message, retryAt, "", 409, response.status);
    }
    // Both the first-pairing and the add-device (join) exchange paths expire
    // the same way, so map either 403 to the same actionable, retry-free state.
    const invitationPath =
      path.startsWith("/v1/invitations") ||
      path.startsWith("/v1/connection-invitations");
    if (
      invitationPath &&
      response.status === 403 &&
      [
        "invitation_expired",
        "pairing_invalid_expired_or_account_mismatch",
        "invitation_invalid_expired_or_account_mismatch",
        "connection_unavailable_or_account_mismatch",
      ].includes(String(problem?.error))
    )
      throw new NotifierError(
        "二维码已失效或设备账号已变更，请重新生成并扫码",
        retryAt,
        "",
        410,
        response.status,
      );
    const block =
      sender &&
      !path.startsWith("/v1/invitations") &&
      (response.status === 401 ||
        (response.status === 403 &&
          ["invalid_credentials", "source_account_mismatch"].includes(
            String(problem?.error),
          )))
        ? "pairing"
        : "";
    throw new NotifierError(
      block
        ? "配对凭据已失效，请重新配对"
        : `推送服务返回 HTTP ${response.status}${responseDiagnostic(response)}，保留原请求`,
      Math.max(
        retryAt,
        response.status === 403
          ? c.now + 900000
          : [400, 404, 413].includes(response.status)
            ? c.now + 180000
            : 0,
      ),
      block,
      409,
      response.status,
    );
  }
  try {
    return {
      data: JSON.parse(await bounded(response, 262144, c)) as unknown,
      retryAt,
    };
  } catch (error) {
    if (error instanceof NotifierError) throw error;
    throw new NotifierError("推送服务响应格式无效，保留原请求");
  }
}
