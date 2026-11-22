import { DomUtils, parseDocument } from "htmlparser2";
import type { HttpProxyTestResult } from "../shared/proxy-types";
import type { Database } from "./db";
import { createHttpTransport, HttpProxyRequestError } from "./http-proxy";
import { bounded, USER_AGENT } from "./notifier/http";
import { NotifierError } from "./notifier/model";
import { accessRestriction } from "./notifier/response-errors";
import { proxyTestConfig } from "./proxy-settings";
import { MAX_BODY, type Env } from "./types";

const target = "https://www.v2ex.com/";

function isHomepage(html: string): boolean {
  const doc = parseDocument(html);
  const title = DomUtils.getElementsByTagName("title", doc.children, true, 1)[0];
  const main = DomUtils.getElementById("Main", doc.children);
  if (!title || !/^V2EX\b/i.test(DomUtils.textContent(title).trim()) || !main)
    return false;
  return DomUtils.findAll(
    element => (element.attribs.class ?? "").split(/\s+/).includes("item_title"),
    main.children,
  ).some(item => DomUtils.getElementsByTagName("a", item.children).some(link => {
    try {
      const url = new URL(link.attribs.href ?? "", target);
      return url.origin === "https://www.v2ex.com" && /^\/t\/[1-9]\d*$/.test(url.pathname);
    } catch {
      return false;
    }
  }));
}

export async function testHttpProxy(
  db: Database,
  env: Env,
  input: unknown,
  transportFactory: typeof createHttpTransport = createHttpTransport,
): Promise<HttpProxyTestResult> {
  const config = await proxyTestConfig(db, env, input);
  const outbound = transportFactory(async () => config);
  const signal = AbortSignal.timeout(12_000);
  const started = performance.now();
  let http_status: number | null = null;
  const result = (ok: boolean, message: string): HttpProxyTestResult => ({
    proxy_address: config.address,
    ok, http_status, duration_ms: Math.round(performance.now() - started), message,
  });
  try {
    db.outbound++;
    const response = await outbound.fetch(target, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "manual",
      signal,
    });
    http_status = response.status;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return result(false, "V2EX 返回了重定向，未能确认首页可正常访问。");
    }
    const html = await bounded(response, MAX_BODY, { db });
    const restriction = accessRestriction(response, html);
    if (restriction)
      return result(false, `代理已连通，但 V2EX ${restriction}，暂时无法正常访问。`);
    if (response.status === 403)
      return result(false, "代理已连通，但 V2EX 拒绝了访问，请检查代理出口。");
    if (response.status === 429)
      return result(false, "V2EX 暂时限制访问频率，请稍后再测试。");
    if (!response.ok)
      return result(false, "V2EX 返回异常响应，当前无法正常访问网页。");
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!["text/html", "application/xhtml+xml"].includes(mime ?? "") || !isHomepage(html))
      return result(false, "收到的内容不是可识别的 V2EX 首页，未能确认网页可正常访问。");
    return result(true, "代理可正常访问 V2EX 网页。");
  } catch (error) {
    if (signal.aborted)
      return result(false, "代理测试超时，12 秒内未能读取 V2EX 网页，请检查代理后重试。");
    if (error instanceof HttpProxyRequestError || error instanceof NotifierError)
      return result(false, error.message);
    throw error;
  } finally {
    await outbound.close();
  }
}
