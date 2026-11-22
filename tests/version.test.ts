import { describe, expect, it } from "vitest";
import { compareVersions, normalizeVersion, RELEASES_PAGE_URL } from "../shared/version";
import { checkLatestRelease } from "../worker/version";

describe("version comparison helpers", () => {
  it("normalizes and compares SemVer strings including prereleases", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("0.1.0-beta.2")).toBe("0.1.0-beta.2");
    expect(normalizeVersion("latest")).toBeNull();

    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0", "invalid")).toBeNull();
  });
});

describe("checkLatestRelease", () => {
  it("detects newer releases and validates the release URL origin", async () => {
    const result = await checkLatestRelease(
      async () =>
        Response.json({
          tag_name: "v1.2.0",
          html_url: "https://github.com/wizcheu/v2echo-notifier-cf/releases/tag/v1.2.0",
          published_at: "2026-11-22T12:00:00Z",
        }),
      "0.1.0",
      1700000000000,
    );
    expect(result).toEqual({
      current_version: "0.1.0",
      latest_version: "1.2.0",
      has_update: true,
      release_url: "https://github.com/wizcheu/v2echo-notifier-cf/releases/tag/v1.2.0",
      published_at: "2026-11-22T12:00:00Z",
      checked_at: 1700000000000,
    });

    // Untrusted html_url falls back to the canonical repository tag URL.
    const sanitized = await checkLatestRelease(
      async () =>
        Response.json({
          tag_name: "v0.1.0",
          html_url: "https://evil.example/phish",
          published_at: "invalid-date",
        }),
      "0.1.0",
      1700000000000,
    );
    expect(sanitized).toEqual({
      current_version: "0.1.0",
      latest_version: "0.1.0",
      has_update: false,
      release_url: "https://github.com/wizcheu/v2echo-notifier-cf/releases/tag/v0.1.0",
      published_at: null,
      checked_at: 1700000000000,
    });
  });

  it("handles unpublished repos, rate limits, and network failures gracefully", async () => {
    const notFound = await checkLatestRelease(async () => new Response("not found", { status: 404 }), "0.1.0", 1);
    expect(notFound.has_update).toBe(false);
    expect(notFound.latest_version).toBeNull();
    expect(notFound.release_url).toBe(RELEASES_PAGE_URL);
    expect(notFound.note).toContain("尚未发布");

    const rateLimited = await checkLatestRelease(async () => new Response("limit", { status: 429 }), "0.1.0", 1);
    expect(rateLimited.note).toContain("限流");

    const networkErr = await checkLatestRelease(async () => {
      throw new Error("offline");
    }, "0.1.0", 1);
    expect(networkErr.note).toContain("无法连接");
  });
});
