import { describe, expect, it } from "vitest";
import { apiBudget } from "../worker/api-budget";
const now = 1792587273000;
const budget = (headers: Record<string, string>, status = 200) =>
  apiBudget(new Response("", { headers, status }), now);
describe("V2EX API quota snapshots", () => {
  it("does not mistake missing, empty or malformed headers for zero remaining", () => {
    for (const value of [undefined, "", "bad", "-1", "Infinity", "1e25"]) {
      const b = budget(
        value === undefined ? {} : { "x-rate-limit-remaining": value },
      );
      expect(b.remaining).toBeNull();
      expect(b.backoff_until).toBe(0);
    }
  });
  it("keeps zero remaining, honors a future reset, and falls back when reset is past", () => {
    const future = Math.floor((now + 1800000) / 1000);
    const b = budget({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "120",
      "x-ratelimit-reset": String(future),
    });
    expect(b).toMatchObject({
      remaining: 0,
      budget_limit: 120,
      reset_at: future * 1000,
      backoff_until: future * 1000,
      backoff_reason: "reserve",
    });
    expect(
      budget({ "x-rate-limit-remaining": "1", "x-rate-limit-reset": "60" })
        .backoff_until,
    ).toBe(now + 3600000);
  });
  it("honors 429 retry-after without adding an arbitrary hour and bounds long waits", () => {
    expect(budget({ "retry-after": "120" }, 429)).toMatchObject({
      backoff_until: now + 120000,
      backoff_reason: "http_429",
    });
    expect(budget({}, 429).backoff_until).toBe(now + 3600000);
    expect(budget({ "retry-after": "9999999999" }).backoff_until).toBe(
      now + 48 * 3600000,
    );
  });
});
