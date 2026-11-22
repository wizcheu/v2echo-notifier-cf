import { isAppPairingRequest, watchAppRequest, WatchError } from "./notifier/watch-local";
import { Context } from "./notifier/context";
import { Database } from "./db";
import { apiUsageState } from "./api-usage";
import {
  authorized,
  createSession,
  sameOriginSessionRequest,
  sessionCookie,
  validAdminToken,
} from "./session";
import { cleanup } from "./maintenance";
import { FREE, type Env } from "./types";
import {
  eventContent,
  notifierAction,
  notifierMaintenance,
  notifierState,
  notifierTick,
} from "./notifier";
import { NotifierError } from "./notifier/model";
import { createAccount, deleteAccount, listAccounts, requireAccount } from "./notifier/accounts";
import { credentialStatus } from "./notifier/credentials";
import { cachedMessages, notificationRecords } from "./notifier/records";
import { unreadPage } from "./notifier/unread";
import { createHttpTransport, ProxySettingsError } from "./http-proxy";
import { testHttpProxy } from "./proxy-test";
import {
  loadHttpProxy,
  proxySettings,
  updateHttpProxy,
} from "./proxy-settings";
import { APP_VERSION } from "../shared/version";
import { checkLatestRelease } from "./version";

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
// Lets the app show how long a cooldown lasts instead of inviting blind retries.
const retryField = (error: NotifierError) =>
  error.retryAt > Date.now() ? { retry_at: error.retryAt } : {};
async function body(request: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("input");
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new Error("input");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("input");
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("input");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const result = JSON.parse(text + decoder.decode());
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("input");
  return result;
}
async function route(request: Request, env: Env, db: Database) {
  const url = new URL(request.url);
  if (url.pathname === "/api/accounts") {
    if (request.method === "GET") return json(await listAccounts(db, env));
    if (request.method === "POST") return json(await createAccount(db, env, await body(request, 65536)));
    return json({ error: "请求方法无效" }, 405);
  }
  const accountRoute = url.pathname.match(/^\/api\/accounts\/([1-9]\d*)(\/.*)?$/);
  const accountID = accountRoute ? Number(accountRoute[1]) : 1;
  if (!Number.isSafeInteger(accountID)) throw new NotifierError("账号编号无效", 0, "", 400);
  if (accountRoute) {
    if (!accountRoute[2] && request.method === "DELETE") return json(await deleteAccount(db, env, accountID));
    await requireAccount(db, accountID);
    if (!accountRoute[2]) {
      return json({ error: "请求方法无效" }, 405);
    }
    url.pathname = `/api${accountRoute[2]}`;
    if (url.pathname !== "/api/state" && !url.pathname.startsWith("/api/notifier/"))
      return json({ error: "接口不存在" }, 404);
  }
  if (!accountRoute && (url.pathname === "/api/state" || url.pathname.startsWith("/api/notifier/")))
    await requireAccount(db, accountID);
  if (request.method === "GET" && url.pathname === "/api/state") {
    const snapshotNow = Date.now();
    const [control, daily] = await db.batch([
      db.statement(
        "SELECT MAX(c.next_dispatch,n.next_dispatch) AS next_dispatch,MAX(c.api_until,n.api_until) AS api_until,c.web_until,c.lease_until FROM control c JOIN notifier n ON n.id=? WHERE c.id=1", accountID,
      ),
      db.statement("SELECT * FROM daily ORDER BY day DESC LIMIT 7"),
    ]);
    return json({
      now: snapshotNow,
      version: APP_VERSION,
      control: control.results[0],
      daily: daily.results,
      credentials: await credentialStatus(db, env, accountID),
      limits: FREE,
      notifier: await notifierState(db, env, snapshotNow, accountID),
      api_usage: await apiUsageState(db, snapshotNow, accountID),
      proxy: await proxySettings(db, env),
    });
  }
  if (url.pathname === "/api/version/check") {
    if (request.method !== "GET") return json({ error: "请求方法无效" }, 405);
    return json(await checkLatestRelease());
  }
  if (url.pathname === "/api/proxy-settings/test") {
    if (request.method !== "POST") return json({ error: "请求方法无效" }, 405);
    return json(await testHttpProxy(db, env, await body(request)));
  }
  if (url.pathname === "/api/proxy-settings") {
    if (request.method === "GET") return json(await proxySettings(db, env));
    if (request.method === "PUT")
      return json(await updateHttpProxy(db, env, await body(request)));
    return json({ error: "请求方法无效" }, 405);
  }
  const notificationAction = url.pathname.match(
    /^\/api\/notifier\/(verify|credentials|pair\/qr|transfer(?:\/complete)?|config|schedule|tick|test|history|unread\/refresh|checks\/ack|watch\/(?:sync|refresh|config|clients\/revoke))$/,
  );
  if (
    notificationAction &&
    request.method ===
      (["config", "schedule", "credentials"].includes(notificationAction[1]) ? "PUT" : "POST")
  ) {
    return json(
      await notifierAction(
        db,
        env,
        notificationAction[1],
        ["verify", "tick", "checks/ack", "watch/sync"].includes(notificationAction[1])
          ? {}
          : await body(request, notificationAction[1] === "credentials" ? 65536 : 4096),
        undefined, Date.now(), accountID,
      ),
    );
  }
  if (url.pathname === "/api/notifier/unread") {
    if (request.method !== "GET") return json({ error: "请求方法无效" }, 405);
    return json(await unreadPage(db, env, url.searchParams, accountID));
  }
  if (url.pathname === "/api/notifier/messages") {
    if (request.method !== "GET") return json({ error: "请求方法无效" }, 405);
    return json(await cachedMessages(db, env, url.searchParams, accountID));
  }
  if (request.method === "GET" && url.pathname === "/api/notifier/records")
    return json(await notificationRecords(db, env, url.searchParams, accountID));
  const event = url.pathname.match(/^\/api\/notifier\/events\/([0-9a-f]{64})$/);
  if (event && request.method === "GET")
    return json(await eventContent(db, env, event[1], accountID));
  return json({ error: "接口不存在" }, 404);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/"))
      return json({ error: "Not found" }, 404);
    if (url.pathname === "/api/app/v1/health") {
      if (request.method === "GET") return json({ status: "ok" });
      const response = json({ error: "请求方法无效" }, 405);
      response.headers.set("Allow", "GET");
      return response;
    }
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32)
      return json(
        { error: "请先配置至少 32 字符的随机 ADMIN_TOKEN Secret" },
        503,
      );
    if (["/api/login", "/api/logout"].includes(url.pathname)) {
      if (request.method !== "POST")
        return json({ error: "请求方法无效" }, 405);
      if (!sameOriginSessionRequest(request))
        return json({ error: "不允许跨站操作" }, 403);
      let session = "";
      if (url.pathname === "/api/login") {
        let input: Record<string, unknown>;
        try {
          input = await body(request);
        } catch {
          return json({ error: "请求格式无效" }, 400);
        }
        if (!(await validAdminToken(input.token, env)))
          return json({ error: "管理密钥无效或已失效" }, 401);
        session = await createSession(env);
      }
      const response = json({ authenticated: Boolean(session) });
      response.headers.set(
        "Set-Cookie",
        sessionCookie(session, url.protocol === "https:"),
      );
      return response;
    }
    const nativeWatch = url.pathname.startsWith("/api/app/v1/");
    if (!nativeWatch && !(await authorized(request, env)))
      return json({ error: "登录已过期或无效，请重新登录" }, 401);
    const origin = request.headers.get("origin");
    if (
      !nativeWatch && request.method !== "GET" &&
      ((origin && origin !== url.origin) ||
        (!request.headers.has("Authorization") &&
          !sameOriginSessionRequest(request)))
    )
      return json({ error: "不允许跨站操作" }, 403);
    const db = new Database(env.DB);
    const outbound = createHttpTransport(() => loadHttpProxy(db, env));
    let recordUsage = !nativeWatch;
    try {
      if (nativeWatch) {
        if (isAppPairingRequest(request.method, url.pathname)) {
          const { success } = await env.APP_PAIR_RATE_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "local" });
          if (!success) {
            const response = json({ error: "rate_limited", message: "配对请求过于频繁，请稍后重试", retry_at: Date.now() + 60000 }, 429);
            response.headers.set("Retry-After", "60");
            return response;
          }
        }
        const result = await watchAppRequest(request, new Context(db, { ...env, outbound }, ""), () => body(request, 16384));
        recordUsage = true;
        return json(result);
      }
      return await route(request, { ...env, outbound }, db);
    } catch (error) {
      if (error instanceof ProxySettingsError)
        return json({ error: error.message }, 400);
      if (error instanceof WatchError) return json({ error: nativeWatch ? error.code : error.message, message: error.message, ...retryField(error) }, error.status);
      if (error instanceof NotifierError)
        return json({ error: error.message, ...retryField(error) }, error.status);
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === "input")
      )
        return json({ error: "请求格式无效" }, 400);
      // Never log an upstream body, request headers, credentials, or a D1 error containing values.
      console.error(JSON.stringify({ event: "api_failure" }));
      return json(
        { error: "操作未完成，请检查数据库迁移与 Cloudflare 日志" },
        500,
      );
    } finally {
      await outbound.close();
      try {
        if (recordUsage) await db.flush("http");
      } catch {
        console.error(JSON.stringify({ event: "usage_write_failed" }));
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    const db = new Database(env.DB);
    const outbound = createHttpTransport(() => loadHttpProxy(db, env));
    const bound = { ...env, outbound };
    try {
      await cleanup(db, Date.now());
      await notifierMaintenance(db, bound);
      await notifierTick(db, bound);
    } finally {
      await outbound.close();
      await db.flush("cron");
    }
  },
} satisfies ExportedHandler<Env>;
