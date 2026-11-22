import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";

let empty: Miniflare;
let configured: Miniflare;
let outbound = 0;

beforeAll(async () => {
  const result = await build({
    entryPoints: ["worker/index.ts"],
    external: ["cloudflare:sockets"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  const options = {
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: "2026-10-19",
    outboundService: () => {
      outbound++;
      return new Response("unexpected upstream", { status: 500 });
    },
  };
  empty = new Miniflare(convertV4MiniflareOptions(options));
  configured = new Miniflare(
    convertV4MiniflareOptions({
      ...options,
      bindings: { ADMIN_TOKEN: "synthetic-health-admin-".repeat(4) },
    }),
  );
}, 60_000);

afterAll(async () => {
  await Promise.all([empty?.dispose(), configured?.dispose()]);
});

beforeEach(() => {
  outbound = 0;
});

describe("anonymous app health route", () => {
  it("responds without credentials, secrets, database bindings or external requests", async () => {
    const response = await empty.dispatchFetch("http://local/api/app/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(outbound).toBe(0);
  });

  it.each(["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects %s without entering authentication or database handling",
    async (method) => {
      const response = await empty.dispatchFetch("http://local/api/app/v1/health", { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      if (method !== "HEAD")
        expect(await response.json()).toEqual({ error: "请求方法无效" });
      expect(outbound).toBe(0);
    },
  );

  it.each(["/api/app/v1/health/", "/api/app/v1/health-extra", "/api/health"])(
    "does not exempt the neighboring path %s from configuration requirements",
    async (path) => {
      const response = await empty.dispatchFetch(`http://local${path}`);
      expect(response.status).toBe(503);
      expect(outbound).toBe(0);
    },
  );

  it.each(["/api/state", "/api/proxy-settings", "/api/notifier/records", "/api/version/check"])(
    "keeps authentication required for %s",
    async (path) => {
      const response = await configured.dispatchFetch(`http://local${path}`);
      expect(response.status).toBe(401);
      expect(outbound).toBe(0);
    },
  );
});
