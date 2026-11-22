import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const key = "ab".repeat(32), cookie = "session=synthetic-unread", pat = "synthetic-unread-pat";
const scope = createHash("sha256").update(JSON.stringify([cookie, pat])).digest("hex");
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let now: number;
const home = (count: number, username = "tester") => ({ body:
  `<a class="top" href="/member/${username}">${username}</a><div id="Rightbar"><a href="/notifications">${count} unread notifications</a></div><div id="Main"><span class="item_title"><a href="/t/123">topic</a></span></div>` });
const notice = (id: number) => ({
  id, for_member_id: 7, created: Math.floor(Date.now() / 1000),
  text: '<a href="/member/actor">actor</a> 回复了你 <a href="/t/123">topic</a>',
  payload_rendered: `private-notification-${id}`,
  member: { username: "actor", avatar_large: "//cdn.v2ex.com/avatar/1/2/3.png" },
});
const page = (...ids: number[]) => ({ body: { success: true, result: ids.map(notice) } });
const descending = (top: number, length: number) => Array.from({ length }, (_, i) => top - i);
async function call(path: string, data: Record<string, unknown> = {}) {
  return mf.dispatchFetch(`http://local${path}`, { method: "POST", body: JSON.stringify({ now, ...data }) })
    .then(response => response.json()) as Promise<any>;
}
const refresh = (responses: unknown[], input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  call("/refresh", { responses, input, ...extra });
const list = (query = "", extra: Record<string, unknown> = {}) => call("/list", { query, ...extra });
const state = () => db.prepare("SELECT * FROM notifier WHERE id=1").first<any>();
const control = () => db.prepare("SELECT * FROM unread_control WHERE id=1").first<any>();
async function immutable() {
  return {
    notifier: await state(),
    candidates: (await db.prepare("SELECT * FROM notification_candidates").all()).results,
    outbox: (await db.prepare("SELECT * FROM notification_outbox").all()).results,
    dedup: (await db.prepare("SELECT * FROM notification_dedup").all()).results,
  };
}
async function completed(ids = [100, 99], extraIDs: number[] = []) {
  const first = await refresh([home(ids.length), page(...ids, ...extraIDs)]);
  expect(first.error).toBeUndefined();
  const result = await refresh([home(ids.length), page(...ids, ...extraIDs)], { refresh_id: first.result.refresh_id });
  expect(result.error).toBeUndefined();
  expect(result.result.complete).toBe(true);
  return { ...result.result, snapshot_id: first.result.refresh_id };
}

beforeAll(async () => {
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(), sourcefile: "unread.harness.ts", loader: "ts",
      contents: `
import { Database } from "./worker/db";
import { locked } from "./worker/notifier/context";
import { refreshUnread, unreadPage } from "./worker/notifier/unread";
export default {
  async fetch(request, env) {
    const input = await request.json(), db = new Database(env.DB), calls = [];
    const bound = {...env, ...input.env};
    const responses = input.responses ?? [];
    const fetcher = async (url, init) => {
      calls.push({url:String(url),method:init?.method ?? "GET",headers:Object.fromEntries(new Headers(init?.headers)),redirect:init?.redirect});
      const next = responses.shift();
      if (!next) throw new Error("Unexpected network request");
      if (next.error) throw new Error("private-network-detail");
      if (next.replaceLease) await db.run("UPDATE control SET lease='replaced' WHERE id=1");
      return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {status:next.status ?? 200,headers:next.headers});
    };
    try {
      const result = new URL(request.url).pathname === "/list"
        ? await unreadPage(db,bound,new URLSearchParams(input.query))
        : await locked(db,bound,c=>refreshUnread(c,input.input ?? {}),fetcher,input.now);
      return Response.json({result,calls});
    } catch(error) { return Response.json({error:error.message,retry_at:error.retryAt,status:error.status,calls}); }
  }
};`,
    },
    bundle: true, write: false, format: "esm", target: "es2022", external: ["cloudflare:sockets"],
  });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-10-19", d1Databases: ["DB"],
    bindings: { ADMIN_TOKEN: "synthetic-admin-token", NOTIFIER_KEY: key, V2EX_COOKIE: cookie, V2EX_PAT: pat },
    outboundService: () => { throw new Error("Unexpected real upstream request"); },
  }));
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort())
    await db.exec((await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/g, "").replace(/\n/g, " "));
}, 60_000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  now = Date.now() + 1000;
  await db.exec(`DELETE FROM unread_items; DELETE FROM unread_control; INSERT INTO unread_control(id) VALUES(1);
    DELETE FROM notifier_credentials; DELETE FROM notifier; INSERT INTO notifier(id) VALUES(1);
    DELETE FROM notification_candidates; DELETE FROM notification_outbox; DELETE FROM notification_dedup;
    DELETE FROM api_usage; DELETE FROM api_daily;
    UPDATE control SET lease='',lease_until=0,api_until=0,web_until=0,api_forbidden_failures=0,web_forbidden_failures=0;
    INSERT INTO notification_candidates(scan_id,notification_id,content_enc,kind,avatar_url,queued) VALUES('existing-scan',999,'existing-private-content','reply','',0);
    INSERT INTO notification_dedup VALUES(7,999,'existing-event');`);
  await db.prepare(`UPDATE notifier SET account_id=7,username='tester',credential_scope=?,verified_at=?,
    enabled=0,binding_id='',scan_stage='page',scan_id='existing-scan',scan_page=3,scan_collected=40,
    scan_head='[1000,999]',scan_min=900,unread=9,observed_at=?,last_scan=?,next_scan=?,scan_until=? WHERE id=1`)
    .bind(scope, now - 1000, now - 60000, now - 120000, now + 600000, now + 120000).run();
});

describe("independent unread snapshots", () => {
  it("is empty before the first read and publishes zero unread without requesting the API", async () => {
    expect((await list()).result).toMatchObject({ items: [], total: null, snapshot_id: null });
    const before = await immutable();
    const result = await refresh([home(0)]);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ complete: true, total: 0, collected: 0 });
    expect(result.calls.map((call: any) => call.url)).toEqual(["https://www.v2ex.com/"]);
    expect((await list()).result).toMatchObject({ items: [], total: 0, refreshing: false });
    expect(await immutable()).toEqual(before);
  });

  it("reads while paused and unpaired, excludes already-read history, and never touches push progress", async () => {
    const before = await immutable();
    const snapshot = await completed([100, 99], [98, 97]);
    const result = (await list()).result;
    expect(result).toMatchObject({ total: 2, snapshot_id: snapshot.snapshot_id, refreshing: false, next_cursor: null });
    expect(result.items.map((item: any) => item.notification_id)).toEqual([100, 99]);
    expect(result.items[0]).toMatchObject({ title: "actor 回复了《topic》", body: "private-notification-100", avatar_url: "https://cdn.v2ex.com/avatar/1/2/3.png" });
    const stored = (await db.prepare("SELECT content_enc FROM unread_items").all()).results;
    expect(JSON.stringify(stored)).not.toContain("private-notification");
    expect(await immutable()).toEqual(before);
    const replay = await refresh([], { refresh_id: snapshot.snapshot_id });
    expect(replay.result.complete).toBe(true);
    expect(replay.calls).toEqual([]);
  });

  it("publishes all pages only after rechecking the count and first page, then serves stable keyset pages", async () => {
    const head = descending(100, 20);
    const first = await refresh([home(25), page(...head)]);
    expect(first.result).toMatchObject({ complete: false, collected: 20, total: 25 });
    expect((await list()).result).toMatchObject({ total: null, items: [], collected: 20, refreshing: true });
    const second = await refresh([page(...descending(80, 20))], { refresh_id: first.result.refresh_id });
    expect(second.calls).toHaveLength(1);
    expect(second.result).toMatchObject({ complete: false, collected: 25, total: 25 });
    expect((await list()).result.items).toEqual([]);
    const final = await refresh([home(25), page(...head)], { refresh_id: first.result.refresh_id });
    expect(final.result.complete).toBe(true);
    const newest = (await list()).result;
    expect(newest.items).toHaveLength(20);
    const older = (await list(new URLSearchParams({ cursor: newest.next_cursor }).toString())).result;
    expect(older.items.map((item: any) => item.notification_id)).toEqual([80, 79, 78, 77, 76]);
    expect(older.next_cursor).toBeNull();
    expect(older.snapshot_id).toBe(newest.snapshot_id);
  });

  it("keeps a completed snapshot during a failed refresh and resumes the saved page", async () => {
    const original = await completed();
    now += 61000;
    const first = await refresh([home(3), page(110)]);
    expect((await list()).result).toMatchObject({ snapshot_id: original.snapshot_id, total: 2, collected: 1 });
    const failed = await refresh([{ error: true }], { refresh_id: first.result.refresh_id });
    expect(failed.error).toContain("网络请求失败");
    expect(failed.error).not.toContain("private-");
    expect((await control()).page).toBe(2);
    expect((await list()).result.items.map((item: any) => item.notification_id)).toEqual([100, 99]);
    const retry = await refresh([page(109, 108)], { refresh_id: first.result.refresh_id });
    expect(retry.result.collected).toBe(3);
    const done = await refresh([home(3), page(110)], { refresh_id: first.result.refresh_id });
    expect(done.result.complete).toBe(true);
    expect((await list()).result.items.map((item: any) => item.notification_id)).toEqual([110, 109, 108]);
    expect((await db.prepare("SELECT COUNT(DISTINCT snapshot_id) AS n FROM unread_items").first<any>()).n).toBe(1);
  });

  it.each(["count", "head"])("does not replace the old snapshot when the %s changes during the scan", async (change) => {
    const old = await completed();
    now += 61000;
    const first = await refresh([home(1), page(110)]);
    const failed = await refresh(change === "count" ? [home(0)] : [home(1), page(111)], { refresh_id: first.result.refresh_id });
    expect(failed.error).toContain("发生变化");
    expect((await list()).result).toMatchObject({ snapshot_id: old.snapshot_id, total: 2, refreshing: false });
    expect((await control()).refresh_id).toBe("");
  });

  it.each([page(110, 109), page()])("rejects shifted or incomplete pagination without publishing it", async (response) => {
    const first = await refresh([home(3), page(110)]);
    const failed = await refresh([response], { refresh_id: first.result.refresh_id });
    expect(failed.error).toContain("发生变化");
    expect((await list()).result.total).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM unread_items").first<any>()).n).toBe(0);
  });

  it("rejects a cursor from a replaced snapshot rather than mixing records", async () => {
    const old = await completed();
    now += 61000;
    await completed([110]);
    const result = await list(new URLSearchParams({ cursor: JSON.stringify([old.snapshot_id, 100]) }).toString());
    expect(result.error).toContain("列表已更新");
    expect(result.result).toBeUndefined();
  });

  it("hides old-scope data and rejects continuation after credentials change", async () => {
    await completed();
    now += 61000;
    const pending = await refresh([home(3), page(110)]);
    const env = { V2EX_PAT: "new-private-pat" };
    expect((await list("", { env })).result).toMatchObject({ snapshot_id: null, total: null, items: [], refresh_id: null });
    const result = await refresh([], { refresh_id: pending.result.refresh_id }, { env });
    expect(result.error).toContain("访问凭据已变化");
    expect(result.calls).toEqual([]);
  });

  it("probes an unverified identity without resetting the push scan", async () => {
    await db.exec("UPDATE notifier SET verified_at=0");
    const before = await immutable();
    const result = await refresh([
      { body: { success: true, result: { id: 7, username: "tester" } } }, home(1), page(100),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.calls.map((call: any) => new URL(call.url).pathname)).toEqual(["/api/v2/member", "/", "/api/v2/notifications"]);
    const after = await immutable();
    expect(after.notifier.verify_until).toBeGreaterThan(now);
    after.notifier.verify_until = before.notifier.verify_until;
    expect(after).toEqual(before);
    expect(result.calls.some((call: any) => new URL(call.url).pathname === "/notifications")).toBe(false);
  });

  it("respects channel backoff and does not clear it on continuation", async () => {
    const result = await refresh([home(2), { status: 429, headers: { "retry-after": "120" }, body: "" }]);
    expect(result.error).toContain("限流");
    const pending = await control();
    const waiting = await refresh([], { refresh_id: pending.refresh_id });
    expect(waiting.calls).toEqual([]);
    expect(waiting.retry_at).toBeGreaterThan(now);
    expect((await control()).refresh_id).toBe(pending.refresh_id);
    expect((await db.prepare("SELECT api_until FROM notifier WHERE id=1").first<any>()).api_until).toBe(pending.retry_at);
  });

  it("preserves the old snapshot when unread exceeds the explicit safety bound", async () => {
    const old = await completed();
    now += 61000;
    const result = await refresh([home(1001)]);
    expect(result.error).toContain("1000");
    expect(result.calls).toHaveLength(1);
    expect((await list()).result).toMatchObject({ snapshot_id: old.snapshot_id, total: 2 });
  });

  it("throttles new starts but allows continuation, and rejects expired progress", async () => {
    const first = await refresh([home(3), page(110)]);
    const repeated = await refresh([]);
    expect(repeated.error).toContain("一分钟");
    expect(repeated.calls).toEqual([]);
    const next = await refresh([page(109)], { refresh_id: first.result.refresh_id });
    expect(next.result.collected).toBe(2);
    now += 10 * 60000 + 1000;
    const expired = await refresh([], { refresh_id: first.result.refresh_id });
    expect(expired.error).toContain("已过期");
    expect(expired.calls).toEqual([]);
    expect((await control()).refresh_id).toBe("");
  });

  it("also throttles the next start when the first homepage request fails before identity is stored", async () => {
    const failed = await refresh([{ error: true }]);
    expect(failed.error).toContain("网络请求失败");
    const repeated = await refresh([]);
    expect(repeated.error).toContain("一分钟");
    expect(repeated.calls).toEqual([]);
  });

  it("does not publish data after the lease has been replaced", async () => {
    const result = await refresh([home(1), { ...page(100), replaceLease: true }]);
    expect(result.error).toContain("CHECK");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM unread_items").first<any>()).n).toBe(0);
    expect((await control()).snapshot_id).toBe("");
  });
});
