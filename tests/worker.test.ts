import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const admin = "synthetic-test-admin-".repeat(4);
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let outbound = 0;
let migrated: any;
const home =
  '<a class="top" href="/member/tester">tester</a><div id="Rightbar"><a href="/notifications">12 unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/123#reply2">topic</a></span></div>';
const sql = (text: string) => text.replace(/--[^\n]*/g, "").replace(/\n/g, " ");
async function call(path: string, data: unknown = {}) {
  return mf
    .dispatchFetch(`http://local${path}`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    .then((r) => r.json()) as Promise<any>;
}
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  token = admin,
  origin = "http://local",
) {
  return mf.dispatchFetch(`http://local/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(async () => {
  const result = await build({
    entryPoints: ["tests/harness.ts"],
    external: ["cloudflare:sockets"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-10-19",
      d1Databases: ["DB"],
      bindings: { ADMIN_TOKEN: admin, NOTIFIER_KEY: "ab".repeat(32) },
      outboundService: () => {
        outbound++;
        return new Response("unexpected upstream", { status: 500 });
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    if (file === "0005_remove_probes.sql") {
      await db.exec(
        sql(`
        UPDATE control SET enabled=1,lease='in-flight',lease_until=123,next_dispatch=456,api_until=789,web_until=987,cleanup_at=654;
        UPDATE notifier SET account_id=7,binding_id='paired',sender_enc='encrypted-sender',scan_page=3;
        INSERT INTO notification_dedup VALUES(7,99,'existing-event');
        INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,avatar_url,content_enc,wire,status,created_at,expires_at,updated_at) VALUES('existing-event',7,99,'paired','notification','reply',1,'','encrypted-content','immutable-wire','submitted',1,999999,2);
        INSERT INTO notification_history VALUES(7,99,'reply',1,2,'encrypted-content');
        INSERT INTO runs(id,probe_id,kind,started_at) VALUES('old-run','home','home',1);
        INSERT INTO daily(day,rows_read,rows_written) VALUES('2026-10-01',123,45);
        INSERT INTO api_daily(day,source,endpoint,attempts) VALUES('2026-10-01','probe','member',2),('2026-10-01','notifier','member',3);
      `),
      );
      await db.exec(sql(await readFile(`migrations/${file}`, "utf8")));
      migrated = {
        control: await db.prepare("SELECT * FROM control").first(),
        notifier: await db
          .prepare(
            "SELECT account_id,binding_id,sender_enc,scan_page FROM notifier",
          )
          .first(),
        queue: await db
          .prepare("SELECT event_id,wire,status FROM notification_outbox")
          .first(),
        dedup: await db
          .prepare("SELECT COUNT(*) AS n FROM notification_dedup")
          .first(),
        history: await db
          .prepare("SELECT COUNT(*) AS n FROM notification_history")
          .first(),
        usage: await db
          .prepare(
            "SELECT rows_read,rows_written FROM daily WHERE day='2026-10-01'",
          )
          .first(),
      };
    } else if (file === "0017_personal_messages_cache.sql") {
      await db.exec(sql(`
        UPDATE notification_outbox SET avatar_url='https://cdn.v2ex.com/avatar/existing.png' WHERE event_id='existing-event';
        INSERT INTO notification_history(account_id,notification_id,kind,created_at,fetched_at,content_enc) VALUES(8,99,'reply',1,2,'other-account'),(7,100,'reply',1,2,'without-avatar');
      `));
      await db.exec(sql(await readFile(`migrations/${file}`, "utf8")));
      migrated.messages = {
        items: (await db.prepare("SELECT account_id,notification_id,avatar_url,content_enc FROM notification_history ORDER BY account_id,notification_id").all()).results,
        progress: await db.prepare("SELECT history_next_page FROM notifier WHERE id=1").first(),
      };
    } else await db.exec(sql(await readFile(`migrations/${file}`, "utf8")));
  }
  migrated.accessControl = await db.prepare("SELECT * FROM control").first();
  migrated.state = await (await api("/state")).json();
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  outbound = 0;
  await db.batch([
    ...[
      "api_usage",
      "api_daily",
      "daily",
      "notification_outbox",
      "notification_history",
      "notification_dedup",
      "notifier_pairing_invitation",
      "notifier_credentials",
      "notifier",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
    db.prepare("INSERT INTO notifier(id) VALUES(1)"),
    db.prepare(
      "UPDATE http_proxy SET enabled=0,address='',authenticated=0,payload='' WHERE id=1",
    ),
    db.prepare(
      "UPDATE control SET lease='',lease_until=0,next_dispatch=0,api_until=0,web_until=0,cleanup_at=0,api_forbidden_failures=0,web_forbidden_failures=0",
    ),
  ]);
});

describe("notification-only Worker and migration", () => {
  it("reads empty message caches without upstream calls and enforces authentication, cursor validation and GET-only access", async () => {
    expect((await api("/notifier/messages", "GET", undefined, "wrong")).status).toBe(401);
    expect((await api("/notifier/messages", "POST", {})).status).toBe(405);
    for (const cursor of ["invalid", "null", "{}", "[0,\"history\"]", "[1,\"checks\"]", "[1,\"history\",2]", "x".repeat(129)]) {
      expect((await api(`/notifier/messages?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    }
    expect((await api("/notifier/messages?view=deliveries")).status).toBe(400);
    const result = await api("/notifier/messages");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ items: [], next_cursor: null, fetched_at: 0, upstream_next_page: 1 });
    expect(outbound).toBe(0);
  });

  it("migrates cached personal messages without losing content and only backfills matching account avatars", () => {
    expect(migrated.messages).toEqual({
      items: [
        { account_id: 7, notification_id: 99, avatar_url: "https://cdn.v2ex.com/avatar/existing.png", content_enc: "encrypted-content" },
        { account_id: 7, notification_id: 100, avatar_url: "", content_enc: "without-avatar" },
        { account_id: 8, notification_id: 99, avatar_url: "", content_enc: "other-account" },
      ],
      progress: { history_next_page: 1 },
    });
  });

  it("reads and validates the personal messages page body behind administrator authentication", async () => {
    expect((await api("/notifier/history", "POST", { page: 2 }, "wrong")).status).toBe(401);
    for (const input of [{ page: 0 }, { page: 10000 }, { page: "2" }, { page: 1, extra: true }, null, []]) {
      const response = await api("/notifier/history", "POST", input);
      expect(response.status).toBe(400);
    }
    expect(outbound).toBe(0);
  });

  it("protects proxy tests with administrator auth, same-origin writes and POST-only routing", async () => {
    const draft = { address: "http://proxy.example:8080", username: "", password: "" };
    expect((await api("/proxy-settings/test", "POST", draft, "wrong")).status).toBe(401);
    expect((await api("/proxy-settings/test", "POST", draft, admin, "https://evil.example")).status).toBe(403);
    expect((await api("/proxy-settings/test")).status).toBe(405);
    expect(outbound).toBe(0);
  });

  it("rejects missing or invalid proxy test settings without altering settings or notification state", async () => {
    await db.exec("UPDATE control SET api_until=789,web_until=987,next_dispatch=654");
    const before = {
      control: await db.prepare("SELECT * FROM control").first(),
      notifier: await db.prepare("SELECT * FROM notifier").first(),
      proxy: await db.prepare("SELECT * FROM http_proxy").first(),
    };
    for (const input of [
      {},
      { url: "https://other.example/" },
      { address: "http://proxy.example:8080", username: "", password: "", enabled: true },
      { address: "https://proxy.example:8080", username: "", password: "" },
    ]) expect((await api("/proxy-settings/test", "POST", input)).status).toBe(400);
    expect(await db.prepare("SELECT * FROM control").first()).toEqual(before.control);
    expect(await db.prepare("SELECT * FROM notifier").first()).toEqual(before.notifier);
    expect(await db.prepare("SELECT * FROM http_proxy").first()).toEqual(before.proxy);
    expect(outbound).toBe(0);
  });

  it.each(["http://proxy.example:8080", "socks5://proxy.example:1080"])(
    "saves %s encrypted and preserves existing cooldowns",
    async (address) => {
      const config = {
        enabled: true,
        address,
        username: "proxy-user",
        password: "private-password",
      };
      await db.exec(
        "UPDATE control SET api_until=789,web_until=987,next_dispatch=654",
      );
      const before = await db.prepare("SELECT * FROM control").first();
      expect(
        (await api("/proxy-settings", "PUT", config, "wrong")).status,
      ).toBe(401);
      expect(
        (
          await api(
            "/proxy-settings",
            "PUT",
            config,
            admin,
            "https://evil.example",
          )
        ).status,
      ).toBe(403);
      expect((await api("/proxy-settings", "PUT", config)).status).toBe(200);
      const saved = await db.prepare("SELECT * FROM http_proxy").first<any>();
      expect(saved.payload).toMatch(/^1\./);
      expect(JSON.stringify(saved)).not.toMatch(/proxy-user|private-password/);
      const state = await (await api("/proxy-settings")).json<any>();
      expect(state).toMatchObject({
        enabled: true,
        configured: true,
        address: config.address,
        authenticated: true,
      });
      expect(JSON.stringify(state)).not.toMatch(
        /payload|proxy-user|private-password/,
      );
      expect(await db.prepare("SELECT * FROM control").first()).toEqual(before);
      for (const address of [
        "https://proxy.example",
        "socks4://proxy.example:1080",
        "http://user:secret@proxy.example",
        "http://proxy.example/path",
      ]) {
        expect(
          (await api("/proxy-settings", "PUT", { ...config, address })).status,
        ).toBe(400);
      }
      expect(
        (await db.prepare("SELECT payload FROM http_proxy").first<any>())
          .payload,
      ).toBe(saved.payload);
      await api("/proxy-settings", "PUT", { enabled: false });
      expect(await (await api("/proxy-settings")).json()).toMatchObject({
        enabled: false,
        configured: true,
      });
      expect(
        (await api("/proxy-settings", "PUT", { enabled: true })).status,
      ).toBe(200);
      await db.exec("UPDATE http_proxy SET payload='invalid',enabled=0");
      expect(
        (await api("/proxy-settings", "PUT", { enabled: true })).status,
      ).toBe(400);
      await api("/proxy-settings", "PUT", { enabled: false, remove: true });
      expect(await (await api("/proxy-settings")).json()).toMatchObject({
        enabled: false,
        configured: false,
        address: "",
      });
      expect(outbound).toBe(0);
    },
  );

  it("saves validated check hours without changing notification state, progress or cooldowns", async () => {
    await db.exec(
      "UPDATE notifier SET enabled=1,scan_page=3,scan_until=123,relay_until=456; UPDATE control SET api_until=789,web_until=987,next_dispatch=654",
    );
    const protectedState = await db
      .prepare("SELECT enabled,scan_page,scan_until,relay_until FROM notifier")
      .first();
    const control = await db.prepare("SELECT * FROM control").first();
    expect(
      (
        await api(
          "/notifier/schedule",
          "PUT",
          { startHour: 22, endHour: 6 },
          "wrong",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await api(
          "/notifier/schedule",
          "PUT",
          { startHour: 22, endHour: 6 },
          admin,
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    for (const input of [
      {},
      { startHour: 8, endHour: 8 },
      { startHour: "8", endHour: 24 },
      { startHour: 24, endHour: 8 },
      { startHour: 8, endHour: 0 },
      { startHour: 8.5, endHour: 24 },
    ])
      expect((await api("/notifier/schedule", "PUT", input)).status).toBe(400);
    expect(
      (await api("/notifier/schedule", "PUT", { startHour: 22, endHour: 6 }))
        .status,
    ).toBe(200);
    const current = (await (await api("/state")).json()) as any;
    expect(current.notifier).toMatchObject({
      check_start_hour: 22,
      check_end_hour: 6,
    });
    expect(
      await db
        .prepare(
          "SELECT enabled,scan_page,scan_until,relay_until FROM notifier",
        )
        .first(),
    ).toEqual(protectedState);
    expect(await db.prepare("SELECT * FROM control").first()).toEqual(control);
    expect(outbound).toBe(0);
  });
  it("drops only obsolete storage and preserves the notification workflow and recorded usage", async () => {
    expect(migrated.accessControl).toEqual({
      ...migrated.control,
      last_notifier_id: 0,
      account_creation_until: 0,
      account_validation_sequence: 0,
      api_forbidden_failures: 0,
      web_forbidden_failures: 0,
    });
    expect(migrated.control).toEqual({
      id: 1,
      lease: "in-flight",
      lease_until: 123,
      next_dispatch: 456,
      api_until: 789,
      web_until: 987,
      cleanup_at: 654,
    });
    expect(migrated.notifier).toEqual({
      account_id: 7,
      binding_id: "paired",
      sender_enc: "encrypted-sender",
      scan_page: 3,
    });
    expect(migrated.queue).toEqual({
      event_id: "existing-event",
      wire: "immutable-wire",
      status: "submitted",
    });
    expect(migrated.dedup.n).toBe(1);
    expect(migrated.history.n).toBe(1);
    expect(migrated.state.notifier.check_start_hour).toBe(8);
    expect(migrated.state.notifier.check_end_hour).toBe(24);
    expect(migrated.usage).toEqual({ rows_read: 123, rows_written: 45 });
    expect(migrated.state.api_usage.daily).toContainEqual(
      expect.objectContaining({
        day: "2026-10-01",
        endpoint: "member",
        attempts: 5,
      }),
    );
    const tables = (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
    ).results.map((x) => x.name);
    expect(tables).not.toContain("probes");
    expect(tables).not.toContain("runs");
    expect(tables).toContain("notifier_pairing_invitation");
  });
  it.each([
    ["/run", "POST", {}],
    ["/config", "PUT", { enabled: true, retentionDays: 7 }],
    ["/topics", "POST", { topicId: 123 }],
    ["/probes/home", "PATCH", { enabled: true, intervalSeconds: 180 }],
    ["/probes/topic:123", "DELETE", undefined],
    ["/export", "GET", undefined],
    ["/notifier/pair", "POST", {}],
    ["/accounts/1/notifier/pair/qr/complete", "POST", {}],
    ["/notifier/watch/pair", "POST", {}],
  ])("removes the legacy endpoint %s", async (path, method, body) => {
    expect((await api(path, method, body)).status).toBe(404);
    expect(outbound).toBe(0);
  });
  it("keeps authorization, same-origin writes, bounded input and a notification-only state", async () => {
    for (const path of ["/notifier/pair/qr", "/notifier/transfer/complete"]) {
      expect((await api(path, "POST", {}, "wrong")).status).toBe(401);
      expect(
        (await api(path, "POST", {}, admin, "https://evil.example")).status,
      ).toBe(403);
      expect(
        (await api(path, "POST", { extra: "x".repeat(5000) })).status,
      ).toBe(400);
      expect((await api(path, "GET")).status).toBe(404);
    }
    expect((await api("/state", "GET", undefined, "wrong")).status).toBe(401);
    expect(
      (
        await api(
          "/notifier/config",
          "PUT",
          { enabled: false },
          admin,
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api("/notifier/config", "PUT", {
          enabled: false,
          extra: "x".repeat(5000),
        })
      ).status,
    ).toBe(400);
    expect(
      (await api("/notifier/config", "PUT", { enabled: false })).status,
    ).toBe(200);
    const response = await api("/state");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(admin);
    const state = JSON.parse(text);
    expect(state).not.toHaveProperty("probes");
    expect(state).not.toHaveProperty("runs");
    expect(state).not.toHaveProperty("outcomes");
    expect(state.control).not.toHaveProperty("enabled");
    expect(state.control).not.toHaveProperty("retention_days");
    expect(state.notifier.enabled).toBe(0);
  });
  it("issues persistent browser cookies, protects writes and clears login on logout", async () => {
    const headers = {
      Origin: "http://local",
      "X-Notifier-Request": "1",
      "Content-Type": "application/json",
    };
    const login = (extra = {}, payload: unknown = { token: admin }) =>
      mf.dispatchFetch("http://local/api/login", {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(payload),
      });
    expect((await login({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await login({ "X-Notifier-Request": "" })).status).toBe(403);
    const wrong = await login({}, { token: "wrong" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    expect((await login({}, { token: "x".repeat(5000) })).status).toBe(400);
    const response = await login();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("HttpOnly; SameSite=Strict");
    expect(setCookie).not.toContain(admin);
    const Cookie = setCookie.split(";")[0];
    const read = await mf.dispatchFetch("http://local/api/state", {
      headers: { Cookie },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("Set-Cookie")).toBeNull();
    expect(
      (
        await mf.dispatchFetch("http://local/api/notifier/config", {
          method: "PUT",
          headers: { Cookie, "Content-Type": "application/json" },
          body: '{"enabled":false}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await mf.dispatchFetch("http://local/api/notifier/config", {
          method: "PUT",
          headers: { ...headers, Cookie },
          body: '{"enabled":false}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mf.dispatchFetch("http://local/api/logout", {
          method: "POST",
          headers: { Cookie },
        })
      ).status,
    ).toBe(403);
    const logout = await mf.dispatchFetch("http://local/api/logout", {
      method: "POST",
      headers: { ...headers, Cookie },
    });
    expect(logout.status).toBe(200);
    const clearedCookie = logout.headers.get("Set-Cookie")!;
    expect(clearedCookie).toContain("Max-Age=0");
    expect(
      (
        await mf.dispatchFetch("http://local/api/state", {
          headers: { Cookie: clearedCookie.split(";")[0] },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await mf.dispatchFetch("http://local/api/logout", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200);
    expect(outbound).toBe(0);
  });
  it("performs maintenance with no upstream traffic when notifications are paused", async () => {
    expect(await call("/scheduled")).toEqual({ ok: true });
    expect(outbound).toBe(0);
    expect(await db.prepare("SELECT cron,outbound FROM daily").first()).toEqual(
      { cron: 1, outbound: 0 },
    );
    expect(
      (await db.prepare("SELECT cleanup_at FROM control").first())?.cleanup_at,
    ).toBeGreaterThan(Date.now());
  });
  it("retains bounded usage cleanup after removing probe storage", async () => {
    const now = Date.now(),
      day = new Date(now).toISOString().slice(0, 10);
    await db
      .prepare(
        "INSERT INTO api_usage(id,source,endpoint,attempted_at) VALUES('old','notifier','member',?),('recent','notifier','notifications',?)",
      )
      .bind(now - 8 * 86400000, now)
      .run();
    await db
      .prepare(
        "INSERT INTO api_daily(day,source,endpoint) VALUES('2020-01-01','notifier','member'),(?,'notifier','member')",
      )
      .bind(day)
      .run();
    await db
      .prepare("INSERT INTO daily(day) VALUES('2020-01-01'),(?)")
      .bind(day)
      .run();
    expect(await call("/cleanup", { now })).toEqual({ ok: true });
    expect(
      (await db.prepare("SELECT id FROM api_usage").all()).results,
    ).toEqual([{ id: "recent" }]);
    expect(
      (await db.prepare("SELECT day FROM api_daily").all()).results,
    ).toEqual([{ day }]);
    expect((await db.prepare("SELECT day FROM daily").all()).results).toEqual([
      { day },
    ]);
  });
});

describe("homepage unread validation", () => {
  it.runIf(existsSync("../site-data/html_20260701/root_index"))(
    "checks real saved homepage structure",
    async () => {
      const root = "../site-data/html_20260701/root_index";
      const file = (await readdir(root)).find((name) =>
        name.endsWith(".html"),
      )!;
      expect(
        await call("/parse", {
          html: await readFile(`${root}/${file}`, "utf8"),
          username: "wizChen",
        }),
      ).toEqual({ count: 0 });
    },
  );
  it("requires matching identity and supports absolute links, Chinese and zero unread", async () => {
    expect(await call("/parse", { html: home, username: "tester" })).toEqual({
      count: 12,
    });
    expect(
      await call("/parse", {
        html: home
          .replaceAll('href="/', 'href="https://www.v2ex.com/')
          .replace("12 unread notifications", "0 未读提醒"),
        username: "TESTER",
      }),
    ).toEqual({ count: 0 });
    expect(await call("/parse", { html: home, username: "other" })).toEqual({
      error: "auth",
    });
    expect(await call("/parse", { html: home, username: "" })).toEqual({
      error: "auth",
    });
  });
  it("rejects challenges and incomplete pages without classifying them as zero unread", async () => {
    expect(
      await call("/parse", {
        html: "<title>Just a moment...</title>",
        username: "tester",
      }),
    ).toEqual({ error: "challenge" });
    expect(
      await call("/parse", {
        html: home.replace("12 unread notifications", "unknown"),
        username: "tester",
      }),
    ).toEqual({ error: "parse" });
    expect(
      await call("/parse", {
        html: home.replace("item_title", "other"),
        username: "tester",
      }),
    ).toEqual({ error: "parse" });
    expect(
      await call("/parse", {
        html:
          home +
          '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
        username: "tester",
      }),
    ).toEqual({ count: 12 });
  });
  it("preserves full Cookie headers and rejects injected headers or oversized input", async () => {
    expect(
      await call("/cookie", { value: "Cookie: A2=one=two; session=three" }),
    ).toEqual({ value: "A2=one=two; session=three" });
    for (const value of [
      "A2=x\r\nAuthorization: other",
      "invalid",
      "",
      `A2=${"x".repeat(16384)}`,
    ])
      expect(await call("/cookie", { value })).toHaveProperty("error");
  });
});
