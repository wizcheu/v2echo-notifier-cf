import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCentralApnsPayload, validateCentralEvent } from "./central-push";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { createHash, generateKeyPairSync, diffieHellman, hkdfSync, createDecipheriv, createPublicKey } from "node:crypto";
import type { WatchConfig } from "../shared/watch-contracts";
import { topicHTML } from "./watch-fixtures";

const admin = "synthetic-watch-test-admin-".repeat(3);
const binding = "11111111-1111-4111-8111-111111111111";
const assistant = "22222222-2222-4222-8222-222222222222";
const device = "33333333-3333-4333-8333-333333333333";
const secondBinding = "44444444-4444-4444-8444-444444444444";
const keys = generateKeyPairSync("x25519");
const publicBytes = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const recipient = { device_id: device, binding_id: binding, public_key: publicBytes.toString("base64url"),
  key_id: createHash("sha256").update(publicBytes).digest("hex") };
const health = { notification_details: 1, notification_body_encryption: 2, notification_routing: 1,
  notification_test_samples: 1, notification_test_avatars: 1, watch_notifications: 1, watch_comment_details: 1,
  watch_test_notifications: 1, max_events: 20, max_receipts: 50, max_sync_bytes: 65536, sync_interval: 30 };
const directory = { body: { source_account_id: 7, recipients: [recipient] } };
const home = (username = "tester") => `<a class="top" href="/member/${username}">${username}</a><div id="Rightbar"><a href="/notifications">0 unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/1">topic</a></span></div>`;
const profile = (id = 7, username = "tester") => ({ body: { success: true, result: { id, username } } });
type TestKind = "topic_reply" | "topic_replies" | "following_topic";
let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>, now: number;
let migrations: string[], config: WatchConfig;
let apiResponses: { body?: unknown; status?: number; receiptStatus?: string }[], apiCalls: { url: string; body: any; headers: Record<string, string> }[];

async function call(path: string, data: unknown = {}) {
  return (await mf.dispatchFetch(`http://local${path}`, { method: "POST", body: JSON.stringify(data) })).json<any>();
}
async function request(path: string, body: unknown) {
  return mf.dispatchFetch(`https://assistant.example/api${path}`, { method: "POST", headers: {
    Authorization: `Bearer ${admin}`, "Content-Type": "application/json", Origin: "https://assistant.example",
  }, body: JSON.stringify(body) });
}
const queue = (kind: TestKind, responses: unknown[] = [], accountID = 1) => call("/queue-test", { now, input: { kind }, responses, accountID });
const relay = (responses: unknown[], accountID = 1) => call("/relay", { now, responses, accountID });
const paths = (result: any) => result.calls.map((call: any) => new URL(call.url).pathname + new URL(call.url).search);
const rows = async () => (await db.prepare("SELECT * FROM notification_outbox ORDER BY created_at,event_id").all<any>()).results;
const body = async (id: string, accountID = 1) => (await call("/content", { id, accountID })).result;
async function saveConfig(value = config, accountID = 1) {
  await db.prepare("UPDATE watch_control SET config=?,published_binding=?,config_owner='assistant',ownership_committed=1,explicit_pairing=1 WHERE id=?")
    .bind(JSON.stringify(value), value.profile_id, accountID).run();
}
async function saveFeed(value: any = {}, accountID = 1, account = 7) {
  const state = { boundary: now, members: { writer: now }, seen: [],
    member_feed: { observed_at: now, topics: [{ id: 42, author: "writer", title: "真实关注主题", reply_count: 5,
      avatar_url: "https://cdn.v2ex.com/avatar/writer.png" }] }, ...value };
  const sealed = (await call("/seal", { purpose: `watch:${account}:following:1`, value: state })).result;
  await db.prepare("UPDATE watch_targets SET state_enc=? WHERE notifier_id=? AND target_key='following'").bind(sealed, accountID).run();
}
async function scannedState(accountID = 1) {
  const result: Record<string, unknown> = {};
  result.notifier = await db.prepare("SELECT unread,observed_at,last_scan,scan_stage,scan_error,scan_until,scan_id,scan_page,scan_collected,scan_min,scan_head FROM notifier WHERE id=?").bind(accountID).first();
  for (const table of ["watch_targets", "unread_items", "notification_candidates", "notification_checks"])
    result[table] = (await db.prepare(`SELECT * FROM ${table} WHERE notifier_id=?`).bind(accountID).all()).results;
  const account = (await db.prepare("SELECT account_id FROM notifier WHERE id=?").bind(accountID).first<any>()).account_id;
  for (const table of ["notification_dedup", "notification_history", "notification_samples", "watch_dedup"])
    result[table] = (await db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).bind(account).all()).results;
  return result;
}
const replies = () => topicHTML(8, now - 86400000, [
  { id: 101, floor: 1, author: "older", body: "较早评论" },
  { id: 102, floor: 2, author: "reader", body: "最近评论 <img src='https://example.test/content.png'>" },
  { id: 103, floor: 3, author: "tester", body: "自己的评论" },
]);
function decrypt(wire: any) {
  const envelope = wire.encrypted_bodies[0];
  const ephemeral = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(envelope.ephemeral_key, "base64url")]), format: "der", type: "spki" });
  const secret = diffieHellman({ privateKey: keys.privateKey, publicKey: ephemeral });
  const aad = Buffer.from(`V2EchoPushContent/v2\n${wire.event_id}\n${wire.source_account_id}\n${device}\n${binding}\n${recipient.key_id}`);
  const aes = Buffer.from(hkdfSync("sha256", secret, createHash("sha256").update(publicBytes).digest(), aad, 32));
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", aes, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
  const raw = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  const length = raw.readUInt16BE(0);
  return { title: raw.subarray(2, 2 + length).toString(), body: raw.subarray(2 + length).toString() };
}

beforeAll(async () => {
  const bundle = await build({ entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false,
    format: "esm", target: "es2022", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-19", d1Databases: ["DB"], bindings: {
      ADMIN_TOKEN: admin, NOTIFIER_KEY: "ab".repeat(32), V2EX_COOKIE: "A2=synthetic", V2EX_PAT: "synthetic-pat",
    }, outboundService: async request => {
      apiCalls.push({ url: request.url, headers: Object.fromEntries(request.headers), body: request.method === "GET" ? null : await request.json() });
      const response = apiResponses.shift();
      if (!response) return Response.json({ error: "unexpected outbound request" }, { status: 500 });
      if (response.receiptStatus) response.body = { retry_after_seconds: 30,
        receipts: apiCalls.at(-1)!.body.events.map((event: any) => ({ event_id: event.event_id, status: response.receiptStatus })) };
      return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body), { status: response.status ?? 200 });
    } }));
  db = await mf.getD1Database("DB");
  migrations = await Promise.all((await readdir("migrations")).sort().map(async file =>
    (await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " ")));
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results;
  for (const { name } of tables) await db.exec(`DROP TABLE ${name}`);
  for (const migration of migrations) await db.exec(migration);
  now = Date.now() + 1000; apiCalls = []; apiResponses = [];
  const verified = await call("/action", { action: "verify", now, responses: [profile(), { body: home() }] });
  expect(verified.error).toBeUndefined();
  const sender = (await call("/seal", { purpose: `sender:${binding}`, value: "synthetic-sender" })).result;
  await db.prepare("UPDATE notifier SET enabled=1,binding_id=?,sender_enc=?,check_start_hour=0,check_end_hour=24 WHERE id=1").bind(binding, sender).run();
  config = { config_owner: "assistant", profile_id: binding, assistant_id: assistant, source_account_id: 7,
    source_generation: 1, revision: 1, max_topics: 20, following: { enabled: true, epoch: 1, enabled_at: Math.floor(now / 1000) },
    topics: [{ topic_id: 8, enabled: true, epoch: 1, enabled_at: Math.floor(now / 1000) }], applied_revision: 1,
    recipient_count: 1, capable_recipient_count: 1, last_seen: 0, last_checked: 0, runtime_status: "ready" };
  await saveConfig();
  await db.prepare("INSERT INTO watch_targets(notifier_id,target_key,topic_id,epoch,enabled_at,state_enc,next_check) VALUES(1,'following',0,1,?,'',?),(1,'topic:8',8,1,?,'',?)")
    .bind(now, now + 600000, now, now + 600000).run();
  await saveFeed();
});

describe("real watch test samples", () => {
  it("uses the first eligible current member-feed row without network or changing scan state", async () => {
    await saveFeed({ member_feed: { observed_at: now, topics: [
      { id: 1, author: "tester", title: "自己", reply_count: 0 }, { id: 2, author: "removed", title: "已取消关注", reply_count: 0 },
      { id: 42, author: "Writer", title: "真实关注主题", reply_count: 5, avatar_url: "https://cdn.v2ex.com/avatar/writer.png" },
      { id: 43, author: "writer", title: "后续主题", reply_count: 0 },
    ] } });
    const before = await scannedState(), result = await queue("following_topic");
    expect(result.error).toBeUndefined(); expect(result.calls).toEqual([]);
    expect(result.result).toMatchObject({ sample_source: "real", sample_origin: "cache", source_topic_id: 42 });
    expect(await scannedState()).toEqual(before);
    const [row] = await rows();
    expect(row).toMatchObject({ type: "test", kind: "following_topic", account_id: 7, notification_id: null, unread: 0,
      avatar_url: "https://cdn.v2ex.com/avatar/writer.png", status: "pending", attempts: 0 });
    expect(row.expires_at - row.created_at).toBe(900000);
    expect(JSON.parse(row.watch_meta)).toEqual({ profile_id: binding, source_generation: 1, watch_kind: "following_topic", watch_epoch: 1, topic_id: 42 });
    expect(await body(row.event_id)).toEqual({ title: "Writer 发布了新主题", body: "《真实关注主题》" });
    expect(row.content_enc).not.toContain("真实关注主题");
  });

  it("accepts the current scan membership snapshot without requiring a six-hour network check for cached data", async () => {
    await saveFeed({ members: {}, scan: { members: { writer: now } } });
    await db.prepare("UPDATE notifier SET verified_at=? WHERE id=1").bind(now - 7 * 3600000).run();
    const result = await queue("following_topic");
    expect(result.error).toBeUndefined(); expect(result.calls).toEqual([]);
    expect(result.result.source_topic_id).toBe(42);
  });

  it.each([
    ["missing feed", { member_feed: undefined }], ["empty feed", { member_feed: { observed_at: 1, topics: [] } }],
    ["non-followed author", { members: { other: 1 } }],
    ["own topic", { members: { tester: 1 }, member_feed: { observed_at: 1, topics: [{ id: 1, author: "tester", title: "mine", reply_count: 0 }] } }],
  ])("reports %s without synthetic content or remote fallback", async (_, state) => {
    await saveFeed(state); const result = await queue("following_topic");
    expect(result.error).toBeTruthy(); expect(result.calls).toEqual([]); expect(await rows()).toEqual([]);
  });

  it("uses the latest real non-self comment, including body and commenter avatar", async () => {
    const before = await scannedState();
    const result = await queue("topic_reply", [{ body: replies() }]);
    expect(result.error).toBeUndefined(); expect(paths(result)).toEqual(["/t/8?p=1"]);
    expect(result.result).toMatchObject({ sample_source: "real", sample_origin: "live", source_topic_id: 8, source_reply_id: 102 });
    expect(result.calls[0].headers.cookie).toBe("A2=synthetic"); expect(result.calls[0].headers.authorization).toBeUndefined();
    const [row] = await rows();
    expect(row).toMatchObject({ type: "test", kind: "topic_reply", notification_id: null, unread: 0,
      avatar_url: "https://cdn.v2ex.com/avatar/reader.png" });
    expect(JSON.parse(row.watch_meta)).toMatchObject({ watch_kind: "topic_reply", topic_id: 8, reply_id: 102, reply_floor: 2 });
    expect(await body(row.event_id)).toEqual({ title: "reader 回复了《主题 8》", body: "最近评论 [图片]" });
    expect(await scannedState()).toEqual(before);
  });

  it("collects at most three latest non-self comments using the tail and one preceding page", async () => {
    const created = now - 86400000;
    const result = await queue("topic_replies", [
      { body: topicHTML(8, created, [{ id: 1 }], 5) },
      { body: topicHTML(8, created, [{ id: 101, floor: 5 }, { id: 102, floor: 6, author: "tester" }], 5, "writer", 5) },
      { body: topicHTML(8, created, [{ id: 97, floor: 2 }, { id: 98, floor: 3 }, { id: 99, floor: 4 }], 5, "writer", 4) },
    ]);
    expect(result.error).toBeUndefined(); expect(paths(result)).toEqual(["/t/8?p=1", "/t/8?p=5", "/t/8?p=4"]);
    const [row] = await rows();
    expect(row.kind).toBe("topic_replies");
    expect(await body(row.event_id)).toEqual({ title: "新增了 3 条评论", body: "《主题 8》" });
    expect(row.avatar_url).toBe("https://cdn.v2ex.com/avatar/writer.png");
    const meta = JSON.parse(row.watch_meta);
    expect(meta).toMatchObject({ watch_kind: "topic_reply", topic_id: 8 });
    expect(meta.reply_id).toBe(98);
    expect(meta.reply_floor).toBe(3);
  });

  it.each(["topic_reply", "topic_replies"] as const)("does not invent %s samples when there are too few comments", async kind => {
    const result = await queue(kind, [{ body: topicHTML(8, now - 86400000,
      kind === "topic_reply" ? [{ id: 100, author: "tester" }] : [{ id: 100, author: "reader" }]) }]);
    expect(result.error).toBeTruthy(); expect(await rows()).toEqual([]);
    expect(paths(result)).toEqual(["/t/8?p=1"]);
  });

  it("revalidates expired live identity and refuses a different credential owner", async () => {
    now += 61000;
    await db.prepare("UPDATE notifier SET verified_at=? WHERE id=1").bind(now - 7 * 3600000).run();
    const result = await queue("topic_reply", [profile(8, "other"), { body: home("other") }, { body: replies() }]);
    expect(result.error).toBeTruthy(); expect(result.block).toBe("credentials"); expect(await rows()).toEqual([]);
    expect(paths(result)).not.toContain("/t/8?p=1");
  });

  it("checks changed credentials before using a cached following sample", async () => {
    now += 61000;
    await db.exec("UPDATE notifier SET credential_scope='stale' WHERE id=1");
    const result = await queue("following_topic", [profile(), { body: home() }]);
    expect(result.error).toBeUndefined(); expect(paths(result)).toEqual(["/api/v2/member", "/"]);
  });

  it.each(["expired live identity", "changed cached credentials"])("keeps the existing credential-bound scan contract for %s", async scenario => {
    now += 61000;
    await db.prepare("UPDATE notifier SET unread=9,observed_at=?,last_scan=?,scan_stage='collect',scan_id='active-scan',scan_collected=1,scan_page=2,scan_min=60,scan_head='[70]',verified_at=?,credential_scope=CASE WHEN ?=1 THEN 'changed' ELSE credential_scope END WHERE id=1")
      .bind(now - 120000, now - 180000, now - 7 * 3600000, Number(scenario === "changed cached credentials")).run();
    await db.exec("INSERT INTO notification_candidates(notifier_id,scan_id,notification_id,content_enc,kind,avatar_url) VALUES(1,'active-scan',70,'saved-candidate','reply',''); INSERT INTO unread_items(notifier_id,snapshot_id,notification_id,kind,content_enc) VALUES(1,'existing-snapshot',60,'reply','saved-unread')");
    const before = await scannedState();
    const live = scenario === "expired live identity";
    const result = await queue(live ? "topic_reply" : "following_topic", [profile(), { body: home() }, ...(live ? [{ body: replies() }] : [])]);
    expect(result.error).toBeUndefined();
    if (live) expect(await scannedState()).toEqual(before);
    else {
      // A changed Cookie/PAT scope already invalidates the old unread candidates.
      // Test sampling must preserve that boundary, while leaving watch scans alone.
      const after = await scannedState();
      expect(after.notifier).toMatchObject({ unread: 0, scan_stage: "idle", scan_id: "", scan_collected: 0 });
      expect(after.notification_candidates).toEqual([]);
      for (const table of ["watch_targets", "unread_items", "notification_checks", "notification_dedup", "notification_history", "notification_samples", "watch_dedup"])
        expect(after[table]).toEqual(before[table]);
    }
  });

  it.each(["disabled", "wrong account", "wrong binding", "no capable device"])("rejects %s before fetching a sample", async mode => {
    if (mode === "disabled") { config.following.enabled = false; config.topics[0].enabled = false; }
    if (mode === "wrong account") config.source_account_id = 8;
    if (mode === "wrong binding") config.profile_id = secondBinding;
    if (mode === "no capable device") config.capable_recipient_count = 0;
    await saveConfig();
    for (const kind of ["following_topic", "topic_reply", "topic_replies"] as const) {
      const result = await queue(kind); expect(result.error).toBeTruthy(); expect(result.calls).toEqual([]);
    }
    expect(await rows()).toEqual([]);
  });

  it("uses random test IDs and shares the existing one-minute test rate limit", async () => {
    const first = await queue("following_topic"); expect(first.error).toBeUndefined();
    const blocked = await queue("topic_reply", [{ body: replies() }]);
    expect(blocked.error).toContain("频率"); expect(blocked.calls).toEqual([]);
    now += 61000;
    const second = await queue("following_topic"); expect(second.error).toBeUndefined();
    expect(second.result.event_id).not.toBe(first.result.event_id);
    expect(await rows()).toHaveLength(2);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_dedup").first())).toEqual({ n: 0 });
  });
});

describe("watch test relay and API", () => {
  it.each(["following_topic", "topic_reply", "topic_replies"] as const)("sends %s as encrypted test JSON with watch routing and no badge", async kind => {
    const created = await queue(kind, kind === "following_topic" ? [] : [{ body: replies() }]);
    expect(created.error).toBeUndefined();
    const result = await relay([{ body: health }, directory, { receiptStatus: "pending" }]);
    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(["/api/push/v1/health", "/api/push/v1/recipient-keys?purpose=watch", "/api/push/v1/sync"]);
    const wire = result.calls.at(-1).body.events[0];
    expect(wire).toMatchObject({ event_id: created.result.event_id, type: "test", test_kind: kind,
      source_account_id: 7, body_encryption: 2, profile_id: binding, source_generation: 1, watch_epoch: 1,
      watch_kind: kind === "following_topic" ? "following_topic" : "topic_reply", topic_id: kind === "following_topic" ? 42 : 8 });
    expect(wire.notification_id).toBeUndefined(); expect(wire.unread_count).toBeUndefined();
    expect(wire.title).toBeUndefined(); expect(wire.body).toBeUndefined();
    expect(wire.avatar_url).toBe(`https://cdn.v2ex.com/avatar/${kind === "topic_reply" ? "reader" : "writer"}.png`);
    expect(decrypt(wire)).toEqual(await body(created.result.event_id));
    await validateCentralEvent(JSON.parse(JSON.stringify(wire)), now);
    const apns = await buildCentralApnsPayload({ id: device, binding_id: binding, username: "tester" }, wire, now);
    if (apns) {
      expect(apns).toMatchObject({ kind: "watch_update", topic_id: wire.topic_id,
        source_account_id: 7, username: "tester", avatar_url: wire.avatar_url });
      expect(apns.aps.badge).toBeUndefined(); expect(apns.notification_id).toBeUndefined();
    }
    expect((await rows())[0]).toMatchObject({ status: "submitted", attempts: 1 });
  });

  it.each(["watch_test_notifications", "watch_notifications", "watch_comment_details", "notification_body_encryption"])("waits when the service lacks %s", async capability => {
    const created = await queue("topic_reply", [{ body: replies() }]); expect(created.error).toBeUndefined();
    const old = { ...health, [capability]: capability === "notification_body_encryption" ? 1 : 0 };
    const result = await relay([{ body: old }]); expect(paths(result)).toEqual(["/api/push/v1/health"]);
    const [row] = await rows(); expect(row).toMatchObject({ status: "pending", attempts: 0, wire: null });
  });

  it("does not downgrade an empty watch recipient list to personal delivery", async () => {
    await queue("following_topic");
    const result = await relay([{ body: health }, { body: { source_account_id: 7, recipients: [] } }]);
    expect(result.error).toBeTruthy(); expect(paths(result)).toEqual(["/api/push/v1/health", "/api/push/v1/recipient-keys?purpose=watch"]);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0, wire: null });
  });

  it("cancels unattempted tests after their watch rule is disabled", async () => {
    await queue("following_topic"); config.following.enabled = false; await saveConfig();
    const result = await relay([]); expect(result.error).toBeUndefined(); expect(result.calls).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "cancelled", attempts: 0, wire: null });
  });

  it("keeps uncertain test wire immutable and queries a submitted receipt without resending", async () => {
    const created = await queue("following_topic");
    await relay([{ body: health }, directory, { error: true }]);
    const [uncertain] = await rows(); expect(uncertain.attempts).toBe(1); expect(uncertain.wire).toBeTruthy();
    now += 180000;
    const retry = await relay([{ body: health }, { receiptStatus: "pending" }]);
    expect(retry.error).toBeUndefined(); expect(retry.calls.at(-1).body.events).toEqual([JSON.parse(uncertain.wire)]);
    now += 180000;
    const receipt = await relay([{ receiptStatus: "apns_accepted" }]);
    expect(receipt.error).toBeUndefined(); expect(receipt.calls).toHaveLength(1);
    expect(receipt.calls[0].body).toMatchObject({ events: [], receipts: [created.result.event_id] });
    expect((await rows())[0].status).toBe("apns_accepted"); expect(await rows()).toHaveLength(1);
  });

  it("omits an unavailable real avatar rather than synthesizing one", async () => {
    const sample = replies().replace('src="https://cdn.v2ex.com/avatar/reader.png"', 'src="https://foreign.example/avatar.png"');
    await queue("topic_reply", [{ body: sample }]);
    const result = await relay([{ body: health }, directory, { receiptStatus: "pending" }]);
    expect(result.error).toBeUndefined(); expect(result.calls.at(-1).body.events[0].avatar_url).toBe("");
    const apns = await buildCentralApnsPayload(
      { id: device, binding_id: binding, username: "tester" },
      result.calls.at(-1).body.events[0],
      now,
    );
    if (apns) expect(apns.avatar_url).toBeUndefined();
    expect(result.calls).toHaveLength(3);
  });

  it("accepts the new kind through the authenticated account API and immediately relays only that test", async () => {
    apiResponses = [{ body: health }, directory, { receiptStatus: "pending" }];
    const before = await scannedState();
    const response = await request("/accounts/1/notifier/test", { kind: "following_topic" });
    const result = await response.json<any>();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ sample_source: "real", sample_origin: "cache", source_topic_id: 42, delivery_status: "submitted" });
    expect(apiCalls.map(call => new URL(call.url).pathname)).toEqual(["/api/push/v1/health", "/api/push/v1/recipient-keys", "/api/push/v1/sync"]);
    expect(apiCalls.at(-1)!.body.events).toHaveLength(1);
    expect(apiCalls.at(-1)!.body.events[0]).toMatchObject({ event_id: result.event_id, type: "test", test_kind: "following_topic" });
    expect(await scannedState()).toEqual(before);
  });

  it("keeps cached samples, encryption scopes and the rate limit isolated by account", async () => {
    apiResponses = [profile(8, "other"), { body: home("other") }];
    const response = await request("/accounts", { cookie: "A2=other", pat: "other-pat" });
    expect(response.status).toBe(200);
    const secondID = (await response.json<any>()).id;
    const sender = (await call("/seal", { purpose: `sender:${secondBinding}`, value: "second-sender" })).result;
    await db.prepare("UPDATE notifier SET enabled=1,binding_id=?,sender_enc=? WHERE id=?").bind(secondBinding, sender, secondID).run();
    await saveConfig({ ...config, profile_id: secondBinding, source_account_id: 8 }, secondID);
    await db.prepare("INSERT INTO watch_targets(notifier_id,target_key,topic_id,epoch,enabled_at) VALUES(?,'following',0,1,?)").bind(secondID, now).run();
    await saveFeed({ member_feed: { observed_at: now, topics: [{ id: 81, author: "writer", title: "第二账号私有主题", reply_count: 0 }] } }, secondID, 8);
    const first = await queue("following_topic"), second = await queue("following_topic", [], secondID);
    expect(first.error).toBeUndefined(); expect(second.error).toBeUndefined();
    expect(second.result.source_topic_id).toBe(81); expect(second.result.event_id).not.toBe(first.result.event_id);
    expect(await body(second.result.event_id, secondID)).toEqual({ title: "writer 发布了新主题", body: "《第二账号私有主题》" });
    expect((await call("/content", { id: second.result.event_id, accountID: 1 })).error).toBeTruthy();
    const saved = (await rows()).find(row => row.account_id === 8);
    const wrongScope = await call("/open", { purpose: `notification:7:${saved.event_id}`, value: saved.content_enc });
    expect(wrongScope.error).toBeTruthy();
    expect((await rows()).map(row => row.account_id).sort()).toEqual([7, 8]);
  });
});
