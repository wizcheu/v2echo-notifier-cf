import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "../worker/notifier/context";
import { relayRequest, upstream } from "../worker/notifier/http";
import { createHttpTransport, parseProxyUpdate } from "../worker/http-proxy";
import { Database } from "../worker/db";
import type { Env } from "../worker/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notifier proxy routing", () => {
  it("preserves SOCKS5 authorities and rejects oversized UTF-8 authentication", () => {
    const config = {
      enabled: true,
      username: "proxy-user",
      password: "private-password",
    };
    for (const address of [
      "socks5://proxy.example:1080",
      "socks5://[::1]:1080",
      "socks5://proxy.example",
    ]) {
      expect(
        parseProxyUpdate({ ...config, address: address + "/" }).config?.address,
      ).toBe(address);
    }
    expect(() =>
      parseProxyUpdate({
        ...config,
        address: "socks5://proxy.example",
        username: "用".repeat(86),
      }),
    ).toThrow("255");
    expect(() =>
      parseProxyUpdate({
        ...config,
        address: "socks5://proxy.example",
        password: "p".repeat(256),
      }),
    ).toThrow("255");
  });
  it("uses the same transport for Cookie HTML, PAT API, and push calls even with a service binding", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const direct = vi.fn(() => {
      throw new Error("unexpected direct fetch");
    });
    const service = vi.fn(() => {
      throw new Error("unexpected service binding");
    });
    vi.stubGlobal("fetch", direct);
    const outbound = createHttpTransport(
      async () => ({
        address: "http://proxy.example:8080",
        username: "",
        password: "",
      }),
      async () => ({
        close: async () => {},
        fetch: async (input, init) => {
          calls.push({ url: String(input), init });
          return String(input) === "https://www.v2ex.com/"
            ? new Response("html")
            : Response.json({ ok: true });
        },
      }),
    );
    const db = new Database({} as D1Database);
    vi.spyOn(db, "one").mockImplementation(async sql =>
      sql.includes("FROM notifier_credentials") ? undefined : { until: 0, failures: 0 });
    vi.spyOn(db, "batch").mockResolvedValue([]);
    vi.spyOn(db, "statement").mockReturnValue({} as D1PreparedStatement);
    const env = {
      DB: {} as D1Database,
      ADMIN_TOKEN: "test",
      V2EX_COOKIE: "session=synthetic",
      V2EX_PAT: "synthetic-pat",
      PUSH_SERVICE: { fetch: service } as unknown as Fetcher,
      outbound,
    } satisfies Env;
    const c = new Context(db, env, "fixture");
    await upstream(c, "/");
    await upstream(c, "/api/v2/member");
    await relayRequest(c, "/v1/sync", "synthetic-sender", { events: [] });
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.v2ex.com/",
      "https://www.v2ex.com/api/v2/member",
      "https://app.v2echo.com/api/push/v1/sync",
    ]);
    expect(new Headers(calls[0].init?.headers).get("Cookie")).toBe(
      "session=synthetic",
    );
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe(
      "Bearer synthetic-pat",
    );
    expect(new Headers(calls[2].init?.headers).get("Authorization")).toBe(
      "Bearer synthetic-sender",
    );
    expect(calls[2].init?.body).toBe('{"events":[]}');
    expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
    expect(direct).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
    await outbound.close();
  });

  it("keeps the direct binding when disabled and never falls back to it when the proxy fails", async () => {
    const service = vi.fn(async () => Response.json({ ok: true }));
    const db = new Database({} as D1Database);
    const env = {
      DB: {} as D1Database,
      ADMIN_TOKEN: "test",
      PUSH_SERVICE: { fetch: service } as unknown as Fetcher,
      outbound: createHttpTransport(async () => null),
    } satisfies Env;
    await relayRequest(new Context(db, env, "fixture"), "/v1/health");
    expect(service).toHaveBeenCalledTimes(1);
    const fail = vi.fn(async () => {
      throw new Error("secret-proxy-user");
    });
    env.outbound = createHttpTransport(
      async () => ({
        address: "http://proxy.example:8080",
        username: "",
        password: "",
      }),
      async () => ({ fetch: fail, close: async () => {} }),
    );
    await expect(
      relayRequest(new Context(db, env, "fixture"), "/v1/health"),
    ).rejects.toThrow("推送服务网络请求失败");
    expect(service).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
    await env.outbound.close();
  });

  it.each([
    "PROXY_AUTH_FAILED",
    "SOCKS5_NO_ACCEPTABLE_AUTH",
    "SOCKS5_REPLY",
    "TLS_HANDSHAKE",
    "CERT_SIGNATURE_UNSUPPORTED",
  ])(
    "keeps safe %s diagnostics through API, HTML and push requests",
    async (code) => {
      const failure = Object.assign(
        new Error("secret-proxy-user private-password upstream-body"),
        { code },
      );
      const direct = vi.fn();
      vi.stubGlobal("fetch", direct);
      const service = vi.fn();
      const outbound = createHttpTransport(
        async () => ({
          address: "http://proxy.example:8080",
          username: "user",
          password: "password",
        }),
        async () => ({
          fetch: async () => {
            throw failure;
          },
          close: async () => {},
        }),
      );
      const db = new Database({} as D1Database);
      vi.spyOn(db, "one").mockImplementation(async sql =>
        sql.includes("FROM notifier_credentials") ? undefined : { until: 0, failures: 0 });
      vi.spyOn(db, "batch").mockResolvedValue([]);
      vi.spyOn(db, "statement").mockReturnValue({} as D1PreparedStatement);
      const env = {
        DB: {} as D1Database,
        ADMIN_TOKEN: "test",
        V2EX_COOKIE: "session=synthetic",
        V2EX_PAT: "synthetic-pat",
        PUSH_SERVICE: { fetch: service } as unknown as Fetcher,
        outbound,
      } satisfies Env;
      const c = new Context(db, env, "fixture");
      for (const run of [
        () => upstream(c, "/"),
        () => upstream(c, "/api/v2/member"),
        () => relayRequest(c, "/v1/health"),
      ]) {
        const error = await run().catch((error) => error);
        expect(error.message).toContain(code);
        expect(error.message).not.toMatch(
          /secret-proxy-user|private-password|upstream-body/,
        );
      }
      expect(direct).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
      await outbound.close();
    },
  );
});
