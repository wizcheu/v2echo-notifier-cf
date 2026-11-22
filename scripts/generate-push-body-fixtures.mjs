import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const outputDirectory = process.argv[2];
assert.ok(outputDirectory, "Pass the temporary fixture output directory");
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["tests/notifier.harness.ts"],
  external: ["cloudflare:sockets"],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-19",
    d1Databases: ["DB"],
    outboundService: () => {
      throw new Error("Push body fixtures must not make external requests");
    },
  }),
);

async function call(path, input) {
  const response = await mf.dispatchFetch(`http://local${path}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.deepEqual(body.calls, []);
  return body.result;
}

try {
  // Sharing the key and event ID makes account/binding isolation independent
  // of key selection. All credentials and notification text are synthetic.
  const keys = generateKeyPairSync("x25519");
  const publicBytes = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const privateBytes = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const eventID = "c".repeat(64);
  const now = Date.parse("2026-11-13T00:00:00Z");
  for (const account of [
    { id: 7, username: "alice", device: "11111111-1111-4111-8111-111111111111", binding: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { id: 8, username: "bob", device: "22222222-2222-4222-8222-222222222222", binding: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ]) {
    const content = {
      title: `actor 提及了 ${account.username} 👋`,
      body: `仅属于 ${account.username} 的合成正文：你好，世界。`,
    };
    const recipient = {
      device_id: account.device,
      binding_id: account.binding,
      key_id: createHash("sha256").update(publicBytes).digest("hex"),
      public_key: publicBytes.toString("base64url"),
    };
    const encrypted = await call("/encrypt", {
      id: eventID, account: account.id, content, recipient,
    });
    const userInfo = await call("/apns", {
      now,
      device: {
        id: account.device, username: account.username,
        binding_id: account.binding, device_token: "ab".repeat(32),
      },
      wire: {
        event_id: eventID, type: "notification", source_account_id: account.id,
        notification_id: 42, notification_kind: "mention", details_version: 3,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 300_000).toISOString(),
        encrypted_bodies: [encrypted],
      },
    });
    assert.equal(userInfo.source_account_id, account.id);
    assert.equal(userInfo.username, account.username);
    assert.equal(userInfo.body_encryption, 2);
    assert.deepEqual(userInfo.encrypted_body, encrypted);
    assert.equal(JSON.stringify(userInfo).includes(content.title), false);
    assert.equal(JSON.stringify(userInfo).includes(content.body), false);
    await writeFile(join(outputDirectory, `push-content-cf-${account.username}.json`), JSON.stringify({
      ...content,
      private_key: privateBytes.toString("base64url"),
      user_info: userInfo,
    }));
  }
  console.log("Generated two CF encrypt → relay validation → APNs fixtures without external requests");
} finally {
  await mf.dispose();
}
