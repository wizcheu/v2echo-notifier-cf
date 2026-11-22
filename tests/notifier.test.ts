import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCentralApnsPayload, validateCentralEvent } from "./central-push";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import type { Notification } from "../worker/notifier/presentation";
import {
  createHash,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
  createPublicKey,
} from "node:crypto";

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const admin = "synthetic-test-admin-".repeat(4),
  key = "ab".repeat(32),
  cookie = "A2=synthetic; other=value",
  pat = "synthetic-pat";
const binding = "11111111-1111-4111-8111-111111111111",
  device = "22222222-2222-4222-8222-222222222222";
let now: number;
let outboundCalls = 0;
let serviceCalls: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}[] = [];
const home = (count: number, username = "tester") =>
  `<a class="top" href="/member/${username}">${username}</a><div id="Rightbar"><a href="/notifications">${count} unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/123">topic</a></span></div>`;
const profile = {
  body: { success: true, result: { id: 7, username: "tester" } },
};
const notice = (
  id: number,
  action = "回复了你",
  payload = "private notification content",
) => ({
  id,
  for_member_id: 7,
  text: `<a href="/member/actor">actor</a> ${action} <a href="/t/123">topic about 感谢</a>`,
  payload_rendered: payload,
  member: {
    username: "actor",
    avatar_large: "//cdn.v2ex.com/avatar/1/2/3.png",
  },
});
const page = (...ids: number[]) => ({
  body: { success: true, result: ids.map((id) => notice(id)) },
});
const health = {
  body: {
    notification_details: 1,
    notification_body_encryption: 2,
    notification_routing: 1,
    notification_test_samples: 1,
    notification_test_avatars: 1,
    max_events: 20,
    max_receipts: 50,
    max_sync_bytes: 65536,
    sync_interval: 30,
  },
};
const pairingHealth = { body: { notifier_direct_pairing: 1 } };
const cryptographic = generateKeyPairSync("x25519");
const publicBytes = cryptographic.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const recipient = {
  device_id: device,
  binding_id: binding,
  key_id: createHash("sha256").update(publicBytes).digest("hex"),
  public_key: publicBytes.toString("base64url"),
};
const directory = { body: { source_account_id: 7, recipients: [recipient] } };
async function call(path: string, data: unknown = {}) {
  return mf
    .dispatchFetch(`http://local${path}`, {
      method: "POST",
      body: JSON.stringify(data),
    })
    .then((r) => r.json()) as Promise<any>;
}
async function state() {
  return db.prepare("SELECT * FROM notifier WHERE id=1").first<any>();
}
async function rows() {
  return (
    await db
      .prepare("SELECT * FROM notification_outbox ORDER BY created_at,event_id")
      .all<any>()
  ).results;
}
async function scan(count: number, ids: number[]) {
  const result = await call("/scan", {
    now,
    responses: [{ body: home(count) }, page(...ids)],
  });
  expect(result.error).toBeUndefined();
  return result;
}
async function prepareOne(id = 100) {
  await scan(1, [id]);
  return (await rows())[0];
}
const receipt = (id: string, status = "pending") => ({
  body: { retry_after_seconds: 30, receipts: [{ event_id: id, status }] },
});
async function api(path: string, token = admin) {
  return mf.dispatchFetch(`http://local/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["tests/notifier.harness.ts"],
    external: ["cloudflare:sockets"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-19",
      d1Databases: ["DB"],
      serviceBindings: {
        PUSH_SERVICE: async (request) => {
          serviceCalls.push({
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: request.method === "GET" ? undefined : await request.json(),
          });
          if (new URL(request.url).pathname.endsWith("/v1/health")) return Response.json(pairingHealth.body);
          if (new URL(request.url).pathname.endsWith("/v1/invitations"))
            return Response.json({ expires_at: new Date(Date.now() + 599000).toISOString() });
          return Response.json({
            paired: true,
            binding_id: binding,
            username: "tester",
          });
        },
      },
      outboundService: (request) => {
        outboundCalls++;
        return new URL(request.url).pathname === "/api/v2/member"
          ? Response.json(profile.body)
          : new Response(home(0));
      },
      bindings: {
        ADMIN_TOKEN: admin,
        NOTIFIER_KEY: key,
        V2EX_COOKIE: cookie,
        V2EX_PAT: pat,
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort())
    await db.exec(
      (await readFile(`migrations/${file}`, "utf8"))
        .replace(/--[^\n]*/g, "")
        .replace(/\n/g, " "),
    );
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  serviceCalls = [];
  outboundCalls = 0;
  now = Date.now() + 1000;
  // These legacy notification cases do not schedule the new, independently tested control plane.
  await db.prepare("UPDATE watch_control SET next_sync=?,config='' WHERE id=1").bind(now + 30 * 86400000).run();
  await db.batch(
    [
      "api_usage",
      "api_daily",
      "notification_checks",
      "notification_history",
      "notification_samples",
      "notification_outbox",
      "notification_candidates",
      "notification_dedup",
      "notification_key_pins",
      "notifier_pairing_invitation",
      "notifier_credentials",
      "watch_targets",
      "notifier",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
  await db.exec(
    "INSERT INTO notifier(id) VALUES(1); UPDATE control SET lease='',lease_until=0,next_dispatch=0,api_until=0,web_until=0,api_forbidden_failures=0,web_forbidden_failures=0;",
  );
  const verified = await call("/action", {
    now,
    action: "verify",
    responses: [profile, { body: home(0) }],
  });
  expect(verified.error).toBeUndefined();
  now += 61000;
  const sender = (
    await call("/seal", {
      purpose: `sender:${binding}`,
      value: "synthetic-sender",
    })
  ).result;
  await db
    .prepare(
      "UPDATE notifier SET enabled=1,binding_id=?,sender_enc=?,paired_at=?,next_scan=0,check_start_hour=0,check_end_hour=24 WHERE id=1",
    )
    .bind(binding, sender, now - 60000)
    .run();
});

describe("persisted check intervals", () => {
  const schedule = {
    startHour: 0,
    endHour: 24,
    scanIntervalMinutes: 15,
    followingIntervalMinutes: 30,
    topicIntervalMinutes: 60,
  };
  const intervals = {
    scan_interval_minutes: 15,
    following_interval_minutes: 30,
    topic_interval_minutes: 60,
  };
  const saveSchedule = (input: Record<string, unknown>) =>
    mf.dispatchFetch("http://local/api/notifier/schedule", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

  it("keeps the existing default frequencies and exposes saved values in state", async () => {
    expect(await state()).toMatchObject({
      scan_interval_minutes: 3,
      following_interval_minutes: 10,
      topic_interval_minutes: 5,
    });
    const response = await saveSchedule({
      ...schedule,
      startHour: 22,
      endHour: 6,
    });
    expect(response.status).toBe(200);
    expect(await state()).toMatchObject({
      ...intervals,
      check_start_hour: 22,
      check_end_hour: 6,
    });
    const current = (await (await api("/state")).json()) as any;
    expect(current.notifier).toMatchObject({
      ...intervals,
      check_start_hour: 22,
      check_end_hour: 6,
    });
  });

  it("preserves saved frequencies for an older hours-only request", async () => {
    expect((await saveSchedule(schedule)).status).toBe(200);
    expect((await saveSchedule({ startHour: 8, endHour: 22 })).status).toBe(
      200,
    );
    expect(await state()).toMatchObject({
      ...intervals,
      check_start_hour: 8,
      check_end_hour: 22,
    });
  });

  it.each([
    [
      "only one interval",
      { startHour: 8, endHour: 22, scanIntervalMinutes: 15 },
    ],
    [
      "missing the scan interval",
      {
        startHour: 8,
        endHour: 22,
        followingIntervalMinutes: 30,
        topicIntervalMinutes: 60,
      },
    ],
    [
      "missing the topic interval",
      {
        startHour: 8,
        endHour: 22,
        scanIntervalMinutes: 15,
        followingIntervalMinutes: 30,
      },
    ],
    ["a string interval", { ...schedule, scanIntervalMinutes: "15" }],
    ["a null interval", { ...schedule, followingIntervalMinutes: null }],
    ["an unsupported scan interval", { ...schedule, scanIntervalMinutes: 30 }],
    [
      "an unsupported following interval",
      { ...schedule, followingIntervalMinutes: 3 },
    ],
    ["an unsupported topic interval", { ...schedule, topicIntervalMinutes: 7 }],
    ["a fractional interval", { ...schedule, topicIntervalMinutes: 10.5 }],
    ["an invalid time window", { ...schedule, startHour: 8, endHour: 8 }],
  ])("rejects %s without partially saving settings", async (_label, input) => {
    const before = await state();
    const response = await saveSchedule(input as Record<string, unknown>);
    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  it("keeps planned checks, partial scans, baselines and cooldowns when saving", async () => {
    await scan(3, [100, 99]);
    await db
      .prepare(
        "UPDATE notifier SET next_scan=?,scan_until=?,scan_failures=4,scan_error='scan cooldown',relay_until=?,relay_failures=2,relay_error='relay cooldown' WHERE id=1",
      )
      .bind(now + 900000, now + 1800000, now + 600000)
      .run();
    await db
      .prepare(
        "UPDATE control SET next_dispatch=?,api_until=?,web_until=?,api_forbidden_failures=2,web_forbidden_failures=3 WHERE id=1",
      )
      .bind(now + 60000, now + 3600000, now + 1800000)
      .run();
    await db
      .prepare(
        "INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at,state_enc,next_check,last_checked,failures,checking,error) VALUES('schedule-target',123,1,?,'persisted-baseline',?,?,3,1,'watch cooldown')",
      )
      .bind(now - 3600000, now + 3600000, now - 600000)
      .run();
    const before = await state();
    const control = await db
      .prepare("SELECT * FROM control WHERE id=1")
      .first();
    const targets = await db.prepare("SELECT * FROM watch_targets").all();
    const candidates = await db
      .prepare("SELECT * FROM notification_candidates")
      .all();

    expect(
      (await saveSchedule({ ...schedule, startHour: 8, endHour: 22 })).status,
    ).toBe(200);
    expect(await state()).toEqual({
      ...before,
      ...intervals,
      check_start_hour: 8,
      check_end_hour: 22,
    });
    expect(
      await db.prepare("SELECT * FROM control WHERE id=1").first(),
    ).toEqual(control);
    expect(
      (await db.prepare("SELECT * FROM watch_targets").all()).results,
    ).toEqual(targets.results);
    expect(
      (await db.prepare("SELECT * FROM notification_candidates").all()).results,
    ).toEqual(candidates.results);
  });

  it.each([
    [0, 3],
    [0, 15],
    [1, 3],
    [1, 15],
  ])(
    "schedules the next scan after %i unread at a %i-minute interval",
    async (unread, minutes) => {
      expect(
        (await saveSchedule({ ...schedule, scanIntervalMinutes: minutes }))
          .status,
      ).toBe(200);
      await scan(unread, unread ? [100] : []);
      const completed = await state();
      expect(completed.scan_stage).toBe("idle");
      expect(completed.next_scan - completed.last_scan).toBeGreaterThanOrEqual(
        minutes * 60000 - 1000,
      );
      expect(completed.next_scan - completed.last_scan).toBeLessThanOrEqual(
        minutes * 60000 + 1000,
      );
      now = completed.next_scan - 1000;
      expect((await call("/scan", { now, responses: [] })).calls).toEqual([]);
      now = completed.next_scan + 1;
      const due = await call("/scan", { now, responses: [{ body: home(0) }] });
      expect(due.error).toBeUndefined();
      expect(
        due.calls.map((request: any) => new URL(request.url).pathname),
      ).toEqual(["/"]);
    },
  );

  it("still refreshes a partial scan's unread snapshot after three minutes with a fifteen-minute interval", async () => {
    expect((await saveSchedule(schedule)).status).toBe(200);
    await scan(3, [100, 99]);
    const partial = await state();
    expect(partial.scan_stage).toBe("page");
    now = partial.observed_at + 180001;
    const refreshed = await call("/scan", {
      now,
      responses: [{ body: home(0) }],
    });
    expect(refreshed.error).toBeUndefined();
    expect(
      refreshed.calls.map((request: any) => new URL(request.url).pathname),
    ).toEqual(["/"]);
    expect(await state()).toMatchObject({ unread: 0, scan_stage: "idle" });
    expect(
      (await db.prepare("SELECT * FROM notification_candidates").all()).results,
    ).toEqual([]);
  });

  it("holds never-attempted notifications after six minutes until the configured next scan refreshes them", async () => {
    expect((await saveSchedule(schedule)).status).toBe(200);
    const row = await prepareOne();
    const completed = await state();
    now = completed.last_scan + 6 * 60000 + 1;
    const stale = await call("/round", { now, responses: [] });
    expect(stale.error).toBeUndefined();
    expect(stale.calls).toEqual([]);
    expect((await state()).last_scan).toBe(completed.last_scan);
    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      wire: null,
    });

    now = completed.next_scan + 1;
    const refreshed = await call("/round", {
      now,
      responses: [
        { body: home(1) },
        page(100),
        health,
        directory,
        receipt(row.event_id),
      ],
    });
    expect(refreshed.error).toBeUndefined();
    expect(
      refreshed.calls.map((request: any) => new URL(request.url).pathname),
    ).toEqual([
      "/",
      "/api/v2/notifications",
      "/api/push/v1/health",
      "/api/push/v1/recipient-keys",
      "/api/push/v1/sync",
    ]);
    expect((await rows())[0]).toMatchObject({
      event_id: row.event_id,
      status: "submitted",
      attempts: 1,
    });
  });
});

describe("single-account persisted notification workflow", () => {
  it("preserves a partial scan overnight without checking V2EX, renewing a lease or writing check records", async () => {
    const midnight =
      Math.floor((now + 8 * 3600000) / 86400000) * 86400000 -
      8 * 3600000 +
      2 * 86400000;
    now = midnight - 120000;
    await db
      .prepare(
        "UPDATE notifier SET verified_at=?,check_start_hour=8,check_end_hour=24",
      )
      .bind(now)
      .run();
    await scan(3, [100, 99]);
    const before = await state();
    const control = await db.prepare("SELECT * FROM control").first();
    const checks = await db
      .prepare("SELECT COUNT(*) AS n FROM notification_checks")
      .first();
    for (const hour of [0, 7]) {
      const result = await call("/round", {
        now: midnight + hour * 3600000,
        responses: [],
      });
      expect(result.calls).toEqual([]);
      expect(result.result.reason).toContain("不在检查时段");
    }
    expect(await state()).toEqual(before);
    expect(await db.prepare("SELECT * FROM control").first()).toEqual(control);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM notification_checks").first(),
    ).toEqual(checks);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM notification_candidates")
        .first(),
    ).toEqual({ n: 2 });
    // Reopening still follows the existing expired-identity verification rule.
    now = midnight + 8 * 3600000;
    const reopened = await call("/round", {
      now,
      responses: [profile, { body: home(3) }],
    });
    expect(reopened.calls.map((r: any) => new URL(r.url).pathname)).toEqual([
      "/api/v2/member",
      "/",
    ]);
    expect((await state()).scan_error).toBe("");
    expect((await state()).verified_at).toBeGreaterThanOrEqual(now);
    expect(await rows()).toHaveLength(0);
  });
  it("continues immutable push retries and receipt queries outside the check window without V2EX access", async () => {
    const midnight =
      Math.floor((now + 8 * 3600000) / 86400000) * 86400000 -
      8 * 3600000 +
      2 * 86400000;
    now = midnight - 120000;
    await db
      .prepare(
        "UPDATE notifier SET verified_at=?,check_start_hour=8,check_end_hour=24",
      )
      .bind(now)
      .run();
    const row = await prepareOne();
    const lost = await call("/relay", {
      now,
      responses: [health, directory, { error: true }],
    });
    expect(lost.error).toContain("网络");
    now = midnight + 8 * 60000;
    const retry = await call("/round", {
      now,
      responses: [health, receipt(row.event_id)],
    });
    expect(retry.calls).toHaveLength(2);
    expect(retry.calls.at(-1).body.events[0]).toEqual(
      lost.calls.at(-1).body.events[0],
    );
    expect(
      retry.calls.every((r: any) => new URL(r.url).host === "app.v2echo.com"),
    ).toBe(true);
    now += 61000;
    const confirmed = await call("/round", {
      now,
      responses: [receipt(row.event_id, "apns_accepted")],
    });
    expect(confirmed.calls).toHaveLength(1);
    expect(confirmed.calls[0].body).toEqual({
      events: [],
      receipts: [row.event_id],
    });
    expect((await rows())[0]).toMatchObject({
      status: "apns_accepted",
      attempts: 2,
      receipt_attempts: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM notification_checks WHERE source='scan'",
        )
        .first(),
    ).toEqual({ n: 0 });
  });
  it("does not send unattempted real content from a stale scan or bypass credential re-verification overnight", async () => {
    const midnight =
      Math.floor((now + 8 * 3600000) / 86400000) * 86400000 -
      8 * 3600000 +
      2 * 86400000;
    now = midnight - 120000;
    await db
      .prepare(
        "UPDATE notifier SET verified_at=?,check_start_hour=8,check_end_hour=24",
      )
      .bind(now)
      .run();
    await prepareOne();
    now = midnight + 8 * 60000;
    const stale = await call("/round", { now, responses: [] });
    expect(stale.calls).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      wire: null,
    });
    now += 61000;
    const changed = await call("/round", {
      now,
      env: { V2EX_PAT: "changed-synthetic-pat" },
      responses: [],
    });
    expect(changed.calls).toEqual([]);
    expect(changed.result.reason).toContain("重新确认");
    expect((await rows())[0].attempts).toBe(0);
  });
  it("paginates encrypted history without duplicate rows and isolates accounts", async () => {
    for (const ids of [
      Array.from({ length: 20 }, (_, i) => 120 - i),
      [100, 99, 98],
    ]) {
      const loaded = await call("/action", {
        now,
        action: "history",
        responses: [page(...ids)],
      });
      expect(loaded.error).toBeUndefined();
      now += 181000;
    }
    await db.exec(
      "UPDATE notification_history SET kind='mention' WHERE notification_id=110; INSERT INTO notification_history(account_id,notification_id,kind,created_at,fetched_at,content_enc) SELECT 8,999,kind,created_at,fetched_at,content_enc FROM notification_history LIMIT 1;",
    );
    const first = (await (
      await api("/notifier/records?view=history")
    ).json()) as any;
    expect(first.items.map((r: any) => r.notification_id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 120 - i),
    );
    const second = (await (
      await api(
        `/notifier/records?view=history&cursor=${encodeURIComponent(first.next_cursor)}`,
      )
    ).json()) as any;
    expect(second.items.map((r: any) => r.notification_id)).toEqual([
      100, 99, 98,
    ]);
    expect(second.next_cursor).toBeNull();
    expect(first.items[0].created_at).toBeNull();
    const filtered = (await (
      await api("/notifier/records?view=history&kind=mention")
    ).json()) as any;
    expect(filtered.items.map((r: any) => r.notification_id)).toEqual([110]);
    expect((await api("/notifier/records?cursor=invalid")).status).toBe(400);
    expect((await api("/notifier/records?view=unknown")).status).toBe(400);
    expect((await api("/notifier/records?kind=unknown")).status).toBe(400);
  });
  it("reads cached messages with avatars and isolated pagination without upstream access or fresh credentials", async () => {
    const loaded = await call("/action", {
      now,
      action: "history",
      responses: [page(...Array.from({ length: 23 }, (_, index) => 120 - index))],
    });
    expect(loaded.error).toBeUndefined();
    await db.exec("INSERT INTO notification_history(account_id,notification_id,kind,created_at,fetched_at,content_enc) SELECT 8,999,kind,created_at,fetched_at,content_enc FROM notification_history LIMIT 1; UPDATE notifier SET verified_at=0,credential_scope='changed',blocked='credentials',enabled=0,binding_id='' WHERE id=1;");
    const before = await state();
    const firstResponse = await api("/notifier/messages");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as any;
    expect(first).toMatchObject({
      fetched_at: loaded.result.fetched_at,
      upstream_next_page: 2,
      items: [{
        notification_id: 120,
        title: "actor 回复了《topic about 感谢》",
        body: "private notification content",
        avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png",
      }, ...Array.from({ length: 19 }, () => expect.any(Object))],
    });
    expect(first.items.map((item: any) => item.notification_id)).toEqual(Array.from({ length: 20 }, (_, index) => 120 - index));
    expect(Object.keys(first.items[0]).sort()).toEqual(["avatar_url", "body", "created_at", "kind", "notification_id", "title"]);
    const second = await (await api(`/notifier/messages?cursor=${encodeURIComponent(first.next_cursor)}`)).json() as any;
    expect(second.items.map((item: any) => item.notification_id)).toEqual([100, 99, 98]);
    expect(second.next_cursor).toBeNull();
    expect(second.upstream_next_page).toBe(2);
    expect(await state()).toEqual(before);
    expect(outboundCalls).toBe(0);
  });
  it("retains a usable history avatar when later API messages omit or reject the avatar", async () => {
    await call("/action", { now, action: "history", responses: [page(100)] });
    for (const member of [undefined, { username: "actor", avatar_large: "https://other.example/avatar/actor.png" }]) {
      const n = { ...notice(100), member };
      const refreshed = await call("/action", {
        now, action: "history", responses: [{ body: { success: true, result: [n] } }],
      });
      expect(refreshed.error).toBeUndefined();
      expect(refreshed.result.items[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/1/2/3.png");
      expect(refreshed.calls).toHaveLength(1);
      const cached = await (await api("/notifier/messages")).json() as any;
      expect(cached.items[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/1/2/3.png");
    }
    expect(await db.prepare("SELECT avatar_url FROM notification_history WHERE notification_id=100").first())
      .toEqual({ avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png" });
  });
  it("keeps avatars collected by the automatic personal notification scan in the message cache", async () => {
    await prepareOne(100);
    const cached = await (await api("/notifier/messages")).json() as any;
    expect(cached.items[0]).toMatchObject({ notification_id: 100, avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png" });
    expect(cached.fetched_at).toBeGreaterThanOrEqual(now);
    expect(cached.upstream_next_page).toBe(1);
    expect(outboundCalls).toBe(0);
  });
  it("paginates equal-time checks and deliveries and keeps encrypted payloads out of records", async () => {
    await db.prepare("DELETE FROM notification_checks").run();
    const statements = [];
    for (let i = 0; i < 23; i++) {
      const id = i.toString().padStart(4, "0");
      statements.push(
        db
          .prepare(
            "INSERT INTO notification_checks(id,source,started_at,outcome,stage_before) VALUES(?,'scan',?,'ok','idle')",
          )
          .bind(id, now),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,avatar_url,content_enc,wire,status,created_at,expires_at,updated_at) VALUES(?,7,?,'binding',?,'reply',0,'','secret-ciphertext','secret-wire',?,?,?,?)",
          )
          .bind(
            id,
            100 + i,
            i === 0 ? "test" : "notification",
            i === 0 ? "pending" : "apns_accepted",
            now,
            now + 86400000,
            now,
          ),
      );
    }
    await db.batch(statements);
    for (const view of ["checks", "deliveries"]) {
      const first = (await (
        await api(`/notifier/records?view=${view}`)
      ).json()) as any;
      const second = (await (
        await api(
          `/notifier/records?view=${view}&cursor=${encodeURIComponent(first.next_cursor)}`,
        )
      ).json()) as any;
      const ids = [...first.items, ...second.items].map(
        (r: any) => r.id ?? r.event_id,
      );
      expect(first.items).toHaveLength(20);
      expect(ids).toHaveLength(23);
      expect(new Set(ids).size).toBe(23);
      expect(second.next_cursor).toBeNull();
      expect(JSON.stringify(first)).not.toContain("secret-");
      expect(
        (await api(`/notifier/records?view=${view}`, "wrong")).status,
      ).toBe(401);
    }
    const filtered = (await (
      await api("/notifier/records?view=deliveries&type=test&status=pending")
    ).json()) as any;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].type).toBe("test");
    expect(
      (await api("/notifier/records?view=checks&outcome=unknown")).status,
    ).toBe(400);
    await db.batch([
      db.prepare("INSERT INTO notification_checks(id,source,started_at,outcome,stage_before) VALUES('issue-err','scan',?,'error','idle')").bind(now + 100),
      db.prepare("INSERT INTO notification_checks(id,source,started_at,outcome,stage_before) VALUES('issue-int','following_topic',?,'interrupted','idle')").bind(now + 200),
    ]);
    const issueChecks = (await (
      await api("/notifier/records?view=checks&outcome=issues")
    ).json()) as any;
    expect(issueChecks.items.map((item: any) => item.id)).toEqual([
      "issue-int",
      "issue-err",
    ]);
    expect(
      (await api("/notifier/records?view=deliveries&type=unknown")).status,
    ).toBe(400);
  });
  it("filters and paginates real check sources while preserving topic identities", async () => {
    await db.prepare("DELETE FROM notification_checks").run();
    const statements = [];
    for (let i = 0; i < 23; i++) {
      statements.push(db.prepare("INSERT INTO notification_checks(id,source,detail,started_at,outcome,stage_before) VALUES(?,'topic_reply',?,?,'ok','idle')").bind(`topic-${i.toString().padStart(2, "0")}`, `帖子 #${i + 1} · 检查完成`, now));
    }
    for (const source of ["scan", "following_topic", "verify", "history"]) {
      statements.push(db.prepare("INSERT INTO notification_checks(id,source,started_at,outcome,stage_before) VALUES(?,?,?,'ok','idle')").bind(source.replace("_", "-"), source, now));
    }
    await db.batch(statements);
    const first = await (await api("/notifier/records?view=checks&source=topic_reply")).json() as any;
    const second = await (await api(`/notifier/records?view=checks&source=topic_reply&cursor=${encodeURIComponent(first.next_cursor)}`)).json() as any;
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item: any) => item.detail)).size).toBe(23);
    expect(first.items.every((item: any) => item.source === "topic_reply" && /^帖子 #[0-9]+ · 检查完成$/.test(item.detail))).toBe(true);
    expect(first.items[0]).not.toHaveProperty("topic_id");
    for (const source of ["scan", "following_topic", "verify", "history"]) {
      const page = await (await api(`/notifier/records?view=checks&source=${source}`)).json() as any;
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ source });
      expect(page.items[0]).not.toHaveProperty("topic_id");
    }
    expect((await api("/notifier/records?view=checks&source=unknown")).status).toBe(400);
  });
  it("counts only retained notification-check failures in the inclusive snapshot day", async () => {
    const snapshotNow = now, since = snapshotNow - 86400000;
    const entries: [string, string, number][] = [
      ["scan", "error", since],
      ["scan", "interrupted", snapshotNow],
      ["following_topic", "error", since + 1],
      ["following_topic", "interrupted", snapshotNow - 1000],
      ["following_topic", "error", snapshotNow],
      ["topic_reply", "error", since],
      ["topic_reply", "interrupted", since + 1000],
      ["topic_reply", "error", snapshotNow - 1000],
      ["topic_reply", "interrupted", snapshotNow],
    ];
    for (const source of ["scan", "following_topic", "topic_reply"]) {
      entries.push([source, "error", since - 1], [source, "interrupted", snapshotNow + 1]);
      for (const outcome of ["waiting", "running", "ok"])
        entries.push([source, outcome, snapshotNow - 1000]);
    }
    for (const source of ["verify", "history", "relay"])
      entries.push([source, "error", snapshotNow - 1000], [source, "interrupted", snapshotNow - 1000]);
    await db.batch(entries.map(([source, outcome, started], index) =>
      db.prepare("INSERT INTO notification_checks(id,source,started_at,finished_at,outcome,stage_before) VALUES(?,?,?,?,?,'idle')")
        .bind(`error-count-${index}`, source, started, snapshotNow + 10000, outcome),
    ));
    const result = await call("/notifier-state", { now: snapshotNow });
    expect(result.error).toBeUndefined();
    expect(result.calls).toEqual([]);
    expect(result.result.check_errors).toEqual([
      { source: "following_topic", count: 3 },
      { source: "scan", count: 2 },
      { source: "topic_reply", count: 4 },
    ]);
    await db.prepare("DELETE FROM notification_checks WHERE id='error-count-0'").run();
    expect((await call("/notifier-state", { now: snapshotNow })).result.check_errors)
      .toContainEqual({ source: "scan", count: 1 });
  });
  it("acknowledges check errors without deleting logs and surfaces new or in-flight failures", async () => {
    const base = Date.now();
    await db.batch([
      db.prepare("INSERT INTO notifier(id,account_id,username) VALUES(2,8,'other')"),
      db.prepare("INSERT OR IGNORE INTO watch_control(id) VALUES(2)"),
      db.prepare("INSERT INTO notification_checks(id,notifier_id,source,started_at,finished_at,outcome,stage_before) VALUES('ack-1',1,'scan',?,?,'error','idle')").bind(base - 5000, base - 4500),
      db.prepare("INSERT INTO notification_checks(id,notifier_id,source,started_at,finished_at,outcome,stage_before) VALUES('ack-2',1,'topic_reply',?,?,'interrupted','idle')").bind(base - 2000, base - 1500),
      db.prepare("INSERT INTO notification_checks(id,notifier_id,source,started_at,outcome,stage_before) VALUES('in-flight',1,'following_topic',?,'running','idle')").bind(base - 1000),
      db.prepare("INSERT INTO notification_checks(id,notifier_id,source,started_at,finished_at,outcome,stage_before) VALUES('other-acct',2,'scan',?,?,'error','idle')").bind(base - 3000, base - 2500),
      // Hold the global lease to verify acknowledging errors never blocks on a running cron tick.
      db.prepare("UPDATE control SET lease='busy',lease_until=? WHERE id=1").bind(base + 60000),
    ]);
    const before = await (await api("/state")).json() as any;
    expect(before.notifier.check_errors).toEqual([
      { source: "scan", count: 1 },
      { source: "topic_reply", count: 1 },
    ]);

    const ackResponse = await mf.dispatchFetch("http://local/api/notifier/checks/ack", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(ackResponse.status).toBe(200);
    expect(await ackResponse.json()).toEqual({ reason: "已清除异常红点，历史日志仍保留" });

    const after = await (await api("/state")).json() as any;
    expect(after.notifier.check_errors).toEqual([]);
    const accountTwo = await (await api("/accounts/2/state")).json() as any;
    expect(accountTwo.notifier.check_errors).toEqual([{ source: "scan", count: 1 }]);

    // Historical error logs remain queryable.
    const issues = await (await api("/notifier/records?view=checks&outcome=issues")).json() as any;
    expect(issues.items.map((item: any) => item.id)).toEqual(["ack-2", "ack-1"]);

    // An in-flight check that fails after ack and any brand-new error both re-trigger the badge.
    const later = Date.now();
    await db.batch([
      db.prepare("UPDATE notification_checks SET outcome='interrupted',finished_at=? WHERE id='in-flight'").bind(later),
      db.prepare("INSERT INTO notification_checks(id,notifier_id,source,started_at,finished_at,outcome,stage_before) VALUES('ack-new',1,'scan',?,?,'error','idle')").bind(later, later),
    ]);
    const retriggered = await (await api("/state")).json() as any;
    expect(retriggered.notifier.check_errors).toEqual([
      { source: "following_topic", count: 1 },
      { source: "scan", count: 1 },
    ]);
    expect((await api("/notifier/checks/ack")).status).toBe(404);
  });
  it("exposes empty check failure counts on the authenticated state snapshot", async () => {
    const before = Date.now();
    const response = await api("/state");
    expect(response.status).toBe(200);
    const snapshot = await response.json() as any;
    expect(snapshot.now).toBeGreaterThanOrEqual(before);
    expect(snapshot.now).toBeLessThanOrEqual(Date.now());
    expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(snapshot.notifier.check_errors).toEqual([]);
  });
  it("cleans old samples, history and checks and marks abandoned checks without deleting dedup", async () => {
    await call("/action", { now, action: "history", responses: [page(100)] });
    await db
      .prepare("UPDATE notification_samples SET fetched_at=?")
      .bind(now - 8 * 86400000)
      .run();
    await db
      .prepare("UPDATE notification_history SET fetched_at=?")
      .bind(now - 8 * 86400000)
      .run();
    await db
      .prepare("UPDATE notification_checks SET started_at=?")
      .bind(now - 8 * 86400000)
      .run();
    await db
      .prepare(
        "INSERT INTO notification_checks(id,source,started_at,stage_before) VALUES('abandoned','scan',?,'idle')",
      )
      .bind(now - 180000)
      .run();
    await db.prepare("INSERT INTO notification_checks(id,source,started_at,stage_before,detail) VALUES('abandoned-watch','topic_reply',?,'idle','帖子 #8 · 正在检查')").bind(now - 180000).run();
    await db.exec(
      "INSERT INTO notification_dedup VALUES(7,100,'original'); UPDATE notifier SET cleanup_at=0;",
    );
    await call("/round", { now, responses: [{ body: home(0) }] });
    expect(
      (await db.prepare("SELECT * FROM notification_history").all()).results,
    ).toEqual([]);
    expect(
      (await db.prepare("SELECT * FROM notification_samples").all()).results,
    ).toEqual([]);
    expect(
      (
        await db
          .prepare("SELECT * FROM notification_checks WHERE id='abandoned'")
          .first<any>()
      ).outcome,
    ).toBe("interrupted");
    expect(await db.prepare("SELECT outcome,detail FROM notification_checks WHERE id='abandoned-watch'").first()).toEqual({ outcome: "interrupted", detail: "帖子 #8 · 正在检查；执行中断或结果未保存" });
    expect(
      (
        await db
          .prepare("SELECT * FROM notification_checks WHERE started_at<?")
          .bind(now - 7 * 86400000)
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (await db.prepare("SELECT * FROM notification_dedup").all()).results,
    ).toHaveLength(1);
  });
  it("returns read personal messages when unread is zero and encrypts history without changing push state", async () => {
    const n = { ...notice(91), created: Math.floor((now - 86400000) / 1000) };
    const result = await call("/action", {
      now,
      action: "history",
      responses: [{ body: { success: true, result: [n] } }],
    });
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe("https://www.v2ex.com/api/v2/notifications?p=1");
    expect(result.calls[0].headers.cookie).toBeUndefined();
    expect(result.result).toMatchObject({
      page: 1,
      next_page: 2,
      fetched_at: expect.any(Number),
      items: [{
        notification_id: 91,
        kind: "reply",
        title: "actor 回复了《topic about 感谢》",
        body: "private notification content",
        avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png",
        created_at: n.created * 1000,
      }],
    });
    expect(result.result.reason).toContain("包含已读消息");
    expect(await rows()).toHaveLength(0);
    expect(
      (await db.prepare("SELECT * FROM notification_dedup").all()).results,
    ).toHaveLength(0);
    expect((await state()).unread).toBe(0);
    const stored = await db
      .prepare("SELECT * FROM notification_history")
      .first<any>();
    expect(stored.content_enc).not.toContain("private notification content");
    expect(stored.avatar_url).toBe("https://cdn.v2ex.com/avatar/1/2/3.png");
    const sample = await db.prepare("SELECT * FROM notification_samples").first<any>();
    expect(sample).toMatchObject({
      account_id: 7,
      kind: "reply",
      notification_id: 91,
      avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png",
    });
    expect(sample.raw_enc).not.toContain(n.text);
    expect(sample.raw_enc).not.toContain(n.payload_rendered);
    expect((await call("/open", { purpose: "sample:7:91", value: sample.raw_enc })).result).toEqual(n);
    const response = await api("/notifier/records?view=history");
    expect(response.status).toBe(200);
    const records = (await response.json()) as any;
    expect(records.items[0]).toMatchObject({
      notification_id: 91,
      kind: "reply",
      body: "private notification content",
      avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png",
      push_status: null,
      created_at: n.created * 1000,
    });
    expect(records.items[0].content_enc).toBeUndefined();
    expect(
      (
        (await (
          await api("/notifier/records?view=history&kind=mention")
        ).json()) as any
      ).items,
    ).toEqual([]);
    expect((await api("/notifier/records?view=history", "wrong")).status).toBe(
      401,
    );
    const next = await call("/action", {
      now: now + 1000,
      action: "history",
      input: { page: 2 },
      responses: [page(90)],
    });
    expect(next.error).toBeUndefined();
    expect(next.calls.map((entry: any) => entry.url)).toEqual([
      "https://www.v2ex.com/api/v2/notifications?p=2",
    ]);
    expect(next.result).toMatchObject({
      page: 2,
      next_page: 3,
      items: [{ notification_id: 90, created_at: null }],
    });
    expect(await state()).toMatchObject({ history_until: 0, history_error: "", history_next_page: 3 });
  });
  it("returns every API message without the old 20-item excerpt or manual history interval", async () => {
    await db.prepare("UPDATE notifier SET history_until=? WHERE id=1").bind(now + 180000).run();
    const ids = Array.from({ length: 100 }, (_, index) => 200 - index);
    const result = await call("/action", {
      now,
      action: "history",
      responses: [page(...ids)],
    });
    expect(result.error).toBeUndefined();
    expect(result.result.items.map((item: any) => item.notification_id)).toEqual(ids);
    expect(result.result.next_page).toBe(2);
    expect((await state()).history_until).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 100 });
  });
  it.each([
    { requested: 3, ids: [], next: null },
    { requested: 9999, ids: [100], next: null },
  ])("ends personal message pagination for page $requested with $ids", async ({ requested, ids, next }) => {
    const result = await call("/action", {
      now, action: "history", input: { page: requested }, responses: [page(...ids)],
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ page: requested, next_page: next });
    expect((await state()).history_next_page).toBe(next);
    expect(result.calls[0].url).toBe(`https://www.v2ex.com/api/v2/notifications?p=${requested}`);
  });
  it("preserves cached history progress when refreshing the latest page or retrying older pages", async () => {
    for (const requested of [1, 2, 3]) {
      const loaded = await call("/action", {
        now, action: "history", input: { page: requested }, responses: [page(100 - requested)],
      });
      expect(loaded.error).toBeUndefined();
      expect((await state()).history_next_page).toBe(requested + 1);
    }
    for (const [requested, ids] of [[1, [101]], [2, [98]], [2, []]] as const) {
      const refreshed = await call("/action", {
        now, action: "history", input: { page: requested }, responses: [page(...ids)],
      });
      expect(refreshed.error).toBeUndefined();
      expect(refreshed.result.next_page).toBe(ids.length ? requested + 1 : null);
      expect((await state()).history_next_page).toBe(4);
      const cached = await (await api("/notifier/messages")).json() as any;
      expect(cached.upstream_next_page).toBe(4);
    }
  });
  it("keeps completed history exhausted after refreshing latest messages or retrying older pages", async () => {
    for (const requested of [1, 2, 3, 4]) {
      const loaded = await call("/action", {
        now, action: "history", input: { page: requested }, responses: [page(...(requested === 4 ? [] : [100 - requested]))],
      });
      expect(loaded.error).toBeUndefined();
    }
    expect((await state()).history_next_page).toBeNull();
    for (const requested of [1, 2]) {
      const refreshed = await call("/action", {
        now, action: "history", input: { page: requested }, responses: [page(101)],
      });
      expect(refreshed.error).toBeUndefined();
      expect(refreshed.result.next_page).toBe(requested + 1);
      expect((await state()).history_next_page).toBeNull();
      const cached = await (await api("/notifier/messages")).json() as any;
      expect(cached.upstream_next_page).toBeNull();
      expect(cached.items[0].notification_id).toBe(101);
    }
  });
  it.each([
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: 10000 },
    { page: "2" }, { page: null }, { page: true }, { page: {} },
    { page: 1, unknown: true }, { cursor: "2" },
  ])("rejects invalid personal message parameters %j before upstream access", async (input) => {
    const before = await state();
    const result = await call("/action", { now, action: "history", input, responses: [] });
    expect(result.status).toBe(400);
    expect(result.calls).toEqual([]);
    expect(await state()).toEqual(before);
  });
  it.each(["stale", "changed scope", "credential block"])(
    "uses only the member API for %s identity without resetting partial scanning",
    async (scenario) => {
      await scan(3, [100, 99]);
      if (scenario === "stale")
        await db.prepare("UPDATE notifier SET verified_at=0").run();
      if (scenario === "changed scope")
        await db.prepare("UPDATE notifier SET credential_scope='old-scope'").run();
      if (scenario === "credential block")
        await db.prepare("UPDATE notifier SET blocked='credentials'").run();
      await db.prepare("UPDATE control SET web_until=?").bind(now + 3600000).run();
      await db.prepare("UPDATE notifier SET verify_until=?,history_until=?").bind(now + 60000, now + 180000).run();
      const before = await state();
      const candidates = (await db.prepare("SELECT * FROM notification_candidates ORDER BY notification_id").all()).results;
      expect(candidates).toHaveLength(2);
      const result = await call("/action", {
        now, action: "history", input: { page: 2 }, responses: [profile, page(98)],
      });
      expect(result.error).toBeUndefined();
      expect(result.calls.map((entry: any) => entry.url)).toEqual([
        "https://www.v2ex.com/api/v2/member",
        "https://www.v2ex.com/api/v2/notifications?p=2",
      ]);
      expect(result.calls.every((entry: any) => entry.headers.cookie === undefined)).toBe(true);
      expect(await state()).toEqual({ ...before, history_at: result.result.fetched_at, history_next_page: 3, history_until: 0, history_error: "" });
      expect((await db.prepare("SELECT * FROM notification_candidates ORDER BY notification_id").all()).results).toEqual(candidates);
      expect(await rows()).toEqual([]);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_dedup").first()).toEqual({ n: 0 });
    },
  );
  it("loads messages while paused and unpaired without promoting PAT-only identity to verified push state", async () => {
    await db.exec("UPDATE notifier SET enabled=0,binding_id='',sender_enc='',account_id=0,username='',verified_at=0,credential_scope='' WHERE id=1");
    const before = await state();
    const result = await call("/action", { now, action: "history", responses: [profile, page(100)] });
    expect(result.error).toBeUndefined();
    expect(result.result.items[0].notification_id).toBe(100);
    expect(await state()).toEqual({ ...before, account_id: 7, username: "tester", history_at: result.result.fetched_at, history_next_page: 2 });
    expect(await db.prepare("SELECT account_id,notification_id FROM notification_history").first()).toEqual({ account_id: 7, notification_id: 100 });
    const cached = await (await api("/notifier/messages")).json() as any;
    expect(cached.items[0].notification_id).toBe(100);
    expect(outboundCalls).toBe(0);
  });
  it("rejects a mismatching PAT account without changing the stored identity or push state", async () => {
    await db.prepare("UPDATE notifier SET verified_at=0").run();
    const before = await state();
    const result = await call("/action", {
      now, action: "history",
      responses: [{ body: { success: true, result: { id: 8, username: "other" } } }],
    });
    expect(result.error).toContain("此账号不符");
    expect(result.calls.map((entry: any) => entry.url)).toEqual(["https://www.v2ex.com/api/v2/member"]);
    expect(await state()).toEqual({ ...before, history_error: result.error });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 0 });
  });
  it("requires the encryption key before loading even an empty personal message page", async () => {
    const result = await call("/action", { now, action: "history", env: { NOTIFIER_KEY: "" }, responses: [page()] });
    expect(result.status).toBe(503);
    expect(result.error).toContain("NOTIFIER_KEY");
    expect(result.calls).toEqual([]);
  });
  it("preserves encrypted personal message history and samples when the next page fails", async () => {
    const loaded = await call("/action", { now, action: "history", responses: [page(100)] });
    expect(loaded.error).toBeUndefined();
    const history = (await db.prepare("SELECT * FROM notification_history").all()).results;
    const samples = (await db.prepare("SELECT * FROM notification_samples").all()).results;
    const before = await state();
    const failed = await call("/action", {
      now, action: "history", input: { page: 2 }, responses: [{ status: 500, body: "unavailable" }],
    });
    expect(failed.error).toContain("HTTP 500");
    expect((await db.prepare("SELECT * FROM notification_history").all()).results).toEqual(history);
    expect((await db.prepare("SELECT * FROM notification_samples").all()).results).toEqual(samples);
    expect(await state()).toEqual({ ...before, history_error: failed.error });
  });
  it("shares API rate limiting across personal message pages", async () => {
    const limited = await call("/action", {
      now, action: "history", responses: [{ status: 429, headers: { "Retry-After": "120" }, body: "rate limited" }],
    });
    expect(limited.error).toContain("限流");
    expect(limited.calls).toHaveLength(1);
    expect(limited.retryAt).toBeGreaterThanOrEqual(now + 120000);
    const waiting = await call("/action", { now: now + 1000, action: "history", input: { page: 2 }, responses: [] });
    expect(waiting.error).toContain("暂停");
    expect(waiting.retryAt).toBe(limited.retryAt);
    expect(waiting.calls).toEqual([]);
    expect((await state()).history_until).toBe(limited.retryAt);
  });
  it("shows persisted check results without polling or marking historical notifications read", async () => {
    await call("/round", { now, responses: [{ body: home(0) }] });
    const records = (await (
      await api("/notifier/records?view=checks&outcome=ok")
    ).json()) as any;
    expect(records.items[0]).toMatchObject({
      source: "scan",
      outcome: "ok",
      unread: 0,
      requests: 1,
      api_requests: 0,
    });
    expect(records.items[0].detail).toContain("未读取通知 API");
    const count = records.items.length;
    now += 61000;
    const second = await call("/round", { now, responses: [] });
    expect(second.calls).toHaveLength(0);
    expect(
      ((await (await api("/notifier/records?view=checks")).json()) as any)
        .items,
    ).toHaveLength(count);
  });
  it("logs a history API cooldown without making a request or changing existing history", async () => {
    await db
      .prepare("UPDATE control SET api_until=?")
      .bind(now + 3600000)
      .run();
    const result = await call("/action", {
      now,
      action: "history",
      responses: [],
    });
    expect(result.error).toContain("暂停");
    expect(result.calls).toHaveLength(0);
    const checks = (await (
      await api("/notifier/records?view=checks&outcome=waiting")
    ).json()) as any;
    expect(checks.items[0]).toMatchObject({
      source: "history",
      outcome: "waiting",
      requests: 0,
      api_requests: 0,
    });
    expect((await state()).history_until).toBeGreaterThanOrEqual(now + 3600000);
    expect((await state()).scan_error).toBe("");
  });
  it("runs a real notification through automatic scanning, encrypted delivery, receipt and repeated-scan dedup", async () => {
    const id = createHash("sha256").update("v2ex:7:100").digest("hex");
    const first = await call("/round", {
      now,
      responses: [{ body: home(1) }, page(100), health, directory, receipt(id)],
    });
    expect(first.result.handled).toBe(true);
    expect(first.calls).toHaveLength(5);
    const wire = first.calls.at(-1).body.events[0];
    expect(wire).toMatchObject({
      type: "notification",
      notification_id: 100,
      notification_kind: "reply",
      unread_count: 1,
    });
    expect(JSON.stringify(wire)).not.toContain("private notification content");
    expect((await rows())[0]).toMatchObject({
      status: "submitted",
      attempts: 1,
    });
    now += 61000;
    await call("/round", { now, responses: [receipt(id, "apns_accepted")] });
    expect((await rows())[0]).toMatchObject({
      status: "apns_accepted",
      attempts: 1,
      receipt_attempts: 1,
    });
    now += 200000;
    const repeated = await call("/round", {
      now,
      responses: [{ body: home(1) }, page(100)],
    });
    expect(repeated.calls).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].attempts).toBe(1);
    const usage = ((await (await api("/state")).json()) as any).api_usage;
    expect(
      usage.daily.find((x: any) => x.endpoint === "notifications").attempts,
    ).toBe(2);
  });
  it("records API attempts and quota headers, excludes HTML, and records no request during cooldown", async () => {
    const reset = Math.ceil((now + 3600000) / 1000);
    await call("/scan", {
      now,
      responses: [
        { body: home(1) },
        {
          ...page(100),
          headers: {
            "X-Rate-Limit-Limit": "600",
            "X-Rate-Limit-Remaining": "40",
            "X-Rate-Limit-Reset": String(reset),
          },
        },
      ],
    });
    const usage = ((await (await api("/state")).json()) as any).api_usage;
    expect(usage.latest_budget).toMatchObject({
      endpoint: "notifications",
      status: 200,
      budget_limit: 600,
      remaining: 40,
      reset_at: reset * 1000,
      backoff_reason: "reserve",
    });
    expect(usage.daily.reduce((n: number, x: any) => n + x.attempts, 0)).toBe(
      2,
    ); // fixture verification + notifications
    expect(usage.daily.every((x: any) => x.responses === x.attempts)).toBe(
      true,
    );
    const blocked = await call("/action", {
      now: now + 61000,
      action: "verify",
      responses: [],
    });
    expect(blocked.calls).toHaveLength(0);
    const again = ((await (await api("/state")).json()) as any).api_usage;
    expect(again.daily).toEqual(usage.daily);
    expect(JSON.stringify(again)).not.toContain(pat);
    expect(JSON.stringify(again)).not.toContain(cookie);
    expect(JSON.stringify(again)).not.toContain("private notification content");
  });
  it("distinguishes network failures from HTTP errors and records exact backoff metadata", async () => {
    const network = await call("/action", {
      now,
      action: "verify",
      responses: [{ error: true }],
    });
    expect(network.error).toContain("网络");
    now += 61000;
    await call("/action", {
      now,
      action: "verify",
      responses: [{ status: 429, headers: { "retry-after": "120" }, body: "" }],
    });
    const usage = ((await (await api("/state")).json()) as any).api_usage;
    const member = usage.daily.find((x: any) => x.endpoint === "member");
    expect(member).toMatchObject({
      attempts: 3,
      responses: 2,
      network_errors: 1,
      http_errors: 1,
      rate_limited: 1,
    });
    expect(usage.recent[0]).toMatchObject({
      status: 429,
      backoff_reason: "http_429",
      network_error: 0,
    });
    expect(usage.recent[1]).toMatchObject({ status: null, network_error: 1 });
    expect(usage.recent[0].backoff_until).toBeLessThan(now + 130000);
  });
  it.each(["api", "web"])(
    "backs off %s access denials without declaring the credentials expired",
    async (channel) => {
      const denied = {
        status: 403,
        body: {
          cloudflare_error: true,
          error_code: 1010,
          detail: "private denied content",
        },
      };
      const result = await call("/action", {
        now,
        action: "verify",
        responses: channel === "api" ? [denied] : [profile, denied],
      });
      expect(result.error).toContain("1010");
      expect(result.error).not.toContain("private denied content");
      expect((await state()).blocked).toBe("");
      const control = await db
        .prepare("SELECT api_until,web_until FROM control")
        .first<any>();
      expect(control[channel + "_until"]).toBeGreaterThanOrEqual(now + 900000);
      const record = await db
        .prepare(
          "SELECT detail FROM notification_checks ORDER BY started_at DESC LIMIT 1",
        )
        .first<any>();
      expect(record.detail).toContain(channel === "api" ? "API" : "网页");
      expect(record.detail).toContain("1010");
      if (channel === "api") {
        const usage = ((await (await api("/state")).json()) as any).api_usage;
        expect(usage.active_backoff).toMatchObject({
          endpoint: "member",
          status: 403,
          backoff_reason: "access_restricted",
          backoff_until: control.api_until,
        });
        expect(usage.recent[0].backoff_reason).toBe("access_restricted");
        expect(JSON.stringify(usage)).not.toContain("private denied content");
      }
    },
  );
  it.each([undefined, "1800"])(
    "reports an unclassified API 403 conservatively and respects Retry-After (%s)",
    async (retry) => {
      const result = await call("/action", {
        now,
        action: "verify",
        responses: [
          {
            status: 403,
            headers: retry ? { "Retry-After": retry } : {},
            body: "private denied content",
          },
        ],
      });
      expect(result.error).toContain("尚不能判定 PAT 失效");
      expect(result.error).not.toContain("private denied content");
      expect((await state()).blocked).toBe("");
      const until = (
        await db.prepare("SELECT api_until FROM control").first<any>()
      ).api_until;
      expect(until).toBeGreaterThanOrEqual(now + (retry ? 1800000 : 60000));
      if (!retry) expect(until).toBeLessThan(now + 65000);
      const usage = ((await (await api("/state")).json()) as any).api_usage;
      expect(usage.active_backoff).toMatchObject({
        status: 403,
        backoff_reason: "http_403",
        backoff_until: until,
      });
      const waiting = await call("/action", {
        now: until - 1000,
        action: "verify",
        responses: [],
      });
      expect(waiting.error).toMatch(/暂停|间隔/);
      expect(waiting.calls).toHaveLength(0);
      const recovered = await call("/action", {
        now: until + 1000,
        action: "verify",
        responses: [profile, { body: home(0) }],
      });
      expect(recovered.error).toBeUndefined();
      expect(recovered.calls).toHaveLength(2);
      expect((await state()).scan_error).toBe("");
    },
  );
  it("records an API challenge returned as HTTP 200 without counting a quota exhaustion", async () => {
    await call("/action", {
      now,
      action: "verify",
      responses: [
        {
          headers: { "cf-mitigated": "challenge" },
          body: "private challenge page",
        },
      ],
    });
    const until = (
      await db.prepare("SELECT api_until FROM control").first<any>()
    ).api_until;
    const usage = ((await (await api("/state")).json()) as any).api_usage;
    expect(until).toBeGreaterThanOrEqual(now + 900000);
    expect(usage.active_backoff).toMatchObject({
      status: 200,
      backoff_reason: "access_restricted",
      backoff_until: until,
    });
    expect(usage.daily[0].rate_limited).toBe(0);
    expect((await state()).blocked).toBe("");
    expect(JSON.stringify(usage)).not.toContain("private challenge page");
  });
  it.each(["api", "web"])(
    "persists progressive %s 403 cooldowns, isolates channels, and resets only after success",
    async (channel) => {
      for (const [index, minutes] of [1, 2, 5, 15, 15, 15].entries()) {
        const result = await call("/action", {
          now,
          action: "verify",
          responses:
            channel === "api"
              ? [{ status: 403, body: "private denied content" }]
              : [profile, { status: 403, body: "private denied content" }],
        });
        expect(result.error).toContain("HTTP 403");
        const control = await db.prepare("SELECT * FROM control").first<any>();
        const until = control[`${channel}_until`];
        expect(until - now).toBeGreaterThanOrEqual(minutes * 60000);
        expect(until - now).toBeLessThan(minutes * 60000 + 5000);
        expect(control[`${channel}_forbidden_failures`]).toBe(
          Math.min(index + 1, 4),
        );
        expect(
          control[`${channel === "api" ? "web" : "api"}_forbidden_failures`],
        ).toBe(0);
        expect((await state()).scan_until).toBeLessThan(until + 1000);
        if (index === 0) {
          // Pause/resume must not reset the deadline or failure streak.
          await call("/action", {
            now: now + 1000,
            action: "config",
            input: { enabled: false },
          });
          await call("/action", {
            now: now + 2000,
            action: "config",
            input: { enabled: true },
          });
          const waiting = await call("/action", {
            now: until - 1000,
            action: "pair/qr",
            env: { V2EX_PAT: "changed-pat" },
            responses: [],
          });
          expect(waiting.error).toContain("暂停");
          expect(waiting.calls).toHaveLength(0);
          expect(await db.prepare("SELECT * FROM control").first()).toEqual(
            control,
          );
        }
        now = until + 1000;
      }
      const success = await call("/action", {
        now,
        action: "verify",
        responses: [profile, { body: home(0) }],
      });
      expect(success.error).toBeUndefined();
      expect(
        (await db.prepare("SELECT * FROM control").first<any>())[
          `${channel}_forbidden_failures`
        ],
      ).toBe(0);
      now += 61000;
      await call("/action", {
        now,
        action: "verify",
        responses:
          channel === "api"
            ? [{ status: 403, body: "denied again" }]
            : [profile, { status: 403, body: "denied again" }],
      });
      expect(
        (await db.prepare("SELECT * FROM control").first<any>())[
          `${channel}_until`
        ] - now,
      ).toBeLessThan(65000);
    },
  );
  it.each([403, 200])(
    "identifies explicit PAT expiry with HTTP %s separately from Cookie and access restrictions",
    async (status) => {
      const result = await call("/action", {
        now,
        action: "verify",
        responses: [
          { status, body: { success: false, message: "Token expired" } },
        ],
      });
      expect(result.error).toContain("PAT 身份已失效");
      expect(result.error).toContain("更新 PAT");
      expect((await state()).blocked).toBe("credentials");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].headers.cookie).toBeUndefined();
      const usage = ((await (await api("/state")).json()) as any).api_usage;
      expect(usage.active_backoff).toBeNull();
    },
  );
  it("uses the native workerd fetch path through the authenticated API", async () => {
    await db.exec("UPDATE notifier SET verify_until=0;");
    const r = await mf.dispatchFetch("http://local/api/notifier/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).reason).toContain("同一账号");
  });
  it("verifies PAT and full Cookie independently; never sends V2EX credentials to the relay", async () => {
    const r = await call("/action", {
      now,
      action: "verify",
      responses: [profile, { body: home(0) }],
    });
    expect(r.calls[0].headers.authorization).toBe(`Bearer ${pat}`);
    expect(r.calls[0].headers.cookie).toBeUndefined();
    expect(r.calls[1].headers.cookie).toBe(cookie);
    expect(r.calls[1].headers.authorization).toBeUndefined();
    expect(r.calls.every((x: any) => x.redirect === "manual")).toBe(true);
    const bad = await call("/action", {
      now: now + 61000,
      action: "verify",
      responses: [profile, { body: home(0, "someone-else") }],
    });
    expect(bad.error).toContain("不符");
    expect((await state()).blocked).toBe("credentials");
    expect((await state()).account_id).toBe(7);
  });
  it("enqueues one immutable event per unread ID and retains exact dedup after repeat scans", async () => {
    await scan(2, [100, 99]);
    expect(await rows()).toHaveLength(2);
    const first = await rows();
    expect(first.every((x) => !x.content_enc.includes("private"))).toBe(true);
    expect(first.find((x) => x.notification_id === 100).event_id).toBe(
      createHash("sha256").update("v2ex:7:100").digest("hex"),
    );
    now += 200000;
    await scan(2, [100, 99]);
    expect((await rows()).map((x) => x.event_id)).toEqual(
      first.map((x) => x.event_id),
    );
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM notification_dedup")
          .first<any>()
      ).count,
    ).toBe(2);
  });
  it("preserves failed page progress and verifies the first page before multi-page commit", async () => {
    await scan(3, [100, 99]);
    expect((await state()).scan_page).toBe(2);
    expect(await rows()).toHaveLength(0);
    const failed = await call("/scan", {
      now,
      responses: [{ status: 500, body: "private upstream error" }],
    });
    expect(failed.error).not.toContain("private upstream");
    expect((await state()).scan_page).toBe(2);
    const second = await call("/scan", { now, responses: [page(98)] });
    expect(second.error).toBeUndefined();
    expect((await state()).scan_stage).toBe("verify");
    expect(await rows()).toHaveLength(0);
    expect(
      (await call("/scan", { now, responses: [page(100, 99)] })).error,
    ).toBeUndefined();
    expect(await rows()).toHaveLength(3);
  });
  it("discards moving multi-page candidates without advancing dedup", async () => {
    await scan(3, [100, 99]);
    await call("/scan", { now, responses: [page(98)] });
    const changed = await call("/scan", { now, responses: [page(101, 100)] });
    expect(changed.error).toContain("首屏发生变化");
    expect((await state()).scan_stage).toBe("idle");
    expect(await rows()).toHaveLength(0);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM notification_candidates")
          .first<any>()
      ).count,
    ).toBe(0);
  });
  it("refreshes unread count during long scans and cancels only unattempted events", async () => {
    await scan(2, [100, 99]);
    const existing = await rows();
    await db
      .prepare("UPDATE notification_outbox SET attempts=1 WHERE event_id=?")
      .bind(existing[0].event_id)
      .run();
    now += 200000;
    const r = await call("/scan", { now, responses: [{ body: home(0) }] });
    expect(r.error).toBeUndefined();
    expect(r.calls).toHaveLength(1);
    const current = await rows();
    expect(
      current.find((x) => x.event_id === existing[0].event_id).status,
    ).toBe("pending");
    expect(
      current.find((x) => x.event_id === existing[1].event_id).status,
    ).toBe("cancelled");
  });
  it("protects all atomic writes with a lease fence", async () => {
    await db.exec("UPDATE notifier SET enabled=0;");
    const r = await call("/fence");
    expect(r.error).toContain("CHECK");
    expect((await state()).enabled).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM notification_dedup")
          .first<any>()
      ).n,
    ).toBe(0);
  });
  it("serializes concurrent invocations and does not steal an active lease", async () => {
    const [a, b] = await Promise.all([
      call("/scan", { now, responses: [{ body: home(0), delay: 100 }] }),
      call("/scan", { now, responses: [{ body: home(0), delay: 100 }] }),
    ]);
    expect(a.calls.length + b.calls.length).toBe(1);
    expect([a.error, b.error].filter(Boolean)).toHaveLength(1);
  });
});

describe("notification classification before delivery", () => {
  const scanItems = async (...items: ReturnType<typeof notice>[]) => {
    const result = await call("/scan", {
      now,
      responses: [
        { body: home(items.length) },
        { body: { success: true, result: items } },
      ],
    });
    expect(result.error).toBeUndefined();
  };

  it.each([
    ["reply", "回复了你"],
    ["mention", "提到了你"],
    ["thanks_topic", "感谢了你的主题"],
    ["thanks_reply", "感谢了你的回复"],
    ["favorite", "收藏了你发布的主题"],
  ])(
    "preserves %s from the API through encrypted delivery and APNs",
    async (kind, action) => {
      await scanItems(notice(100, action));
      const row = (await rows())[0];
      expect(row.kind).toBe(kind);
      const sent = await call("/relay", {
        now,
        responses: [health, directory, receipt(row.event_id)],
      });
      expect(sent.error).toBeUndefined();
      const wire = sent.calls.at(-1).body.events[0];
      expect(wire.notification_kind).toBe(kind);
      const apns = await buildCentralApnsPayload(
        { id: device, binding_id: binding, username: "tester" },
        wire,
        now,
      );
      if (apns) {
        expect(apns.notification_kind).toBe(kind);
        expect(apns.notification_id).toBe(100);
        // Classification survives independently of encrypted alert replacement.
        expect(apns.aps.alert.title).toBe("V2Echo 通知");
      }
    },
  );

  it("holds unknown actions without deduping them or blocking classified notifications", async () => {
    await scanItems(notice(101, "产生了未知活动"), notice(100));
    const pending = (await rows()).find((row) => row.notification_id === 100);
    const held = (await rows()).find((row) => row.notification_id === 101);
    expect(held).toMatchObject({
      kind: "other",
      status: "unclassified",
      attempts: 0,
      wire: null,
    });
    expect(held.detail).toContain("暂不推送");
    expect(
      await db
        .prepare("SELECT * FROM notification_dedup WHERE notification_id=101")
        .first(),
    ).toBeNull();
    const listed = await api(
      "/notifier/records?view=deliveries&status=unclassified",
    );
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as any).items.map(
        (row: any) => row.notification_id,
      ),
    ).toEqual([101]);
    const sent = await call("/relay", {
      now,
      responses: [health, directory, receipt(pending.event_id)],
    });
    expect(sent.error).toBeUndefined();
    expect(
      sent.calls.at(-1).body.events.map((event: any) => event.notification_id),
    ).toEqual([100]);
    expect(
      (await rows()).find((row) => row.notification_id === 101),
    ).toMatchObject({ status: "unclassified", attempts: 0, wire: null });
    expect((await call("/relay", { now, responses: [] })).calls).toEqual([]);
  });

  it("releases a never-attempted classification hold only after a fresh unread scan", async () => {
    await scanItems(notice(100, "产生了未知活动"));
    const held = (await rows())[0];
    expect((await call("/relay", { now, responses: [] })).calls).toEqual([]);
    now += 200000;
    await scanItems(notice(100, "收藏了你发布的主题"));
    const ready = (await rows())[0];
    expect(ready).toMatchObject({
      event_id: held.event_id,
      kind: "favorite",
      status: "pending",
      attempts: 0,
      wire: null,
    });
    expect(ready.created_at).toBeGreaterThan(held.created_at);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM notification_dedup").first(),
    ).toEqual({ n: 1 });
    const sent = await call("/relay", {
      now,
      responses: [health, directory, receipt(ready.event_id)],
    });
    expect(sent.calls.at(-1).body.events[0].notification_kind).toBe("favorite");
    now += 200000;
    await scanItems(notice(100, "收藏了你发布的主题"));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      status: "submitted",
      attempts: 1,
    });
  });

  it.each([{ ids: [] }, { ids: [99] }])(
    "cancels a held notification outside the new unread range $ids",
    async ({ ids }) => {
      await scanItems(notice(100, "产生了未知活动"));
      now += 200000;
      await scan(ids.length, ids);
      expect(
        (await rows()).find((row) => row.notification_id === 100),
      ).toMatchObject({ status: "cancelled", attempts: 0, content_enc: "" });
    },
  );

  it("holds a previously queued but unattempted notification when its new action is unknown", async () => {
    const queued = await prepareOne();
    now += 200000;
    await scanItems(notice(100, "产生了未知活动"));
    expect((await rows())[0]).toMatchObject({
      event_id: queued.event_id,
      kind: "other",
      status: "unclassified",
      attempts: 0,
      wire: null,
    });
    expect((await call("/relay", { now, responses: [] })).calls).toEqual([]);
  });

  it.each([
    ["other", "other"],
    ["reply", undefined],
    ["reply", "future-kind"],
    ["reply", "mention"],
  ])(
    "holds an old queued %s event with wire kind %s before any network call",
    async (kind, wireKind) => {
      const queued = await prepareOne();
      const wire = JSON.stringify({
        event_id: queued.event_id,
        notification_id: 100,
        type: "notification",
        notification_kind: wireKind,
      });
      await db
        .prepare(
          "UPDATE notification_outbox SET kind=?,wire=? WHERE event_id=?",
        )
        .bind(kind, wire, queued.event_id)
        .run();
      const result = await call("/relay", { now, responses: [] });
      expect(result.error).toBeUndefined();
      expect(result.calls).toEqual([]);
      expect((await rows())[0]).toMatchObject({
        status: "unclassified",
        attempts: 0,
        wire,
      });
      now += 200000;
      await scan(1, [100]);
      expect((await rows())[0]).toMatchObject({
        event_id: queued.event_id,
        kind: "reply",
        status: "pending",
        attempts: 0,
        wire: null,
      });
    },
  );

  it("does not allow an unprepared other kind into encryption", async () => {
    await prepareOne();
    await db.exec("UPDATE notification_outbox SET kind='other'");
    const result = await call("/relay", { now, responses: [] });
    expect(result.error).toBeUndefined();
    expect(result.calls).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "unclassified",
      attempts: 0,
      wire: null,
    });
  });

  it("stops an attempted unclassified wire without regenerating or replaying it", async () => {
    const queued = await prepareOne();
    const wire = JSON.stringify({
      event_id: queued.event_id,
      notification_id: 100,
      type: "notification",
    });
    await db
      .prepare(
        "UPDATE notification_outbox SET attempts=1,wire=? WHERE event_id=?",
      )
      .bind(wire, queued.event_id)
      .run();
    const result = await call("/relay", { now, responses: [] });
    expect(result.calls).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "unclassified",
      attempts: 1,
      wire,
    });
    expect((await rows())[0].detail).toContain("可能已送达");
    now += 200000;
    await scan(1, [100]);
    expect((await rows())[0]).toMatchObject({
      status: "unclassified",
      attempts: 1,
      wire,
    });
    expect((await call("/relay", { now, responses: [] })).calls).toEqual([]);
  });

  it("continues receipt-only tracking for an old unclassified event already accepted by the service", async () => {
    const queued = await prepareOne();
    await db.exec(
      "UPDATE notification_outbox SET kind='other',status='submitted',attempts=1",
    );
    const result = await call("/relay", {
      now,
      responses: [receipt(queued.event_id, "apns_accepted")],
    });
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].body).toEqual({
      events: [],
      receipts: [queued.event_id],
    });
    expect((await rows())[0]).toMatchObject({
      status: "apns_accepted",
      attempts: 1,
      receipt_attempts: 1,
    });
  });

  it("expires held records without attempting to send them", async () => {
    await scanItems(notice(100, "产生了未知活动"));
    now = (await rows())[0].expires_at + 1000;
    const result = await call("/round", {
      now,
      responses: [profile, { body: home(0) }],
    });
    expect(result.error).toBeUndefined();
    expect(
      result.calls.every((request: any) =>
        request.url.startsWith("https://www.v2ex.com/"),
      ),
    ).toBe(true);
    expect((await rows())[0]).toMatchObject({
      status: "expired",
      attempts: 0,
      wire: null,
    });
    expect((await rows())[0].detail).toContain("分类未确认");
  });
});

describe("Docker-compatible encrypted delivery and receipts", () => {
  it.each(["pending", "cancelled", "expired"])(
    "recovers an unattempted %s notification only after re-pairing and a fresh unread scan",
    async (status) => {
      const queued = await prepareOne();
      const nextBinding = "33333333-3333-4333-8333-333333333333";
      await db
        .prepare(
          "UPDATE notification_outbox SET status=?,wire='old-prepared-wire',content_enc='',next_at=? WHERE event_id=?",
        )
        .bind(status, now + 3600000, queued.event_id)
        .run();
      await db
        .prepare("UPDATE notifier SET blocked='pairing' WHERE id=1")
        .run();
      const paired = await call("/save-pairing", { now, binding: nextBinding });
      expect(paired.error).toBeUndefined();
      expect((await state()).blocked).toBe("");
      expect((await call("/relay", { now, responses: [] })).calls).toEqual([]);
      now += 2000;
      await scan(1, [100]);
      const recovered = (await rows())[0];
      expect(recovered).toMatchObject({
        event_id: queued.event_id,
        binding_id: nextBinding,
        notification_id: 100,
        status: "pending",
        attempts: 0,
        receipt_attempts: 0,
        next_at: 0,
        wire: null,
      });
      expect(recovered.created_at).toBeGreaterThan(queued.created_at);
      expect(recovered.expires_at - recovered.created_at).toBe(86400000);
      expect(recovered.content_enc).not.toBe("");
      expect(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM notification_dedup")
            .first<any>()
        ).n,
      ).toBe(1);
      const sent = await call("/relay", {
        now,
        responses: [
          health,
          {
            body: {
              source_account_id: 7,
              recipients: [{ ...recipient, binding_id: nextBinding }],
            },
          },
          receipt(queued.event_id),
        ],
      });
      expect(sent.error).toBeUndefined();
      const wire = sent.calls.at(-1).body.events[0];
      expect(wire).toMatchObject({
        event_id: queued.event_id,
        notification_kind: "reply",
        details_version: 3,
      });
      expect(wire.encrypted_bodies[0].binding_id).toBe(nextBinding);
      await validateCentralEvent(wire, now);
      now += 200000;
      await scan(1, [100]);
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({
        status: "submitted",
        attempts: 1,
      });
    },
  );
  it.each([
    "pending",
    "submitted",
    "apns_accepted",
    "expired",
    "rejected",
    "cancelled",
  ])(
    "does not replay an attempted %s event after re-pairing",
    async (status) => {
      const queued = await prepareOne();
      await db
        .prepare(
          "UPDATE notification_outbox SET status=?,attempts=1,wire='immutable-wire' WHERE event_id=?",
        )
        .bind(status, queued.event_id)
        .run();
      const paired = await call("/save-pairing", { now, binding: "33333333-3333-4333-8333-333333333333" });
      expect(paired.error).toBeUndefined();
      now += 2000;
      await scan(1, [100]);
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({
        binding_id: binding,
        attempts: 1,
        wire: "immutable-wire",
      });
      expect((await call("/relay", { now, responses: [] })).calls).toEqual([]);
    },
  );
  it("does not recover a notification outside the new unread range or without a new pairing", async () => {
    await scan(2, [100, 99]);
    await db.prepare("UPDATE notification_outbox SET status='expired'").run();
    now += 200000;
    await scan(2, [100, 99]);
    expect((await rows()).every((x) => x.status === "expired")).toBe(true);
    const paired = await call("/save-pairing", { now, binding: "33333333-3333-4333-8333-333333333333" });
    expect(paired.error).toBeUndefined();
    now += 2000;
    await scan(1, [100, 99]);
    const byID = Object.fromEntries(
      (await rows()).map((x) => [x.notification_id, x]),
    );
    expect(byID[100].status).toBe("pending");
    expect(byID[99]).toMatchObject({
      status: "expired",
      binding_id: binding,
      attempts: 0,
    });
  });
  it("encrypts title and body for Apple, passes the actual server validator, and stores before send", async () => {
    const row = await prepareOne();
    const r = await call("/relay", {
      now,
      responses: [health, directory, receipt(row.event_id)],
    });
    expect(r.error).toBeUndefined();
    const sync = r.calls.at(-1),
      wire = sync.body.events[0];
    expect(JSON.stringify(r.calls)).not.toContain(
      "private notification content",
    );
    expect(JSON.stringify(r.calls)).not.toContain(cookie);
    expect(JSON.stringify(r.calls)).not.toContain(pat);
    expect(wire.title).toBeUndefined();
    expect(wire.body).toBeUndefined();
    await validateCentralEvent(wire, now);
    const e = wire.encrypted_bodies[0];
    const epk = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        Buffer.from(e.ephemeral_key, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    const shared = diffieHellman({
      privateKey: cryptographic.privateKey,
      publicKey: epk,
    });
    const aad = Buffer.from(
      `V2EchoPushContent/v2\n${row.event_id}\n7\n${device}\n${binding}\n${recipient.key_id}`,
    );
    const aes = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        createHash("sha256").update(publicBytes).digest(),
        aad,
        32,
      ),
    );
    const cipher = Buffer.from(e.ciphertext, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      aes,
      Buffer.from(e.nonce, "base64url"),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(cipher.subarray(-16));
    const raw = Buffer.concat([
      decipher.update(cipher.subarray(0, -16)),
      decipher.final(),
    ]);
    const titleLength = raw.readUInt16BE(0);
    expect(raw.subarray(2, 2 + titleLength).toString()).toBe(
      "actor 回复了《topic about 感谢》",
    );
    expect(raw.subarray(2 + titleLength).toString()).toBe(
      "private notification content",
    );
    const saved = (await rows())[0];
    expect(JSON.parse(saved.wire)).toEqual(wire);
    expect(saved.status).toBe("submitted");
  });
  it("retries byte-identical wire after a lost response; confirmed receipts never resend", async () => {
    const row = await prepareOne();
    const lost = await call("/relay", {
      now,
      responses: [health, directory, { error: true }],
    });
    expect(lost.error).toContain("网络");
    const saved = (await rows())[0];
    expect(saved.attempts).toBe(1);
    expect(saved.status).toBe("pending");
    now += 60000;
    const retry = await call("/relay", {
      now,
      responses: [health, receipt(row.event_id)],
    });
    expect(retry.error).toBeUndefined();
    expect(retry.calls.at(-1).body.events[0]).toEqual(
      lost.calls.at(-1).body.events[0],
    );
    now += 60000;
    const missing = await call("/relay", {
      now,
      responses: [receipt(row.event_id, "not_found")],
    });
    expect(missing.error).toBeUndefined();
    expect(missing.calls).toHaveLength(1);
    expect(missing.calls[0].body).toEqual({
      events: [],
      receipts: [row.event_id],
    });
    expect((await rows())[0].status).toBe("submitted");
    now += 120000;
    const accepted = await call("/relay", {
      now,
      responses: [receipt(row.event_id, "apns_accepted")],
    });
    expect(accepted.error).toBeUndefined();
    expect((await rows())[0].status).toBe("apns_accepted");
    expect((await rows())[0].detail).toContain("未知");
  });
  it("rejects malformed receipt batches without falsely confirming any item", async () => {
    const row = await prepareOne();
    const r = await call("/relay", {
      now,
      responses: [
        health,
        directory,
        {
          body: {
            receipts: [
              { event_id: row.event_id, status: "apns_accepted" },
              { event_id: row.event_id, status: "apns_accepted" },
            ],
          },
        },
      ],
    });
    expect(r.error).toContain("回执数量");
    expect((await rows())[0].status).toBe("pending");
  });
  it("requires advertised capabilities and rejects a changed pinned device key", async () => {
    await prepareOne();
    const unsupported = await call("/relay", {
      now,
      responses: [{ body: {} }],
    });
    expect(unsupported.error).toContain("能力");
    expect(unsupported.calls).toHaveLength(1);
    await db
      .prepare("INSERT INTO notification_key_pins VALUES(?,?)")
      .bind(device, "a-different-key")
      .run();
    const changed = await call("/relay", {
      now,
      responses: [health, directory],
    });
    expect(changed.error).toContain("公钥发生变化");
    expect((await rows())[0].wire).toBeNull();
    expect(changed.calls).toHaveLength(2);
  });
  it("allows a valid legacy empty directory only as a generic encrypted-format notification", async () => {
    const row = await prepareOne();
    const r = await call("/relay", {
      now,
      responses: [
        health,
        { body: { source_account_id: 7, recipients: [] } },
        receipt(row.event_id),
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.calls.at(-1).body.events[0].encrypted_bodies).toEqual([]);
    expect(JSON.stringify(r.calls.at(-1).body)).not.toContain("private");
  });
  it("persists relay authentication failure and suspends scanning until a successful new pairing", async () => {
    await prepareOne();
    const r = await call("/round", {
      now,
      responses: [
        health,
        { status: 401, body: { error: "secret-upstream-message" } },
      ],
    });
    expect(r.error).toBeUndefined();
    expect((await state()).blocked).toBe("pairing");
    now += 200000;
    const stopped = await call("/round", { now, responses: [] });
    expect(stopped.calls).toHaveLength(0);
    const enabled = await call("/action", {
      now,
      action: "config",
      input: { enabled: true },
    });
    expect(enabled.error).toContain("有效配对");
  });
  it.each([
    {
      status: 403,
      body: {
        cloudflare_error: true,
        error_code: 1010,
        detail: "private upstream text",
      },
    },
    {
      status: 403,
      body: "<title>Attention Required! | Cloudflare</title>private upstream text",
    },
    { status: 403, body: "private upstream text" },
  ])(
    "keeps pairing and immutable wire after a relay access restriction: $body",
    async (denied) => {
      const queued = await prepareOne();
      await call("/round", { now, responses: [health, directory, denied] });
      const saved = (await rows())[0],
        s = await state();
      expect(s.blocked).toBe("");
      expect(s.relay_until).toBeGreaterThanOrEqual(now + 900000);
      expect(s.relay_error).not.toContain("private upstream text");
      expect(saved).toMatchObject({ status: "pending", attempts: 1 });
      now = s.relay_until + 1000;
      const retry = await call("/relay", {
        now,
        responses: [health, receipt(queued.event_id)],
      });
      expect(retry.error).toBeUndefined();
      expect(retry.calls.at(-1).body.events[0]).toEqual(JSON.parse(saved.wire));
      expect(retry.calls[0].headers["user-agent"]).toContain(
        "V2Echo-CF-Notifier/",
      );
    },
  );
  it("does not invalidate pairing when the unauthenticated health endpoint returns 401", async () => {
    await prepareOne();
    await call("/round", { now, responses: [{ status: 401, body: {} }] });
    expect((await state()).blocked).toBe("");
    expect((await rows())[0].attempts).toBe(0);
  });
  it("blocks a confirmed sender account mismatch", async () => {
    await prepareOne();
    await call("/round", {
      now,
      responses: [
        health,
        directory,
        { status: 403, body: { error: "source_account_mismatch" } },
      ],
    });
    expect((await state()).blocked).toBe("pairing");
  });
  it("preserves Retry-After across pause/resume and expires events without retrying", async () => {
    await prepareOne();
    await call("/round", {
      now,
      responses: [
        health,
        { status: 429, headers: { "retry-after": "7200" }, body: {} },
      ],
    });
    const deadline = (await state()).relay_until;
    expect(deadline).toBeGreaterThanOrEqual(now + 7200000);
    await call("/action", { now, action: "config", input: { enabled: false } });
    await call("/action", { now, action: "config", input: { enabled: true } });
    expect((await state()).relay_until).toBe(deadline);
    now += 86401000;
    await db.prepare("UPDATE notifier SET blocked='pairing' WHERE id=1").run();
    await call("/round", { now, responses: [] });
    expect((await rows())[0].status).toBe("expired");
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM notification_dedup")
          .first<any>()
      ).n,
    ).toBe(1);
  });
  it.each(["changed", "expired", "blocked"])(
    "does not bypass API cooldown for a %s identity while pairing",
    async (identity) => {
      if (identity === "expired") now += 6 * 3600000;
      if (identity === "blocked")
        await db.exec("UPDATE notifier SET blocked='credentials'");
      await db
        .prepare("UPDATE control SET api_until=?")
        .bind(now + 900000)
        .run();
      const result = await call("/action", {
        now,
        action: "pair/qr",
        env: identity === "changed" ? { V2EX_PAT: "changed-pat" } : {},
        responses: [],
      });
      expect(result.error).toContain("暂停");
      expect(result.calls).toHaveLength(0);
      expect((await state()).pair_enc).toBe("");
    },
  );
  it("revalidates a changed credential or expired identity before exchanging a pairing", async () => {
    const changed = await call("/action", {
      now,
      action: "pair/qr",
      env: { V2EX_PAT: "changed-pat" },
      responses: [{ status: 401, body: "" }],
    });
    expect(changed.error).toContain("PAT 身份已失效");
    expect(changed.calls).toHaveLength(1);
    expect(changed.calls[0].url).toBe("https://www.v2ex.com/api/v2/member");
    const expired = await call("/action", {
      now: now + 6 * 3600000,
      action: "pair/qr",
      responses: [{ status: 401, body: "" }],
    });
    expect(expired.error).toContain("PAT 身份已失效");
    expect(expired.calls).toHaveLength(1);
    expect((await state()).pair_enc).toBe("");
  });
  it("builds an encrypted synthetic test with no real notification ID or badge count", async () => {
    const created = await call("/queue-test", {
      now,
      action: "test",
      input: { kind: "mention" },
      responses: [page()],
    });
    expect(created.error).toBeUndefined();
    const row = (await rows())[0];
    const r = await call("/relay", {
      now,
      responses: [health, directory, receipt(row.event_id)],
    });
    expect(r.error).toBeUndefined();
    const wire = r.calls.at(-1).body.events[0];
    expect(wire.body_encryption).toBe(2);
    expect(wire.notification_id).toBeUndefined();
    expect(wire.unread_count).toBeUndefined();
    await validateCentralEvent(wire, now);
  });
  it("never returns storage/sender keys or wire content in state, and guards content access", async () => {
    const row = await prepareOne();
    const response = await api("/state"),
      data = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(JSON.stringify(data)).not.toContain("synthetic-sender");
    expect(JSON.stringify(data)).not.toContain(key);
    expect(JSON.stringify(data)).not.toContain("private notification");
    expect(data.notifier.device_ack_available).toBe(false);
    expect(
      (await api(`/notifier/events/${row.event_id}`, "wrong")).status,
    ).toBe(401);
    expect(
      await (await api(`/notifier/events/${row.event_id}`)).json(),
    ).toEqual({
      title: "actor 回复了《topic about 感谢》",
      body: "private notification content",
    });
  });
  it("classifies outside topic links and removes self mentions without changing code or email", async () => {
    const r = await call("/presentation", {
      username: "tester",
      notification: notice(
        100,
        "提到了你",
        '@<a href="/member/tester">tester</a> hi <code>@tester</code> person@tester.com <img src="x">',
      ),
    });
    expect(r.result.kind).toBe("mention");
    expect(r.result.body).toBe("hi @tester person@tester.com [图片]");
  });
});

describe("personal message avatar cache", () => {
  const usernameNotice = (id: number, username = "actor") => ({
    ...notice(id),
    text: `<a href="/member/${username}">${username}</a> 回复了你 <a href="/t/123">topic</a>`,
    member: { username },
  });
  const messagePage = (...items: Notification[]) => ({ body: { success: true, result: items } });
  const avatar = (username = "actor") => `https://cdn.v2ex.com/avatar/${username}.png`;
  const memberProfile = (username = "actor") => ({
    body: { status: "found", id: 123, username, avatar_large: avatar(username) },
  });

  it("persists username-only message avatars with one public lookup per author and reuses them on refresh", async () => {
    const messages = messagePage(usernameNotice(100), usernameNotice(99, "Actor"));
    const loaded = await call("/action", { now, action: "history", responses: [messages, memberProfile()] });
    expect(loaded.error).toBeUndefined();
    expect(loaded.calls).toHaveLength(2);
    expect(loaded.calls[1]).toMatchObject({
      url: "https://www.v2ex.com/api/members/show.json?username=actor",
      redirect: "manual",
    });
    expect(loaded.calls[1].headers.authorization).toBeUndefined();
    expect(loaded.calls[1].headers.cookie).toBeUndefined();
    expect(loaded.result.items.map((item: any) => item.avatar_url)).toEqual([avatar(), avatar()]);
    expect((await db.prepare("SELECT notification_id,avatar_url FROM notification_history ORDER BY notification_id DESC").all()).results)
      .toEqual([{ notification_id: 100, avatar_url: avatar() }, { notification_id: 99, avatar_url: avatar() }]);

    const repeated = await call("/action", { now, action: "history", responses: [messages] });
    expect(repeated.error).toBeUndefined();
    expect(repeated.calls).toHaveLength(1);
    const cached = await (await api("/notifier/messages")).json() as any;
    expect(cached.items.map((item: any) => item.avatar_url)).toEqual([avatar(), avatar()]);
    expect(outboundCalls).toBe(0);
  });

  it("seeds author avatars from later cached messages while excluding another account's matching notification", async () => {
    await call("/action", { now, action: "history", responses: [page(100)] });
    await db.exec("INSERT INTO notification_history(account_id,notification_id,kind,created_at,fetched_at,content_enc,avatar_url) SELECT 8,102,kind,created_at,fetched_at,content_enc,avatar_url FROM notification_history WHERE notification_id=100;");
    const loaded = await call("/action", {
      now, action: "history",
      responses: [messagePage(usernameNotice(102, "stranger"), usernameNotice(101), usernameNotice(100)), memberProfile("stranger")],
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.calls.map((entry: any) => new URL(entry.url).pathname + new URL(entry.url).search)).toEqual([
      "/api/v2/notifications?p=1", "/api/members/show.json?username=stranger",
    ]);
    expect(loaded.result.items.map((item: any) => item.avatar_url)).toEqual([
      avatar("stranger"), "https://cdn.v2ex.com/avatar/1/2/3.png", "https://cdn.v2ex.com/avatar/1/2/3.png",
    ]);
  });

  it("reuses an existing notification outbox avatar without another public query", async () => {
    await prepareOne(100);
    await db.exec("UPDATE notification_history SET avatar_url='' WHERE notification_id=100");
    const loaded = await call("/action", {
      now, action: "history", responses: [messagePage(usernameNotice(100))],
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.calls).toHaveLength(1);
    expect(loaded.result.items[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/1/2/3.png");
    expect(await db.prepare("SELECT avatar_url FROM notification_history WHERE notification_id=100").first())
      .toEqual({ avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png" });
  });

  it("keeps real text and known avatars when optional public profile enrichment fails", async () => {
    await call("/action", { now, action: "history", responses: [page(100)] });
    const loaded = await call("/action", {
      now, action: "history",
      responses: [messagePage(usernameNotice(102, "stranger"), usernameNotice(101, "stranger"), usernameNotice(100)), { status: 500, body: "unavailable" }],
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.calls).toHaveLength(2);
    const cached = await (await api("/notifier/messages")).json() as any;
    expect(cached.items.map((item: any) => item.avatar_url)).toEqual(["", "", "https://cdn.v2ex.com/avatar/1/2/3.png"]);
    expect(cached.items.map((item: any) => item.body)).toEqual(Array(3).fill("private notification content"));
    expect((await state()).history_error).toBe("");
    expect(outboundCalls).toBe(0);
  });

  it("limits optional public lookups to ten authors and still saves the full message page", async () => {
    const messages = Array.from({ length: 11 }, (_, index) => usernameNotice(200 - index, `actor${index}`));
    const loaded = await call("/action", {
      now, action: "history",
      responses: [messagePage(...messages), ...Array.from({ length: 10 }, (_, index) => memberProfile(`actor${index}`))],
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.calls).toHaveLength(11);
    expect(loaded.result.items).toHaveLength(11);
    expect(loaded.result.items.slice(0, 10).map((item: any) => item.avatar_url))
      .toEqual(Array.from({ length: 10 }, (_, index) => avatar(`actor${index}`)));
    expect(loaded.result.items[10]).toMatchObject({ notification_id: 190, avatar_url: "", body: "private notification content" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 11 });
  });

  it("does not swallow lease failures during optional avatar enrichment", async () => {
    const loaded = await call("/action", {
      now, action: "history",
      responses: [messagePage(usernameNotice(100)), { status: 429, body: "limited", headers: { "retry-after": "120" }, replaceLease: true }],
    });
    expect(loaded.error).toContain("CHECK");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 0 });
    expect((await state()).history_next_page).toBe(1);
  });
});

describe("real notification test samples", () => {
  const samplePage = (...items: Notification[]) => ({
    body: { success: true, result: items },
  });
  const testSample = (kind: string, responses: unknown[]) =>
    call("/queue-test", { now, input: { kind }, responses });
  const cached = (kind = "reply", account = 7) =>
    db.prepare("SELECT * FROM notification_samples WHERE account_id=? AND kind=?")
      .bind(account, kind).first<any>();

  const usernameOnlyPage = () => ({
    body: {
      success: true,
      result: [{ ...notice(100), member: { username: "actor" } }],
    },
  });
  const senderProfile = {
    body: {
      status: "found",
      id: 123,
      username: "Actor",
      avatar_large: "//cdn.v2ex.com/avatar/a/b/123_large.png?m=1234",
    },
  };

  it("reformats a large cached raw sample offline despite expired verification and both upstream cooldowns", async () => {
    const n = notice(120, "提到了你", `@tester <b>${"x".repeat(13000)}</b>`);
    const first = await testSample("mention", [samplePage(n)]);
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({
      sample_source: "real", sample_origin: "live", source_notification_id: 120, searched_count: 1,
    });
    const sample = await cached("mention");
    expect(sample.raw_enc).not.toContain(n.payload_rendered);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 0 });

    now += 6 * 3600000 + 61000;
    await db.prepare("UPDATE control SET api_until=?,web_until=?").bind(now + 120000, now + 120000).run();
    await db.prepare("UPDATE notifier SET verify_until=?").bind(now + 120000).run();
    const before = await state();
    expect(before.verified_at).toBeLessThan(now - 6 * 3600000);
    const reused = await testSample("mention", []);
    expect(reused.error).toBeUndefined();
    expect(reused.calls).toEqual([]);
    expect(reused.result).toMatchObject({
      sample_source: "real", sample_origin: "cache", source_notification_id: 120, searched_count: 0,
    });
    expect((await call("/content", { id: reused.result.event_id })).result).toEqual({
      title: "actor 提到了你", body: `${"x".repeat(180)}…`,
    });
    expect((await rows()).find((row) => row.event_id === reused.result.event_id)?.avatar_url).toBe(sample.avatar_url);
    expect((await cached("mention")).fetched_at).toBe(sample.fetched_at);
    expect(await state()).toEqual(before);
  });

  it("keeps the newest classified raw sample per kind and ignores old formatted history when testing", async () => {
    const first = await call("/action", {
      now, action: "history",
      responses: [samplePage(notice(104, "回复了你", "newest reply"), notice(103), notice(102, "提到了你", "@tester newest mention"), notice(101, "未知动态"))],
    });
    expect(first.error).toBeUndefined();
    expect((await db.prepare("SELECT kind,notification_id FROM notification_samples ORDER BY kind").all()).results)
      .toEqual([{ kind: "mention", notification_id: 102 }, { kind: "reply", notification_id: 104 }]);
    const mention = await cached("mention");
    now += 181000;
    const refreshed = await call("/action", {
      now, action: "history", responses: [samplePage(notice(105, "回复了你", "newer reply"), notice(100, "提到了你", "older mention"))],
    });
    expect(refreshed.error).toBeUndefined();
    expect((await cached()).notification_id).toBe(105);
    expect(await cached("mention")).toEqual(mention);
    const oldContent = (await call("/seal", {
      purpose: "notification:7:105", value: { title: "actor 回复了你的主题", body: "old formatted history" },
    })).result;
    await db.prepare("UPDATE notification_history SET content_enc=? WHERE notification_id=105").bind(oldContent).run();
    const reused = await testSample("reply", []);
    expect(reused.error).toBeUndefined();
    expect(reused.calls).toEqual([]);
    expect(reused.result).toMatchObject({ sample_origin: "cache", source_notification_id: 105, searched_count: 0 });
    expect((await call("/content", { id: reused.result.event_id })).result).toEqual({
      title: "actor 回复了《topic about 感谢》", body: "newer reply",
    });
  });

  it.each(["expired", "foreign account", "formatted history only", "different kind"])(
    "reads live when only a %s sample exists", async (scenario) => {
      const loaded = await call("/action", { now, action: "history", responses: [page(100)] });
      expect(loaded.error).toBeUndefined();
      if (scenario === "expired")
        await db.prepare("UPDATE notification_samples SET fetched_at=?").bind(now - 7 * 86400000).run();
      if (scenario === "foreign account") {
        const raw = (await call("/seal", { purpose: "sample:8:100", value: { ...notice(100), for_member_id: 8 } })).result;
        await db.prepare("UPDATE notification_samples SET account_id=8,raw_enc=?").bind(raw).run();
      }
      if (scenario === "formatted history only") await db.exec("DELETE FROM notification_samples");
      const kind = scenario === "different kind" ? "favorite" : "reply";
      const result = await testSample(kind, [samplePage(notice(101, kind === "favorite" ? "收藏了你的主题" : "回复了你", "fresh live reply"))]);
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        sample_source: "real", sample_origin: "live", source_notification_id: 101, searched_count: 1,
      });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].url).toContain("/api/v2/notifications?p=1");
      expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 1 });
    },
  );

  it("reuses a completed page's cached sample after a later live page fails without queuing a synthetic test", async () => {
    const failed = await testSample("favorite", [page(100), { error: true }]);
    expect(failed.error).toBeTruthy();
    expect(await rows()).toEqual([]);
    const reused = await testSample("reply", []);
    expect(reused.error).toBeUndefined();
    expect(reused.calls).toEqual([]);
    expect(reused.result).toMatchObject({
      sample_source: "real", sample_origin: "cache", source_notification_id: 100, searched_count: 0,
    });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_history").first()).toEqual({ n: 0 });
  });

  // The live API v2 notification's member contains only username, unlike the
  // full-member fixtures above. Both real and test sends must fill this gap.
  it.each(["test", "notification"])(
    "resolves the public sender avatar before the first %s delivery",
    async (type) => {
      const created =
        type === "test"
          ? await testSample("reply", [usernameOnlyPage()])
          : await call("/scan", {
              now,
              responses: [{ body: home(1) }, usernameOnlyPage()],
            });
      expect(created.error).toBeUndefined();
      const row = (await rows())[0];
      expect(row.avatar_url).toBe("");
      const historyBefore = await db.prepare("SELECT avatar_url,fetched_at FROM notification_history WHERE account_id=7 AND notification_id=100").first<any>();
      const sent = await call("/relay", {
        now,
        responses: [health, directory, senderProfile, receipt(row.event_id)],
      });
      expect(sent.error).toBeUndefined();
      const lookup = sent.calls[2];
      expect(lookup.url).toBe(
        "https://www.v2ex.com/api/members/show.json?username=actor",
      );
      expect(lookup.headers.authorization).toBeUndefined();
      expect(lookup.headers.cookie).toBeUndefined();
      expect(lookup.redirect).toBe("manual");
      const wire = sent.calls.at(-1).body.events[0];
      expect(wire.avatar_url).toBe(
        "https://cdn.v2ex.com/avatar/a/b/123_large.png?m=1234",
      );
      expect((await rows())[0].avatar_url).toBe(wire.avatar_url);
      const historyAfter = await db.prepare("SELECT avatar_url,fetched_at FROM notification_history WHERE account_id=7 AND notification_id=100").first<any>();
      if (type === "notification") {
        expect(historyBefore.avatar_url).toBe("");
        expect(historyAfter).toEqual({ avatar_url: wire.avatar_url, fetched_at: historyBefore.fetched_at });
        const cachedMessages = await (await api("/notifier/messages")).json() as any;
        expect(cachedMessages.items[0].avatar_url).toBe(wire.avatar_url);
        expect(outboundCalls).toBe(0);
      } else {
        expect(historyBefore).toBeNull();
        expect(historyAfter).toBeNull();
      }
      await validateCentralEvent(wire, now);
      const apns = await buildCentralApnsPayload(
        { id: device, binding_id: binding, username: "tester" },
        wire,
        now,
      );
      if (apns) {
        expect(apns.avatar_url).toBe(wire.avatar_url);
        expect(apns.aps["mutable-content"]).toBe(1);
        if (type === "test") {
          expect(apns.notification_id).toBeUndefined();
          expect(apns.aps.badge).toBeUndefined();
        }
      }
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM api_usage WHERE endpoint='member' AND attempted_at>=?",
          )
          .bind(now)
          .first(),
      ).toEqual({ n: 1 });
    },
  );

  it("freezes the resolved avatar with the ciphertext before a lost relay response", async () => {
    const created = await testSample("reply", [usernameOnlyPage()]);
    const id = created.result.event_id;
    const lost = await call("/relay", {
      now,
      responses: [health, directory, senderProfile, { error: true }],
    });
    expect(lost.error).toBeTruthy();
    const wire = (await rows())[0].wire;
    now += 120000;
    const retry = await call("/relay", {
      now,
      responses: [health, receipt(id)],
    });
    expect(retry.error).toBeUndefined();
    expect(retry.calls).toHaveLength(2);
    expect(retry.calls.at(-1).body.events[0]).toEqual(JSON.parse(wire));
    expect((await rows())[0].wire).toBe(wire);
  });

  it("reuses an enriched avatar without refreshing cache age or inheriting it for a newer notification", async () => {
    const created = await testSample("reply", [usernameOnlyPage()]);
    const sample = await cached();
    now += 1000;
    const sent = await call("/relay", {
      now, responses: [health, directory, senderProfile, receipt(created.result.event_id)],
    });
    expect(sent.error).toBeUndefined();
    const avatar = "https://cdn.v2ex.com/avatar/a/b/123_large.png?m=1234";
    expect(await cached()).toMatchObject({ avatar_url: avatar, fetched_at: sample.fetched_at });

    now += 181000;
    const refreshed = await call("/action", { now, action: "history", responses: [usernameOnlyPage()] });
    expect(refreshed.error).toBeUndefined();
    const refetched = await cached();
    expect(refetched.avatar_url).toBe(avatar);
    const reused = await call("/action", {
      now, action: "test", input: { kind: "reply" }, responses: [health, directory, { receiptStatus: "pending" }],
    });
    expect(reused.error).toBeUndefined();
    expect(reused.result).toMatchObject({ sample_origin: "cache", searched_count: 0, delivery_status: "submitted" });
    expect(reused.calls.map((c: any) => new URL(c.url).pathname)).toEqual([
      "/api/push/v1/health", "/api/push/v1/recipient-keys", "/api/push/v1/sync",
    ]);
    expect(reused.calls.at(-1).body.events[0].avatar_url).toBe(avatar);
    expect((await cached()).fetched_at).toBe(refetched.fetched_at);

    now += 181000;
    const newer = await call("/action", {
      now, action: "history", responses: [samplePage({ ...notice(101), member: { username: "actor" } })],
    });
    expect(newer.error).toBeUndefined();
    expect(await cached()).toMatchObject({ notification_id: 101, avatar_url: "" });
  });

  it.each([
    { error: true },
    { streamError: true },
    { status: 401, body: { message: "Invalid token" } },
    { status: 302, body: "" },
    { status: 403, body: "forbidden" },
    { status: 429, body: "", headers: { "retry-after": "120" } },
    { body: "invalid JSON" },
    { body: { ...senderProfile.body, username: "different" } },
    {
      body: {
        ...senderProfile.body,
        avatar_large: "https://external.example/avatar.png",
      },
    },
  ])(
    "keeps real text and pairing when the optional avatar is unavailable: %j",
    async (failure) => {
      const created = await testSample("reply", [usernameOnlyPage()]);
      const sent = await call("/relay", {
        now,
        responses: [
          health,
          directory,
          failure,
          receipt(created.result.event_id),
        ],
      });
      expect(sent.error).toBeUndefined();
      expect(sent.calls.at(-1).body.events[0].avatar_url).toBe("");
      expect((await state()).blocked).toBe("");
      expect(
        (await call("/content", { id: created.result.event_id })).result.title,
      ).toBe("actor 回复了《topic about 感谢》");
      if (failure.status === 429 || failure.status === 403) {
        expect(
          (await db.prepare("SELECT api_until FROM control").first<any>())!
            .api_until,
        ).toBeGreaterThan(now);
      }
    },
  );

  it("respects API cooldown while allowing the encrypted text to be delivered", async () => {
    const created = await testSample("reply", [usernameOnlyPage()]);
    await db
      .prepare("UPDATE control SET api_until=?")
      .bind(now + 120000)
      .run();
    const sent = await call("/relay", {
      now,
      responses: [health, directory, receipt(created.result.event_id)],
    });
    expect(sent.error).toBeUndefined();
    expect(sent.calls).toHaveLength(3);
    expect(sent.calls.at(-1).body.events[0].avatar_url).toBe("");
  });

  it.each([
    ["reply", "回复了你", "实际回复", "实际回复"],
    ["mention", "提到了你", "@tester 实际提及", "实际提及"],
    ["thanks_topic", "感谢了你的主题", "忽略正文", "《topic about 感谢》"],
    ["thanks_reply", "感谢了你的回复", "被感谢的回复", "被感谢的回复"],
    ["favorite", "收藏了你的主题", "忽略正文", "《topic about 感谢》"],
  ])(
    "uses the newest matching %s even with no unread notifications",
    async (kind, action, payload, body) => {
      const before = await state();
      const created = await testSample(kind, [
        samplePage(
          notice(103, "未知动态"),
          { ...notice(102, action, payload), member: { username: "actor" } },
          notice(101, action, "older"),
        ),
      ]);
      expect(created.error).toBeUndefined();
      expect(created.result).toMatchObject({
        sample_source: "real",
        sample_origin: "live",
        source_notification_id: 102,
      });
      expect(created.calls).toHaveLength(1);
      expect(created.calls[0]).toMatchObject({
        url: "https://www.v2ex.com/api/v2/notifications?p=1",
        headers: { authorization: `Bearer ${pat}` },
        redirect: "manual",
      });
      expect(created.calls[0].headers.cookie).toBeUndefined();
      expect(await state()).toEqual(before);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM notification_dedup")
          .first(),
      ).toEqual({ n: 0 });
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM notification_history")
          .first(),
      ).toEqual({ n: 0 });
      const row = (await rows())[0];
      expect(row).toMatchObject({
        type: "test",
        kind,
        notification_id: 102,
        unread: 0,
        status: "pending",
      });
      const content = await call("/content", { id: row.event_id });
      expect(content.result).toMatchObject({ body });
      expect(content.result.title).toMatch(/^actor /);
      expect(row.content_enc).not.toContain(body);
      const sent = await call("/relay", {
        now,
        responses: [health, directory, senderProfile, receipt(row.event_id)],
      });
      expect(sent.error).toBeUndefined();
      const wire = sent.calls.at(-1).body.events[0];
      expect(wire).toMatchObject({
        type: "test",
        test_kind: kind,
        body_encryption: 2,
        avatar_url: "https://cdn.v2ex.com/avatar/a/b/123_large.png?m=1234",
      });
      expect(wire.notification_id).toBeUndefined();
      expect(wire.unread_count).toBeUndefined();
      expect(wire.title).toBeUndefined();
      expect(wire.body).toBeUndefined();
      await validateCentralEvent(wire, now);
      const apns = await buildCentralApnsPayload(
        { id: device, binding_id: binding, username: "tester" },
        wire,
        now,
      );
      if (apns) {
        expect(apns.avatar_url).toBe(wire.avatar_url);
        expect(apns.notification_kind).toBe(kind);
        expect(apns.notification_id).toBeUndefined();
        expect(apns.aps.badge).toBeUndefined();
      }
    },
  );

  it("continues past non-matching pages and can select the hundredth notification", async () => {
    const responses = Array.from({ length: 10 }, (_, pageIndex) =>
      samplePage(
        ...Array.from({ length: 10 }, (_, i) =>
          notice(
            200 - pageIndex * 10 - i,
            pageIndex === 9 && i === 9 ? "感谢了你的主题" : "回复了你",
          ),
        ),
      ),
    );
    const result = await testSample("thanks_topic", responses);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      sample_source: "real",
      source_notification_id: 101,
      searched_count: 100,
    });
    expect(result.calls).toHaveLength(10);
    expect(result.calls.at(-1).url).toContain("?p=10");
  });

  it("falls back only after checking all 100 notifications and does not fetch the 101st", async () => {
    const responses = Array.from({ length: 10 }, (_, index) =>
      page(...Array.from({ length: 10 }, (_, i) => 200 - index * 10 - i)),
    );
    const result = await testSample("thanks_topic", [
      ...responses,
      samplePage(notice(100, "感谢了你的主题")),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(10);
    expect(result.result).toMatchObject({
      sample_source: "synthetic",
      sample_origin: "live",
      source_notification_id: null,
      searched_count: 100,
    });
    expect((await rows())[0].notification_id).toBeNull();
    expect(
      (await call("/content", { id: result.result.event_id })).result.title,
    ).toBe("测试用户 感谢了你的主题");
  });

  it("checks for the end of a shorter history instead of assuming a short page is final", async () => {
    const result = await testSample("favorite", [
      page(100),
      samplePage(notice(99, "未知动态")),
      page(),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(3);
    expect(result.result).toMatchObject({
      sample_source: "synthetic",
      searched_count: 2,
    });
  });

  it.each([
    { error: true },
    { status: 429, body: "", headers: { "retry-after": "120" } },
    { status: 403, body: "forbidden" },
    { body: "invalid JSON" },
    { body: { success: false, result: [] } },
  ])(
    "does not substitute a synthetic sample after a failed page: %j",
    async (failure) => {
      const result = await testSample("favorite", [page(100), failure]);
      expect(result.error).toBeTruthy();
      expect(await rows()).toEqual([]);
    },
  );

  it("does not substitute a synthetic sample for an incomplete or moving history", async () => {
    for (const responses of [
      Array.from({ length: 10 }, (_, i) => page(100 - i)),
      [page(100), page(100, 99)],
    ]) {
      const result = await testSample("favorite", responses);
      expect(result.error).toBeTruthy();
      expect(await rows()).toEqual([]);
    }
  });

  it("refuses foreign-account data even if an earlier notification matches", async () => {
    const foreign = { ...notice(99), for_member_id: 8 };
    const result = await testSample("reply", [
      samplePage(notice(100), foreign),
    ]);
    expect(result.error).toContain("收件人");
    expect(await rows()).toEqual([]);
    expect((await state()).blocked).toBe("credentials");
  });

  it("revalidates changed credentials and never reads samples for a different account", async () => {
    expect((await call("/action", { now, action: "history", responses: [page(100)] })).error).toBeUndefined();
    expect((await cached()).notification_id).toBe(100);
    const result = await call("/queue-test", {
      now,
      action: "test",
      input: { kind: "reply" },
      env: { V2EX_PAT: "changed-pat" },
      responses: [
        { body: { success: true, result: { id: 8, username: "another" } } },
      ],
    });
    expect(result.error).toContain("此账号不符");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toContain("/api/v2/member");
    expect(await rows()).toEqual([]);
    expect((await state()).blocked).toBe("credentials");
  });

  it("verifies an expired identity before searching samples", async () => {
    const result = await call("/queue-test", {
      now: now + 6 * 3600000,
      action: "test",
      input: { kind: "reply" },
      responses: [profile, { body: home(0) }, page(100)],
    });
    expect(result.error).toBeUndefined();
    expect(result.calls.map((c: any) => new URL(c.url).pathname)).toEqual([
      "/api/v2/member",
      "/",
      "/api/v2/notifications",
    ]);
    expect(result.result.sample_source).toBe("real");
  });

  it("respects the API cooldown and does not treat a skipped request as empty history", async () => {
    await db
      .prepare("UPDATE control SET api_until=?")
      .bind(now + 120000)
      .run();
    const result = await testSample("reply", []);
    expect(result.error).toContain("暂停");
    expect(result.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("validates types and rate limits before reading notifications", async () => {
    const invalid = await testSample("other", []);
    expect(invalid.error).toContain("类型无效");
    expect(invalid.calls).toEqual([]);
    expect((await testSample("reply", [page(100)])).error).toBeUndefined();
    const repeated = await testSample("reply", [page(100)]);
    expect(repeated.error).toContain("测试频率");
    expect(repeated.calls).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  it("keeps tests separate from a partial unread scan and future real deliveries", async () => {
    await scan(3, [100, 99]);
    const before = await state();
    const candidates = await db
      .prepare("SELECT * FROM notification_candidates ORDER BY notification_id")
      .all();
    const test = await testSample("reply", []);
    expect(test.error).toBeUndefined();
    expect(test.calls).toEqual([]);
    expect(test.result).toMatchObject({ sample_origin: "cache", source_notification_id: 100, searched_count: 0 });
    expect(await state()).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM notification_candidates ORDER BY notification_id",
          )
          .all()
      ).results,
    ).toEqual(candidates.results);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM notification_dedup").first(),
    ).toEqual({ n: 0 });
    await db.exec(
      "UPDATE notifier SET scan_stage='idle',next_scan=0,observed_at=0",
    );
    now += 61000;
    await scan(1, [100]);
    expect((await rows()).map((row) => row.type).sort()).toEqual([
      "notification",
      "test",
    ]);
  });

  it("does not queue a sample after its lease is replaced", async () => {
    const result = await testSample("reply", [
      { ...page(100), replaceLease: true },
    ]);
    expect(result.error).toContain("CHECK");
    expect(await rows()).toEqual([]);
  });

  it("waits for avatar support without blocking ordinary notifications", async () => {
    const real = await prepareOne(100);
    expect((await testSample("reply", [])).error).toBeUndefined();
    const result = await call("/relay", {
      now,
      responses: [
        { body: { ...health.body, notification_test_avatars: undefined } },
        directory,
        receipt(real.event_id),
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.calls.at(-1).body.events).toHaveLength(1);
    expect(result.calls.at(-1).body.events[0].type).toBe("notification");
    const waiting = (await rows()).find((row) => row.type === "test");
    expect(waiting).toMatchObject({
      status: "pending",
      wire: null,
      attempts: 0,
    });
    expect(waiting.next_at).toBeGreaterThan(now);
    expect(waiting.detail).toContain("真实测试头像");
  });

  it("omits an unavailable real avatar instead of attaching the synthetic user's avatar", async () => {
    const result = await testSample("reply", [
      samplePage({
        ...notice(100),
        member: {
          username: "actor",
          avatar_large: "https://external.example/avatar.png",
        },
      }),
    ]);
    expect(result.error).toBeUndefined();
    const sent = await call("/relay", {
      now,
      responses: [
        health,
        directory,
        { body: { status: "not_found" } },
        receipt(result.result.event_id),
      ],
    });
    expect(sent.error).toBeUndefined();
    const wire = sent.calls.at(-1).body.events[0];
    expect(wire.avatar_url).toBe("");
    const apns = await buildCentralApnsPayload(
      { id: device, binding_id: binding, username: "tester" },
      wire,
      now,
    );
    if (apns) expect(apns.avatar_url).toBeUndefined();
  });
});

describe("immediate manual test delivery", () => {
  const sendTest = (responses: unknown[]) =>
    call("/action", {
      now,
      action: "test",
      input: { kind: "reply" },
      responses,
    });

  it("submits the new test immediately without waiting for cron or running an unread scan", async () => {
    await db
      .prepare("UPDATE control SET next_dispatch=?")
      .bind(now + 60000)
      .run();
    await db.exec("UPDATE notifier SET check_start_hour=1,check_end_hour=2");
    const before = await state();
    const result = await sendTest([
      page(100),
      health,
      directory,
      { receiptStatus: "pending" },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.result.delivery_status).toBe("submitted");
    expect(result.result.reason).toContain("已提交推送服务");
    expect(result.calls.map((c: any) => new URL(c.url).pathname)).toEqual([
      "/api/v2/notifications",
      "/api/push/v1/health",
      "/api/push/v1/recipient-keys",
      "/api/push/v1/sync",
    ]);
    expect(result.calls.at(-1).body.events).toHaveLength(1);
    expect(result.calls.at(-1).body.events[0].event_id).toBe(
      result.result.event_id,
    );
    expect((await rows())[0]).toMatchObject({
      status: "submitted",
      attempts: 1,
    });
    expect((await state()).last_scan).toBe(before.last_scan);
    expect(
      await db.prepare("SELECT next_dispatch FROM control").first(),
    ).toEqual({ next_dispatch: now + 60000 });
  });

  it("keeps a test queued when the service requires cooldown", async () => {
    const until = now + 120000;
    await db.prepare("UPDATE notifier SET relay_until=?").bind(until).run();
    const result = await sendTest([page(100)]);
    expect(result.error).toBeUndefined();
    expect(result.result.delivery_status).toBe("pending");
    expect(result.result.reason).toContain("尚未到推送重试时间");
    expect(result.calls).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect((await state()).relay_until).toBe(until);
  });

  it("retains a successfully created test and its immutable wire after an uncertain submission", async () => {
    const result = await sendTest([
      page(100),
      health,
      directory,
      { error: true },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.result.delivery_status).toBe("pending");
    expect(result.result.reason).toContain("后台");
    const saved = (await rows())[0];
    expect(saved.attempts).toBe(1);
    expect(saved.wire).toBeTruthy();
    expect((await state()).relay_error).toBeTruthy();
    now += 180000;
    const retry = await call("/relay", {
      now,
      responses: [health, receipt(saved.event_id)],
    });
    expect(retry.error).toBeUndefined();
    expect(retry.calls.at(-1).body.events[0]).toEqual(JSON.parse(saved.wire));
    expect(await rows()).toHaveLength(1);
  });

  it("sends only the requested test while leaving older queued notifications for cron", async () => {
    const earlier = await prepareOne();
    const result = await sendTest([
      health,
      directory,
      { receiptStatus: "pending" },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.result.delivery_status).toBe("submitted");
    const events = result.calls.at(-1).body.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "test",
      event_id: result.result.event_id,
    });
    const unchanged = (await rows()).find(
      (r) => r.event_id === earlier.event_id,
    );
    expect(unchanged).toMatchObject({
      attempts: 0,
      wire: null,
      status: "pending",
    });
  });
});

describe("assistant QR pairing", () => {
  const savedInvitation = () =>
    db.prepare("SELECT * FROM notifier_pairing_invitation").first<any>();
  async function createQR(
    responses: unknown[] = [
      { body: { expires_at: new Date(now + 599000).toISOString() } },
    ],
  ) {
    return call("/action", { now, action: "pair/qr", responses: [pairingHealth, ...responses] });
  }
  it("persists secrets before requesting an invitation and recovers the same QR without extending its lifetime", async () => {
    const before = await state();
    const lost = await createQR([{ error: true }]);
    expect(lost.error).toContain("网络请求失败");
    expect(lost.calls).toHaveLength(2);
    const first = lost.calls[1],
      stored = await savedInvitation();
    expect(first.url).toBe("https://app.v2echo.com/api/push/v1/invitations");
    expect(first.body).toEqual({
      code: expect.stringMatching(/^V2N-[A-Za-z0-9_-]{24}$/),
      source_account_id: 7,
      source_username: "tester",
    });
    expect(first.headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(first.headers).not.toHaveProperty("cookie");
    expect(first.redirect).toBe("manual");
    for (const secret of [
      first.body.code,
      first.headers.authorization.slice(7),
      pat,
      cookie,
    ])
      expect(JSON.stringify(stored)).not.toContain(secret);
    expect((await state()).sender_enc).toBe(before.sender_enc);

    now += 31000;
    const retry = await createQR();
    expect(retry.error).toBeUndefined();
    expect(retry.calls[1]).toEqual(first);
    expect(retry.result).toEqual({
      code: first.body.code,
      direct: true,
      expires_at: stored.expires_at,
    });
    expect((await savedInvitation()).expires_at).toBe(stored.expires_at);
    expect((await state()).pair_until).toBe(0);
    const restored = await createQR([]);
    expect(restored.result).toEqual(retry.result);
    expect(restored.calls).toHaveLength(1);
    const publicState = await (await api("/state")).text();
    expect(publicState).not.toContain(first.body.code);
    expect(publicState).not.toContain(first.headers.authorization.slice(7));
  });

  it("validates both V2EX credentials before generating the first QR", async () => {
    await db.exec("DELETE FROM notifier; INSERT INTO notifier(id) VALUES(1)");
    const created = await call("/action", { now, action: "pair/qr", responses: [
      profile,
      { body: home(3) },
      pairingHealth,
      { body: { expires_at: new Date(now + 599000).toISOString() } },
    ] });
    expect(created.error).toBeUndefined();
    expect(created.calls.map((c: any) => c.url)).toEqual([
      "https://www.v2ex.com/api/v2/member",
      "https://www.v2ex.com/",
      "https://app.v2echo.com/api/push/v1/health",
      "https://app.v2echo.com/api/push/v1/invitations",
    ]);
    expect((await state()).binding_id).toBe("");
    expect((await state()).unread).toBe(3);
  });

  it("does not spend an identity request while QR pairing is cooling down", async () => {
    now += 6 * 3600000;
    await db
      .prepare("UPDATE notifier SET pair_until=?")
      .bind(now + 120000)
      .run();
    const result = await createQR([]);
    expect(result.error).toContain("暂停");
    expect(result.calls).toHaveLength(0);
    expect(await savedInvitation()).toBeNull();
  });

  it.each([
    null,
    {},
    { expires_at: 123 },
    { expires_at: "invalid" },
    { expires_at: "2099-01-01T00:00:00Z" },
  ])(
    "does not display a QR for an invalid registration response %j",
    async (body) => {
      const result = await createQR([{ body }]);
      expect(result.error).toContain("有效期响应无效");
      expect((await state()).binding_id).toBe(binding);
      expect(await savedInvitation()).not.toBeNull();
    },
  );

  it("uses the authenticated Push service binding without forwarding V2EX or admin credentials", async () => {
    const response = await mf.dispatchFetch("http://local/api/notifier/pair/qr", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ direct: true, code: expect.stringMatching(/^V2N-/) });
    expect(serviceCalls.map(call => call.url)).toEqual([
      "https://app.v2echo.com/api/push/v1/health",
      "https://app.v2echo.com/api/push/v1/invitations",
    ]);
    expect(serviceCalls[1].headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(serviceCalls[1].body).toMatchObject({ source_account_id: 7 });
    expect(JSON.stringify(serviceCalls)).not.toContain(cookie);
    expect(JSON.stringify(serviceCalls)).not.toContain(pat);
    expect(JSON.stringify(serviceCalls)).not.toContain(admin);
  });
});
