import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDeploymentConfig,
  detectGatedMigrations,
  ensureSecretsFile,
  parseJsonOutput,
  parseSecretsEnv,
  patchWorkerConfig,
  verifySha256,
} from "../scripts/self-host.mjs";
import {
  assertCleanReleaseWorkerConfig,
  sanitizeReleaseWorkerConfig,
} from "../scripts/pack-release.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("self-host deployment helpers", () => {
  it("parses JSON output even with ANSI escapes or CLI banner preamble", () => {
    expect(parseJsonOutput('[{"id":"abc","name":"Main"}]')).toEqual([
      { id: "abc", name: "Main" },
    ]);
    expect(
      parseJsonOutput('\u001b[32m✓ Loaded\u001b[0m\n{\n  "uuid": "11111111-1111-4111-8111-111111111111"\n}\n'),
    ).toEqual({ uuid: "11111111-1111-4111-8111-111111111111" });
    expect(parseJsonOutput("not json at all")).toBeNull();
  });

  it("validates deployment config and rejects placeholder D1 UUIDs", () => {
    const valid = buildDeploymentConfig({
      accountId: "ABCDEF0123456789ABCDEF0123456789",
      databaseId: "11111111-1111-4111-8111-111111111111",
      workerName: "my-notifier",
      domain: "notifier.example.com",
    });
    expect(valid).toEqual({
      accountId: "abcdef0123456789abcdef0123456789",
      databaseId: "11111111-1111-4111-8111-111111111111",
      workerName: "my-notifier",
      domain: "notifier.example.com",
    });
    expect(() =>
      buildDeploymentConfig({
        accountId: "abcdef0123456789abcdef0123456789",
        databaseId: "00000000-0000-4000-8000-000000000001",
        workerName: "my-notifier",
      }),
    ).toThrow(/占位值/);
    expect(() =>
      buildDeploymentConfig({
        accountId: "abcdef0123456789abcdef0123456789",
        databaseId: "11111111-1111-4111-8111-111111111111",
        workerName: "my-notifier",
        domain: "https://notifier.example.com",
      }),
    ).toThrow(/自定义域名/);
  });

  it("patches prebuilt worker.config.json cleanly and strips internal bindings", () => {
    const template = {
      name: "v2echo-notifier-cf",
      workersDev: true,
      previewUrls: false,
      env: {
        PUSH_SERVICE: { type: "worker", worker: "v2echo-admin" },
        DB: { type: "d1", name: "v2echo-notifier-cf", id: "00000000-0000-4000-8000-000000000001" },
        ADMIN_TOKEN: { type: "secret" },
        NOTIFIER_KEY: { type: "secret" },
      },
    };
    const withDomain = patchWorkerConfig(template, {
      accountId: "abcdef0123456789abcdef0123456789",
      databaseId: "22222222-2222-4222-8222-222222222222",
      workerName: "my-echo",
      domain: "echo.example.com",
    });
    expect(withDomain.name).toBe("my-echo");
    expect(withDomain.domains).toEqual(["echo.example.com"]);
    expect(withDomain.workersDev).toBe(false);
    expect(withDomain.env.PUSH_SERVICE).toBeUndefined();
    expect(withDomain.env.DB).toEqual({
      type: "d1",
      name: "my-echo",
      id: "22222222-2222-4222-8222-222222222222",
    });

    const withoutDomain = patchWorkerConfig(withDomain, {
      accountId: "abcdef0123456789abcdef0123456789",
      databaseId: "22222222-2222-4222-8222-222222222222",
      workerName: "my-echo",
    });
    expect(withoutDomain.domains).toBeUndefined();
    expect(withoutDomain.workersDev).toBe(true);
  });

  it("sanitizes and verifies clean release worker configs", () => {
    const dirty = {
      name: "private-name",
      domains: ["private.example.com"],
      workersDev: false,
      env: {
        PUSH_SERVICE: { type: "worker", worker: "v2echo-admin" },
        DB: { type: "d1", name: "private-name", id: "22222222-2222-4222-8222-222222222222" },
      },
    };
    expect(() => assertCleanReleaseWorkerConfig(dirty)).toThrow(/domains/);
    const clean = sanitizeReleaseWorkerConfig(dirty);
    expect(() => assertCleanReleaseWorkerConfig(clean)).not.toThrow();
    expect(clean.env.PUSH_SERVICE).toBeUndefined();
    expect(clean.env.DB.id).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("verifies SHA-256 digests against SHA256SUMS.txt", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "v2echo-sha-"));
    tempDirs.push(dir);
    const archive = path.join(dir, "v2echo-notifier-cf-v1.0.0.tar.gz");
    writeFileSync(archive, "release-archive-bytes");
    const expected = createHash("sha256").update("release-archive-bytes").digest("hex");
    expect(
      verifySha256(archive, `${expected}  v2echo-notifier-cf-v1.0.0.tar.gz\n`, "v2echo-notifier-cf-v1.0.0.tar.gz"),
    ).toBe(expected);
    expect(() =>
      verifySha256(archive, `${"0".repeat(64)}  v2echo-notifier-cf-v1.0.0.tar.gz\n`, "v2echo-notifier-cf-v1.0.0.tar.gz"),
    ).toThrow(/SHA-256/);
  });

  it("creates 0600 secrets file once and never overwrites an existing NOTIFIER_KEY", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "v2echo-self-host-"));
    tempDirs.push(dir);
    const file = path.join(dir, "private", "secrets.env");

    const first = ensureSecretsFile(file);
    expect(first).toEqual({ created: true, valid: true });
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const generated = parseSecretsEnv(readFileSync(file, "utf8"));
    expect(generated.ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.NOTIFIER_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.ADMIN_TOKEN).not.toBe(generated.NOTIFIER_KEY);

    const second = ensureSecretsFile(file);
    expect(second).toEqual({ created: false, valid: true });
    expect(parseSecretsEnv(readFileSync(file, "utf8"))).toEqual(generated);

    const badFile = path.join(dir, "bad.env");
    writeFileSync(badFile, 'ADMIN_TOKEN="short"\nNOTIFIER_KEY="bad"\n');
    chmodSync(badFile, 0o600);
    expect(ensureSecretsFile(badFile)).toEqual({ created: false, valid: false });
  });

  it("only blocks gated legacy migrations on existing databases, not fresh installs", () => {
    expect(
      detectGatedMigrations(["0001_initial.sql", "0005_remove_probes.sql", "0018_multi_account.sql"]),
    ).toEqual([]);
    expect(detectGatedMigrations(["0018_multi_account.sql", "0019_account_avatar.sql"])).toEqual([
      "0018_multi_account.sql",
    ]);
    expect(detectGatedMigrations(["0020_check_interval_defaults.sql", "0021_check_errors_ack.sql"])).toEqual([]);
  });
});
