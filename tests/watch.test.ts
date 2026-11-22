import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { validateCentralEvent } from "./central-push";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import { followingHTML, membersFeedHTML, topicHTML } from "./watch-fixtures";
import type { WatchConfig } from "../shared/watch-contracts";

let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>, now: number;
const binding = "11111111-1111-4111-8111-111111111111", assistant = "22222222-2222-4222-8222-222222222222";
const key = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const recipient = { device_id: "33333333-3333-4333-8333-333333333333", binding_id: binding,
  public_key: key.toString("base64url"), key_id: createHash("sha256").update(key).digest("hex") };
const health = { watch_notifications: 1, watch_direct: 1, notifier_explicit_pairing: 1, watch_comment_details: 1, notification_details: 1, notification_body_encryption: 2,
  notification_routing: 1, notification_test_samples: 1, max_events: 20, max_receipts: 50, max_sync_bytes: 65536, sync_interval: 30 };
let config: WatchConfig;
async function call(path: string, data: unknown = {}) {
  const result: any = await mf.dispatchFetch(`http://local${path}`, { method: "POST", body: JSON.stringify(data) }).then(r => r.json());
  const requested = paths(result);
  expect(requested.filter((value: string) => value.startsWith("/my/following") && value !== "/my/following?p=1")).toEqual([]);
  if (path === "/watch") expect(result.calls.length).toBeLessThanOrEqual(3);
  return result;
}
async function run(...pages: string[]) {
  const result = await call("/watch", { now, responses: pages.map(body => ({ body })) });
  expect(result.error).toBeUndefined(); return result;
}
async function events() { return (await db.prepare("SELECT * FROM notification_outbox ORDER BY created_at,event_id").all<any>()).results; }
async function due() { now += 600001; await db.exec("UPDATE watch_targets SET next_check=0"); }
async function resumeFollowing() { now += 60001; await db.exec("UPDATE watch_targets SET next_check=0"); }
async function followingState() {
  const target = await db.prepare("SELECT state_enc FROM watch_targets WHERE target_key='following'").first<any>();
  const opened = await call("/open", { purpose: "watch:7:following:1", value: target.state_enc });
  expect(opened.error).toBeUndefined();
  return opened.result;
}
async function saveFollowing(value: unknown) {
  const sealed = (await call("/seal", { purpose: "watch:7:following:1", value })).result;
  await db.prepare("UPDATE watch_targets SET state_enc=? WHERE target_key='following'").bind(sealed).run();
}
function paths(result: any) { return result.calls.map((value: any) => new URL(value.url).pathname + new URL(value.url).search); }
async function followingEventIDs() { return (await events()).map(row => JSON.parse(row.watch_meta).topic_id).sort((a, b) => a - b); }
async function enable(topic = 0) {
  const instance = (await call("/seal", { purpose: `watch-instance:${assistant}`, value: "synthetic-instance" })).result;
  await db.prepare("UPDATE assistant_instance SET assistant_id=?,instance_enc=?").bind(assistant, instance).run();
  config.following.enabled = !topic;
  config.topics = topic ? [{ topic_id: topic, enabled: true, epoch: 1, enabled_at: Math.floor(now / 1000) }] : [];
  await db.prepare("UPDATE watch_control SET explicit_pairing=1,config=?,published_binding=?,assistant_id=?,config_owner='assistant',ownership_committed=1 WHERE id=1").bind(JSON.stringify(config), binding, assistant).run();
  await db.prepare("INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at) VALUES(?,?,1,?)").bind(topic ? `topic:${topic}` : "following", topic, now).run();
}
beforeAll(async () => {
  const compiled = await build({ entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0]!.text,
    compatibilityDate: "2026-06-22", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    bindings: { ADMIN_TOKEN: "synthetic-admin".repeat(5), NOTIFIER_KEY: "ab".repeat(32), V2EX_COOKIE: "A2=synthetic", V2EX_PAT: "synthetic" } }));
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) await db.exec((await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "));
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  // Align to a whole second so wall-clock elapsed time inside Context.now
  // does not spuriously cross a 1-second truncation boundary mid-step.
  now = Math.floor(Date.now() / 1000) * 1000 + 2000;
  await db.exec("DELETE FROM notifier_credentials");
  await db.exec("DELETE FROM notification_checks; DELETE FROM watch_local_operations; DELETE FROM watch_app_clients; DELETE FROM watch_app_invitation; DELETE FROM watch_cancellations; DELETE FROM notifier_source_transfer; DELETE FROM watch_targets; DELETE FROM watch_dedup; DELETE FROM notification_outbox; DELETE FROM notification_key_pins; DELETE FROM notifier; INSERT INTO notifier(id) VALUES(1); UPDATE assistant_instance SET assistant_id='',instance_enc=''; UPDATE watch_control SET explicit_pairing=0,config='',assistant_id='',instance_enc='',published_binding='',next_sync=0,last_sync=0,error='',config_owner='central',ownership_committed=0,ownership_revision=0; UPDATE control SET lease='',lease_until=0,next_dispatch=0,web_until=0,api_until=0;");
  const verified = await call("/action", { action: "verify", now, responses: [
    { body: { success: true, result: { id: 7, username: "tester" } } },
    { body: '<a class="top" href="/member/tester">tester</a><div id="Rightbar"><a href="/notifications">0 unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/1">topic</a></span></div>' },
  ] });
  expect(verified.error).toBeUndefined();
  const sealed = (await call("/seal", { purpose: `sender:${binding}`, value: "test-sender" })).result;
  await db.prepare("UPDATE notifier SET enabled=1,binding_id=?,sender_enc=?,check_start_hour=0,check_end_hour=24 WHERE id=1").bind(binding, sealed).run();
  config = { config_owner: "assistant", profile_id: binding, assistant_id: assistant, source_account_id: 7, revision: 1, source_generation: 1, max_topics: 20,
    following: { enabled: false, epoch: 1, enabled_at: Math.floor(now / 1000) }, topics: [], applied_revision: 1,
    recipient_count: 1, capable_recipient_count: 1, last_seen: 0, last_checked: 0, runtime_status: "ready" };
});

async function checks() {
  return (await db.prepare("SELECT * FROM notification_checks WHERE source IN ('following_topic','topic_reply') ORDER BY started_at,id").all<any>()).results;
}

const refresh = (input: Record<string, unknown> = {}, responses: unknown[] = []) =>
  call("/action", { action: "watch/refresh", input, now, responses });
const memberList = (names = ["writer"]) => followingHTML([{ id: 999999, title: "Never a candidate" }], names, 406);
const pendingIDs = (state: any) => state.feed_monitor.pending.map((topic: any) => topic.id);
async function baseline(ids = [200], members = ["writer"]) {
  const result = await run(memberList(members), membersFeedHTML(ids.map(id => ({ id }))));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members"]);
  return (await followingState()).members.writer;
}

it("records a saved watch slice separately from the completed scan", async () => {
  await enable(8);
  await db.exec("UPDATE notifier SET topic_interval_minutes=60");
  await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due();
  const created = now - 100000;
  await run(topicHTML(8, created, [{ id: 10 }], 5), topicHTML(8, created, [{ id: 15, floor: 5 }], 5, "writer", 5), topicHTML(8, created, [{ id: 14, floor: 4 }], 5, "writer", 4));
  expect((await checks()).at(-1)).toMatchObject({ source: "topic_reply", outcome: "ok", stage_before: "idle", stage_after: "watch_scan", requests: 3 });
  expect((await checks()).at(-1).detail).toBe("帖子 #8 · 分页进度已保存，等待继续检查");
  const pending = await db.prepare("SELECT next_check FROM watch_targets").first<any>();
  expect(pending.next_check - now).toBeGreaterThanOrEqual(60000);
  expect(pending.next_check - now).toBeLessThan(65000);
  await due();
  await run(topicHTML(8, created, [{ id: 13, floor: 3 }], 5, "writer", 3), topicHTML(8, created, [{ id: 12, floor: 2 }], 5, "writer", 2), topicHTML(8, created, [{ id: 10 }, { id: 11 }], 5));
  expect((await checks()).at(-1)).toMatchObject({ outcome: "ok", stage_before: "watch_scan", stage_after: "idle", requests: 3 });
  expect((await checks()).at(-1).detail).toContain("新增 1 条关注推送");
  const completed = await db.prepare("SELECT next_check FROM watch_targets").first<any>();
  expect(completed.next_check - now).toBeGreaterThanOrEqual(3600000);
  expect(completed.next_check - now).toBeLessThan(3605000);
});

it("slows quiet topics at the existing thresholds and returns to the configured interval after new replies", async () => {
  await enable(8);
  await db.exec("UPDATE notifier SET topic_interval_minutes=15");
  const created = now - 100000;
  for (let quiet = 1; quiet <= 12; quiet++) {
    await run(topicHTML(8, created, [{ id: 10 }]));
    const target = await db.prepare("SELECT next_check,state_enc FROM watch_targets").first<any>();
    const state = (await call("/open", { purpose: "watch:7:topic:8:1", value: target.state_enc })).result;
    const minutes = quiet < 6 ? 15 : quiet < 12 ? 30 : 60;
    expect(state.quiet).toBe(quiet);
    expect(target.next_check - now).toBeGreaterThanOrEqual(minutes * 60000);
    expect(target.next_check - now).toBeLessThan(minutes * 60000 + 5000);
    now = target.next_check + 1;
  }
  await run(topicHTML(8, created, [{ id: 10 }, { id: 11 }]));
  const target = await db.prepare("SELECT next_check,state_enc FROM watch_targets").first<any>();
  expect((await call("/open", { purpose: "watch:7:topic:8:1", value: target.state_enc })).result.quiet).toBe(0);
  expect(target.next_check - now).toBeGreaterThanOrEqual(15 * 60000);
  expect(target.next_check - now).toBeLessThan(15 * 60000 + 5000);
  expect(await events()).toHaveLength(1);
}, 20000);

it.each([5, 11])("never shortens a one-hour topic interval when quiet count %i reaches its slowdown threshold", async (quiet) => {
  await enable(8);
  await db.exec("UPDATE notifier SET topic_interval_minutes=60");
  const saved = { high: 10, checked: now, quiet };
  const sealed = (await call("/seal", { purpose: "watch:7:topic:8:1", value: saved })).result;
  await db.prepare("UPDATE watch_targets SET state_enc=?").bind(sealed).run();
  await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  const target = await db.prepare("SELECT next_check FROM watch_targets").first<any>();
  expect(target.next_check - now).toBeGreaterThanOrEqual(3600000);
  expect(target.next_check - now).toBeLessThan(3605000);
});

it("records watch failures and cooldown waits without marking swallowed errors successful", async () => {
  await enable(8);
  await db.exec("UPDATE notifier SET topic_interval_minutes=60");
  await run(topicHTML(999, now - 100000));
  let rows = await checks();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: "topic_reply", outcome: "error", requests: 1 });
  expect(rows[0].detail).toBe(`帖子 #8 · ${(await db.prepare("SELECT error FROM watch_targets").first<any>()).error}`);
  const failed = await db.prepare("SELECT next_check FROM watch_targets").first<any>();
  expect(failed.next_check - now).toBeGreaterThanOrEqual(30000);
  expect(failed.next_check - now).toBeLessThan(35000);
  await due();
  await db.prepare("UPDATE control SET web_until=?").bind(now + 900000).run();
  await run();
  rows = await checks();
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ source: "topic_reply", outcome: "waiting", requests: 0, api_requests: 0, detail: expect.stringContaining("帖子 #8 · V2EX 网页请求已暂停") });
});

it("does not create watch history for absent targets, future targets, paused service or incapable devices", async () => {
  await run();
  await enable(8);
  await db.prepare("UPDATE watch_targets SET next_check=?").bind(now + 600000).run();
  await run();
  await db.exec("UPDATE watch_targets SET next_check=0; UPDATE notifier SET enabled=0");
  await run();
  await db.exec("UPDATE notifier SET enabled=1");
  config.capable_recipient_count = 0;
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  await run();
  expect(await checks()).toEqual([]);
});

it("keeps watch collection running when diagnostic inserts fail", async () => {
  await enable(8);
  await db.exec("CREATE TRIGGER reject_watch_check BEFORE INSERT ON notification_checks WHEN NEW.source='topic_reply' BEGIN SELECT RAISE(FAIL, 'synthetic diagnostic failure'); END");
  try {
    await run(topicHTML(8, now - 100000, [{ id: 10 }]));
    expect((await db.prepare("SELECT last_checked FROM watch_targets").first<any>()).last_checked).toBeGreaterThan(0);
    expect(await checks()).toEqual([]);
  } finally {
    await db.exec("DROP TRIGGER reject_watch_check");
  }
});

it("establishes reply baseline, detects same-count replacement and excludes the user's own comment", async () => {
  await enable(8);
  await run(topicHTML(8, now - 86400000, [{ id: 10 }, { id: 11 }]));
  expect(await events()).toHaveLength(0);
  await due(); await run(topicHTML(8, now - 86400000, [{ id: 12, author: "tester" }, { id: 13, author: "reader", body: '这是回复 <img src="https://example.test/image.png"> 的正文' }]));
  const rows = await events(); expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].watch_meta)).toMatchObject({ watch_kind: "topic_reply", reply_id: 13 });
  const content = (await call("/content", { id: rows[0].event_id })).result;
  expect(content).toEqual({ title: "reader 回复了《主题 8》", body: "这是回复 [图片] 的正文" });
  expect(rows[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/reader.png");
  await due(); await run(topicHTML(8, now - 86400000, [{ id: 12, author: "tester" }, { id: 13 }]));
  expect(await events()).toHaveLength(1);
});

it("persists a reverse page cursor and queues exactly once only after its full range is read", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); const created = now - 100000;
  await run(topicHTML(8, created, [{ id: 10 }], 5), topicHTML(8, created, [{ id: 15, floor: 5 }], 5, "writer", 5), topicHTML(8, created, [{ id: 14, floor: 4 }], 5, "writer", 4));
  expect(await events()).toHaveLength(0);
  await due(); await run(topicHTML(8, created, [{ id: 13, floor: 3 }], 5, "writer", 3), topicHTML(8, created, [{ id: 12, floor: 2 }], 5, "writer", 2), topicHTML(8, created, [{ id: 10 }, { id: 11 }], 5));
  expect(await events()).toHaveLength(1);
  expect(JSON.parse((await events())[0].watch_meta)).toMatchObject({ reply_id: 11, reply_floor: 2 });
  expect((await call("/content", { id: (await events())[0].event_id })).result).toEqual({ title: "新增了 5 条评论", body: "《主题 8》" });
  expect((await events())[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/writer.png");
});

it("retains the reply cursor when different page URLs return the same records", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); const created = now - 100000;
  await run(topicHTML(8, created, [{ id: 10 }], 3),
    topicHTML(8, created, [{ id: 13, floor: 4 }], 3, "writer", 3),
    topicHTML(8, created, [{ id: 13, floor: 4 }], 3, "writer", 2));
  expect(await events()).toHaveLength(0);
  expect((await db.prepare("SELECT error FROM watch_targets").first<any>()).error).toContain("分页重复");
  await due(); await run(topicHTML(8, created, [{ id: 12, floor: 3 }], 3, "writer", 2),
    topicHTML(8, created, [{ id: 10 }, { id: 11 }], 3));
  expect(await events()).toHaveLength(1);
  expect((await call("/content", { id: (await events())[0].event_id })).result.title).toBe("新增了 3 条评论");
});

it("retains progress on a failed page, isolates failure by target and resets after a day offline", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); await run(topicHTML(999, now - 100000));
  expect((await db.prepare("SELECT failures FROM watch_targets").first<any>()).failures).toBe(1);
  now += 86400001; await run(topicHTML(8, now - 100000, [{ id: 200 }]));
  expect(await events()).toHaveLength(0);
});

it("rolls back stale-holder updates, dedup and outbox together", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due();
  const result = await call("/watch", { now, responses: [{ body: topicHTML(8, now - 100000, [{ id: 10 }, { id: 11 }]), replaceLease: true }] });
  expect(result.error).toBeTruthy(); expect(await events()).toHaveLength(0);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_dedup").first<any>()).n).toBe(0);
});

it("reuses immutable watch ciphertext after a lost response and omits unread/notification fields", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); await run(topicHTML(8, now - 100000, [{ id: 10 }, { id: 11 }]));
  let result = await call("/relay", { now, responses: [{ body: health }, { body: { source_account_id: 7, recipients: [recipient] } }, { error: true }] });
  expect(result.error).toBeTruthy();
  const row = (await events())[0], wire = JSON.parse(row.wire);
  expect(wire.type).toBe("watch_update"); expect(wire.notification_id).toBeUndefined(); expect(wire.unread_count).toBeUndefined();
  await validateCentralEvent(wire, now);
  expect(result.calls[1].url).toContain("purpose=watch");
  now += 3600000;
  result = await call("/relay", { now, responses: [{ body: health }, { receiptStatus: "pending" }] });
  expect(result.error).toBeUndefined(); expect(result.calls[1].body.events[0]).toEqual(wire);
  expect((await events())[0].wire).toBe(row.wire);
});

it("waits for comment presentation capability before preparing a new event, then retains its first reply and avatar", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); await run(topicHTML(8, now - 100000, [{ id: 10 }, { id: 11, floor: 2 }]));
  const waiting = await call("/relay", { now, responses: [{ body: { ...health, watch_comment_details: 0 } }] });
  expect(waiting.error).toBeUndefined(); expect(waiting.calls).toHaveLength(1);
  expect((await events())[0]).toMatchObject({ wire: null, status: "pending", attempts: 0 });
  now += 600000;
  const sent = await call("/relay", { now, responses: [{ body: health }, { body: { source_account_id: 7, recipients: [recipient] } }, { receiptStatus: "pending" }] });
  expect(sent.error).toBeUndefined();
  expect(sent.calls).toHaveLength(3);
  const wire = JSON.parse((await events())[0].wire);
  expect(wire).toMatchObject({ reply_id: 11, reply_floor: 2, avatar_url: "https://cdn.v2ex.com/avatar/reader.png" });
  expect(wire.title).toBeUndefined(); expect(wire.body).toBeUndefined();
});

it("cancels a not-yet-sent watch event when its rule is disabled", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); await run(topicHTML(8, now - 100000, [{ id: 10 }, { id: 11 }]));
  config.topics[0]!.enabled = false;
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  const result = await call("/relay", { now });
  expect(result.error).toBeUndefined(); expect(result.calls).toHaveLength(0); expect((await events())[0].status).toBe("cancelled");
});

it("imports frozen legacy rules atomically and sends no rules or target state after handoff", async () => {
  await enable(8);
  await db.exec("UPDATE watch_control SET config_owner='central',ownership_committed=0");
  config.revision = 2; config.topics[0]!.epoch = 2;
  let result = await call("/watch-sync", { now, responses: [
    { body: { ...config, config_owner: "handoff", legacy_config: { ...config, config_owner: "handoff" } } }, { body: config },
  ] });
  expect(result.error).toBeUndefined();
  expect((await db.prepare("SELECT epoch FROM watch_targets").first<any>()).epoch).toBe(2);
  expect(result.calls[0].body).toEqual({ phase: "prepare" });
  expect(result.calls[1].body).toEqual({ phase: "commit", source_generation: 1, revision: 2 });
  expect(result.result.applied_revision).toBe(2);
  result = await call("/watch-sync", { now, responses: [{ body: config }] });
  expect(result.error).toBeUndefined(); expect(result.calls).toHaveLength(1);
  expect(result.calls[0].url).toContain("/v1/watches/source"); expect(result.calls[0].body).toBeNull();
  const prior = await db.prepare("SELECT config FROM watch_control").first<any>();
  result = await call("/watch-sync", { now, responses: [{ body: { ...config, source_account_id: 8 } }] });
  expect(result.error).toBeTruthy(); expect(await db.prepare("SELECT config FROM watch_control").first<any>()).toEqual(prior);
});


it("synchronizes control while paused and outside the scan window without fetching V2EX", async () => {
  await enable(8);
  await db.exec("UPDATE notifier SET enabled=0,check_start_hour=0,check_end_hour=1; UPDATE control SET web_until=9999999999999,api_until=9999999999999");
  const result = await call("/round", { now, responses: [{ body: config }] });
  expect(result.error).toBeUndefined(); expect(result.calls).toHaveLength(1);
  expect(result.calls[0].url).toContain("/v1/watches/source");
  expect(result.calls[0].body).toBeNull();
  expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_targets").first<any>()).n).toBe(1);
});

it("global pause cancels local watch backlog and resumes with a fresh baseline", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); await run(topicHTML(8, now - 100000, [{ id: 10 }, { id: 11 }]));
  expect(await events()).toHaveLength(1);
  let result = await call("/action", { action: "config", input: { enabled: false }, now });
  expect(result.error).toBeUndefined(); expect((await events())[0].status).toBe("cancelled");
  expect((await db.prepare("SELECT state_enc FROM watch_targets").first<any>()).state_enc).toBe("");
  result = await call("/action", { action: "config", input: { enabled: true }, now });
  expect(result.error).toBeUndefined();
  await due(); await run(topicHTML(8, now - 100000, [{ id: 11 }, { id: 12 }]));
  expect(await events()).toHaveLength(1);
});

it("persists source-transfer secrets before a lost response and recovers the same group without another pairing", async () => {
  await db.exec("UPDATE notifier SET binding_id='',sender_enc='',enabled=0");
  let result = await call("/action", { action: "transfer", now, responses: [{ error: true }] });
  expect(result.error).toBeTruthy();
  const first = result.calls[0];
  expect(first.url).toContain("/v1/source-transfers");
  expect(first.body.code).toMatch(/^V2T-/);
  now += 31000;
  result = await call("/action", { action: "transfer", now,
    responses: [{ body: { expires_at: new Date(now + 500000).toISOString() } }] });
  expect(result.error).toBeUndefined(); expect(result.calls[0].body).toEqual(first.body);
  const code = result.result.code;
  result = await call("/action", { action: "transfer/complete", input: { code }, now,
    responses: [{ body: { paired: true, binding_id: binding, username: "tester", transferred: true } }] });
  expect(result.error).toBeUndefined(); expect(result.result.paired).toBe(true);
  const state = await db.prepare("SELECT binding_id,sender_enc,enabled FROM notifier").first<any>();
  expect(state.binding_id).toBe(binding); expect(state.enabled).toBe(0);
  expect((await call("/open", { purpose: `sender:${binding}`, value: state.sender_enc })).result).toBe(first.body.sender_token);
  result = await call("/action", { action: "transfer/complete", input: { code }, now });
  expect(result.error).toBeUndefined(); expect(result.calls).toHaveLength(0);
});

it("keeps the new instance unpaired when the transfer receipt belongs to another account", async () => {
  await db.exec("UPDATE notifier SET binding_id='',sender_enc='',enabled=0");
  const invitation = await call("/action", { action: "transfer", now,
    responses: [{ body: { expires_at: new Date(now + 500000).toISOString() } }] });
  expect(invitation.error).toBeUndefined();
  const result = await call("/action", { action: "transfer/complete", input: { code: invitation.result.code }, now,
    responses: [{ body: { paired: true, binding_id: binding, username: "other" } }] });
  expect(result.error).toBeTruthy();
  expect((await db.prepare("SELECT binding_id FROM notifier").first<any>()).binding_id).toBe("");
});


it("gives other due targets a turn after a failure in a full twenty-topic profile", async () => {
  await enable(1);
  config.topics = Array.from({ length: 20 }, (_, i) => ({ topic_id: i + 1, enabled: true, epoch: 1, enabled_at: Math.floor(now / 1000) }));
  await db.prepare("UPDATE watch_control SET config=? WHERE id=1").bind(JSON.stringify(config)).run();
  for (const topic of config.topics.slice(1)) await db.prepare("INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at) VALUES(?,?,1,?)")
    .bind(`topic:${String(topic.topic_id).padStart(2, "0")}`, topic.topic_id, now).run();
  // Select the first target explicitly; subsequent selection uses the production earliest-due ordering.
  await db.exec("UPDATE watch_targets SET next_check=1 WHERE topic_id<>1");
  await run(topicHTML(999, now - 100000));
  const result = await run(topicHTML(2, now - 100000, [{ id: 10 }]));
  expect(result.calls).toHaveLength(1); expect(result.calls[0].url).toContain("/t/2?");
  expect((await db.prepare("SELECT failures FROM watch_targets WHERE topic_id=1").first<any>()).failures).toBe(1);
  expect((await db.prepare("SELECT last_checked FROM watch_targets WHERE topic_id=2").first<any>()).last_checked).toBeGreaterThan(0);
});

it("counts more than 200 replies across pages while preserving the earliest target and avoiding a replay", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); const created = now - 100000;
  const page = (p: number) => topicHTML(8, created, Array.from({ length: 42 }, (_, i) => ({ id: (p - 1) * 42 + i + 11, floor: (p - 1) * 42 + i + 2 })), 5, "writer", p);
  await run(page(1), page(5), page(4));
  expect(await events()).toHaveLength(0);
  await due(); await run(page(3), page(2), page(1));
  const rows = await events(); expect(rows).toHaveLength(1);
  const meta = JSON.parse(rows[0].watch_meta);
  expect(meta).toMatchObject({ reply_id: 11, reply_floor: 2 });
  expect((await call("/content", { id: rows[0].event_id })).result).toEqual({ title: "新增了 210 条评论", body: "《主题 8》" });
  expect(rows[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/writer.png");
  await due(); await run(page(1), page(5));
  expect(await events()).toHaveLength(1);
});

it("rereads an old unfinished scan without losing its committed baseline or duplicating its new comments", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  const legacy = { high: 10, checked: now, quiet: 0, scan: { high: 12, before: 12, page: 1, started: now, title: "主题 8", replies: [{ id: 12, floor: 3, author: "reader", created: now }], overflow: false } };
  const sealed = (await call("/seal", { purpose: "watch:7:topic:8:1", value: legacy })).result;
  await db.prepare("UPDATE watch_targets SET state_enc=?").bind(sealed).run();
  await due(); const current = topicHTML(8, now - 100000, [{ id: 10 }, { id: 11 }, { id: 12 }]);
  await run(current);
  const rows = await events(); expect(rows).toHaveLength(1);
  expect((await call("/content", { id: rows[0].event_id })).result.title).toBe("新增了 2 条评论");
  expect(JSON.parse(rows[0].watch_meta)).toMatchObject({ reply_id: 11, reply_floor: 2 });
  await due(); await run(current); expect(await events()).toHaveLength(1);
});

it("shows saved rules before checking and keeps local receipt when acknowledgement fails", async () => {
  await enable(8);
  config.revision = 2; config.topics.push({ topic_id: 9, enabled: false, epoch: 2, enabled_at: Math.floor(now / 1000) });
  await db.exec("UPDATE watch_control SET config_owner='central',ownership_committed=0");
  const result = await call("/watch-sync", { now, responses: [{ body: { ...config, config_owner: "handoff", legacy_config: config } }, { error: true }] });
  expect(result.error).toBeTruthy();
  const state = (await call("/watch-state")).result;
  expect(state.config.topics).toHaveLength(2); expect(state.targets).toHaveLength(1);
  expect(state.config.revision).toBe(2); expect(state.config.applied_revision).toBe(2); expect(state.direct_ready).toBe(false);
  const retried = await call("/watch-sync", { now, responses: [{ body: config }] });
  expect(retried.error).toBeUndefined(); expect(retried.calls[0].body.phase).toBe("commit");
  expect((await call("/watch-state")).result.direct_ready).toBe(true);
  expect(state.error).toBeTruthy();
});

it("edits the shared rule from the console, stores it and acknowledges without fetching V2EX", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  await due(); await run(topicHTML(8, now - 100000, [{ id: 11 }]));
  const input = { operation_id: crypto.randomUUID(), profile_id: binding, source_generation: 1, base_revision: 1,
    action: "set_topic", topic_id: 8, enabled: false };
  const result = await call("/action", { action: "watch/config", input, now });
  expect(result.error).toBeUndefined(); expect(result.calls).toHaveLength(0);
  expect(result.result.operation_revision).toBe(2);
  expect((await events())[0].status).toBe("cancelled");
  const state = (await call("/watch-state")).result;
  expect(state.targets).toEqual([]); expect(state.config.topics[0].enabled).toBe(false);
  const stale = await call("/action", { action: "watch/config", input, now });
  expect(stale.error).toBeUndefined(); expect(stale.calls).toHaveLength(0); expect(stale.result.operation_revision).toBe(2);
});

it("reloads a concurrent App edit without replaying an obsolete console operation", async () => {
  await enable(8);
  const input = { operation_id: crypto.randomUUID(), profile_id: binding, source_generation: 1, base_revision: 1,
    action: "set_topic", topic_id: 8, enabled: true };
  const changed = { ...config, revision: 2, applied_revision: 2, topics: [] };
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(changed)).run();
  const result = await call("/action", { action: "watch/config", input, now });
  expect(result.error).toContain("规则已更新"); expect(result.calls).toHaveLength(0);
  expect((await call("/watch-state")).result.config.topics).toEqual([]);
});

it("provides the cached topic title and author avatar and separates both watch histories", async () => {
  await enable(8); await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  const cached = await call("/watch-state");
  expect(cached.calls).toEqual([]);
  expect(cached.result.targets[0]).toMatchObject({ title: "主题 8", author: "writer", avatar_url: "https://cdn.v2ex.com/avatar/writer.png" });
  await due(); await run(topicHTML(8, now - 100000, [{ id: 11 }]));
  const headers = { Authorization: "Bearer " + "synthetic-admin".repeat(5) };
  for (const kind of ["topic_reply", "following_topic"]) {
    const response = await mf.dispatchFetch(`http://local/api/notifier/records?view=deliveries&watch_kind=${kind}`, { headers });
    expect(response.status).toBe(200);
    const rows = await response.json<any>(); expect(rows.items).toHaveLength(kind === "topic_reply" ? 1 : 0);
  }
});

it("fills a legacy topic cache avatar on the next check without requiring new replies", async () => {
  await enable(8);
  const saved = (await call("/seal", { purpose: "watch:7:topic:8:1", value: {
    high: 10, checked: now - 1000, quiet: 0, title: "主题 8", author: "writer",
  } })).result;
  await db.prepare("UPDATE watch_targets SET state_enc=?").bind(saved).run();
  expect((await call("/watch-state")).result.targets[0].avatar_url).toBeUndefined();
  await run(topicHTML(8, now - 100000, [{ id: 10 }]));
  expect((await call("/watch-state")).result.targets[0].avatar_url).toBe("https://cdn.v2ex.com/avatar/writer.png");
  expect(await events()).toEqual([]);
});


it("manually refreshes every target despite routine schedules and a paused service without changing personal scan state", async () => {
  await enable(8);
  config.topics.push({ ...config.topics[0], topic_id: 9 });
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  await db.prepare("INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at) VALUES('topic:9',9,1,?)").bind(now).run();
  await db.prepare("UPDATE watch_targets SET next_check=?").bind(now + 3600000).run();
  await db.exec("UPDATE notifier SET enabled=0,check_start_hour=1,check_end_hour=2,scan_stage='page',scan_id='personal',scan_page=2,scan_collected=1");
  await db.exec("INSERT INTO notification_candidates(scan_id,notification_id,content_enc,kind,avatar_url) VALUES('personal',123,'encrypted','reply','')");
  const personal = await db.prepare("SELECT * FROM notifier").first();
  const candidates = await db.prepare("SELECT * FROM notification_candidates").all();
  const first = await refresh({}, [{ body: topicHTML(8, now - 100000, [{ id: 10 }]) }]);
  expect(first.error).toBeUndefined();
  expect(first.result).toMatchObject({ complete: false, remaining: 1, retry_at: 0 });
  expect(first.calls.map((value: any) => new URL(value.url).pathname)).toEqual(["/t/8"]);
  now += 1000;
  const second = await refresh({ started_at: first.result.started_at }, [{ body: topicHTML(9, now - 100000, [{ id: 20 }]) }]);
  expect(second.error).toBeUndefined();
  expect(second.result).toMatchObject({ complete: true, remaining: 0, retry_at: 0 });
  expect(second.calls.map((value: any) => new URL(value.url).pathname)).toEqual(["/t/9"]);
  expect(await db.prepare("SELECT * FROM notifier").first()).toEqual(personal);
  expect((await db.prepare("SELECT * FROM notification_candidates").all()).results).toEqual(candidates.results);
  expect(await events()).toEqual([]);
});

it("finishes old pagination before checking the latest head for the same manual refresh", async () => {
  await enable(8);
  const created = now - 100000;
  await run(topicHTML(8, created, [{ id: 10 }]));
  await due();
  await run(topicHTML(8, created, [{ id: 10 }], 5), topicHTML(8, created, [{ id: 15, floor: 5 }], 5, "writer", 5), topicHTML(8, created, [{ id: 14, floor: 4 }], 5, "writer", 4));
  now += 1000;
  const old = await refresh({}, [
    { body: topicHTML(8, created, [{ id: 13, floor: 3 }], 5, "writer", 3) },
    { body: topicHTML(8, created, [{ id: 12, floor: 2 }], 5, "writer", 2) },
    { body: topicHTML(8, created, [{ id: 10 }, { id: 11 }], 5) },
  ]);
  expect(old.error).toBeUndefined();
  expect(old.calls).toHaveLength(3);
  expect(old.result).toMatchObject({ complete: false, remaining: 1, retry_at: 0 });
  expect(await events()).toHaveLength(1);
  now += 1000;
  const latest = await refresh({ started_at: old.result.started_at }, [
    { body: topicHTML(8, created, [{ id: 10 }], 5) },
    { body: topicHTML(8, created, [{ id: 15, floor: 5 }], 5, "writer", 5) },
  ]);
  expect(latest.error).toBeUndefined();
  expect(latest.result).toMatchObject({ complete: true, remaining: 0 });
  expect(latest.calls[0].url).toContain("/t/8?p=1");
  expect(await events()).toHaveLength(1);
});

it("keeps failed targets in their retry wait instead of resetting them for a manual refresh", async () => {
  await enable(8);
  await db.prepare("UPDATE watch_targets SET failures=2,next_check=?,error='previous failure'").bind(now + 120000).run();
  const before = await db.prepare("SELECT * FROM watch_targets").first();
  const waiting = await refresh();
  expect(waiting.error).toBeUndefined();
  expect(waiting.calls).toEqual([]);
  expect(waiting.result).toMatchObject({ complete: false, remaining: 1, retry_at: now + 120000 });
  expect(await db.prepare("SELECT * FROM watch_targets").first()).toEqual(before);
  now += 120001;
  const resumed = await refresh({ started_at: waiting.result.started_at }, [{ body: topicHTML(8, now - 100000) }]);
  expect(resumed.error).toBeUndefined();
  expect(resumed.result.complete).toBe(true);
  expect(resumed.calls).toHaveLength(1);
});

it("respects V2EX webpage cooldown before selecting or modifying a manual-refresh target", async () => {
  await enable(8);
  await db.prepare("UPDATE control SET web_until=?").bind(now + 120000).run();
  const before = await db.prepare("SELECT * FROM watch_targets").first();
  const result = await refresh();
  expect(result.error).toContain("网页请求已暂停");
  expect(result.calls).toEqual([]);
  expect(await db.prepare("SELECT * FROM watch_targets").first()).toEqual(before);
});

it.each(["expired", "changed"])("uses the full verification contract for %s credentials before a manual refresh", async (scenario) => {
  await enable(8);
  await db.exec("UPDATE notifier SET scan_stage='page',scan_id='stale-personal',scan_collected=1,verify_until=0");
  await db.exec("INSERT INTO notification_candidates(scan_id,notification_id,content_enc,kind,avatar_url) VALUES('stale-personal',124,'encrypted','reply','')");
  if (scenario === "expired") await db.prepare("UPDATE notifier SET verified_at=?").bind(now - 7 * 3600000).run();
  else await db.exec("UPDATE notifier SET credential_scope='old-scope'");
  const result = await refresh({}, [
    { body: { success: true, result: { id: 7, username: "tester" } } },
    { body: '<a class="top" href="/member/tester">tester</a><div id="Rightbar"><a href="/notifications">0 unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/1">topic</a></span></div>' },
    { body: topicHTML(8, now - 100000) },
  ]);
  expect(result.error).toBeUndefined();
  expect(result.result.complete).toBe(true);
  expect(result.calls.map((value: any) => new URL(value.url).pathname)).toEqual(["/api/v2/member", "/", "/t/8"]);
  expect(await db.prepare("SELECT scan_stage,scan_id,scan_collected FROM notifier").first()).toEqual({ scan_stage: "idle", scan_id: "", scan_collected: 0 });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM notification_candidates").first()).toEqual({ n: 0 });
});

it.each(["pairing", "no device"])("does not silently skip manual refresh when %s blocks collection", async (problem) => {
  await enable(8);
  if (problem === "pairing") await db.exec("UPDATE notifier SET blocked='pairing'");
  else {
    config.capable_recipient_count = 0;
    await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  }
  const result = await refresh();
  expect(result.error).toMatch(/连接|设备/);
  expect(result.calls).toEqual([]);
});

it("builds the first baseline only from the members tab and never scans following history pages", async () => {
  await enable();
  const members = memberList().replace('href="/t/999999"', 'href="https://foreign.example/t/999999"');
  const result = await run(members, membersFeedHTML([{ id: 91 }, { id: 5 }, { id: 70 }]));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members"]);
  const state = await followingState();
  expect(state.seen).toEqual([91, 5, 70]);
  expect(state.seen).not.toContain(999999);
  expect(state.feed_monitor).toMatchObject({ baseline: false, pending: [] });
  expect(state.feed_monitor.scan).toBeUndefined();
  expect(state.incremental).toBeUndefined(); expect(state.scan).toBeUndefined();
  expect(state.member_feed.topics.map((topic: any) => topic.id)).toEqual([91, 5, 70]);
  expect(await events()).toEqual([]);
  expect((await db.prepare("SELECT checking,error FROM watch_targets").first<any>())).toEqual({ checking: 0, error: "" });
  expect((await checks()).at(-1)).toMatchObject({ source: "following_topic", outcome: "ok", stage_after: "idle", requests: 2, api_requests: 0 });
});

it("uses members-tab topics as candidates and verifies real author and creation time before notifying", async () => {
  await enable(); const since = await baseline(); await due();
  const feed = membersFeedHTML([{ id: 201, title: "Feed title" }, { id: 200 }]);
  const result = await run(memberList(), feed, topicHTML(201, since + 1000));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/201?p=1"]);
  expect(await followingEventIDs()).toEqual([201]);
  const event = (await events())[0];
  expect(JSON.parse(event.watch_meta)).toMatchObject({ watch_kind: "following_topic", topic_id: 201 });
  expect((await call("/content", { id: event.event_id })).result).toEqual({ title: "writer 发布了新主题", body: "《主题 201》" });
  expect((await followingState()).seen).not.toContain(999999);
  await due();
  expect(paths(await run(memberList(), feed))).toEqual(["/my/following?p=1", "/?tab=members"]);
  expect(await followingEventIDs()).toEqual([201]);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_dedup").first<any>()).n).toBe(1);
});

it("treats activity time only as a per-topic exclusion and keeps unsorted new candidates", async () => {
  await enable(); const since = await baseline(); await due();
  const result = await run(memberList(), membersFeedHTML([
    { id: 200 }, { id: 9999, updatedAt: since - 1000 }, { id: 3, updatedAt: since },
  ]), topicHTML(3, since));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/3?p=1"]);
  expect(await followingEventIDs()).toEqual([3]);
  expect((await followingState()).members.writer).toBe(since);
  expect((await followingState()).member_feed.topics.map((topic: any) => topic.id)).toEqual([200, 9999, 3]);
});

it("rejects bumped old topics and a new follow's history while accepting both members' new posts", async () => {
  await enable(); const since = await baseline(); await due();
  const followedAt = Math.floor(now / 1000) * 1000;
  const list = memberList(["writer", "newperson"]);
  const feed = membersFeedHTML([{ id: 100 }, { id: 201 }, { id: 300, author: "newperson" }, { id: 200 }]);
  await run(list, feed, topicHTML(100, since - 1000));
  expect(await events()).toEqual([]);
  await resumeFollowing();
  expect(paths(await run(topicHTML(201, since + 1000), topicHTML(300, followedAt - 1000, [], 1, "newperson"))))
    .toEqual(["/t/201?p=1", "/t/300?p=1"]);
  expect(await followingEventIDs()).toEqual([201]);
  expect((await followingState()).members.newperson).toBe(followedAt);
  await due();
  await run(list, membersFeedHTML([{ id: 301, author: "newperson" }, { id: 201 }]), topicHTML(301, followedAt + 1000, [], 1, "newperson"));
  expect(await followingEventIDs()).toEqual([201, 301]);
});

it("never notifies the account's own post even if the feed and membership contain that author", async () => {
  await enable();
  await run(memberList(["writer", "tester"]), membersFeedHTML([{ id: 200 }]));
  const since = (await followingState()).members.tester; await due();
  await run(memberList(["writer", "tester"]), membersFeedHTML([{ id: 201, author: "tester" }]), topicHTML(201, since + 1000, [], 1, "tester"));
  expect(await events()).toEqual([]);
});

it("does not accept a topic whose actual author differs from its members-feed author", async () => {
  await enable(); const since = await baseline(); await due();
  await run(memberList(), membersFeedHTML([{ id: 201 }]), topicHTML(201, since + 1000, [], 1, "impostor"));
  expect(await events()).toEqual([]);
  expect((await followingState()).seen).not.toContain(201);
  expect(pendingIDs(await followingState())).toEqual([201]);
  expect((await db.prepare("SELECT error FROM watch_targets").first<any>()).error).toContain("作者");
});

it("includes the same-second boundary and durable dedup survives loss of the bounded seen cache", async () => {
  await enable(); now = Math.floor(now / 1000) * 1000 + 100;
  const since = await baseline();
  expect(since).toBe(Math.floor(now / 1000) * 1000);
  await due();
  const feed = membersFeedHTML([{ id: 201, updatedAt: since }]);
  await run(memberList(), feed, topicHTML(201, since));
  expect(await followingEventIDs()).toEqual([201]);
  const state = await followingState(); state.seen = [];
  await saveFollowing(state); await due();
  await run(memberList(), feed, topicHTML(201, since));
  expect(await followingEventIDs()).toEqual([201]);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_dedup").first<any>()).n).toBe(1);
});

it("forgets an unfollowed member's cutoff and excludes the gap when they are followed again", async () => {
  await enable(); const since = await baseline(); await due();
  const gap = now;
  await run(memberList([]), membersFeedHTML([]));
  expect((await followingState()).members).toEqual({});
  await due(); const again = Math.floor(now / 1000) * 1000;
  await run(memberList(), membersFeedHTML([{ id: 201 }]), topicHTML(201, gap));
  expect(await events()).toEqual([]);
  expect((await followingState()).members.writer).toBe(again);
  expect(again).toBeGreaterThan(since);
  await due();
  await run(memberList(), membersFeedHTML([{ id: 202 }, { id: 201 }]), topicHTML(202, again + 1000));
  expect(await followingEventIDs()).toEqual([202]);
});

it("retains old member cutoffs across multiple days and excludes candidates removed from the membership", async () => {
  await enable(); const since = await baseline();
  now += 2 * 86400000; await db.exec("UPDATE watch_targets SET next_check=0");
  await run(memberList(), membersFeedHTML([{ id: 201 }]), topicHTML(201, since + 1000));
  expect(await followingEventIDs()).toEqual([201]);
  expect((await followingState()).members.writer).toBe(since);
  const state = await followingState();
  state.feed_monitor.pending = [{ id: 202, author: "writer", title: "old pending" }];
  // Force a stale source snapshot: beyond the longest configurable interval,
  // independent of the default following interval and worker clock drift.
  const stale = now - 3600001;
  state.feed_monitor.scan = { started: stale, phase: "candidates" };
  state.observed_at = stale;
  await saveFollowing(state); await due();
  expect(paths(await run(memberList([]), membersFeedHTML([])))).toEqual(["/my/following?p=1", "/?tab=members"]);
  expect(pendingIDs(await followingState())).toEqual([]);
  expect((await followingState()).seen).not.toContain(202);
});

it("bounds slices to three requests and schedules pending candidates at one minute then the configured interval", async () => {
  await enable(); const since = await baseline();
  await db.exec("UPDATE notifier SET following_interval_minutes=15"); await due();
  const result = await run(memberList(), membersFeedHTML([{ id: 201 }, { id: 202 }, { id: 203 }, { id: 204 }]), topicHTML(201, since + 1000));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/201?p=1"]);
  let target = await db.prepare("SELECT next_check,checking FROM watch_targets").first<any>();
  expect(target.checking).toBe(1);
  expect(target.next_check - now).toBeGreaterThanOrEqual(60000);
  expect(target.next_check - now).toBeLessThan(65000);
  const visible = (await call("/watch-state")).result.targets[0];
  expect(visible.progress).toEqual({ kind: "candidates", pending_topics: 3 });
  const dueAt = target.next_check; now = dueAt - 1000;
  expect((await run()).calls).toEqual([]);
  now = dueAt + 1;
  expect(paths(await run(...[202, 203, 204].map(id => topicHTML(id, since + 1000)))))
    .toEqual(["/t/202?p=1", "/t/203?p=1", "/t/204?p=1"]);
  target = await db.prepare("SELECT next_check,checking FROM watch_targets").first<any>();
  expect(target.checking).toBe(0);
  expect(target.next_check - now).toBeGreaterThanOrEqual(15 * 60000);
  expect(target.next_check - now).toBeLessThan(15 * 60000 + 5000);
  expect(await followingEventIDs()).toEqual([201, 202, 203, 204]);
});

it("refreshes due sources during a long candidate backlog and prioritizes new feed candidates without losing old ones", async () => {
  await enable(); const since = await baseline();
  await db.exec("UPDATE notifier SET following_interval_minutes=5"); await due();
  const state = await followingState();
  const pending = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, author: "writer", title: `pending ${i}` }));
  state.feed_monitor.pending = pending;
  state.feed_monitor.scan = { started: now - 300001, phase: "candidates" };
  await saveFollowing(state);
  const result = await run(memberList(), membersFeedHTML([{ id: 9999 }, { id: 1000 }, { id: 200 }]), topicHTML(9999, since + 1000));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/9999?p=1"]);
  expect(await followingEventIDs()).toEqual([9999]);
  expect(pendingIDs(await followingState())).toEqual(pending.map(topic => topic.id));
  await resumeFollowing();
  expect(paths(await run(...[1000, 1001, 1002].map(id => topicHTML(id, since + 1000)))))
    .toEqual(["/t/1000?p=1", "/t/1001?p=1", "/t/1002?p=1"]);
  expect(pendingIDs(await followingState())).toHaveLength(97);
});

it.each(["network", "malformed"])("rotates a %s detail failure without marking it seen or losing other pending topics", async failure => {
  await enable(); const since = await baseline(); await due();
  const bad = failure === "network" ? { error: true } : { body: topicHTML(999, since + 1000) };
  const result = await call("/watch", { now, responses: [{ body: memberList() }, { body: membersFeedHTML([{ id: 201 }, { id: 202 }]) }, bad] });
  expect(result.error).toBeUndefined();
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/201?p=1"]);
  expect(pendingIDs(await followingState())).toEqual([202, 201]);
  expect((await followingState()).seen).not.toContain(201);
  expect((await db.prepare("SELECT failures FROM watch_targets").first<any>()).failures).toBe(1);
  await resumeFollowing();
  expect(paths(await run(topicHTML(202, since + 1000), topicHTML(201, since + 1000)))).toEqual(["/t/202?p=1", "/t/201?p=1"]);
  expect(await followingEventIDs()).toEqual([201, 202]);
});

it.each([404, 410])("continues past a %i detail without marking it seen and rediscovers it from a later feed", async status => {
  await enable(); const since = await baseline(); await due();
  const feed = membersFeedHTML([{ id: 201 }, { id: 202 }]);
  const result = await call("/watch", { now, responses: [{ body: memberList() }, { body: feed }, { status, body: "gone" }] });
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/201?p=1"]);
  expect((await followingState()).seen).not.toContain(201);
  expect(pendingIDs(await followingState())).toEqual([202]);
  await resumeFollowing(); await run(topicHTML(202, since + 1000));
  expect(await followingEventIDs()).toEqual([202]);
  await due(); await run(memberList(), feed, topicHTML(201, since + 1000));
  expect(await followingEventIDs()).toEqual([201, 202]);
});

it.each([401, 429])("stops a candidate slice on HTTP %i and preserves the pending candidate", async status => {
  await enable(); const since = await baseline(); await due();
  await call("/watch", { now, responses: [{ body: memberList() }, { body: membersFeedHTML([{ id: 201 }, { id: 202 }]) },
    { status, body: "blocked", headers: status === 429 ? { "retry-after": "900" } : {} }] });
  expect(pendingIDs(await followingState())).toEqual([201, 202]);
  expect((await followingState()).seen).not.toContain(201);
  expect(await events()).toEqual([]);
  const target = await db.prepare("SELECT failures,next_check FROM watch_targets").first<any>();
  expect(target.failures).toBe(1);
  if (status === 401) expect((await db.prepare("SELECT blocked FROM notifier").first<any>()).blocked).toBe("credentials");
  else {
    const until = (await db.prepare("SELECT web_until FROM control").first<any>()).web_until;
    expect(until).toBeGreaterThanOrEqual(now + 900000);
    expect(target.next_check).toBeGreaterThanOrEqual(until);
  }
  expect(since).toBeGreaterThan(0);
});

it("rolls back a following event, dedup and seen marker atomically if its detail loses the lease", async () => {
  await enable(); const since = await baseline(); await due();
  const result = await call("/watch", { now, responses: [{ body: memberList() }, { body: membersFeedHTML([{ id: 201 }]) },
    { body: topicHTML(201, since + 1000), replaceLease: true }] });
  expect(result.error).toBeTruthy();
  expect(await events()).toEqual([]);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_dedup").first<any>()).n).toBe(0);
  expect((await followingState()).seen).not.toContain(201);
  expect(pendingIDs(await followingState())).toEqual([201]);
  await db.exec("UPDATE control SET lease='',lease_until=0");
  await resumeFollowing(); await run(topicHTML(201, since + 1000));
  expect(await followingEventIDs()).toEqual([201]);
});

it("does not commit a members-feed cache or baseline if its source request loses the lease", async () => {
  await enable();
  const result = await call("/watch", { now, responses: [{ body: memberList() },
    { body: membersFeedHTML([{ id: 201 }]), replaceLease: true }] });
  expect(result.error).toBeTruthy();
  const state = await followingState();
  expect(state.member_feed).toBeUndefined(); expect(state.seen).toEqual([]);
  expect(state.feed_monitor.baseline).toBe(true);
  expect(await events()).toEqual([]);
});

it("retains the first-baseline flag when the first feed fails after a successful member list", async () => {
  await enable();
  const result = await call("/watch", { now, responses: [{ body: memberList() }, { error: true }] });
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members"]);
  let state = await followingState();
  const since = state.members.writer;
  expect(state.feed_monitor).toMatchObject({ baseline: true, pending: [], scan: { phase: "feed" } });
  expect(state.member_feed).toBeUndefined(); expect(state.seen).toEqual([]);
  await resumeFollowing();
  expect(paths(await run(membersFeedHTML([{ id: 201 }, { id: 202 }])))).toEqual(["/?tab=members"]);
  state = await followingState();
  expect(state.feed_monitor.baseline).toBe(false);
  expect(state.seen).toEqual([201, 202]);
  expect(state.members.writer).toBe(since);
  expect(await events()).toEqual([]);
});

it("preserves the first-baseline checkpoint when a request consumes the 25-second slice budget", async () => {
  await enable();
  const result = await call("/watch", { now, responses: [{ body: memberList(), delay: 26000 }, { body: membersFeedHTML([{ id: 201 }]) }] });
  expect(result.error).toBeUndefined();
  expect(paths(result)).toEqual(["/my/following?p=1"]);
  const state = await followingState();
  expect(state.feed_monitor).toMatchObject({ baseline: true, scan: { phase: "feed" } });
  expect(state.seen).toEqual([]); expect(state.member_feed).toBeUndefined();
  await resumeFollowing(); await run(membersFeedHTML([{ id: 201 }]));
  expect(await events()).toEqual([]);
  expect((await followingState()).seen).toEqual([201]);
}, 40000);

it("migrates legacy pending candidates once without promoting scan ids or display-only cache ids to seen", async () => {
  await enable();
  const since = now - 120037, newcomerSince = now - 60019;
  await saveFollowing({ boundary: now - 100000, members: { writer: since }, seen: [200],
    member_feed: { observed_at: now - 5000, topics: [{ id: 601, title: "old display", author: "writer", reply_count: 0 }] },
    scan: { started: now - 60000, page: 301, pages: 406, verified: false,
      members: { writer: since, newcomer: newcomerSince }, ids: [201, 301, 601],
      candidates: [{ id: 201, title: "writer pending", author: "writer" }, { id: 301, title: "newcomer pending", author: "newcomer" }] },
    incremental: { page: 302, pages: 406, pending: [{ id: 301, title: "duplicate", author: "newcomer" },
      { id: 401, title: "audit pending", author: "writer" }, { id: 200, title: "seen", author: "writer" }] } });
  const result = await run(memberList(["writer", "newcomer"]), membersFeedHTML([{ id: 601 }, { id: 200 }]), topicHTML(601, since + 1000));
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members", "/t/601?p=1"]);
  let state = await followingState();
  expect(state.scan).toBeUndefined(); expect(state.incremental).toBeUndefined();
  expect(state.feed_monitor.baseline).toBe(false);
  expect(state.members).toEqual({ writer: since, newcomer: newcomerSince });
  expect(pendingIDs(state)).toEqual([201, 301, 401]);
  expect(await followingEventIDs()).toEqual([601]);
  await resumeFollowing();
  expect(paths(await run(topicHTML(201, since + 1000), topicHTML(301, newcomerSince + 1000, [], 1, "newcomer"), topicHTML(401, since + 1000))))
    .toEqual(["/t/201?p=1", "/t/301?p=1", "/t/401?p=1"]);
  expect(await followingEventIDs()).toEqual([201, 301, 401, 601]);
  state = await followingState();
  expect(pendingIDs(state)).toEqual([]);
  const visible = (await call("/watch-state")).result.targets[0];
  expect(visible.state_enc).toBeUndefined();
  expect(visible.progress?.kind).not.toBe("audit");
  if (visible.progress) expect(visible.progress).not.toHaveProperty("total_pages");
});

it.each(["completed", "members", "pending"])("migrates a %s legacy state without silently creating a new baseline", async kind => {
  await enable();
  const since = now - 2 * 86400000;
  const state: any = { boundary: kind === "completed" ? since : 0, members: kind === "pending" ? {} : { writer: since }, seen: [] };
  if (kind === "pending") state.incremental = { page: 80, pages: 406, pending: [{ id: 201, title: "waiting", author: "writer" }] };
  await saveFollowing(state);
  const created = kind === "pending" ? Math.floor(now / 1000) * 1000 : since + 1000;
  await run(memberList(), membersFeedHTML([{ id: 201 }]), topicHTML(201, created));
  expect(await followingEventIDs()).toEqual([201]);
  expect((await followingState()).feed_monitor.baseline).toBe(false);
  if (kind !== "pending") expect((await followingState()).members.writer).toBe(since);
});

it("keeps display-only legacy data from converting a genuinely new source into an established baseline", async () => {
  await enable();
  await saveFollowing({ boundary: 0, members: {}, seen: [],
    member_feed: { observed_at: now - 1000, topics: [{ id: 201, title: "display only", author: "writer", reply_count: 0 }] } });
  expect(paths(await run(memberList(), membersFeedHTML([{ id: 201 }, { id: 202 }])))).toEqual(["/my/following?p=1", "/?tab=members"]);
  expect((await followingState()).seen).toEqual([201, 202]);
  expect(await events()).toEqual([]);
});

it("exposes unknown, confirmed-empty and legacy member caches without inventing feed or observation data", async () => {
  await enable();
  let cached = (await call("/watch-state")).result.targets[0];
  expect(cached).not.toHaveProperty("followed_members"); expect(cached).not.toHaveProperty("member_feed");
  await run(memberList([]), membersFeedHTML([]));
  cached = (await call("/watch-state")).result.targets[0];
  expect(cached.followed_members).toEqual([]);
  expect(cached.member_feed.topics).toEqual([]);
  expect(cached.members_observed_at).toBeGreaterThanOrEqual(now);
  expect(cached.member_feed.observed_at).toBeGreaterThanOrEqual(now);
  await saveFollowing({ boundary: now - 60000, members: { cached_name: now - 60000 }, seen: [] });
  cached = (await call("/watch-state")).result.targets[0];
  expect(cached.followed_members).toEqual([{ username: "cached_name" }]);
  expect(cached).not.toHaveProperty("members_observed_at"); expect(cached).not.toHaveProperty("member_feed");
});

it("caches member presentation and members-tab display metadata and serves authenticated GET without upstream reads", async () => {
  await enable();
  const list = memberList(["WriterCase", "NoAvatar"])
    .replace("<img>", '<img class="avatar" alt="WriterCase" src="//cdn.v2ex.com/avatar/WriterCase.png">')
    .replace("<img>", '<img class="avatar" alt="NoAvatar" src="https://foreign.example/avatar/wrong.png">');
  const feed = membersFeedHTML([{ id: 900, author: "WriterCase", title: "Visible title", replyCount: 23,
    nodeName: "swift", nodeTitle: "Swift", updatedAt: now - 1000 }, { id: 901, author: "NoAvatar", avatar: null, nodeName: null }]);
  expect(paths(await run(list, feed))).toEqual(["/my/following?p=1", "/?tab=members"]);
  const cached = await call("/watch-state");
  expect(cached.calls).toEqual([]);
  const target = cached.result.targets[0];
  expect(target.followed_members).toEqual([{ username: "WriterCase", avatar_url: "https://cdn.v2ex.com/avatar/WriterCase.png" }, { username: "NoAvatar" }]);
  expect(target.member_feed.topics[0]).toMatchObject({ id: 900, title: "Visible title", author: "WriterCase", reply_count: 23, node_name: "swift", node_title: "Swift" });
  expect(target.member_feed.topics[1]).not.toHaveProperty("avatar_url");
  const response = await mf.dispatchFetch("http://local/api/accounts/1/state", { headers: { Authorization: "Bearer " + "synthetic-admin".repeat(5) } });
  expect(response.status).toBe(200);
  expect((await response.json<any>()).notifier.watches.targets[0].member_feed).toEqual(target.member_feed);
  const again = await call("/watch-state");
  expect(again.calls).toEqual([]);
  expect(again.result.targets[0].member_feed).toEqual(target.member_feed);
  expect(again.result.targets[0].members_observed_at).toBe(target.members_observed_at);
});

it("preserves cached members, feed and candidates when the complete member list cannot be validated", async () => {
  await enable(); await baseline();
  const before = await followingState(); await due();
  const bad = memberList(["OtherMember"]).replace("<span>1</span>", "<span>2</span>");
  expect(paths(await run(bad))).toEqual(["/my/following?p=1"]);
  const state = await followingState();
  expect(state.members).toEqual(before.members);
  expect(state.followed_members).toEqual(before.followed_members);
  expect(state.members_observed_at).toBe(before.members_observed_at);
  expect(state.member_feed).toEqual(before.member_feed);
  expect(state.seen).toEqual(before.seen);
  expect((await db.prepare("SELECT error FROM watch_targets").first<any>()).error).not.toBe("");
});

it.each(["wrong tab", "bad topic", "duplicate topic"])("does not replace good feed cache or candidates with a %s page", async fault => {
  await enable(); const since = await baseline(); await due();
  const old = await followingState();
  let html = membersFeedHTML([{ id: 201 }]);
  if (fault === "wrong tab") html = html.replace('class="tab_current"', 'class="tab"');
  if (fault === "bad topic") html = html.replace('/t/201#reply0', 'https://foreign.example/t/201#reply0');
  if (fault === "duplicate topic") html = membersFeedHTML([{ id: 201 }, { id: 201 }]);
  expect(paths(await run(memberList(), html))).toEqual(["/my/following?p=1", "/?tab=members"]);
  const state = await followingState();
  expect(state.member_feed).toEqual(old.member_feed);
  expect(state.seen).toEqual(old.seen); expect(pendingIDs(state)).toEqual([]);
  expect(state.members.writer).toBe(since);
  const visible = (await call("/watch-state")).result.targets[0];
  expect(visible.error || visible.member_feed_error).toBeTruthy();
  expect(await events()).toEqual([]);
});

it.each([401, 429])("stops source collection on HTTP %i and preserves the last valid feed", async status => {
  await enable(); await baseline(); const before = await followingState(); await due();
  const result = await call("/watch", { now, responses: [{ body: memberList() },
    { status, body: "blocked", headers: status === 429 ? { "retry-after": "900" } : {} }, { body: topicHTML(201, now - 1000) }] });
  expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members"]);
  expect((await followingState()).member_feed).toEqual(before.member_feed);
  expect((await followingState()).seen).toEqual(before.seen);
  expect(await events()).toEqual([]);
  if (status === 401) expect((await db.prepare("SELECT blocked FROM notifier").first<any>()).blocked).toBe("credentials");
  else expect((await db.prepare("SELECT web_until FROM control").first<any>()).web_until).toBeGreaterThanOrEqual(now + 900000);
});

it("refreshes an expired member list after feed throttling before checking old pending topics", async () => {
  await enable(); const since = await baseline();
  const state = await followingState();
  state.feed_monitor.pending = [{ id: 201, author: "writer", title: "old pending" }];
  // Expire the source beyond the longest configurable interval so the refresh
  // does not depend on the default following interval or worker clock drift.
  const stale = now - 3600001;
  state.feed_monitor.scan = { started: stale, phase: "candidates" };
  state.observed_at = stale;
  await saveFollowing(state); await due();
  const failed = await call("/watch", { now, responses: [{ body: memberList() },
    { status: 429, body: "blocked", headers: { "retry-after": "900" } }] });
  expect(paths(failed)).toEqual(["/my/following?p=1", "/?tab=members"]);
  expect((await followingState()).feed_monitor.scan.phase).toBe("feed");
  expect(pendingIDs(await followingState())).toEqual([201]);
  now = (await db.prepare("SELECT next_check FROM watch_targets").first<any>()).next_check + 1;
  const resumed = await run(memberList([]), membersFeedHTML([]), topicHTML(201, since + 1000));
  expect(paths(resumed)).toEqual(["/my/following?p=1", "/?tab=members"]);
  expect((await followingState()).members).toEqual({});
  expect(pendingIDs(await followingState())).toEqual([]);
  expect((await followingState()).seen).not.toContain(201);
  expect(await events()).toEqual([]);
});

it.each(["network", "malformed"])("increases retry backoff across repeated %s feed failures without resetting at failed checkpoints", async failure => {
  await enable(); await baseline(); await due();
  const bad = () => failure === "network" ? { error: true }
    : { body: membersFeedHTML([]).replace('class="tab_current"', 'class="tab"') };
  const previous = (await followingState()).member_feed;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const responses = attempt === 1 ? [{ body: memberList() }, bad()] : [bad()];
    const result = await call("/watch", { now, responses });
    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(attempt === 1 ? ["/my/following?p=1", "/?tab=members"] : ["/?tab=members"]);
    const target = await db.prepare("SELECT failures,next_check FROM watch_targets").first<any>();
    expect(target.failures).toBe(attempt);
    const delay = 30000 * 2 ** (attempt - 1);
    expect(target.next_check - now).toBeGreaterThanOrEqual(delay);
    expect(target.next_check - now).toBeLessThan(delay + 5000);
    expect((await followingState()).member_feed).toEqual(previous);
    expect((await followingState()).feed_monitor.scan.phase).toBe("feed");
    now = target.next_check + 1;
  }
  expect(await events()).toEqual([]);
});

it("increases retry backoff across consecutive failed candidate checkpoints while retaining the queue", async () => {
  await enable(); await baseline(); await due();
  const ids = [201, 202, 203];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const responses = attempt === 1
      ? [{ body: memberList() }, { body: membersFeedHTML(ids.map(id => ({ id }))) }, { error: true }]
      : [{ error: true }];
    const result = await call("/watch", { now, responses });
    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(attempt === 1 ? ["/my/following?p=1", "/?tab=members", "/t/201?p=1"] : [`/t/${ids[attempt - 1]}?p=1`]);
    const target = await db.prepare("SELECT failures,next_check FROM watch_targets").first<any>();
    expect(target.failures).toBe(attempt);
    const delay = 30000 * 2 ** (attempt - 1);
    expect(target.next_check - now).toBeGreaterThanOrEqual(delay);
    expect(target.next_check - now).toBeLessThan(delay + 5000);
    expect(pendingIDs(await followingState()).sort()).toEqual(ids);
    expect((await followingState()).seen).toEqual([200]);
    now = target.next_check + 1;
  }
  expect(await events()).toEqual([]);
});

it("uses each account's credentials and encrypted feed scope even when the source topic ids overlap", async () => {
  await enable();
  await run(memberList(["FirstMember"]), membersFeedHTML([{ id: 900, author: "FirstMember" }]));
  const firstCipher = (await db.prepare("SELECT state_enc FROM watch_targets WHERE notifier_id=1").first<any>()).state_enc;
  const secondBinding = "55555555-5555-4555-8555-555555555555", cookie = "A2=synthetic-second", pat = "synthetic-second";
  const scope = createHash("sha256").update(JSON.stringify([cookie, pat])).digest("hex");
  const credentials = (await call("/seal", { purpose: "v2ex-credentials:2", value: { cookie, pat } })).result;
  await db.prepare("INSERT INTO notifier(id,enabled,account_id,username,credential_scope,binding_id,verified_at) VALUES(2,1,8,'second',?,?,?)").bind(scope, secondBinding, now).run();
  await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at,encryption_version) VALUES(2,?,?,2)").bind(credentials, now).run();
  await db.prepare("INSERT INTO watch_control(id,config) VALUES(2,?)").bind(JSON.stringify({ ...config, source_account_id: 8, profile_id: secondBinding })).run();
  await db.prepare("INSERT INTO watch_targets(notifier_id,target_key,topic_id,epoch,enabled_at) VALUES(2,'following',0,1,?)").bind(now).run();
  try {
    const list = memberList(["SecondMember"]).replace('<a class="top" href="/member/tester">tester</a>', '<a class="top" href="/member/second">second</a>');
    const result = await call("/watch", { now, accountID: 2, responses: [{ body: list }, { body: membersFeedHTML([{ id: 900, author: "SecondMember" }], "second") }] });
    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(["/my/following?p=1", "/?tab=members"]);
    expect(result.calls.every((request: any) => request.headers.cookie === cookie && !request.headers.authorization)).toBe(true);
    expect((await db.prepare("SELECT state_enc FROM watch_targets WHERE notifier_id=1").first<any>()).state_enc).toBe(firstCipher);
    const first = await call("/watch-state", { accountID: 1 }), second = await call("/watch-state", { accountID: 2 });
    expect(first.calls).toEqual([]); expect(second.calls).toEqual([]);
    expect(first.result.targets[0].member_feed.topics[0].author).toBe("FirstMember");
    expect(second.result.targets[0].member_feed.topics[0].author).toBe("SecondMember");
    expect(await events()).toEqual([]);
    await db.prepare("UPDATE watch_targets SET state_enc=? WHERE notifier_id=2").bind(firstCipher).run();
    const wrong = (await call("/watch-state", { accountID: 2 })).result.targets[0];
    expect(wrong).not.toHaveProperty("member_feed"); expect(wrong.error).toContain("加密存储");
  } finally {
    await db.exec("DELETE FROM watch_targets WHERE notifier_id=2; DELETE FROM watch_control WHERE id=2; DELETE FROM notifier_credentials WHERE id=2; DELETE FROM notifier WHERE id=2");
  }
});

it("refreshes both sources once per manual batch and finishes all candidate checks before reporting success", async () => {
  await enable();
  const first = await refresh({}, [{ body: memberList() }, { body: membersFeedHTML([{ id: 200 }]) }]);
  expect(first.error).toBeUndefined(); expect(first.result.complete).toBe(true);
  expect(paths(first)).toEqual(["/my/following?p=1", "/?tab=members"]);
  const since = (await followingState()).members.writer;
  now += 1001;
  expect((await refresh({ started_at: first.result.started_at })).calls).toEqual([]);
  const next = await refresh({}, [{ body: memberList() }, { body: membersFeedHTML([{ id: 201 }, { id: 202 }]) }, { body: topicHTML(201, since + 1000) }]);
  expect(next.result).toMatchObject({ complete: false, remaining: 1, retry_at: 0 });
  expect(paths(next)).toEqual(["/my/following?p=1", "/?tab=members", "/t/201?p=1"]);
  expect(await followingEventIDs()).toEqual([201]);
  now += 1000;
  const finished = await refresh({ started_at: next.result.started_at }, [{ body: topicHTML(202, since + 1000) }]);
  expect(paths(finished)).toEqual(["/t/202?p=1"]);
  expect(finished.result).toMatchObject({ complete: true, remaining: 0, retry_at: 0 });
  expect(finished.result.reason).toContain("已获取");
  expect(await followingEventIDs()).toEqual([201, 202]);
});

it("manual source failures remain incomplete and respect retry time before recovering the same batch", async () => {
  await enable(); await baseline();
  const previous = (await followingState()).member_feed; now += 1001;
  const failed = await refresh({}, [{ body: memberList() }, { body: membersFeedHTML([]).replace('class="tab_current"', 'class="tab"') }]);
  expect(failed.error).toBeUndefined();
  expect(failed.result.complete).toBe(false); expect(failed.result.retry_at).toBeGreaterThan(now);
  expect(failed.result.reason).not.toContain("已获取");
  expect((await followingState()).member_feed).toEqual(previous);
  now += 1000;
  const waiting = await refresh({ started_at: failed.result.started_at });
  expect(waiting.calls).toEqual([]); expect(waiting.result.complete).toBe(false);
  now = failed.result.retry_at + 1;
  const recovered = await refresh({ started_at: failed.result.started_at }, [{ body: membersFeedHTML([{ id: 200 }]) }]);
  expect(paths(recovered)).toEqual(["/?tab=members"]);
  expect(recovered.result.complete).toBe(true); expect(recovered.result.reason).toContain("已获取");
});

it("a new manual batch refreshes sources during an old candidate backlog without losing pending topics", async () => {
  await enable(); const since = await baseline(); await due();
  await run(memberList(), membersFeedHTML([{ id: 201 }, { id: 202 }, { id: 203 }]), topicHTML(201, since + 1000));
  now += 1000;
  const refreshed = await refresh({}, [{ body: memberList() }, { body: membersFeedHTML([{ id: 204 }]) }, { body: topicHTML(204, since + 1000) }]);
  expect(paths(refreshed)).toEqual(["/my/following?p=1", "/?tab=members", "/t/204?p=1"]);
  expect(refreshed.result.complete).toBe(false);
  expect(pendingIDs(await followingState())).toEqual([202, 203]);
  now += 1000;
  const finished = await refresh({ started_at: refreshed.result.started_at }, [{ body: topicHTML(202, since + 1000) }, { body: topicHTML(203, since + 1000) }]);
  expect(paths(finished)).toEqual(["/t/202?p=1", "/t/203?p=1"]);
  expect(finished.result.complete).toBe(true);
  expect(await followingEventIDs()).toEqual([201, 202, 203, 204]);
});

it("keeps the current source cache and uncommitted candidate when the notification queue is full", async () => {
  await enable(); const since = await baseline(); await due();
  await db.prepare(`WITH RECURSIVE items(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM items WHERE n<2000)
    INSERT INTO notification_outbox(event_id,account_id,binding_id,type,kind,unread,avatar_url,content_enc,created_at,expires_at,updated_at)
    SELECT 'full-'||n,7,?,'notification','reply',1,'','',?,?,? FROM items`).bind(binding, now, now + 86400000, now).run();
  await run(memberList(), membersFeedHTML([{ id: 201 }]), topicHTML(201, since + 1000));
  const state = await followingState();
  expect(state.member_feed.topics.map((topic: any) => topic.id)).toEqual([201]);
  expect(pendingIDs(state)).toEqual([201]); expect(state.seen).not.toContain(201);
  expect((await events()).filter(row => row.type === "watch_update")).toEqual([]);
  expect((await db.prepare("SELECT error FROM watch_targets").first<any>()).error).toContain("队列");
  await db.exec("DELETE FROM notification_outbox WHERE event_id LIKE 'full-%'");
  await resumeFollowing(); await run(topicHTML(201, since + 1000));
  expect(await followingEventIDs()).toEqual([201]);
});
