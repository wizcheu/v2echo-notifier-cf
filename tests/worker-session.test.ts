import { describe, expect, it } from "vitest";
import {
  authorized,
  createSession,
  sessionCookie,
  validSession,
} from "../worker/session";

const env = { ADMIN_TOKEN: "synthetic-admin-secret-".repeat(3) };
const now = Date.parse("2026-10-22T00:00:00Z");

describe("30-day management sessions", () => {
  it("accepts the same session until the fixed 30-day boundary", async () => {
    const session = await createSession(env, now);
    expect(session).not.toContain(env.ADMIN_TOKEN);
    expect(sessionCookie(session, true)).toContain("Max-Age=2592000");
    expect(sessionCookie(session, true)).toContain("HttpOnly; SameSite=Strict");
    expect(sessionCookie(session, true)).toContain("; Secure");
    expect(sessionCookie(session, false)).not.toContain("; Secure");
    for (const elapsed of [0, 86400_000, 30 * 86400_000 - 1000])
      expect(await validSession(session, env, now + elapsed)).toBe(true);
    expect(await validSession(session, env, now + 30 * 86400_000)).toBe(false);
    expect(await validSession(session, env, now - 1000)).toBe(false);
  });

  it("rejects forgery, malformed cookies, missing configuration and rotated admin keys", async () => {
    const session = await createSession(env, now);
    expect(
      await validSession(
        session,
        { ADMIN_TOKEN: "other-secret-".repeat(5) },
        now,
      ),
    ).toBe(false);
    expect(await validSession(session, { ADMIN_TOKEN: "" }, now)).toBe(false);
    const [version, expiry, nonce, signature] = session.split(".");
    for (const value of [
      "",
      "garbage",
      `${session}.extra`,
      `${version}.${expiry}.${nonce}.${"0".repeat(64)}`,
      `${version}.${Number(expiry) + 1}.${nonce}.${signature}`,
      `${version}.${expiry}.bad.${signature}`,
    ])
      expect(await validSession(value, env, now)).toBe(false);
  });

  it("keeps Bearer API clients compatible without falling back from bad explicit credentials", async () => {
    const cookie = sessionCookie(await createSession(env), true).split(";")[0];
    expect(
      await authorized(
        new Request("https://notifier.example/api/state", {
          headers: { Cookie: cookie },
        }),
        env,
      ),
    ).toBe(true);
    expect(
      await authorized(
        new Request("https://notifier.example/api/state", {
          headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
        }),
        env,
      ),
    ).toBe(true);
    expect(
      await authorized(
        new Request("https://notifier.example/api/state", {
          headers: { Cookie: cookie, Authorization: "Bearer wrong" },
        }),
        env,
      ),
    ).toBe(false);
    expect(
      await authorized(new Request("https://notifier.example/api/state"), env),
    ).toBe(false);
  });
});
