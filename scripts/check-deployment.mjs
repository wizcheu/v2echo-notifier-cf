import { readFile } from "node:fs/promises";

try {
  const config = JSON.parse(await readFile(new URL("../deployment.local.json", import.meta.url), "utf8"));
  if (!/^[a-f0-9]{32}$/.test(config.accountId ?? "") ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.databaseId ?? "") ||
      config.databaseId === "00000000-0000-4000-8000-000000000001") throw new Error();
  console.log("本机部署配置已就绪；Secrets 继续由 Cloudflare 管理。");
} catch {
  console.error("尚未配置部署目标。复制 deployment.example.json 为 deployment.local.json，填写自己的 Cloudflare 账号和 D1 ID 后再部署。");
  process.exitCode = 1;
}
