import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const admin = "synthetic-credentials-admin-".repeat(3);
const key = "ab".repeat(32);
const cookie = "A2=deployment-cookie; session=old-session";
const pat = "deployment-pat";
const newCookie = "A2=settings-cookie; session=new-session";
const newPAT = "settings-pat";
const binding = "11111111-1111-4111-8111-111111111111";
const purpose = "v2ex-credentials";
const profile = { body: { success: true, result: { id: 7, username: "tester" } } };
const home = (count = 8, username = "tester") =>
  `<a class="top" href="/member/${username}">${username}</a><div id="Rightbar"><a href="/notifications">${count} unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/123">topic</a></span></div>`;
const scope = (value = { cookie, pat }) =>
  createHash("sha256").update(JSON.stringify([value.cookie, value.pat])).digest("hex");
type UpstreamResponse = {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
  error?: boolean | "timeout";
  streamError?: boolean;
  delay?: number;
  replaceLease?: boolean;
  replaceCredentials?: string;
};
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let now: number;
let responses: UpstreamResponse[];
let outboundCalls: { url: string; headers: Record<string, string> }[];

async function call(path: string, data: unknown = {}) {
  return mf.dispatchFetch(`http://local${path}`, {
    method: "POST", body: JSON.stringify(data),
  }).then(r => r.json()) as Promise<any>;
}
async function api(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`http://local/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
      Origin: "http://local",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function save(input: unknown = { cookie: newCookie, pat: newPAT }, options: Record<string, unknown> = {}) {
  return call("/action", {
    action: "credentials", input, now,
    responses: [profile, { body: home() }],
    ...options,
  });
}
async function state() { return db.prepare("SELECT * FROM notifier WHERE id=1").first<any>(); }
async function stored() { return db.prepare("SELECT * FROM notifier_credentials WHERE id=1").first<any>(); }
async function seedCredentials(value = { cookie, pat }) {
  const sealed = await call("/seal", { purpose, value });
  expect(sealed.error).toBeUndefined();
  await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at")
    .bind(sealed.result, now - 1000).run();
  return sealed.result as string;
}
async function decrypted() {
  const row = await stored();
  return call("/open", { purpose: row.encryption_version === 2 ? `${purpose}:1` : purpose, value: row.payload });
}
async function related() {
  const tables = ["notification_candidates", "notification_outbox", "notification_dedup", "watch_targets", "watch_dedup", "watch_control"];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await db.prepare(`SELECT * FROM ${table}`).all()).results,
  ])));
}
const without = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => !keys.includes(name)));

beforeAll(async () => {
  const compiled = await build({
    entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false,
    format: "esm", target: "es2022", external: ["cloudflare:sockets"],
  });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-10-19", d1Databases: ["DB"],
    bindings: { ADMIN_TOKEN: admin, NOTIFIER_KEY: key, V2EX_COOKIE: cookie, V2EX_PAT: pat },
    outboundService: request => {
      outboundCalls.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      const response = responses.shift();
      if (!response) return new Response("unexpected upstream", { status: 500 });
      return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body), {
        status: response.status ?? 200, headers: response.headers,
      });
    },
  }));
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort())
    await db.exec((await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "));
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  now = Date.now() + 1000;
  responses = [];
  outboundCalls = [];
  await db.exec(`
    DELETE FROM notifier_credentials;
    DELETE FROM notification_checks;
    DELETE FROM api_usage;
    DELETE FROM api_daily;
    DELETE FROM notification_candidates;
    DELETE FROM notification_outbox;
    DELETE FROM notification_dedup;
    DELETE FROM watch_targets;
    DELETE FROM watch_dedup;
    DELETE FROM notifier_pairing_invitation;
    DELETE FROM watch_app_invitation;
    DELETE FROM watch_app_clients;
    DELETE FROM watch_local_operations;
    DELETE FROM notifier;
    INSERT INTO notifier(id) VALUES(1);
    UPDATE control SET lease='',lease_until=0,next_dispatch=0,api_until=0,web_until=0,api_forbidden_failures=0,web_forbidden_failures=0;
    UPDATE watch_control SET config='',next_sync=0,last_sync=0,error='',assistant_id='',instance_enc='',published_binding='',config_owner='central',ownership_committed=0,ownership_revision=0;
    UPDATE http_proxy SET enabled=0,address='',authenticated=0,payload='' WHERE id=1;
  `);
  await db.prepare(`UPDATE notifier SET account_id=7,username='tester',credential_scope=?,verified_at=?,enabled=1,binding_id=?,sender_enc='existing-sender',paired_at=?,check_start_hour=0,check_end_hour=24,
    scan_stage='page',scan_id='existing-scan',scan_page=3,scan_collected=40,scan_min=80,scan_head='[100,99]',unread=8,observed_at=?,next_scan=?,scan_until=?,scan_failures=2,scan_error='existing scan failure',relay_until=?,relay_failures=1,relay_error='existing relay failure',cleanup_at=? WHERE id=1`)
    .bind(scope(), now - 30000, binding, now - 3600000, now - 30000, now + 300000, now + 600000, now + 900000, now + 3600000).run();
  await db.prepare("UPDATE watch_control SET next_sync=?,last_sync=? WHERE id=1").bind(now + 86400000, now - 60000).run();
  await db.exec(`
    INSERT INTO notification_candidates(scan_id,notification_id,content_enc,kind,avatar_url,queued) VALUES('existing-scan',100,'encrypted candidate','reply','',0);
    INSERT INTO notification_dedup VALUES(7,99,'existing-event');
    INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,avatar_url,content_enc,wire,status,created_at,expires_at,updated_at) VALUES('existing-event',7,99,'${binding}','notification','reply',8,'','encrypted content','immutable wire','submitted',1,9999999999999,2);
    INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at,state_enc,next_check,last_checked,failures,checking,error) VALUES('topic:123',123,1,1,'encrypted baseline',9999999999999,2,3,1,'existing watch failure');
    INSERT INTO watch_dedup VALUES(7,'topic_reply',123,456,'watch-event');
  `);
});

describe("encrypted administrator V2EX credentials", () => {
  it.each([
    ["Cookie", { cookie: newCookie }, { cookie: newCookie, pat }],
    ["PAT", { pat: newPAT }, { cookie, pat: newPAT }],
    ["both", { cookie: newCookie, pat: newPAT }, { cookie: newCookie, pat: newPAT }],
  ])("verifies and atomically saves %s while invalidating only the unread snapshot", async (_name, input, expected) => {
    await seedCredentials();
    await db.exec("UPDATE notifier SET blocked='credentials'");
    const before = await state(), work = await related();
    const result = await save(input);
    expect(result.error).toBeUndefined();
    expect(result.calls.map((c: any) => c.url)).toEqual(["https://www.v2ex.com/api/v2/member", "https://www.v2ex.com/"]);
    expect(result.calls[0].headers).toMatchObject({ authorization: `Bearer ${expected.pat}` });
    expect(result.calls[0].headers).not.toHaveProperty("cookie");
    expect(result.calls[1].headers).toMatchObject({ cookie: expected.cookie });
    expect(result.calls[1].headers).not.toHaveProperty("authorization");
    expect((await decrypted()).result).toEqual(expected);
    const saved = await stored(), after = await state();
    expect(saved.payload).toMatch(/^1\./);
    expect(JSON.stringify(saved)).not.toContain(expected.cookie);
    expect(JSON.stringify(saved)).not.toContain(expected.pat);
    expect(saved.updated_at).toBeGreaterThanOrEqual(now);
    expect(after).toMatchObject({ account_id: 7, username: "tester", credential_scope: scope(expected), blocked: "" });
    expect(after.verified_at).toBeGreaterThanOrEqual(now);
    expect(after.verify_until).toBeGreaterThanOrEqual(now + 60000);
    expect(after).toMatchObject({ scan_stage: "idle", scan_id: "", scan_page: 1, scan_collected: 0, scan_head: "[]", scan_min: 0, next_scan: 0, last_scan: 0, unread: 8 });
    expect(after.observed_at).toBeGreaterThanOrEqual(now);
    const changed = ["credential_scope", "verified_at", "verify_until", "blocked", "scan_stage", "scan_id", "scan_page", "scan_collected", "scan_head", "scan_min", "next_scan", "last_scan", "unread", "observed_at"];
    expect(without(after, changed)).toEqual(without(before, changed));
    expect(await related()).toEqual({ ...work, notification_candidates: [] });
  });

  it("uses deployment Secrets until settings exist and can initialize a missing configuration", async () => {
    const initial = await (await api("/state")).json<any>();
    expect(initial.credentials).toEqual({ cookie: true, pat: true, source: "secrets", updated_at: 0 });
    await db.exec("UPDATE notifier SET account_id=0,username='',credential_scope='',verified_at=0");
    const result = await save(undefined, { env: { V2EX_COOKIE: "", V2EX_PAT: "" } });
    expect(result.error).toBeUndefined();
    expect((await decrypted()).result).toEqual({ cookie: newCookie, pat: newPAT });
    expect(await state()).toMatchObject({ account_id: 7, username: "tester", credential_scope: scope({ cookie: newCookie, pat: newPAT }) });
  });

  it.each([
    [{ cookie: newCookie }, { V2EX_COOKIE: "", V2EX_PAT: "" }],
    [{ pat: newPAT }, { V2EX_COOKIE: "", V2EX_PAT: "" }],
  ])("does not save a partial initial configuration", async (input, env) => {
    const before = await state();
    const result = await save(input, { env });
    expect(result.status).toBe(400);
    expect(result.calls).toHaveLength(0);
    expect(await stored()).toBeNull();
    expect(await state()).toEqual(before);
  });

  it.each([
    ["empty update", {}], ["empty Cookie", { cookie: "" }], ["empty PAT", { pat: "" }],
    ["Cookie type", { cookie: 7 }], ["PAT type", { pat: null }],
    ["Cookie header injection", { cookie: "A2=x\r\nAuthorization: injected" }],
    ["malformed Cookie", { cookie: "not-a-cookie" }],
    ["oversized Cookie", { cookie: `A2=${"x".repeat(16382)}` }],
    ["oversized PAT", { pat: "x".repeat(4097) }],
    ["PAT whitespace", { pat: "with space" }], ["PAT controls", { pat: "with\nnewline" }],
    ["non-ASCII PAT", { pat: "令牌" }],
    ["oversized serialized credentials", { cookie: `A2=${'"'.repeat(16381)}`, pat: "p".repeat(4096) }],
  ])("rejects %s before verification without altering active credentials", async (_name, input) => {
    await seedCredentials();
    const before = await state(), saved = await stored();
    const result = await save(input);
    expect(result.status).toBe(400);
    expect(result.calls).toHaveLength(0);
    expect(await stored()).toEqual(saved);
    expect(await state()).toEqual(before);
  });

  it("accepts the full Cookie and PAT boundaries and can read their large ciphertext", async () => {
    const longCookie = `A2=${"x".repeat(16381)}`, longPAT = "p".repeat(4096);
    const result = await save({ cookie: longCookie, pat: longPAT });
    expect(result.error).toBeUndefined();
    expect(result.calls[0].headers.authorization).toBe(`Bearer ${longPAT}`);
    expect(result.calls[1].headers.cookie).toBe(longCookie);
    expect((await stored()).payload.length).toBeGreaterThan(16384);
    await db.exec("UPDATE notifier SET scan_stage='idle',scan_until=0,next_scan=0,observed_at=0; DELETE FROM notification_outbox");
    const scan = await call("/scan", { now: now + 61000, responses: [{ body: home(0) }] });
    expect(scan.error).toBeUndefined();
    expect(scan.calls).toHaveLength(1);
    expect(scan.calls[0].headers.cookie).toBe(longCookie);
  });

  it("accepts a credential HTTP body larger than the ordinary 4 KiB action limit", async () => {
    const longCookie = `A2=${"x".repeat(8000)}`;
    responses = [profile, { body: home() }];
    const response = await api("/notifier/credentials", "PUT", { cookie: longCookie, pat: newPAT });
    expect(response.status, await response.text()).toBe(200);
    expect(outboundCalls[1].headers.cookie).toBe(longCookie);
    expect((await decrypted()).result).toEqual({ cookie: longCookie, pat: newPAT });
  });

  it("normalizes a pasted Cookie request header", async () => {
    const result = await save({ cookie: `Cookie: ${newCookie}` });
    expect(result.error).toBeUndefined();
    expect(result.calls[1].headers.cookie).toBe(newCookie);
    expect((await decrypted()).result).toEqual({ cookie: newCookie, pat });
  });

  it.each([
    ["another numeric account", [{ body: { success: true, result: { id: 8, username: "tester" } } }], 1],
    ["mismatched homepage", [profile, { body: home(8, "different") }], 2],
    ["unparseable homepage", [profile, { body: "not an authenticated homepage" }], 2],
    ["invalid PAT", [{ status: 401, body: "unauthorized" }], 1],
    ["invalid Cookie", [profile, { status: 302, headers: { Location: "/signin" }, body: "" }], 2],
    ["PAT network failure", [{ error: true }], 1],
    ["Cookie timeout", [profile, { error: "timeout" }], 2],
    ["body read failure", [profile, { streamError: true }], 2],
    ["invalid profile", [{ body: { success: true, result: { id: "7", username: "tester" } } }], 1],
  ] as const)("keeps active credentials and all in-flight work after %s", async (_name, upstream, count) => {
    await seedCredentials();
    await db.exec("UPDATE notifier SET blocked='pairing'");
    const before = await state(), saved = await stored(), work = await related();
    const result = await save(undefined, { responses: upstream });
    expect(result.error).toBeTruthy();
    expect(result.calls).toHaveLength(count);
    expect(await stored()).toEqual(saved);
    expect(without(await state(), ["verify_until"])).toEqual(without(before, ["verify_until"]));
    expect(await related()).toEqual(work);
  });

  it.each(["api", "web"])("retains active state on a candidate %s 403 and honors its cooldown", async channel => {
    await seedCredentials();
    const before = await state(), saved = await stored(), work = await related();
    const denied = { status: 403, body: "denied candidate credentials" };
    const result = await save(undefined, { responses: channel === "api" ? [denied] : [profile, denied] });
    expect(result.error).toContain("HTTP 403");
    const control = await db.prepare("SELECT * FROM control").first<any>();
    expect(control[`${channel}_until`]).toBeGreaterThanOrEqual(now + 60000);
    expect(control[`${channel}_forbidden_failures`]).toBe(1);
    expect(control[channel === "api" ? "web_until" : "api_until"]).toBe(0);
    expect(await stored()).toEqual(saved);
    expect(without(await state(), ["verify_until"])).toEqual(without(before, ["verify_until"]));
    expect(await related()).toEqual(work);
    const verifyUntil = (await state()).verify_until;
    const retry = await save(undefined, { now: now + 1000 });
    expect(retry.error).toContain("暂停");
    expect(retry.calls).toHaveLength(0);
    expect(await stored()).toEqual(saved);
    expect((await state()).verify_until).toBe(verifyUntil);
  });

  it.each(["api", "web"])("does not spend a PAT request while the existing %s channel is cooling down", async channel => {
    await db.prepare(`UPDATE control SET ${channel}_until=?`).bind(now + 900000).run();
    const before = await state();
    const result = await save();
    expect(result.error).toContain("暂停");
    expect(result.calls).toHaveLength(0);
    expect(await state()).toEqual(before);
    expect(await stored()).toBeNull();
  });

  it("shares the one-minute verification limit with repeated saves and manual verification", async () => {
    expect((await save()).error).toBeUndefined();
    const saved = await stored(), before = await state();
    for (const action of ["credentials", "verify"]) {
      const result = await call("/action", { now: now + 1000, action, input: { pat: "second-pat" }, responses: [profile, { body: home() }] });
      expect(result.error).toContain("一分钟");
      expect(result.calls).toHaveLength(0);
      expect(await stored()).toEqual(saved);
      expect((await state()).verify_until).toBe(before.verify_until);
    }
  });

  it("does not clear a pairing block or shorten existing dispatch and cooldown deadlines on success", async () => {
    await db.exec("UPDATE notifier SET blocked='pairing'; UPDATE control SET next_dispatch=9999999999999,api_until=1,web_until=2");
    const before = await db.prepare("SELECT * FROM control").first();
    expect((await save()).error).toBeUndefined();
    expect((await state()).blocked).toBe("pairing");
    expect(await db.prepare("SELECT * FROM control").first()).toEqual(before);
  });

  it("rejects a competing save without reading broken ciphertext or starting upstream work", async () => {
    await seedCredentials();
    await db.exec("UPDATE notifier_credentials SET payload='corrupted'; UPDATE control SET lease='another-task',lease_until=9999999999999");
    const before = await state();
    const result = await save();
    expect(result.error).toContain("正在执行其他任务");
    expect(result.calls).toHaveLength(0);
    expect(await state()).toEqual(before);
    expect((await stored()).payload).toBe("corrupted");
  });

  it("serializes concurrent saves and never commits a stale lease holder", async () => {
    await seedCredentials();
    const first = save(undefined, { responses: [{ ...profile, delay: 250 }, { body: home() }] });
    await vi.waitFor(async () => expect((await db.prepare("SELECT lease FROM control").first<any>()).lease).not.toBe(""));
    const competing = await save({ pat: "competing-pat" });
    expect(competing.error).toContain("正在执行其他任务");
    expect(competing.calls).toHaveLength(0);
    expect((await first).error).toBeUndefined();
    const saved = await stored(), before = await state(), work = await related();
    const stale = await save({ pat: "stale-pat" }, { now: now + 61000, responses: [profile, { body: home(), replaceLease: true }] });
    expect(stale.error).toBeTruthy();
    expect(stale.calls).toHaveLength(2);
    expect(await stored()).toEqual(saved);
    expect(without(await state(), ["verify_until"])).toEqual(without(before, ["verify_until"]));
    expect(await related()).toEqual(work);
    expect((await db.prepare("SELECT lease FROM control").first<any>()).lease).toBe("new-owner");
  });

  it("reports only credential presence, source and update time without exposing saved or deployed secrets", async () => {
    responses = [profile, { body: home() }];
    const response = await api("/notifier/credentials", "PUT", { cookie: newCookie, pat: newPAT });
    expect(response.status).toBe(200);
    const result = await response.text(), saved = await stored();
    const snapshot = await (await api("/state")).json<any>();
    expect(snapshot.credentials).toEqual({ cookie: true, pat: true, source: "settings", updated_at: saved.updated_at });
    const visible = result + JSON.stringify(snapshot);
    for (const secret of [cookie, pat, newCookie, newPAT, saved.payload]) expect(visible).not.toContain(secret);
    expect(snapshot.credentials).not.toHaveProperty("payload");
    expect(outboundCalls).toHaveLength(2);
  });

  it("uses saved credentials for later scans even when deployment Secrets are changed", async () => {
    expect((await save()).error).toBeUndefined();
    await db.exec("UPDATE notifier SET scan_stage='idle',scan_until=0,next_scan=0,observed_at=0; DELETE FROM notification_outbox");
    const result = await call("/scan", {
      now: now + 61000, env: { V2EX_COOKIE: "A2=changed-secret", V2EX_PAT: "changed-secret-pat" },
      responses: [{ body: home(1) }, { body: { success: true, result: [] } }],
    });
    expect(result.calls.map((c: any) => c.url)).toEqual(["https://www.v2ex.com/", "https://www.v2ex.com/api/v2/notifications?p=1"]);
    expect(result.calls[0].headers.cookie).toBe(newCookie);
    expect(result.calls[1].headers.authorization).toBe(`Bearer ${newPAT}`);
    expect((await state()).credential_scope).toBe(scope({ cookie: newCookie, pat: newPAT }));
    expect((await decrypted()).result).toEqual({ cookie: newCookie, pat: newPAT });
  });

  it("keeps one credential snapshot throughout a leased scan", async () => {
    await seedCredentials();
    const replacement = await call("/seal", { purpose, value: { cookie: newCookie, pat: newPAT } });
    await db.exec("UPDATE notifier SET scan_stage='idle',scan_until=0,next_scan=0,observed_at=0; DELETE FROM notification_outbox");
    const result = await call("/scan", { now, responses: [
      { body: home(1), replaceCredentials: replacement.result },
      { body: { success: true, result: [] } },
    ] });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].headers.cookie).toBe(cookie);
    expect(result.calls[1].headers.authorization).toBe(`Bearer ${pat}`);
    expect((await stored()).payload).toBe(replacement.result);
  });

  it("uses the settings snapshot during a cron round instead of changed deployment Secrets", async () => {
    expect((await save()).error).toBeUndefined();
    await db.exec("UPDATE notifier SET scan_until=0,next_scan=0,observed_at=0; DELETE FROM notification_outbox");
    const result = await call("/round", {
      now: now + 61000,
      env: { V2EX_COOKIE: "A2=changed-secret", V2EX_PAT: "changed-secret-pat" },
      responses: [{ body: home(0) }],
    });
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].headers.cookie).toBe(newCookie);
    expect((await state()).credential_scope).toBe(scope({ cookie: newCookie, pat: newPAT }));
  });

  it.each([0, 8])("does not send an old first-attempt notification after the candidate homepage reports %s unread", async count => {
    await db.prepare("UPDATE notifier SET scan_stage='idle',scan_error='',relay_until=0,last_scan=? WHERE id=1").bind(now).run();
    await db.exec("UPDATE notification_outbox SET status='pending',attempts=0,wire=NULL");
    const queued = (await related()).notification_outbox;
    expect((await save(undefined, { responses: [profile, { body: home(count) }] })).error).toBeUndefined();
    expect(await state()).toMatchObject({ last_scan: 0, unread: count, next_scan: 0 });
    const result = await call("/relay", { now, responses: [] });
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(0);
    expect((await related()).notification_outbox).toEqual(queued);
  });

  it.each(["malformed", "wrong purpose", "wrong key"])("fails closed on %s ciphertext instead of falling back to valid deployment Secrets", async corruption => {
    let payload = "corrupted";
    if (corruption !== "malformed") payload = (await call("/seal", {
      purpose: corruption === "wrong purpose" ? "not-credentials" : purpose,
      value: { cookie: newCookie, pat: newPAT },
      ...(corruption === "wrong key" ? { env: { NOTIFIER_KEY: "cd".repeat(32) } } : {}),
    })).result;
    await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at) VALUES(1,?,?)").bind(payload, now).run();
    await db.exec("UPDATE notifier SET scan_until=0");
    const before = await state();
    const result = await call("/scan", { now, responses: [profile, { body: home() }] });
    expect(result.error).toContain("无法读取");
    expect(result.block).toBe("");
    expect(result.calls).toHaveLength(0);
    expect(await state()).toEqual(before);
    expect((await stored()).payload).toBe(payload);
  });

  it("preserves a damaged override on partial updates but can repair it with two newly verified values", async () => {
    await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at) VALUES(1,'corrupted',?)").bind(now).run();
    const before = await state();
    const invalid = await save({ pat: "bad whitespace" });
    expect(invalid.status).toBe(400);
    expect(invalid.calls).toHaveLength(0);
    const partial = await save({ pat: newPAT });
    expect(partial.block).toBe("");
    expect(partial.calls).toHaveLength(0);
    expect(await state()).toEqual(before);
    expect((await stored()).payload).toBe("corrupted");
    const snapshot = await (await api("/state")).json<any>();
    expect(snapshot.credentials).toEqual({ cookie: true, pat: true, source: "settings", updated_at: now });
    expect((await save()).error).toBeUndefined();
    expect((await decrypted()).result).toEqual({ cookie: newCookie, pat: newPAT });
  });

  it.each(["", "storage", "pairing"])("repairs a corrupt record after manual verification while preserving an unrelated '%s' block", async blocked => {
    await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at) VALUES(1,'corrupted',?)").bind(now).run();
    await db.prepare("UPDATE notifier SET blocked=? WHERE id=1").bind(blocked).run();
    const verification = await call("/action", { action: "verify", now, responses: [] });
    expect(verification.error).toContain("无法读取");
    expect(verification.calls).toHaveLength(0);
    expect((await state()).blocked).toBe(blocked);
    const failed = await state();
    expect(failed.scan_error).toContain("无法读取");
    const repaired = await save(undefined, { now: now + 61000 });
    expect(repaired.error).toBeUndefined();
    expect((await decrypted()).result).toEqual({ cookie: newCookie, pat: newPAT });
    expect(await state()).toMatchObject({ blocked, scan_until: failed.scan_until, scan_failures: failed.scan_failures, scan_error: failed.scan_error });
    if (!blocked) {
      const scanned = await call("/scan", { now: now + 3600001, responses: [{ body: home(0) }] });
      expect(scanned.error).toBeUndefined();
      expect(scanned.calls).toHaveLength(1);
      expect(scanned.calls[0].headers.cookie).toBe(newCookie);
      expect(await state()).toMatchObject({ blocked: "", scan_error: "", scan_failures: 0 });
    }
  });

  it("requires authentication and same-origin writes on the new route", async () => {
    const before = await state();
    expect((await api("/notifier/credentials", "PUT", { cookie: newCookie, pat: newPAT }, { Authorization: "" })).status).toBe(401);
    expect((await api("/notifier/credentials", "PUT", { cookie: newCookie, pat: newPAT }, { Origin: "https://evil.example" })).status).toBe(403);
    expect(outboundCalls).toHaveLength(0);
    expect(await stored()).toBeNull();
    expect(await state()).toEqual(before);
  });

  it("bounds HTTP bodies independently of the individual credential limits", async () => {
    const response = await mf.dispatchFetch("http://local/api/notifier/credentials", {
      method: "PUT", headers: { Authorization: `Bearer ${admin}`, Origin: "http://local", "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: newCookie, pat: newPAT }) + " ".repeat(65536),
    });
    expect(response.status).toBe(400);
    expect(outboundCalls).toHaveLength(0);
    expect(await stored()).toBeNull();
  });
});
