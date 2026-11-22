import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { WatchConfig } from "../shared/watch-contracts";

let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const admin = "synthetic-admin".repeat(5), profile = "11111111-1111-4111-8111-111111111111";
let config: WatchConfig;
async function request(path: string, method: string, body?: unknown, secret?: string) {
  return mf.dispatchFetch(`https://assistant.example/api${path}`, { method,
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function claim() {
  const p = await unifiedInvitation();
  const result = await call("/pair-notifier", { input: p.input, now: p.now,
    responses: [{ body: p.receipt }, { body: source() }] });
  expect(result.error).toBeUndefined();
  return p.input;
}
async function state() { return JSON.parse((await db.prepare("SELECT config FROM watch_control").first<{ config: string }>())!.config) as WatchConfig; }
function operation(action: string, extra = {}, base = config.revision) {
  return { operation_id: crypto.randomUUID(), profile_id: profile, source_generation: config.source_generation, base_revision: base, action, ...extra };
}
beforeAll(async () => {
  const compiled = await build({ entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0]!.text, compatibilityDate: "2026-06-22",
    compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    ratelimits: { APP_PAIR_RATE_LIMIT: { namespace_id: "4001", simple: { limit: 1000, period: 60 } } },
    bindings: { ADMIN_TOKEN: admin, NOTIFIER_KEY: "ab".repeat(32), V2EX_COOKIE: "A2=synthetic", V2EX_PAT: "synthetic" } }));
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) await db.exec((await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "));
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.exec("DELETE FROM notifier_credentials");
  await db.exec("DELETE FROM notifier_pairing_invitation; DELETE FROM watch_app_clients; DELETE FROM watch_local_operations; DELETE FROM watch_targets; DELETE FROM watch_cancellations; DELETE FROM notification_outbox; UPDATE control SET lease='',lease_until=0; UPDATE notifier SET enabled=0,account_id=7,blocked='';");
  config = { config_owner: "assistant", profile_id: profile, source_account_id: 7, assistant_id: "22222222-2222-4222-8222-222222222222",
    revision: 1, source_generation: 1, max_topics: 20, following: { enabled: false, epoch: 0, enabled_at: 0 }, topics: [],
    applied_revision: 1, recipient_count: 1, capable_recipient_count: 1, last_seen: 0, last_checked: 0, runtime_status: "ready" };
  await db.prepare("UPDATE notifier SET binding_id=? WHERE id=1").bind(profile).run();
  await db.prepare("UPDATE watch_control SET explicit_pairing=1,config=?,config_owner='assistant',ownership_committed=1,assistant_id=? WHERE id=1")
    .bind(JSON.stringify(config), config.assistant_id).run();
});

it("rate limits native pairing before reading D1 and retires the old watch pairing route", async () => {
  const response = await mf.dispatchFetch("https://assistant.example/api/app/v1/pair", {
    method: "POST", headers: { "X-Test-Deny-App-Pair": "1" },
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(await response.json()).toMatchObject({ error: "rate_limited", retry_at: expect.any(Number) });
  const retired = await mf.dispatchFetch("https://assistant.example/api/app/v1/watch/pair", {
    method: "POST", headers: { "X-Test-Deny-App-Pair": "1" },
  });
  expect(retired.status).toBe(404);
});

it("accepts only the paired device credential for watch management and recovers a completed pairing during a lease", async () => {
  expect((await request("/app/v1/watches", "GET", undefined, admin)).status).toBe(401);
  const input = await claim();
  await db.prepare("UPDATE control SET lease='scheduled',lease_until=?").bind(Date.now() + 60000).run();
  expect((await request("/app/v1/pair", "POST", input)).status).toBe(200);
  expect((await request("/app/v1/watches", "GET", undefined, input.client_secret)).status).toBe(200);
  expect((await request("/state", "GET", undefined, input.client_secret)).status).toBe(401);
});

it("rejects invalid App invitations before the shared lease or usage write", async () => {
  const p = await unifiedInvitation();
  await db.prepare("UPDATE control SET lease='scheduled',lease_until=?").bind(Date.now() + 60000).run();
  const usage = () => db.prepare("SELECT SUM(http) AS n FROM daily").first("n");
  const before = await usage();
  const invalidPair = await request("/app/v1/pair", "POST", { ...p.input, code: `V2N-${"x".repeat(24)}` });
  expect(invalidPair.status).toBe(400);
  expect(await invalidPair.json()).toMatchObject({ error: "二维码或账号凭据已变更，请重新生成并扫码" });
  const saved = (await db.prepare("SELECT content_enc FROM notifier_pairing_invitation").first<string>("content_enc"))!;
  const obsolete = (await call("/open", { purpose: "pairing-invitation", value: saved })).result;
  delete obsolete.direct;
  const legacy = (await call("/seal", { purpose: "pairing-invitation", value: obsolete })).result;
  await db.prepare("UPDATE notifier_pairing_invitation SET content_enc=?").bind(legacy).run();
  const retired = await request("/app/v1/pair", "POST", p.input);
  expect(retired.status).toBe(400);
  expect(await retired.json()).toMatchObject({ error: "请在通知助手重新生成 App 连接二维码" });
  await db.prepare("UPDATE notifier_pairing_invitation SET content_enc=?").bind(saved).run();
  expect(await usage()).toBe(before);
  expect(await db.prepare("SELECT lease FROM control").first("lease")).toBe("scheduled");
  expect((await request("/app/v1/pair", "POST", p.input)).status).toBe(409);
});

it("returns confirmation only after rules, targets and operation receipt are durable and never calls the push service", async () => {
  const client = await claim(), input = operation("add_topic", { topic_id: 42 });
  const response = await request("/app/v1/watches", "PUT", input, client.client_secret);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ applied_revision: 2, revision: 2, operation_revision: 2, topics: [{ topic_id: 42 }] });
  expect((await state()).topics).toHaveLength(1);
  expect(await db.prepare("SELECT topic_id FROM watch_targets").first()).toMatchObject({ topic_id: 42 });
  expect(await db.prepare("SELECT revision FROM watch_local_operations").first()).toMatchObject({ revision: 2 });
  expect((await request("/app/v1/watches", "PUT", input, client.client_secret)).status).toBe(200);
  expect((await state()).revision).toBe(2);
  expect((await request("/app/v1/watches", "PUT", { ...input, topic_id: 43 }, client.client_secret)).status).toBe(409);
});

it("serializes competing final slots, counts paused topics and rejects stale edits", async () => {
  config.topics = Array.from({ length: 19 }, (_, i) => ({ topic_id: i + 1, enabled: false, epoch: 1, enabled_at: 1 }));
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  const client = await claim();
  const responses = await Promise.all([20, 21].map(topic_id => request("/app/v1/watches", "PUT", operation("add_topic", { topic_id }), client.client_secret)));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await state()).topics).toHaveLength(20);
  const overflow = await request("/app/v1/watches", "PUT", operation("add_topic", { topic_id: 22 }, 2), client.client_secret);
  expect(overflow.status).toBe(409); expect(await overflow.json()).toMatchObject({ error: "watch_topic_limit" });
  const stale = await request("/app/v1/watches", "PUT", operation("remove_topic", { topic_id: 1 }), client.client_secret);
  expect(stale.status).toBe(409); expect((await state()).topics).toHaveLength(20);
});

it("revokes direct clients immediately and rejects an old source generation or incomplete migration", async () => {
  const client = await claim();
  expect((await request("/notifier/watch/clients/revoke", "POST", { client_id: client.client_id }, admin)).status).toBe(200);
  expect((await request("/app/v1/watches", "GET", undefined, client.client_secret)).status).toBe(401);
  expect((await request("/app/v1/pair", "POST", client)).status).toBe(403);
  const next = await claim(); config.source_generation = 2;
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  expect((await request("/app/v1/watches", "PUT", operation("add_topic", { topic_id: 42 }), next.client_secret)).status).toBe(401);
  await db.exec("UPDATE watch_control SET ownership_committed=0");
  expect((await request("/app/v1/watches", "GET", undefined, next.client_secret)).status).toBe(409);
});

it("rejects expired invitations and overlarge or unexpected native request fields", async () => {
  const p = await unifiedInvitation();
  await db.exec("UPDATE notifier_pairing_invitation SET expires_at=1");
  expect((await request("/app/v1/pair", "POST", p.input)).status).toBe(400);
  expect((await request("/app/v1/pair", "POST", { ...p.input, admin: "not-accepted" })).status).toBe(400);
  expect((await request("/app/v1/pair", "POST", { padding: "a".repeat(17000) })).status).toBe(400);
});

async function call(path: string, data: unknown) {
  return (await mf.dispatchFetch(`https://assistant.example${path}`, { method: "POST", body: JSON.stringify(data) })).json<any>();
}
function source() {
  return { profile_id: profile, source_account_id: 7, assistant_id: config.assistant_id,
    source_generation: config.source_generation, config_owner: "assistant", recipient_count: 2, capable_recipient_count: 2 };
}
async function unifiedInvitation(first = false, credentials = { cookie: "A2=synthetic", pat: "synthetic" }) {
  const now = Date.now() + 1000;
  const sender = (await call("/seal", { purpose: `sender:${profile}`, value: "synthetic-sender" })).result;
  const instance = (await call("/seal", { purpose: `watch-instance:${config.assistant_id}`, value: "synthetic-instance" })).result;
  const scope = createHash("sha256").update(JSON.stringify([credentials.cookie, credentials.pat])).digest("hex");
  await db.prepare("UPDATE notifier SET username='tester',credential_scope=?,verified_at=?,pair_until=0,binding_id=?,sender_enc=?")
    .bind(scope, now, first ? "" : profile, sender).run();
  await db.prepare("UPDATE assistant_instance SET assistant_id=?,instance_enc=?").bind(config.assistant_id, instance).run();
  await db.prepare("UPDATE watch_control SET published_binding=?,instance_enc=?").bind(first ? "" : profile, instance).run();
  if (first) await db.exec("UPDATE watch_control SET config_owner='central',ownership_committed=0,config=''");
  const responses = [{ body: { notifier_direct_pairing: 1 } }, ...(!first ? [{ body: source() }] : []),
    { body: { expires_at: new Date(now + 590000).toISOString() } }];
  const made = await call("/action", { action: "pair/qr", input: { join_existing: !first }, now, responses });
  expect(made.error).toBeUndefined(); expect(made.result.direct).toBe(true);
  const input = { code: made.result.code, pairing_code: `V2E-${"p".repeat(24)}`, device_id: crypto.randomUUID(),
    client_id: crypto.randomUUID(), client_secret: randomBytes(32).toString("base64url"), source_account_id: 7, label: "Test phone" };
  const receipt = { paired: true, joined: !first, binding_id: profile, device_id: input.device_id,
    device_binding_id: first ? profile : crypto.randomUUID(), username: "tester" };
  return { input, receipt, now };
}

it.each(["secrets", "settings"] as const)("binds a fresh App with %s credentials and grants watch management in one direct request", async sourceKind => {
  const credentials = sourceKind === "settings"
    ? { cookie: "A2=saved-cookie", pat: "saved-pat" }
    : { cookie: "A2=synthetic", pat: "synthetic" };
  if (sourceKind === "settings") {
    const payload = (await call("/seal", { purpose: "v2ex-credentials", value: credentials })).result;
    await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at) VALUES(1,?,?)").bind(payload, Date.now()).run();
  }
  const p = await unifiedInvitation(true, credentials);
  const result = await call("/pair-notifier", { input: p.input, now: p.now, responses: [
    { body: p.receipt }, { body: { watch_direct: 1, notifier_explicit_pairing: 1 } }, { body: { published: true, ready: true, connection_id: profile } },
    { body: { ...source(), config_owner: "handoff", legacy_config: config } }, { body: source() },
  ] });
  expect(result.error).toBeUndefined();
  expect(result.result).toMatchObject({ paired: true, watch_management: true, device_id: p.input.device_id, binding_id: profile, connection_id: profile });
  expect(result.calls[0].body).toEqual({ code: p.input.code, pairing_code: p.input.pairing_code });
  expect(result.calls.every((c: any) => !JSON.stringify(c).includes(p.input.client_secret))).toBe(true);
  expect(result.calls.every((c: any) => new URL(c.url).hostname !== "www.v2ex.com")).toBe(true);
  expect((await request("/app/v1/watches", "GET", undefined, p.input.client_secret)).status).toBe(200);
  const saved = await db.prepare("SELECT * FROM watch_app_clients").first();
  expect(JSON.stringify(saved)).not.toContain(p.input.client_secret);
  expect(await db.prepare("SELECT enabled FROM notifier").first()).toMatchObject({ enabled: 0 });
});

it("recovers personal success followed by a failed control sync after QR expiry without exchanging again", async () => {
  config.topics = [{ topic_id: 42, enabled: true, epoch: 1, enabled_at: 1 }];
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  const p = await unifiedInvitation();
  const partial = await call("/pair-notifier", { input: p.input, now: p.now, responses: [{ body: p.receipt }, { error: true }] });
  expect(partial.error).toBeDefined();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM watch_app_clients").first()).toMatchObject({ n: 0 });
  const recovered = await call("/pair-notifier", { input: p.input, now: p.now + 700000, responses: [{ body: source() }] });
  expect(recovered.error).toBeUndefined(); expect(recovered.result.watch_management).toBe(true);
  expect(recovered.calls).toHaveLength(1); expect(recovered.calls[0].url).toContain("/v1/watches/source");
  expect((await state()).topics).toEqual(config.topics);
});

it("persists the claimant before exchange and rejects another client or changed request on retry", async () => {
  const p = await unifiedInvitation();
  const lost = await call("/pair-notifier", { input: p.input, now: p.now, responses: [{ error: true }] });
  expect(lost.error).toBeDefined();
  for (const changed of [{ client_id: crypto.randomUUID() }, { client_secret: "b".repeat(43) }, { label: "Changed" },
    { import_config: { profile_id: profile, source_account_id: 7, source_generation: 1, following: true, topics: [] } }]) {
    const result = await call("/pair-notifier", { input: { ...p.input, ...changed }, now: p.now + 60000 });
    expect(result.error).toContain("另一台设备"); expect(result.calls).toHaveLength(0);
  }
  const retry = await call("/pair-notifier", { input: p.input, now: p.now + 60000,
    responses: [{ body: p.receipt }, { body: source() }] });
  expect(retry.error).toBeUndefined();
  expect(retry.calls[0].body).toEqual(lost.calls[0].body);
  expect(retry.calls[0].headers.authorization).toEqual(lost.calls[0].headers.authorization);
});

it("treats a rejected join exchange as a dead QR and allows an immediate new one", async () => {
  const p = await unifiedInvitation();
  const pairingRows = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM notification_checks WHERE source='pairing'").first<{ n: number }>())!.n;
  const before = await pairingRows();
  const failed = await call("/pair-notifier", { input: p.input, now: p.now,
    responses: [{ status: 403, body: { error: "connection_unavailable_or_account_mismatch" } }] });
  expect(failed.calls[0].url).toContain("/v1/connection-invitations/exchange");
  expect(failed.status).toBe(410);
  expect(failed.error).toContain("重新生成并扫码");
  expect(failed.retryAt).toBe(0);
  // The paired failure is visible in the records page, with no credentials.
  expect(await pairingRows()).toBe(before + 1);
  const recorded = await db.prepare("SELECT stage_before,outcome,detail FROM notification_checks WHERE source='pairing' ORDER BY rowid DESC LIMIT 1").first<{ stage_before: string; outcome: string; detail: string }>();
  expect(recorded).toMatchObject({ stage_before: "pairing_app", outcome: "error" });
  expect(recorded!.detail).toContain("重新生成");
  // The dead invitation is dropped and the pairing cooldown lifted, so a new
  // QR is available at once instead of being locked out for 15 minutes.
  expect(await db.prepare("SELECT COUNT(*) AS n FROM notifier_pairing_invitation").first()).toMatchObject({ n: 0 });
  expect(await db.prepare("SELECT pair_until FROM notifier").first()).toMatchObject({ pair_until: 0 });
  const next = await call("/action", { action: "pair/qr", input: { join_existing: true }, now: p.now + 1000,
    responses: [{ body: { notifier_direct_pairing: 1 } }, { body: source() },
      { body: { expires_at: new Date(p.now + 591000).toISOString() } }] });
  expect(next.error).toBeUndefined(); expect(next.result.code).toMatch(/^V2N-/);
  expect(await pairingRows()).toBe(before + 2);
  expect(await db.prepare("SELECT stage_before,outcome FROM notification_checks WHERE source='pairing' ORDER BY rowid DESC LIMIT 1").first())
    .toMatchObject({ stage_before: "pairing_qr", outcome: "ok" });
});

it("keeps a durable completion receipt and never resurrects revoked grants", async () => {
  const p = await unifiedInvitation();
  const complete = await call("/pair-notifier", { input: p.input, now: p.now, responses: [{ body: p.receipt }, { body: source() }] });
  expect(complete.error).toBeUndefined();
  await db.exec("DELETE FROM notifier_pairing_invitation");
  const retry = await call("/pair-notifier", { input: p.input, now: p.now + 86400000 });
  expect(retry.error).toBeUndefined(); expect(retry.result).toEqual(complete.result); expect(retry.calls).toHaveLength(0);
  expect((await call("/pair-notifier", { input: { ...p.input, label: "changed" }, now: p.now })).error).toBeDefined();
  await request("/notifier/watch/clients/revoke", "POST", { client_id: p.input.client_id }, admin);
  expect((await call("/pair-notifier", { input: p.input, now: p.now })).error).toContain("撤销");
  expect((await request("/app/v1/watches", "GET", undefined, p.input.client_secret)).status).toBe(401);
});

it("rejects a mismatched account, excess fields, and a mismatched central device before granting management", async () => {
  const p = await unifiedInvitation();
  for (const input of [{ ...p.input, source_account_id: 8 }, { ...p.input, device_secret: "must-not-send" }]) {
    const result = await call("/pair-notifier", { input, now: p.now });
    expect(result.error).toBeDefined(); expect(result.calls).toHaveLength(0);
  }
  const invalid = await call("/pair-notifier", { input: p.input, now: p.now,
    responses: [{ body: { ...p.receipt, device_id: crypto.randomUUID() } }] });
  expect(invalid.error).toContain("回执不匹配");
  expect(await db.prepare("SELECT COUNT(*) AS n FROM watch_app_clients").first()).toMatchObject({ n: 0 });
  expect((await request("/app/v1/pair", "POST", {})).status).toBe(400);
});

it("imports confirmed rules during a source transfer but never overwrites current edits", async () => {
  config.source_generation = 2;
  await db.prepare("UPDATE watch_control SET config=?").bind(JSON.stringify(config)).run();
  const p = await unifiedInvitation();
  const input = { ...p.input, import_config: { profile_id: profile, source_account_id: 7, source_generation: 1,
    following: true, topics: [{ topic_id: 42, enabled: true }] } };
  const result = await call("/pair-notifier", { input, now: p.now, responses: [{ body: p.receipt }, { body: source() }] });
  expect(result.error).toBeUndefined(); expect((await state()).topics.map(t => t.topic_id)).toEqual([42]);
  const reordered = { ...input, import_config: { topics: [{ enabled: true, topic_id: 42 }], following: true,
    source_generation: 1, source_account_id: 7, profile_id: profile } };
  const retry = await call("/pair-notifier", { input: reordered, now: p.now });
  expect(retry.error).toBeUndefined(); expect(retry.result).toEqual(result.result); expect(retry.calls).toHaveLength(0);
  expect((await state()).following.enabled).toBe(true);
  // Remove all rules intentionally, then re-pair with an old snapshot.
  await request("/app/v1/watches", "PUT", operation("remove_topic", { topic_id: 42 }, 2), input.client_secret);
  await request("/app/v1/watches", "PUT", operation("set_following", { enabled: false }, 3), input.client_secret);
  const next = await unifiedInvitation();
  const noOverwrite = await call("/pair-notifier", { input: { ...next.input, import_config: input.import_config }, now: next.now,
    responses: [{ body: next.receipt }, { body: source() }] });
  expect(noOverwrite.error).toBeUndefined(); expect((await state()).topics).toEqual([]); expect((await state()).following.enabled).toBe(false);
});

it("replaces only the same device's old management credential when the client list is full", async () => {
  const p = await unifiedInvitation();
  const initial = await call("/pair-notifier", { input: p.input, now: p.now, responses: [{ body: p.receipt }, { body: source() }] });
  expect(initial.error).toBeUndefined();
  for (let n = 0; n < 19; n++) {
    await db.prepare(`INSERT INTO watch_app_clients(id,token_hash,invitation_hash,profile_id,source_generation,account_id,label,created_at,last_seen)
      VALUES(?,?,?,?,1,7,'Legacy',1,1)`).bind(crypto.randomUUID(), `hash-${n}`, `invitation-${n}`, profile).run();
  }
  const next = await unifiedInvitation();
  const refused = await call("/pair-notifier", { input: next.input, now: next.now });
  expect(refused.error).toContain("20 台"); expect(refused.calls).toHaveLength(0);
  next.input.device_id = p.input.device_id; next.receipt.device_id = p.input.device_id;
  const replacement = await call("/pair-notifier", { input: next.input, now: next.now,
    responses: [{ body: next.receipt }, { body: source() }] });
  expect(replacement.error).toBeUndefined();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM watch_app_clients WHERE revoked_at=0").first()).toMatchObject({ n: 20 });
  expect((await request("/app/v1/watches", "GET", undefined, p.input.client_secret)).status).toBe(401);
  expect((await request("/app/v1/watches", "GET", undefined, next.input.client_secret)).status).toBe(200);
  expect((await call("/pair-notifier", { input: p.input, now: next.now })).error).toContain("撤销");
});
