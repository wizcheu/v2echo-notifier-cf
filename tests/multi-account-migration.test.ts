import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";

let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let original: string[], migration: string;
const name = "0018_multi_account.sql";
const admin = "synthetic-migration-admin-".repeat(3);
const binding = "11111111-1111-4111-8111-111111111111";
const assistant = "22222222-2222-4222-8222-222222222222";
const cookie = "A2=stored-legacy-cookie", pat = "stored-legacy-pat";
const flatten = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\n/g, " ");
async function call(path: string, data: unknown) {
  return (await mf.dispatchFetch(`http://local${path}`, { method: "POST", body: JSON.stringify(data) })).json<any>();
}
async function seal(purpose: string, value: unknown) { return (await call("/seal", { purpose, value })).result as string; }
async function schema() { return (await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all()).results; }
async function snapshot() {
  const result: Record<string, any[]> = {};
  for (const table of ["notifier", "notifier_credentials", "notification_candidates", "notification_outbox", "notification_dedup", "notification_history", "notification_samples",
    "notifier_pairing_invitation", "notifier_source_transfer", "watch_control", "watch_targets", "watch_app_clients", "watch_app_invitation", "watch_dedup", "unread_control", "unread_items", "api_usage", "api_daily"])
    result[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  return result;
}
async function apply(sql = migration) {
  if (await db.prepare("SELECT id FROM d1_migrations WHERE name=?").bind(name).first()) return;
  // cf combines one complete migration file and its applied-name insert in one request.
  await db.exec(flatten(`${sql}\nINSERT INTO d1_migrations(name) VALUES('${name}');`));
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false, format: "esm", target: "es2022", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-19", d1Databases: ["DB"],
    bindings: { ADMIN_TOKEN: admin, NOTIFIER_KEY: "ab".repeat(32), V2EX_COOKIE: "A2=deployment-cookie", V2EX_PAT: "deployment-pat" } }));
  db = await mf.getD1Database("DB");
  const names = (await readdir("migrations")).sort();
  original = await Promise.all(names.filter(path => path < name).map(path => readFile(`migrations/${path}`, "utf8")));
  migration = await readFile(`migrations/${name}`, "utf8");
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  for (const { name: table } of (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results)
    await db.exec(`DROP TABLE ${table}`);
  for (const file of original) await db.exec(flatten(file));
  await db.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)");
  const sender = await seal(`sender:${binding}`, "legacy-sender");
  const credentials = await seal("v2ex-credentials", { cookie, pat });
  const instance = await seal(`watch-instance:${assistant}`, "legacy-instance");
  const pending = await seal("pending-pair", { code: "V2E-" + "p".repeat(24), sender: "pending-sender", account: 7, username: "tester" });
  const qr = await seal("pairing-invitation", { code: "V2N-" + "q".repeat(24), sender: "qr-sender", account: 7, username: "tester" });
  await db.prepare("UPDATE notifier SET account_id=7,username='tester',enabled=1,binding_id=?,sender_enc=?,pair_enc=?,pair_expires=1,scan_stage='page',scan_id='scan',scan_page=3,scan_collected=40,scan_min=80,scan_head='[100,99]',unread=50,verified_at=123,scan_until=456,relay_until=789,history_next_page=8 WHERE id=1").bind(binding, sender, pending).run();
  await db.prepare("INSERT INTO notifier_credentials VALUES(1,?,123)").bind(credentials).run();
  await db.prepare("UPDATE watch_control SET assistant_id=?,instance_enc=?,published_binding=?,config='legacy-config',config_owner='assistant',ownership_committed=1,ownership_revision=9 WHERE id=1").bind(assistant, instance, binding).run();
  await db.prepare("INSERT INTO notifier_pairing_invitation VALUES(1,?,1)").bind(qr).run();
  await db.exec(flatten(`
    INSERT INTO notification_candidates VALUES('scan',100,'candidate-cipher','reply','',0);
    INSERT INTO notification_outbox(event_id,account_id,notification_id,binding_id,type,kind,unread,avatar_url,content_enc,wire,status,attempts,receipt_attempts,created_at,expires_at,updated_at)
      VALUES('immutable-event',7,99,'${binding}','notification','reply',50,'','content-cipher','immutable-wire','submitted',2,3,100,9999999999999,200);
    INSERT INTO notification_dedup VALUES(7,99,'immutable-event');
    INSERT INTO notification_history(account_id,notification_id,kind,created_at,fetched_at,content_enc) VALUES(7,99,'reply',1,2,'history-cipher');
    INSERT INTO notification_samples VALUES(7,'reply',99,'sample-cipher','',123);
    INSERT INTO watch_targets(target_key,topic_id,epoch,enabled_at,state_enc,next_check,checking) VALUES('topic:123',123,4,100,'watch-cipher',200,1);
    INSERT INTO watch_dedup VALUES(7,'topic_reply',123,456,'watch-event');
    INSERT INTO watch_app_clients(id,token_hash,invitation_hash,profile_id,source_generation,account_id,label,created_at,last_seen,device_id,binding_id,request_hash)
      VALUES('client','token-hash','invite-hash','${binding}',3,7,'phone',123,456,'device','${binding}','request-hash');
    UPDATE unread_control SET account_id=7,snapshot_id='snapshot',refresh_id='refresh',stage='page',collected=20 WHERE id=1;
    INSERT INTO unread_items VALUES('snapshot',99,'reply','',100,'unread-cipher');
    INSERT INTO api_usage(id,source,endpoint,attempted_at) VALUES('usage','notifier','member',100);
    INSERT INTO api_daily VALUES('2026-11-12','notifier','member',3,2,1,1,0);
  `));
});

it("preserves the legacy account, encrypted state, immutable wire and all account ownership", async () => {
  const before = await snapshot();
  const oldInstance = before.watch_control[0];
  await apply();
  const after = await snapshot();
  for (const [table, rows] of Object.entries(before)) {
    expect(after[table]).toHaveLength(rows.length);
    for (const [index, row] of rows.entries()) expect(after[table][index]).toMatchObject(row);
  }
  expect(await db.prepare("SELECT assistant_id,instance_enc FROM assistant_instance").first()).toEqual({ assistant_id: oldInstance.assistant_id, instance_enc: oldInstance.instance_enc });
  for (const table of ["notification_candidates", "watch_targets", "watch_app_clients", "unread_items", "api_usage", "api_daily"])
    expect((await db.prepare(`SELECT notifier_id FROM ${table}`).first<any>()).notifier_id).toBe(1);
  expect((await db.prepare("SELECT encryption_version FROM notifier_credentials").first<any>()).encryption_version).toBe(1);
  expect((await db.prepare("SELECT explicit_pairing FROM watch_control").first<any>()).explicit_pairing).toBe(0);
  const migrated = await snapshot();
  await apply();
  expect(await snapshot()).toEqual(migrated);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<any>()).n).toBe(1);
});

it.each(["statement", "unique"])("rolls back a %s failure with the complete D1 migration request and can retry", async failure => {
  const before = await snapshot(), beforeSchema = await schema();
  const marker = "CREATE UNIQUE INDEX notifier_member_identity";
  const injected = failure === "statement" ? "INSERT INTO missing_migration_table VALUES(1);" : "INSERT INTO notifier(id,account_id,username) VALUES(2,7,'duplicate');";
  await expect(apply(migration.replace(marker, `${injected}\n${marker}`))).rejects.toThrow();
  expect(await schema()).toEqual(beforeSchema);
  expect(await snapshot()).toEqual(before);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<any>()).n).toBe(0);
  await apply();
  expect((await db.prepare("SELECT account_id,scan_page FROM notifier WHERE id=1").first())).toEqual({ account_id: 7, scan_page: 3 });
});

it("reads legacy ciphertext only for local id 1 and upgrades it on the next credential write", async () => {
  await apply();
  await db.exec(flatten(await readFile("migrations/0019_account_avatar.sql", "utf8")));
  const now = Date.now() + 1000;
  const responses = [ { body: { success: true, result: { id: 7, username: "tester" } } },
    { body: '<a class="top" href="/member/tester">tester</a><div id="Rightbar"><a href="/notifications">0 unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/1">topic</a></span></div>' } ];
  const verify = await call("/action", { action: "verify", now, responses });
  expect(verify.error).toBeUndefined();
  expect(verify.calls[0].headers.authorization).toBe(`Bearer ${pat}`);
  expect(verify.calls[1].headers.cookie).toBe(cookie);
  const saved = await call("/action", { action: "credentials", input: { cookie, pat }, now: now + 61000, responses });
  expect(saved.error).toBeUndefined();
  const stored = await db.prepare("SELECT payload,encryption_version FROM notifier_credentials WHERE id=1").first<any>();
  expect(stored.encryption_version).toBe(2);
  expect((await call("/open", { purpose: "v2ex-credentials:1", value: stored.payload })).result).toEqual({ cookie, pat });
  expect((await call("/open", { purpose: "v2ex-credentials:2", value: stored.payload })).error).toBeTruthy();
});
