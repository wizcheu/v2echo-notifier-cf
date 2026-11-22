import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Database } from "../worker/db";
import { createHttpTransport, ProxySettingsError } from "../worker/http-proxy";
import { seal } from "../worker/notifier/crypto";
import { testHttpProxy } from "../worker/proxy-test";
import { MAX_BODY, type Env } from "../worker/types";
import type { HttpProxyConfig } from "../shared/proxy-types";

const homepage = '<!doctype html><html><head><title>V2EX</title></head><body><div id="Top"><a href="/">V2EX</a></div><div id="Wrapper"><div id="Main"><span class="item_title"><a href="/t/123">topic</a></span></div></div></body></html>';
const config: HttpProxyConfig = {
  address: "http://proxy.example:8080",
  username: "private-proxy-user",
  password: "private-proxy-password",
};
const empty = { enabled: 0, address: "", authenticated: 0, payload: "" };
const html = (body = homepage, status = 200, headers: HeadersInit = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

function setup(reply: () => Response | Promise<Response> = () => html()) {
  const db = new Database({} as D1Database);
  const read = vi.spyOn(db, "one").mockResolvedValue(empty);
  const write = vi.spyOn(db, "run").mockImplementation(async () => {
    throw new Error("Unexpected settings or notification state write");
  });
  const direct = vi.fn(() => { throw new Error("Unexpected direct request"); });
  vi.stubGlobal("fetch", direct);
  const close = vi.fn(async () => {});
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply());
  const configs: HttpProxyConfig[] = [];
  const factory: typeof createHttpTransport = (load) => createHttpTransport(load, async (proxy) => {
    configs.push(proxy);
    return { fetch: fetcher, close };
  });
  const env: Env = {
    DB: {} as D1Database,
    ADMIN_TOKEN: "private-admin-token",
    NOTIFIER_KEY: "ab".repeat(32),
    V2EX_COOKIE: "private-v2ex-cookie",
    V2EX_PAT: "private-v2ex-pat",
  };
  return { db, env, read, write, direct, close, fetcher, configs, factory };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("manual proxy webpage test", () => {
  it.each(["http://proxy.example:8080", "socks5://proxy.example:1080"])(
    "tests an unsaved %s proxy with one bounded anonymous request and no writes",
    async (address) => {
      const test = setup();
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const draft = { ...config, address };
      const result = await testHttpProxy(test.db, test.env, draft, test.factory);
      expect(result).toMatchObject({ ok: true, http_status: 200, proxy_address: address });
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(test.configs).toEqual([draft]);
      expect(test.fetcher).toHaveBeenCalledTimes(1);
      const [input, init] = test.fetcher.mock.calls[0];
      const request = new Request(input, init);
      expect(request.url).toBe("https://www.v2ex.com/");
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("proxy-authorization")).toBeNull();
      expect(timeout).toHaveBeenCalledWith(12_000);
      expect(test.db.outbound).toBe(1);
      expect(test.db.bytes).toBe(new TextEncoder().encode(homepage).byteLength);
      expect(test.write).not.toHaveBeenCalled();
      expect(test.direct).not.toHaveBeenCalled();
      expect(test.close).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(/private-/);
    },
  );

  const savedHomepage = new URL("../../site-data/html_20260701/root_index/V2EX.html", import.meta.url);
  it.skipIf(!existsSync(savedHomepage))("recognizes the captured V2EX homepage", async () => {
    const source = await readFile(savedHomepage, "utf8");
    const test = setup(() => html(source));
    expect(await testHttpProxy(test.db, test.env, config, test.factory))
      .toMatchObject({ ok: true, http_status: 200 });
  });

  it.each([0, 1])("tests a saved proxy with enabled=%s without changing its state", async (enabled) => {
    const test = setup();
    const saved = {
      enabled,
      address: config.address,
      authenticated: 1,
      payload: await seal(test.env, "outbound-http-proxy", config),
    };
    test.read.mockResolvedValue(saved);
    const before = { ...saved };
    expect(await testHttpProxy(test.db, test.env, {}, test.factory))
      .toMatchObject({ ok: true, http_status: 200 });
    expect(test.configs).toEqual([config]);
    expect(saved).toEqual(before);
    expect(test.write).not.toHaveBeenCalled();
    expect(test.direct).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    { url: "https://other.example/private" },
    { ...config, url: "https://other.example/private" },
    { ...config, enabled: true },
    { ...config, remove: true },
    { username: "private-proxy-user", password: "private-proxy-password" },
    { ...config, address: "http://proxy.example/path" },
  ])("rejects invalid or expanded test input before connecting: %j", async (input) => {
    const test = setup();
    await expect(testHttpProxy(test.db, test.env, input, test.factory))
      .rejects.toBeInstanceOf(ProxySettingsError);
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.direct).not.toHaveBeenCalled();
    expect(test.write).not.toHaveBeenCalled();
    expect(test.db.outbound).toBe(0);
  });

  it.each(["missing", "corrupt", "wrong key"])(
    "does not use a direct connection when the saved proxy is %s",
    async (problem) => {
      const test = setup();
      if (problem !== "missing") {
        const payload = problem === "corrupt" ? "invalid" : await seal(test.env, "outbound-http-proxy", config);
        test.read.mockResolvedValue({ enabled: 0, address: config.address, authenticated: 1, payload });
        if (problem === "wrong key") test.env.NOTIFIER_KEY = "cd".repeat(32);
      }
      await expect(testHttpProxy(test.db, test.env, {}, test.factory))
        .rejects.toBeInstanceOf(ProxySettingsError);
      expect(test.fetcher).not.toHaveBeenCalled();
      expect(test.direct).not.toHaveBeenCalled();
      expect(test.write).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "HTML challenge", reply: () => html("<title>Just a moment...</title>private-upstream-body"), status: 200, reason: /验证/ },
    { name: "challenge header", reply: () => html(homepage, 200, { "cf-mitigated": "challenge" }), status: 200, reason: /验证/ },
    { name: "Cloudflare block", reply: () => html("Error 1010 private-upstream-body", 403), status: 403, reason: /Cloudflare|拒绝/ },
    { name: "forbidden", reply: () => html("private-upstream-body", 403), status: 403, reason: /403|拒绝/ },
    { name: "rate limit", reply: () => html("private-upstream-body", 429), status: 429, reason: /429|频率|限流/ },
    { name: "redirect", reply: () => html("", 302, { location: "https://other.example/private" }), status: 302, reason: /跳转|重定向/ },
    { name: "server error", reply: () => html("private-upstream-body", 503), status: 503, reason: /异常|无法/ },
    { name: "JSON response", reply: () => Response.json({ private: "private-upstream-body" }), status: 200, reason: /网页|HTML/ },
    { name: "empty body", reply: () => html(""), status: 200, reason: /网页|内容|首页/ },
    { name: "unrelated HTML", reply: () => html("<html><title>Proxy login</title><body>private-upstream-body</body></html>"), status: 200, reason: /网页|首页|V2EX/ },
  ])("reports $name without treating it as a usable webpage", async ({ reply, status, reason }) => {
    const test = setup(reply);
    const result = await testHttpProxy(test.db, test.env, config, test.factory);
    expect(result).toMatchObject({ ok: false, http_status: status });
    expect(result.message).toMatch(reason);
    expect(JSON.stringify(result)).not.toMatch(/private-|other\.example/);
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    expect(test.direct).not.toHaveBeenCalled();
    expect(test.write).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it.each(["PROXY_AUTH_FAILED", "CERT_NAME_MISMATCH", "ETIMEDOUT", "UNKNOWN_PRIVATE_ERROR"])(
    "returns a safe diagnostic for %s and closes the failed transport",
    async (code) => {
      const test = setup(() => {
        throw Object.assign(new Error("private-proxy-password private-upstream-body"), { code });
      });
      const result = await testHttpProxy(test.db, test.env, config, test.factory);
      expect(result).toMatchObject({ ok: false, http_status: null });
      expect(result.message).toMatch(/代理|超时|证书/);
      expect(JSON.stringify(result)).not.toMatch(/private-|UNKNOWN_PRIVATE_ERROR/);
      expect(test.direct).not.toHaveBeenCalled();
      expect(test.write).not.toHaveBeenCalled();
      expect(test.close).toHaveBeenCalledTimes(1);
    },
  );

  it("reports the overall timeout without exposing a raw transport error", async () => {
    const test = setup(() => { throw new Error("private-timeout-detail"); });
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const result = await testHttpProxy(test.db, test.env, config, test.factory);
    expect(result).toMatchObject({ ok: false, http_status: null });
    expect(result.message).toContain("超时");
    expect(result.message).not.toContain("private-");
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.direct).not.toHaveBeenCalled();
  });

  it("stops an oversized stream and releases the proxy connection", async () => {
    const cancel = vi.fn();
    const test = setup(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(homepage));
        controller.enqueue(new Uint8Array(MAX_BODY));
      },
      cancel,
    }), { headers: { "content-type": "text/html" } }));
    const result = await testHttpProxy(test.db, test.env, config, test.factory);
    expect(result).toMatchObject({ ok: false, http_status: 200 });
    expect(result.message).toMatch(/超过|过大|大小/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.direct).not.toHaveBeenCalled();
    expect(test.write).not.toHaveBeenCalled();
  });

  it("does not call a partial response successful when its stream fails", async () => {
    const test = setup(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(homepage));
      },
      pull(controller) {
        controller.error(Object.assign(new Error("private-upstream-body"), { code: "ECONNRESET" }));
      },
    }), { headers: { "content-type": "text/html" } }));
    const result = await testHttpProxy(test.db, test.env, config, test.factory);
    expect(result).toMatchObject({ ok: false, http_status: 200 });
    expect(result.message).not.toContain("private-");
    expect(test.close).toHaveBeenCalledTimes(1);
    expect(test.direct).not.toHaveBeenCalled();
  });
});
