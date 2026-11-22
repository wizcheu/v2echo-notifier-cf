import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import type { AccountsState } from "../shared/contracts";

const admin = "synthetic-multi-account-admin-".repeat(3);
const key = "ab".repeat(32);
const physicalDevice = "33333333-3333-4333-8333-333333333333";
const assistantID = "44444444-4444-4444-8444-444444444444";
const publicKey = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const health = { notification_details: 1, notification_body_encryption: 2, notification_routing: 1,
  notification_test_samples: 1, notification_test_avatars: 1, watch_notifications: 1, watch_comment_details: 1,
  watch_direct: 1, notifier_direct_pairing: 1, notifier_explicit_pairing: 1,
  max_events: 20, max_receipts: 50, max_sync_bytes: 65536, sync_interval: 30 };
interface Account { member: number; name: string; cookie: string; pat: string; binding: string; unread: number; failure?: "pat401" | "pat429" | "web403"; }
let a: Account, b: Account;
let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let migrations: string[];
let calls: { path: string; member: number | null; method: string; body: any }[];
let unexpected: string[];
let memberGate: { member: number; promise: Promise<void>; release: () => void; entered: Promise<void>; mark: () => void } | undefined;
const home = (account: Account) => `<a class="top" href="/member/${account.name}">${account.name}</a><div id="Rightbar"><a href="/notifications">${account.unread} unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/123">topic</a></span></div>`;
const notice = (account: Account) => ({ id: 100, for_member_id: account.member,
  text: '<a href="/member/actor">actor</a> 回复了你 <a href="/t/123">topic</a>', payload_rendered: `private for ${account.name}`,
  member: { username: "actor", avatar_large: "https://cdn.v2ex.com/avatar/1/2/3.png" } });
const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers });
async function upstream(request: Request) {
  const url = new URL(request.url), authorization = request.headers.get("authorization"), cookie = request.headers.get("cookie");
  const account = [a, b].find(value => url.hostname === "www.v2ex.com"
    ? authorization === `Bearer ${value.pat}` || cookie === value.cookie
    : authorization === `Bearer sender-${value.name}`);
  const body = request.method === "GET" ? null : await request.json<any>();
  calls.push({ path: url.pathname, member: account?.member ?? null, method: request.method, body });
  if (url.hostname === "www.v2ex.com" && account) {
    if (url.pathname === "/api/v2/member") {
      if (memberGate?.member === account.member) { memberGate.mark(); await memberGate.promise; }
      if (account.failure === "pat401") return json({}, 401);
      if (account.failure === "pat429") return json({}, 429, { "retry-after": "120" });
      return json({ success: true, result: { id: account.member, username: account.name } });
    }
    if (url.pathname === "/") return account.failure === "web403" ? new Response("Forbidden", { status: 403 }) : new Response(home(account));
    if (url.pathname === "/api/v2/notifications") return account.failure === "pat429"
      ? json({}, 429, { "retry-after": "120" }) : json({ success: true, result: [notice(account)] });
  }
  if (url.pathname === "/api/push/v1/health") return json(health);
  if (account && url.pathname === "/api/push/v1/recipient-keys") return json({ source_account_id: account.member, recipients: [{
    device_id: physicalDevice, binding_id: account.binding, public_key: publicKey.toString("base64url"), key_id: createHash("sha256").update(publicKey).digest("hex"),
  }] });
  if (account && url.pathname === "/api/push/v1/sync") {
    if (body.events.some((event: any) => event.source_account_id !== account.member)) {
      unexpected.push("wrong sender/account projection"); return json({}, 403);
    }
    return json({ retry_after_seconds: 30, receipts: [...body.events.map((event: any) => event.event_id), ...body.receipts].map(event_id => ({ event_id, status: "apns_accepted" })) });
  }
  unexpected.push(`${request.method} ${url.pathname} with unmatched credentials`);
  return json({ error: "unexpected test request" }, 500);
}
async function request(path: string, method = "GET", body?: unknown, token = admin) {
  return mf.dispatchFetch(`https://assistant.example/api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "https://assistant.example" },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(path: string, body: unknown) {
  return (await mf.dispatchFetch(`https://assistant.example${path}`, { method: "POST", body: JSON.stringify(body) })).json<any>();
}
async function create(account: Account) {
  const response = await request("/accounts", "POST", { cookie: account.cookie, pat: account.pat });
  const data = await response.json<any>();
  expect(response.status, JSON.stringify(data)).toBe(200);
  return data.id as number;
}
async function state(id: number) { return db.prepare("SELECT * FROM notifier WHERE id=?").bind(id).first<any>(); }
async function snapshot(id: number, member: number) {
  const result: Record<string, unknown> = {};
  for (const table of ["notifier", "notifier_credentials", "watch_control", "unread_control", "notifier_pairing_invitation", "watch_app_invitation"])
    result[table] = (await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).all()).results;
  for (const table of ["notification_candidates", "unread_items", "watch_targets", "watch_app_clients", "notification_checks", "api_usage", "api_daily"])
    result[table] = (await db.prepare(`SELECT * FROM ${table} WHERE notifier_id=?`).bind(id).all()).results;
  for (const table of ["notification_outbox", "notification_dedup", "notification_history", "notification_samples", "watch_dedup"])
    result[table] = (await db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).bind(member).all()).results;
  return result;
}
async function paired(id: number, account: Account) {
  const instance = (await call("/seal", { purpose: `watch-instance:${assistantID}`, value: "synthetic-instance" })).result;
  await db.prepare("UPDATE assistant_instance SET assistant_id=?,instance_enc=?").bind(assistantID, instance).run();
  const sender = (await call("/seal", { purpose: `sender:${account.binding}`, value: `sender-${account.name}` })).result;
  await db.prepare("UPDATE notifier SET enabled=1,binding_id=?,sender_enc=?,check_start_hour=0,check_end_hour=24 WHERE id=?").bind(account.binding, sender, id).run();
  const config = { config_owner: "assistant", profile_id: account.binding, source_account_id: account.member, assistant_id: assistantID,
    source_generation: 1, revision: 1, max_topics: 20, following: { enabled: false, epoch: 0, enabled_at: 0 }, topics: [], applied_revision: 1,
    recipient_count: 1, capable_recipient_count: 1, last_seen: 0, last_checked: 0, runtime_status: "ready" };
  await db.prepare("UPDATE watch_control SET config=?,config_owner='assistant',ownership_committed=1,explicit_pairing=1,published_binding=?,next_sync=? WHERE id=?")
    .bind(JSON.stringify(config), account.binding, Date.now() + 86400000, id).run();
}
async function tick(id: number) {
  await db.exec("UPDATE control SET next_dispatch=0");
  const response = await request(`/accounts/${id}/notifier/tick`, "POST", {});
  expect(response.status).toBe(200);
  return response.json<any>();
}
async function claim(id: number, account: Account, now = Date.now() + 1000) {
  const source = JSON.parse((await db.prepare("SELECT config FROM watch_control WHERE id=?").bind(id).first<any>()).config);
  const qr = await call("/action", { action: "pair/qr", accountID: id, input: { join_existing: true }, now,
    responses: [{ body: health }, { body: source }, { body: { expires_at: new Date(now + 590000).toISOString() } }] });
  expect(qr.error).toBeUndefined();
  const input = { code: qr.result.code, pairing_code: `V2E-${"p".repeat(24)}`, device_id: physicalDevice,
    client_id: crypto.randomUUID(), client_secret: randomBytes(32).toString("base64url"), source_account_id: account.member, label: "Same phone" };
  const receipt = { paired: true, joined: true, binding_id: account.binding, username: account.name,
    device_id: physicalDevice, device_binding_id: crypto.randomUUID() };
  const paired = await call("/pair-notifier", { accountID: id, now, input, responses: [{ body: receipt }, { body: source }] });
  expect(paired.error).toBeUndefined();
  expect(paired.result.source_account_id).toBe(account.member);
  return input;
}

beforeAll(async () => {
  const compiled = await build({ entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false, format: "esm", target: "es2022", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-19", d1Databases: ["DB"],
    ratelimits: { APP_PAIR_RATE_LIMIT: { namespace_id: "4001", simple: { limit: 1000, period: 60 } } },
    bindings: { ADMIN_TOKEN: admin, NOTIFIER_KEY: key }, outboundService: upstream }));
  db = await mf.getD1Database("DB");
  migrations = await Promise.all((await readdir("migrations")).sort().map(async path => (await readFile(`migrations/${path}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " ")));
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results;
  for (const { name } of tables) await db.exec(`DROP TABLE ${name}`);
  for (const migration of migrations) await db.exec(migration);
  a = { member: 7, name: "alpha", cookie: "A2=alpha", pat: "alpha-pat", binding: "11111111-1111-4111-8111-111111111111", unread: 1 };
  b = { member: 8, name: "beta", cookie: "A2=beta", pat: "beta-pat", binding: "22222222-2222-4222-8222-222222222222", unread: 1 };
  calls = []; unexpected = []; memberGate = undefined;
});

describe("explicit multi-account boundaries", () => {
  it("validates both identities, rejects duplicates and never exposes credentials", async () => {
    const first = await create(a), second = await create(b);
    expect([first, second]).toEqual([1, 2]);
    const response = await request("/accounts");
    const list = await response.json<AccountsState>();
    expect(list.accounts.map(account => [account.id, account.account_id, account.username])).toEqual([[first, 7, "alpha"], [second, 8, "beta"]]);
    expect(JSON.stringify(list)).not.toContain(a.cookie);
    expect(JSON.stringify(list)).not.toContain(b.pat);
    const before = await snapshot(second, b.member);
    expect((await request("/accounts", "POST", { cookie: a.cookie, pat: a.pat })).status).toBe(409);
    expect(await snapshot(second, b.member)).toEqual(before);
    expect(unexpected).toEqual([]);
  });

  it("rejects mismatched Cookie/PAT and leaves the existing account unchanged", async () => {
    const first = await create(a), before = await snapshot(first, a.member);
    const response = await request("/accounts", "POST", { cookie: a.cookie, pat: b.pat });
    expect(response.status).toBe(409);
    expect(await snapshot(first, a.member)).toEqual(before);
    expect((await (await request("/accounts")).json<AccountsState>()).accounts).toHaveLength(1);
    expect((await request("/accounts", "POST", { cookie: b.cookie })).status).toBe(400);
  });

  it("updates only the selected identity and binds encrypted credentials to the local account", async () => {
    const first = await create(a), second = await create(b), before = await snapshot(first, a.member);
    expect((await request(`/accounts/${second}/notifier/credentials`, "PUT", { cookie: b.cookie, pat: b.pat })).status).toBe(200);
    expect(await snapshot(first, a.member)).toEqual(before);
    const stored = await db.prepare("SELECT payload FROM notifier_credentials WHERE id=?").bind(first).first<{ payload: string }>();
    await db.prepare("UPDATE notifier_credentials SET payload=? WHERE id=?").bind(stored!.payload, second).run();
    await db.prepare("UPDATE notifier SET verify_until=0 WHERE id=?").bind(second).run();
    const result = await request(`/accounts/${second}/notifier/verify`, "POST", {});
    expect(result.status).toBe(409);
    expect((await result.json<any>()).error).toContain("无法读取");
    expect(await snapshot(first, a.member)).toEqual(before);
  });

  it("keeps equal notification IDs, encrypted event bodies and delivery senders separate", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    const untouched = await snapshot(second, b.member);
    await tick(first);
    expect(await snapshot(second, b.member)).toEqual(untouched);
    await tick(second);
    const rows = (await db.prepare("SELECT account_id,notification_id,event_id,wire FROM notification_outbox ORDER BY account_id").all<any>()).results;
    expect(rows.map(row => [row.account_id, row.notification_id])).toEqual([[7, 100], [8, 100]]);
    expect(new Set(rows.map(row => row.event_id)).size).toBe(2);
    for (const row of rows) {
      expect(JSON.parse(row.wire).source_account_id).toBe(row.account_id);
      expect(JSON.stringify(row)).not.toContain("private for");
    }
    expect(calls.filter(call => call.path.endsWith("/sync")).map(call => call.member)).toEqual([7, 8]);
    expect(unexpected).toEqual([]);
    const foreign = await request(`/accounts/${first}/notifier/events/${rows[1].event_id}`);
    expect(foreign.status).toBe(404);
  });

  it("does not cancel another account's queued notification when one homepage becomes read", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    await tick(second);
    await db.prepare("UPDATE notification_outbox SET status='pending',attempts=0,wire=NULL WHERE account_id=?").bind(b.member).run();
    const before = await snapshot(second, b.member);
    a.unread = 0;
    await tick(first);
    expect(await snapshot(second, b.member)).toEqual(before);
  });

  it("isolates account PAT backoff while applying a shared denied-exit cooldown", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    a.failure = "pat429";
    await tick(first);
    expect((await state(first)).api_until).toBeGreaterThan(Date.now());
    expect((await state(second)).api_until).toBe(0);
    expect((await db.prepare("SELECT api_until FROM control").first<any>()).api_until).toBe(0);
    await tick(second);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notification_dedup WHERE account_id=8").first<any>()).n).toBe(1);
    a.failure = "web403";
    await db.prepare("UPDATE notifier SET api_until=0,scan_until=0,next_scan=0,scan_stage='idle' WHERE id=?").bind(first).run();
    await tick(first);
    expect((await db.prepare("SELECT web_until FROM control").first<any>()).web_until).toBeGreaterThan(Date.now());
    const before = calls.length;
    await db.prepare("UPDATE notifier SET next_scan=0,scan_until=0,scan_stage='idle' WHERE id=?").bind(second).run();
    await tick(second);
    expect(calls.slice(before).filter(call => call.path === "/")).toEqual([]);
  });

  it("scopes messages, check logs, outbox summaries and PAT metrics to the requested account", async () => {
    const first = await create(a), second = await create(b);
    for (const id of [first, second]) expect((await request(`/accounts/${id}/notifier/history`, "POST", {})).status).toBe(200);
    for (const [id, account] of [[first, a], [second, b]] as const) {
      const messages = await (await request(`/accounts/${id}/notifier/messages`)).json<any>();
      expect(messages.items[0].body).toBe(`private for ${account.name}`);
      const stateResponse = await (await request(`/accounts/${id}/state`)).json<any>();
      expect(stateResponse.notifier.account_id).toBe(account.member);
      expect(stateResponse.api_usage.hour_attempts).toBe(2);
      const records = await (await request(`/accounts/${id}/notifier/records?view=checks`)).json<any>();
      expect(records.items).toHaveLength(1);
    }
    expect((await request("/accounts/999/state")).status).toBe(404);
    expect(unexpected).toEqual([]);
  });

  it("publishes independent unread snapshots and preserves another account during refresh", async () => {
    const first = await create(a), second = await create(b);
    async function refresh(id: number) {
      const result = await (await request(`/accounts/${id}/notifier/unread/refresh`, "POST", {})).json<any>();
      expect(result.error).toBeUndefined();
      const continued = await (await request(`/accounts/${id}/notifier/unread/refresh`, "POST", { refresh_id: result.refresh_id })).json<any>();
      expect(continued.complete).toBe(true);
    }
    await refresh(second);
    const before = await snapshot(second, b.member);
    await refresh(first);
    expect(await snapshot(second, b.member)).toEqual(before);
    for (const [id, account] of [[first, a], [second, b]] as const) {
      const page = await (await request(`/accounts/${id}/notifier/unread`)).json<any>();
      expect(page.items[0].body).toBe(`private for ${account.name}`);
    }
  });

  it("authorizes direct clients by token ownership and revokes only the selected account", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    const alpha = await claim(first, a), beta = await claim(second, b);
    const replayedID = { ...beta, client_id: alpha.client_id };
    expect((await request("/app/v1/pair", "POST", replayedID, "")).status).toBe(403);
    const replayedToken = { ...beta, client_id: crypto.randomUUID(), client_secret: alpha.client_secret };
    expect((await request("/app/v1/pair", "POST", replayedToken, "")).status).toBe(403);
    const operation = { operation_id: crypto.randomUUID(), profile_id: b.binding, source_generation: 1, base_revision: 1, action: "add_topic", topic_id: 123 };
    expect((await request("/app/v1/watches", "PUT", operation, alpha.client_secret)).status).toBe(400);
    expect((await request("/app/v1/watches", "PUT", operation, beta.client_secret)).status).toBe(200);
    const betaBefore = await snapshot(second, b.member);
    expect((await request(`/accounts/${first}/notifier/watch/clients/revoke`, "POST", { client_id: alpha.client_id })).status).toBe(200);
    expect((await request("/app/v1/watches", "GET", undefined, alpha.client_secret)).status).toBe(401);
    const allowed = await request("/app/v1/watches", "GET", undefined, beta.client_secret);
    expect(allowed.status).toBe(200);
    expect((await allowed.json<any>()).source_account_id).toBe(b.member);
    expect(await snapshot(second, b.member)).toEqual(betaBefore);
  });

  it("isolates identical watch targets and pauses only one account's baseline", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    for (const [id, account] of [[first, a], [second, b]] as const) {
      expect((await request(`/accounts/${id}/notifier/watch/config`, "POST", { operation_id: crypto.randomUUID(), profile_id: account.binding,
        source_generation: 1, base_revision: 1, action: "add_topic", topic_id: 123 })).status).toBe(200);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM watch_targets WHERE target_key='topic:123'").first<any>()).n).toBe(2);
    const before = await snapshot(second, b.member);
    expect((await request(`/accounts/${first}/notifier/config`, "PUT", { enabled: false })).status).toBe(200);
    expect(await snapshot(second, b.member)).toEqual(before);
  });

  it("serializes simultaneous mutations and never commits a stale validation lease", async () => {
    await create(a);
    let release!: () => void, mark!: () => void;
    memberGate = { member: b.member, promise: new Promise(resolve => { release = resolve; }), release: () => release(),
      entered: new Promise(resolve => { mark = resolve; }), mark: () => mark() };
    const pending = request("/accounts", "POST", { cookie: b.cookie, pat: b.pat });
    await memberGate.entered;
    expect((await request("/accounts", "POST", { cookie: b.cookie, pat: b.pat })).status).toBe(409);
    await db.exec("UPDATE control SET lease='new-owner'");
    memberGate.release();
    expect((await pending).status).toBe(500);
    expect((await (await request("/accounts")).json<AccountsState>()).accounts.map(account => account.account_id)).toEqual([7]);
    expect((await db.prepare("SELECT lease FROM control").first<any>()).lease).toBe("new-owner");
  });

  it("advances the fair cursor after an account failure and skips sleeping accounts", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    const now = Date.now() + 1000;
    await db.exec("UPDATE notifier SET verified_at=0");
    let result = await call("/round", { now, responses: [{ status: 401 }] });
    expect(result.error).toBeUndefined();
    expect((await state(first)).blocked).toBe("credentials");
    result = await call("/round", { now: now + 60001, responses: [
      { body: { success: true, result: { id: b.member, username: b.name } } }, { body: home(b) },
      { body: { success: true, result: [notice(b)] } },
    ] });
    expect(result.error).toBeUndefined();
    expect(result.calls[0].headers.authorization).toBe(`Bearer ${b.pat}`);
    expect((await db.prepare("SELECT last_notifier_id FROM control").first<any>()).last_notifier_id).toBe(second);
    // At 01:00 UTC+8 A sleeps, while B has an all-day window.
    const midnight = Date.UTC(2030, 0, 1, 17);
    await db.prepare("UPDATE notifier SET blocked='',verified_at=?,next_dispatch=0,check_start_hour=8,check_end_hour=24 WHERE id=?").bind(midnight, first).run();
    await db.prepare("UPDATE notifier SET next_dispatch=0,verified_at=? WHERE id=?").bind(midnight, second).run();
    await db.exec("UPDATE control SET next_dispatch=0,last_notifier_id=0");
    await db.exec("UPDATE watch_control SET next_sync=9999999999999");
    result = await call("/round", { now: midnight, responses: [{ body: home(b) }, { body: { success: true, result: [notice(b)] } }] });
    expect(result.error).toBeUndefined();
    expect((await db.prepare("SELECT last_notifier_id FROM control").first<any>()).last_notifier_id).toBe(second);
  });
  it("requires an independent explicit pairing for each account on the same device", async () => {
    const first = await create(a), second = await create(b);
    await paired(first, a); await paired(second, b);
    const now = Date.now() + 1000;
    const alpha = await claim(first, a, now), beta = await claim(second, b, now);
    const betaBefore = await snapshot(second, b.member);
    const retried = await call("/pair-notifier", { accountID: first, now, input: alpha });
    expect(retried.calls).toEqual([]);
    expect(retried.result.source_account_id).toBe(a.member);
    const replacement = await claim(first, a, now);
    expect(await snapshot(second, b.member)).toEqual(betaBefore);
    expect((await request("/app/v1/watches", "GET", undefined, alpha.client_secret)).status).toBe(401);
    expect((await request("/app/v1/watches", "GET", undefined, replacement.client_secret)).status).toBe(200);
    expect((await request("/app/v1/watches", "GET", undefined, beta.client_secret)).status).toBe(200);
    const wrongAccount = await call("/pair-notifier", { accountID: first, now, input: { ...replacement, source_account_id: b.member } });
    expect(wrongAccount.status).toBe(403);
    expect(wrongAccount.calls).toEqual([]);
  });

  it("does not fall back to deployment Secrets for a different local account", async () => {
    await create(a); const second = await create(b);
    await db.prepare("DELETE FROM notifier_credentials WHERE id=?").bind(second).run();
    const result = await call("/action", { accountID: second, action: "verify", now: Date.now() + 1000,
      env: { V2EX_COOKIE: a.cookie, V2EX_PAT: a.pat } });
    expect(result.error).toContain("请配置 Cookie 和 PAT");
    expect(result.calls).toEqual([]);
    expect((await state(second)).account_id).toBe(b.member);
  });

  it("rejects account 21 before spending any upstream request", async () => {
    await create(a);
    await db.batch(Array.from({ length: 19 }, (_, index) => db.prepare("INSERT INTO notifier(account_id,username) VALUES(?,?)").bind(100 + index, `synthetic${index}`)));
    const before = calls.length;
    const response = await request("/accounts", "POST", { cookie: b.cookie, pat: b.pat });
    expect(response.status).toBe(409);
    expect((await response.json<any>()).error).toContain("20");
    expect(calls).toHaveLength(before);
  });

  it("never reuses an unsuccessful candidate's diagnostic account namespace", async () => {
    const first = await create(a);
    expect((await request("/accounts", "POST", { cookie: a.cookie, pat: a.pat })).status).toBe(409);
    await db.exec("UPDATE control SET account_creation_until=0");
    const second = await create(b);
    expect([first, second]).toEqual([1, 2]);
    const data = await (await request(`/accounts/${second}/state`)).json<any>();
    expect(data.api_usage.hour_attempts).toBe(1);
  });

  it("keeps failed onboarding cooldown separate from a working account", async () => {
    const existing = await create(b);
    a.failure = "pat429";
    const failed = await request("/accounts", "POST", { cookie: a.cookie, pat: a.pat });
    expect(failed.status).toBe(409);
    const control = await db.prepare("SELECT account_creation_until FROM control").first<any>();
    expect(control.account_creation_until).toBeGreaterThan(Date.now() + 110000);
    const before = calls.length;
    expect((await request("/accounts", "POST", { cookie: a.cookie, pat: a.pat })).status).toBe(409);
    expect(calls).toHaveLength(before);
    expect((await request(`/accounts/${existing}/notifier/history`, "POST", {})).status).toBe(200);
    expect((await state(existing)).api_until).toBe(0);
  });

  it("does not attach failed initial PAT usage or quota to the first verified account", async () => {
    a.failure = "pat429";
    expect((await request("/accounts", "POST", { cookie: a.cookie, pat: a.pat })).status).toBe(409);
    expect((await state(1)).account_id).toBe(0);
    await db.exec("UPDATE control SET account_creation_until=0");
    const first = await create(b);
    expect(first).toBe(1);
    expect((await state(first)).api_until).toBe(0);
    const status = await (await request(`/accounts/${first}/state`)).json<any>();
    expect(status.api_usage.hour_attempts).toBe(1);
    expect(status.api_usage.active_backoff).toBeNull();
  });

});
