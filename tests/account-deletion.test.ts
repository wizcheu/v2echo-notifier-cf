import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let relay: typeof db;
const senderA = "a".repeat(43), senderB = "b".repeat(43);
const bindingA = "11111111-1111-4111-8111-111111111111";
const bindingB = "22222222-2222-4222-8222-222222222222";
const deviceA = "33333333-3333-4333-8333-333333333333";
const deviceB = "44444444-4444-4444-8444-444444444444";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const now = 1800000000000;

async function call(path: string, data: Record<string, unknown> = {}) {
  return mf.dispatchFetch(`http://local${path}`, {
    method: "POST", body: JSON.stringify({ now, ...data }),
  }).then(response => response.json()) as Promise<any>;
}
async function seal(purpose: string, value: unknown) { return (await call("/seal", { purpose, value })).result as string; }
async function remove(options = {}) { return call("/delete", { id: 1, ...options }); }
async function accountA() { return db.prepare("SELECT * FROM notifier WHERE id=1").first<any>(); }
async function peer() {
  return {
    account: await db.prepare("SELECT * FROM notifier WHERE id=2").first(),
    credentials: await db.prepare("SELECT * FROM notifier_credentials WHERE id=2").first(),
    targets: (await db.prepare("SELECT * FROM watch_targets WHERE notifier_id=2").all()).results,
    dedup: (await db.prepare("SELECT * FROM notification_dedup WHERE account_id=8").all()).results,
    operations: (await db.prepare("SELECT * FROM watch_local_operations WHERE profile_id=?").bind(bindingB).all()).results,
    central: await relay.prepare("SELECT * FROM devices WHERE id=?").bind(deviceB).first(),
  };
}

async function registeredSender(device: string, binding: string, sender: string, account: number, username: string) {
  await relay.prepare(`INSERT INTO devices(id,username,binding_id,sender_hash,source_account_id)
    VALUES(?,?,?,?,?)`)
    .bind(device, username, binding, digest(sender), account).run();
}

beforeAll(async () => {
  const compiled = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import { Database } from './worker/db';
    import { deleteAccount } from './worker/notifier/accounts';
    import { locked } from './worker/notifier/context';
    import { savePairing } from './worker/notifier/pairing';
    import { seal } from './worker/notifier/crypto';
    async function sha256Hex(value) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    async function revokeSender(request, env) {
      const auth = request.headers.get('authorization') ?? '';
      const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const payload = await request.json();
      if (!secret || !Number.isInteger(payload?.source_account_id) || payload.source_account_id <= 0)
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      const senderHash = await sha256Hex(secret);
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO sender_revocations(sender_hash,source_account_id) VALUES(?,?)').bind(senderHash, payload.source_account_id),
        env.DB.prepare('UPDATE devices SET binding_id=NULL,sender_hash=NULL WHERE sender_hash=? AND source_account_id=?').bind(senderHash, payload.source_account_id),
      ]);
      return Response.json({ revoked: true });
    }
    export default { async fetch(request, env) {
      const data = await request.json(), calls = [], db = new Database(env.DB);
      try {
        if (new URL(request.url).pathname === '/seal') return Response.json({ result: await seal(env, data.purpose, data.value) });
        const fetcher = async (url, init) => {
          calls.push({ url, method: init.method, secret: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
          if (new URL(url).pathname !== '/api/push/v1/sender') throw new Error('unexpected upstream request');
          if (data.failure === 'before') throw new Error('synthetic connection failure');
          let response;
          try { response = await revokeSender(new Request(url, init), { DB: env.RELAY_DB }); }
          catch (error) { response = Response.json({ error: error.code ?? 'unknown' }, { status: error.status ?? 500 }); }
          if (data.failure === 'after') throw new Error('synthetic lost revocation response');
          if (data.failure === 'receipt') return Response.json({ revoked: false });
          if (data.failure === 'lease') await db.run("UPDATE control SET lease='new-owner' WHERE id=1");
          return response;
        };
        const bound = { ...env, PUSH_SERVICE: undefined };
        if (new URL(request.url).pathname === '/replace') {
          const confirmation = data.table ? async binding => db.statement(
            'INSERT INTO ' + data.table + '(id,content_enc,expires_at) VALUES(?,?,?)', data.id, data.confirmation, data.now + 600000) : undefined;
          await locked(db, bound, c => savePairing(c, { sender: data.sender, account: 7, username: 'alice', code: 'new-code' },
            { paired: true, binding_id: data.binding, username: 'alice' }, confirmation), fetcher, data.now, false, data.id);
          return Response.json({ replaced: true, calls });
        }
        return Response.json({ result: await deleteAccount(db, bound, data.id, fetcher, data.now), calls });
      } catch (error) { return Response.json({ error: error.message, status: error.status ?? 500, calls }); }
    } };
  ` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0]!.text,
    compatibilityDate: "2026-10-19", d1Databases: ["DB", "RELAY_DB"],
    bindings: { NOTIFIER_KEY: "ab".repeat(32) } }));
  db = await mf.getD1Database("DB");
  relay = await mf.getD1Database("RELAY_DB");
  for (const file of (await readdir("migrations")).sort()) {
    await db.exec((await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  }
  await relay.exec(`CREATE TABLE devices(id TEXT PRIMARY KEY, username TEXT NOT NULL, binding_id TEXT, sender_hash TEXT, source_account_id INTEGER);
    CREATE TABLE sender_revocations(sender_hash TEXT PRIMARY KEY, source_account_id INTEGER NOT NULL);`);
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.exec(`DELETE FROM notifier_credentials; DELETE FROM notifier_pairing_invitation; DELETE FROM notifier_source_transfer;
    DELETE FROM watch_app_clients; DELETE FROM watch_app_invitation; DELETE FROM watch_local_operations; DELETE FROM watch_cancellations;
    DELETE FROM watch_targets; DELETE FROM notification_outbox; DELETE FROM notification_dedup; DELETE FROM notifier;
    DELETE FROM watch_control; DELETE FROM unread_control;
    INSERT INTO notifier(id,account_id,username,enabled) VALUES(1,7,'alice',1),(2,8,'bob',1);
    INSERT INTO watch_control(id) VALUES(1),(2); INSERT INTO unread_control(id) VALUES(1),(2);
    UPDATE control SET lease='',lease_until=0;
    INSERT INTO watch_targets(notifier_id,target_key,topic_id,epoch,enabled_at) VALUES(1,'topic:42',42,1,0),(2,'topic:42',42,1,0);
    INSERT INTO notification_dedup(account_id,notification_id,event_id) VALUES(7,100,'a'),(8,100,'b');`);
  await relay.exec(`DELETE FROM devices; DELETE FROM sender_revocations;`);
  for (const [id, account, binding, username] of [[1, 7, bindingA, "alice"], [2, 8, bindingB, "bob"]] as const) {
    await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at,encryption_version) VALUES(?,?,?,2)")
      .bind(id, await seal(`v2ex-credentials:${id}`, { cookie: `A2=${username}`, pat: `${username}-pat` }), now).run();
    await db.prepare("INSERT INTO watch_local_operations(profile_id,operation_id,payload_hash,revision,created_at) VALUES(?,?,?,1,?)")
      .bind(binding, `operation-${account}`, "hash", now).run();
  }
  await registeredSender(deviceB, bindingB, senderB, 8, "bob");
  await db.prepare("UPDATE notifier SET binding_id=?,sender_enc=? WHERE id=2")
    .bind(bindingB, await seal(`sender:${bindingB}`, senderB)).run();
});

it("removes an unpaired account without contacting the relay or requiring deployed credentials", async () => {
  const before = await peer();
  expect(await remove()).toMatchObject({ result: { reason: expect.stringContaining("已移除") }, calls: [] });
  expect(await accountA()).toBeNull();
  expect(await peer()).toEqual(before);
  expect(await remove()).toMatchObject({ calls: [] });
});

it("revokes a legacy pairing before deleting local data without first publishing an assistant source", async () => {
  await registeredSender(deviceA, bindingA, senderA, 7, "alice");
  await db.prepare("UPDATE notifier SET binding_id=?,sender_enc=? WHERE id=1")
    .bind(bindingA, await seal(`sender:${bindingA}`, senderA)).run();
  const before = await peer(), result = await remove();
  expect(result.error).toBeUndefined();
  expect(result.calls).toEqual([{ url: "https://app.v2echo.com/api/push/v1/sender", method: "DELETE",
    secret: `Bearer ${senderA}`, body: { source_account_id: 7 } }]);
  expect(await relay.prepare("SELECT binding_id,sender_hash FROM devices WHERE id=?").bind(deviceA).first())
    .toEqual({ binding_id: null, sender_hash: null });
  expect(await accountA()).toBeNull();
  expect(await db.prepare("SELECT * FROM notifier_credentials WHERE id=1").first()).toBeNull();
  expect((await db.prepare("SELECT * FROM watch_local_operations WHERE profile_id=?").bind(bindingA).all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM watch_targets WHERE notifier_id=1").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM notification_dedup WHERE account_id=7").all()).results).toEqual([]);
  expect(await peer()).toEqual(before);
});

it("revokes every durable sender after a lost pairing response, including expired QR and transfer state", async () => {
  const pendingSender = "c".repeat(43), transferSender = "d".repeat(43);
  await registeredSender(deviceA, bindingA, senderA, 7, "alice");
  await db.prepare("UPDATE notifier SET binding_id=?,sender_enc=?,pair_enc=? WHERE id=1")
    .bind(bindingA, await seal(`sender:${bindingA}`, senderA), await seal("pending-pair", { sender: pendingSender, account: 7 })).run();
  await db.prepare("INSERT INTO notifier_pairing_invitation(id,content_enc,expires_at) VALUES(1,?,0)")
    .bind(await seal("pairing-invitation", { sender: senderA, account: 7 })).run();
  await db.prepare("INSERT INTO notifier_source_transfer(id,content_enc,expires_at) VALUES(1,?,0)")
    .bind(await seal("source-transfer", { sender: transferSender, account: 7 })).run();
  const before = await peer(), result = await remove();
  expect(result.error).toBeUndefined();
  expect(result.calls.map((call: any) => call.secret)).toEqual([senderA, pendingSender, transferSender].map(value => `Bearer ${value}`));
  expect((await relay.prepare("SELECT sender_hash,source_account_id FROM sender_revocations ORDER BY sender_hash").all()).results)
    .toEqual([senderA, pendingSender, transferSender].map(value => ({ sender_hash: digest(value), source_account_id: 7 }))
      .sort((a, b) => a.sender_hash.localeCompare(b.sender_hash)));
  expect(await accountA()).toBeNull();
  expect(await peer()).toEqual(before);
});

it.each(["before", "after", "receipt"])("retains paused credentials when revocation fails %s, then retries idempotently", async failure => {
  await registeredSender(deviceA, bindingA, senderA, 7, "alice");
  await db.prepare("UPDATE notifier SET binding_id=?,sender_enc=? WHERE id=1")
    .bind(bindingA, await seal(`sender:${bindingA}`, senderA)).run();
  const before = await peer(), credentials = await db.prepare("SELECT * FROM notifier_credentials WHERE id=1").first();
  expect((await remove({ failure })).error).toBeDefined();
  expect(await accountA()).toMatchObject({ enabled: 0, blocked: "deleting", binding_id: bindingA });
  expect(await db.prepare("SELECT * FROM notifier_credentials WHERE id=1").first()).toEqual(credentials);
  expect(await peer()).toEqual(before);
  expect((await remove()).error).toBeUndefined();
  expect(await accountA()).toBeNull();
  expect(await peer()).toEqual(before);
});

it("keeps the deletion retryable when the lease changes after central revocation", async () => {
  await registeredSender(deviceA, bindingA, senderA, 7, "alice");
  await db.prepare("UPDATE notifier SET binding_id=?,sender_enc=? WHERE id=1")
    .bind(bindingA, await seal(`sender:${bindingA}`, senderA)).run();
  const before = await peer();
  expect((await remove({ failure: "lease" })).error).toBeDefined();
  expect(await accountA()).toMatchObject({ enabled: 0, blocked: "deleting" });
  expect(await db.prepare("SELECT * FROM notifier_credentials WHERE id=1").first()).not.toBeNull();
  await db.exec("UPDATE control SET lease='',lease_until=0");
  expect((await remove()).error).toBeUndefined();
  expect(await accountA()).toBeNull();
  expect(await peer()).toEqual(before);
});

it("does not revoke a pending secret whose persisted numeric account disagrees", async () => {
  await db.prepare("UPDATE notifier SET pair_enc=? WHERE id=1")
    .bind(await seal("pending-pair", { sender: senderB, account: 8 })).run();
  const before = await peer(), result = await remove();
  expect(result.error).toContain("当前账号不符");
  expect(result.calls).toEqual([]);
  expect(await accountA()).toMatchObject({ enabled: 0, blocked: "deleting" });
  expect(await peer()).toEqual(before);
});

const pendingSlots = {
  manual: { purpose: "pending-pair", table: "" },
  qr: { purpose: "pairing-invitation", table: "notifier_pairing_invitation" },
  transfer: { purpose: "source-transfer", table: "notifier_source_transfer" },
} as const;
type PairingMode = keyof typeof pendingSlots;
async function pending(mode: PairingMode, sender: string) {
  const slot = pendingSlots[mode], value = await seal(slot.purpose, { sender, account: 7, username: "alice", code: `${mode}-code` });
  if (slot.table) await db.prepare(`INSERT INTO ${slot.table}(id,content_enc,expires_at) VALUES(1,?,0)`).bind(value).run();
  else await db.prepare("UPDATE notifier SET pair_enc=?,pair_expires=0 WHERE id=1").bind(value).run();
  return value;
}
async function replace(mode: PairingMode, sender: string, confirmation: string, failure?: string) {
  return call("/replace", { id: 1, sender, binding: "55555555-5555-4555-8555-555555555555",
    table: pendingSlots[mode].table, confirmation, failure });
}

it.each([
  ["manual", "qr"], ["manual", "transfer"], ["qr", "manual"],
  ["qr", "transfer"], ["transfer", "manual"], ["transfer", "qr"],
] as const)("retires a lost %s pairing before saving %s and keeps the peer untouched", async (oldMode, newMode) => {
  await registeredSender(deviceA, bindingA, senderA, 7, "alice");
  await pending(oldMode, senderA);
  const newSender = "e".repeat(43), confirmation = await pending(newMode, newSender), before = await peer();
  const result = await replace(newMode, newSender, confirmation);
  expect(result.replaced).toBe(true);
  expect(result.calls.map((entry: any) => entry.secret)).toEqual([`Bearer ${senderA}`]);
  expect(await relay.prepare("SELECT sender_hash,binding_id FROM devices WHERE id=?").bind(deviceA).first())
    .toEqual({ sender_hash: null, binding_id: null });
  expect(await accountA()).toMatchObject({ binding_id: "55555555-5555-4555-8555-555555555555", pair_enc: "" });
  for (const mode of ["qr", "transfer"] as const) {
    const row = await db.prepare(`SELECT content_enc FROM ${pendingSlots[mode].table} WHERE id=1`).first();
    expect(row).toEqual(mode === newMode ? { content_enc: confirmation } : null);
  }
  // Removing the successfully replaced account still revokes its current sender.
  expect((await remove()).calls.map((entry: any) => entry.secret)).toEqual([`Bearer ${newSender}`]);
  expect(await peer()).toEqual(before);
});

it.each(["before", "after", "receipt"])("retains both pairing recovery secrets after replacement revocation fails %s", async failure => {
  await registeredSender(deviceA, bindingA, senderA, 7, "alice");
  const previous = await pending("manual", senderA), newSender = "e".repeat(43), confirmation = await pending("qr", newSender);
  const before = await peer();
  expect((await replace("qr", newSender, confirmation, failure)).error).toBeDefined();
  expect(await accountA()).toMatchObject({ binding_id: "", pair_enc: previous });
  expect(await db.prepare("SELECT content_enc FROM notifier_pairing_invitation WHERE id=1").first()).toEqual({ content_enc: confirmation });
  expect((await replace("qr", newSender, confirmation)).replaced).toBe(true);
  expect(await peer()).toEqual(before);
});
