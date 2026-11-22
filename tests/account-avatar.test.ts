import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const admin = "synthetic-account-avatar-admin-".repeat(3);
const key = "ab".repeat(32);
const avatar = "https://cdn.v2ex.com/avatar/alpha.png?m=1";
const otherAvatar = "https://cdn.v2ex.com/avatar/beta.png?m=2";
let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let now: number;
let responses: { body: unknown }[];
let outgoing: string[];
let migration: { before: Record<string, unknown>; after: Record<string, unknown> };
const flatten = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\n/g, " ");
const profile = (id = 7, username = "alpha") => ({ body: { success: true, result: { id, username } } });
const portrait = (owner: string, src: string, uid?: number, alt = owner) =>
  `<a href="/member/${owner}"><img class="avatar" src="${src}" alt="${alt}"${uid === undefined ? "" : ` data-uid="${uid}"`}></a>`;
const home = (right = "", username = "alpha", main = "") =>
  `<a class="top" href="/member/${username}">${username}</a><div id="Rightbar">${right}<a href="/notifications">0 unread notifications</a></div><div id="Main">${main}<span class="item_title"><a href="/t/123">topic</a></span></div>`;
async function call(path: string, input: Record<string, unknown> = {}) {
  return (await mf.dispatchFetch(`https://assistant.example${path}`, {
    method: "POST", body: JSON.stringify({ now, ...input }),
  })).json<any>();
}
async function api(path: string, method = "GET", body?: unknown) {
  return mf.dispatchFetch(`https://assistant.example/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json", Origin: "https://assistant.example" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function account(id = 1) {
  return db.prepare("SELECT * FROM notifier WHERE id=?").bind(id).first<any>();
}
async function seed(id = 1, member = 7, username = "alpha", cachedAvatar = "") {
  const cookie = `session=${username}`, pat = `${username}-pat`;
  const scope = createHash("sha256").update(JSON.stringify([cookie, pat])).digest("hex");
  const sealed = await call("/seal", { purpose: `v2ex-credentials:${id}`, value: { cookie, pat } });
  await db.prepare("INSERT INTO notifier_credentials(id,payload,updated_at,encryption_version) VALUES(?,?,?,2)").bind(id, sealed.result, now).run();
  await db.prepare(`INSERT INTO notifier(id,account_id,username,avatar_url,credential_scope,verified_at,enabled,binding_id,check_start_hour,check_end_hour)
    VALUES(?,?,?,?,?,?,1,?,0,24) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,username=excluded.username,avatar_url=excluded.avatar_url,
    credential_scope=excluded.credential_scope,verified_at=excluded.verified_at,enabled=1,binding_id=excluded.binding_id,check_start_hour=0,check_end_hour=24`)
    .bind(id, member, username, cachedAvatar, scope, now - 1000, `binding-${id}`).run();
  await db.prepare("INSERT OR IGNORE INTO watch_control(id) VALUES(?)").bind(id).run();
  await db.prepare("INSERT OR IGNORE INTO unread_control(id) VALUES(?)").bind(id).run();
}

beforeAll(async () => {
  const bundle = await build({ entryPoints: ["tests/notifier.harness.ts"], bundle: true, write: false,
    format: "esm", target: "es2022", external: ["cloudflare:sockets"] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-19", d1Databases: ["DB"], bindings: { ADMIN_TOKEN: admin, NOTIFIER_KEY: key },
    outboundService: request => {
      outgoing.push(request.url);
      const next = responses.shift();
      if (!next) throw new Error("Unexpected upstream request");
      return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
    },
  }));
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    if (file === "0019_account_avatar.sql") {
      await db.exec("UPDATE notifier SET account_id=7,username='alpha',enabled=1,binding_id='existing-binding',scan_id='existing-scan',scan_page=3 WHERE id=1");
      const before = await account();
      await db.exec(flatten(await readFile(`migrations/${file}`, "utf8")));
      migration = { before, after: await account() };
    } else await db.exec(flatten(await readFile(`migrations/${file}`, "utf8")));
  }
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  now = Date.now() + 1000;
  responses = [];
  outgoing = [];
  await db.exec(flatten(`DELETE FROM notifier_credentials; DELETE FROM notifier; INSERT INTO notifier(id) VALUES(1);
    DELETE FROM watch_control; INSERT INTO watch_control(id) VALUES(1);
    DELETE FROM unread_control; INSERT INTO unread_control(id) VALUES(1);
    DELETE FROM unread_items; DELETE FROM notification_candidates; DELETE FROM notification_checks;
    DELETE FROM notification_outbox; DELETE FROM notification_dedup; DELETE FROM api_usage; DELETE FROM api_daily;
    UPDATE control SET lease='',lease_until=0,next_dispatch=0,api_until=0,web_until=0,api_forbidden_failures=0,
      web_forbidden_failures=0,account_creation_until=0,account_validation_sequence=0;`));
});

describe("verified account avatar cache", () => {
  it("adds an empty cache to an existing account without changing its state", () => {
    expect(migration.after).toEqual({ ...migration.before, avatar_url: "" });
  });

  it("uses only the matching sidebar portrait from an already requested verified homepage", async () => {
    await seed();
    const impostors = portrait("beta", otherAvatar, 8, "alpha")
      + portrait("alpha", otherAvatar, 7, "beta")
      + portrait("alpha", otherAvatar, 8)
      + `<a href="/member/alpha">alpha</a><img class="avatar" src="${otherAvatar}" alt="alpha" data-uid="7">`;
    const own = portrait("AlPhA", avatar.replace("https:", ""), 7, "ALPHA")
      .replace('href="/member/', 'href="https://www.v2ex.com/member/');
    const result = await call("/action", { action: "verify", responses: [profile(), { body: home(impostors + own, "alpha", portrait("alpha", otherAvatar, 7)) }] });
    expect(result.error).toBeUndefined();
    expect((await account()).avatar_url).toBe(avatar);
    expect(result.calls.map((entry: any) => new URL(entry.url).pathname)).toEqual(["/api/v2/member", "/"]);
  });

  it.each([
    "",
    portrait("beta", otherAvatar, 8),
    portrait("alpha", "https://foreign.example/avatar/alpha.png", 7),
    portrait("alpha", "./V2EX_files/136734_xlarge.png", 7),
  ])("keeps a cached avatar when the homepage has no usable current-user portrait", async right => {
    await seed(1, 7, "alpha", avatar);
    const result = await call("/action", { action: "verify", responses: [profile(), { body: home(right) }] });
    expect(result.error).toBeUndefined();
    expect(await account()).toMatchObject({ avatar_url: avatar, unread: 0 });
    expect(result.calls).toHaveLength(2);
  });

  it("does not let a matching portrait bypass the signed-in homepage identity check", async () => {
    await seed(1, 7, "alpha", avatar);
    const result = await call("/action", { action: "verify", responses: [profile(), { body: home(portrait("alpha", otherAvatar, 7), "beta") }] });
    expect(result.error).toBeDefined();
    expect((await account()).avatar_url).toBe(avatar);
  });

  it("stores each new account avatar and serves list/state entirely from the cache", async () => {
    for (const [member, username, url] of [[7, "alpha", avatar], [8, "beta", otherAvatar]] as const) {
      responses = [profile(member, username), { body: home(portrait(username, url, member), username) }];
      const created = await api("/accounts", "POST", { cookie: `session=${username}`, pat: `${username}-pat` });
      expect(created.status).toBe(200);
    }
    expect(outgoing.map(url => new URL(url).pathname)).toEqual(["/api/v2/member", "/", "/api/v2/member", "/"]);
    outgoing = [];
    const listed = await (await api("/accounts")).json<any>();
    expect(listed.accounts.map((entry: any) => entry.avatar_url)).toEqual([avatar, otherAvatar]);
    for (const entry of listed.accounts) {
      const snapshot = await (await api(`/accounts/${entry.id}/state`)).json<any>();
      expect(snapshot.notifier.avatar_url).toBe(entry.avatar_url);
    }
    expect(outgoing).toEqual([]);
  });

  it("updates an existing credential owner's avatar without changing another account", async () => {
    await seed();
    await seed(2, 8, "beta", otherAvatar);
    const untouched = await account(2);
    const result = await call("/action", { action: "credentials", input: { cookie: "session=alpha-new", pat: "alpha-new-pat" },
      responses: [profile(), { body: home(portrait("alpha", avatar, 7)) }] });
    expect(result.error).toBeUndefined();
    expect((await account()).avatar_url).toBe(avatar);
    expect(await account(2)).toEqual(untouched);
    expect(result.calls).toHaveLength(2);
  });

  it("fills a legacy account on its next normal homepage scan without identity revalidation", async () => {
    await seed();
    await seed(2, 8, "beta");
    const untouched = await account(1);
    const result = await call("/scan", { accountID: 2, responses: [{ body: home(portrait("beta", otherAvatar, 8), "beta") }] });
    expect(result.error).toBeUndefined();
    expect(await account(2)).toMatchObject({ avatar_url: otherAvatar, unread: 0, scan_stage: "idle" });
    expect(await account(1)).toEqual(untouched);
    expect(result.calls.map((entry: any) => new URL(entry.url).pathname)).toEqual(["/"]);
  });

  it("fills a paused account during the existing unread refresh without modifying push progress", async () => {
    await seed();
    await db.exec("UPDATE notifier SET enabled=0,binding_id='',scan_stage='page',scan_id='existing-scan',scan_page=3 WHERE id=1");
    const before = await account();
    const result = await call("/action", { action: "unread/refresh", responses: [{ body: home(portrait("alpha", avatar, 7)) }] });
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ complete: true, total: 0 });
    expect(await account()).toEqual({ ...before, avatar_url: avatar });
    expect(result.calls.map((entry: any) => new URL(entry.url).pathname)).toEqual(["/"]);
  });
});
