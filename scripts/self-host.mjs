#!/usr/bin/env node
/**
 * Standalone interactive setup & update helper for self-hosting v2echo-notifier-cf
 * on your own Cloudflare account. Works both inside an extracted GitHub Release
 * tarball (zero Git / zero source compilation) and inside a source checkout.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.basename(SCRIPT_DIR) === "scripts" ? path.resolve(SCRIPT_DIR, "..") : SCRIPT_DIR;

const RELEASE_REPO = "wizcheu/v2echo-notifier-cf";
const RELEASE_API_BASE = `https://api.github.com/repos/${RELEASE_REPO}/releases`;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const PLACEHOLDER_DB_ID = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
const TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const GATED_MIGRATIONS = new Set(["0005_remove_probes.sql", "0018_multi_account.sql"]);

const cfBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "cf.cmd" : "cf");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Extract JSON payload from `cf` CLI stdout even if non-JSON preamble text appears. */
export function parseJsonOutput(raw) {
  const cleaned = String(raw ?? "").replace(ANSI_RE, "").trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch !== "[" && ch !== "{") continue;
      try {
        return JSON.parse(cleaned.slice(i));
      } catch {
        // Keep scanning for the actual JSON start.
      }
    }
    return null;
  }
}

/** Validate and normalize deployment.local.json fields (matches deployment-config.ts). */
export function buildDeploymentConfig(input) {
  const accountId = String(input?.accountId ?? "").trim().toLowerCase();
  const databaseId = String(input?.databaseId ?? "").trim().toLowerCase();
  const workerName = String(input?.workerName ?? "v2echo-notifier-cf").trim().toLowerCase();
  const domain = input?.domain ? String(input.domain).trim().toLowerCase() : undefined;
  const pushService = input?.pushService ? String(input.pushService).trim().toLowerCase() : undefined;

  if (!ACCOUNT_ID_RE.test(accountId))
    throw new Error("Cloudflare Account ID 须为 32 位小写十六进制字符。");
  if (!UUID_RE.test(databaseId) || databaseId === PLACEHOLDER_DB_ID)
    throw new Error("D1 Database ID 须为真实的 UUID，不能使用本地开发占位值。");
  if (!WORKER_NAME_RE.test(workerName))
    throw new Error("Worker 名称仅允许小写字母、数字和连字符，且以字母或数字开头。");
  if (domain !== undefined && !DOMAIN_RE.test(domain))
    throw new Error("自定义域名格式无效（请填写纯域名，例如 notifier.example.com，不要包含 https://）。");
  if (pushService !== undefined && !WORKER_NAME_RE.test(pushService))
    throw new Error("pushService 名称格式无效。");

  return {
    accountId,
    databaseId,
    workerName,
    ...(domain ? { domain } : {}),
    ...(pushService ? { pushService } : {}),
  };
}

/** Apply user deployment settings to a prebuilt Build Output worker.config.json. */
export function patchWorkerConfig(workerConfig, deployment) {
  const config = buildDeploymentConfig(deployment);
  const patched = structuredClone(workerConfig);
  patched.name = config.workerName;
  if (config.domain) {
    patched.domains = [config.domain];
    patched.workersDev = false;
  } else {
    delete patched.domains;
    patched.workersDev = true;
  }
  patched.previewUrls = false;
  patched.env = patched.env && typeof patched.env === "object" ? { ...patched.env } : {};
  delete patched.env.PUSH_SERVICE;
  patched.env.DB = {
    type: "d1",
    name: config.workerName,
    id: config.databaseId,
  };
  return patched;
}

/** Parse KEY=VALUE lines from a dotenv secrets file without executing shell code. */
export function parseSecretsEnv(content) {
  const values = {};
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** Verify a downloaded archive's SHA-256 digest against SHA256SUMS.txt. */
export function verifySha256(filePath, checksumText, fileName) {
  let expected = null;
  for (const line of String(checksumText ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === fileName) {
      expected = match[1].toLowerCase();
      break;
    }
  }
  if (!expected) {
    throw new Error(`SHA256SUMS.txt 中未找到 ${fileName} 的校验值。`);
  }
  const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (actual !== expected) {
    throw new Error(`发布包 ${fileName} SHA-256 校验失败（期望 ${expected}，实际 ${actual}）。`);
  }
  return actual;
}

/**
 * Create private/secrets.env (0600) with random ADMIN_TOKEN and NOTIFIER_KEY if absent.
 * Never overwrites an existing file so NOTIFIER_KEY cannot be accidentally rotated.
 */
export function ensureSecretsFile(filePath) {
  if (existsSync(filePath)) {
    const existing = parseSecretsEnv(readFileSync(filePath, "utf8"));
    const valid =
      typeof existing.ADMIN_TOKEN === "string" &&
      existing.ADMIN_TOKEN.length >= 32 &&
      /^[0-9a-f]{64}$/.test(existing.NOTIFIER_KEY ?? "");
    return { created: false, valid };
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const adminToken = randomBytes(32).toString("hex");
  const notifierKey = randomBytes(32).toString("hex");
  const content =
    "# V2Echo Notifier Cloudflare Worker Secrets (mode 0600, ignored by Git)\n" +
    "# Please back up ADMIN_TOKEN and NOTIFIER_KEY in your password manager.\n" +
    "# NEVER rotate NOTIFIER_KEY on an existing database or stored data cannot be decrypted.\n" +
    `ADMIN_TOKEN="${adminToken}"\n` +
    `NOTIFIER_KEY="${notifierKey}"\n`;
  writeFileSync(filePath, content, { flag: "wx", mode: 0o600 });
  return { created: true, valid: true };
}

/**
 * Detect legacy schema upgrades (0005 / 0018) on an existing non-empty database.
 * Brand-new databases (where 0001_initial.sql is also unapplied) are safe to initialize directly.
 */
export function detectGatedMigrations(pendingNames) {
  const names = new Set(pendingNames);
  if (names.has("0001_initial.sql")) return [];
  return [...names].filter((name) => GATED_MIGRATIONS.has(name)).sort();
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    CF_SEND_TELEMETRY: "false",
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
    ...extra,
  };
}

function runInteractive(command, args, { cwd = ROOT, env = {} } = {}) {
  console.log(`\n→ ${path.basename(command)} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(env),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`命令执行失败（退出码 ${result.status}）：${path.basename(command)} ${args.join(" ")}`);
  }
}

function runCapture(command, args, { cwd = ROOT, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function checkNodeVersion() {
  const pkgPath = path.join(ROOT, "package.json");
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const requirement = pkg.engines?.node;
  if (!requirement) return;
  const current = process.versions.node.split(".").map(Number);
  const ok = requirement.split(" || ").some((term) => {
    const match = term.trim().match(/^(\^|>=)(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return true;
    const min = match.slice(2).map(Number);
    const ge =
      current[0] > min[0] ||
      (current[0] === min[0] && (current[1] > min[1] || (current[1] === min[1] && current[2] >= min[2])));
    return ge && (match[1] === ">=" || current[0] === min[0]);
  });
  if (!ok) {
    throw new Error(
      `当前 Node.js 版本为 v${process.versions.node}，需要满足 ${requirement}（推荐使用 Node 22.23+）。`,
    );
  }
}

function ensureCfInstalled() {
  if (!existsSync(cfBin)) {
    throw new Error("未找到本地 cf CLI，请先运行 npm install 安装依赖。");
  }
}

function assertAllowedDownloadUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`拒绝从不受信任的地址下载发布包：${rawUrl}`);
  }
}

async function fetchDownload(url) {
  assertAllowedDownloadUrl(url);
  let current = url;
  for (let hops = 0; hops < 4; hops++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "v2echo-notifier-cf-updater" },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("下载重定向缺少目标地址。");
      const next = new URL(location, current).toString();
      assertAllowedDownloadUrl(next);
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）：${current}`);
    }
    return response;
  }
  throw new Error("下载重定向次数过多。");
}

async function downloadAndExtractRelease(versionArg, workDir) {
  const normalizedTag = versionArg
    ? versionArg.startsWith("v")
      ? versionArg
      : `v${versionArg}`
    : null;
  if (normalizedTag && !TAG_RE.test(normalizedTag)) {
    throw new Error(`版本号格式无效：${versionArg}（示例：v1.0.0）`);
  }

  const apiUrl = normalizedTag
    ? `${RELEASE_API_BASE}/tags/${encodeURIComponent(normalizedTag)}`
    : `${RELEASE_API_BASE}/latest`;
  console.log(`\n正在从 GitHub 获取${normalizedTag ? `版本 ${normalizedTag}` : "最新正式版本"}信息…`);
  const metaResponse = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "v2echo-notifier-cf-updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (metaResponse.status === 404) {
    throw new Error(
      normalizedTag
        ? `未找到官方发布版本 ${normalizedTag}，请检查版本号或前往 GitHub Releases 核对。`
        : "官方仓库尚未发布正式 Release；如在源码目录开发，可运行 npm run update -- --from-source。",
    );
  }
  if (!metaResponse.ok) {
    throw new Error(`查询 GitHub Releases 失败（HTTP ${metaResponse.status}）。`);
  }

  const release = await metaResponse.json();
  const tag = String(release?.tag_name ?? "");
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const archiveName = `v2echo-notifier-cf-${tag}.tar.gz`;
  const archiveAsset = assets.find((item) => item?.name === archiveName);
  const checksumAsset = assets.find((item) => item?.name === "SHA256SUMS.txt");
  if (!archiveAsset?.browser_download_url || !checksumAsset?.browser_download_url) {
    throw new Error(`Release ${tag} 缺少预构建包或 SHA256SUMS.txt。`);
  }

  console.log(`正在下载 ${archiveName} 与 SHA256SUMS.txt…`);
  const [archiveRes, checksumRes] = await Promise.all([
    fetchDownload(archiveAsset.browser_download_url),
    fetchDownload(checksumAsset.browser_download_url),
  ]);
  const archivePath = path.join(workDir, archiveName);
  writeFileSync(archivePath, Buffer.from(await archiveRes.arrayBuffer()));
  const checksumText = await checksumRes.text();
  const digest = verifySha256(archivePath, checksumText, archiveName);
  console.log(`SHA-256 校验通过：${digest.slice(0, 16)}…`);

  const extractDir = path.join(workDir, "release");
  mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`解压发布包失败：${tar.stderr || tar.stdout}`);
  }
  return { tag, extractDir };
}

function patchWorkerConfigFile(baseDir, deployment) {
  const workerConfigPath = path.join(
    baseDir,
    ".cloudflare",
    "output",
    "v0",
    "workers",
    "default",
    "worker.config.json",
  );
  if (!existsSync(workerConfigPath)) {
    throw new Error(`未找到预构建配置：${workerConfigPath}`);
  }
  const current = JSON.parse(readFileSync(workerConfigPath, "utf8"));
  const patched = patchWorkerConfig(current, deployment);
  writeFileSync(workerConfigPath, `${JSON.stringify(patched, null, 2)}\n`);
}

function checkPendingGatedMigrations(databaseId, accountId, migrationsDir) {
  const args = ["d1", "migrations", "list", databaseId];
  if (migrationsDir) args.push("--dir", migrationsDir);
  const listed = runCapture(cfBin, args, { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  if (!listed.ok) return;
  const text = `${listed.stdout}\n${listed.stderr}`;
  const pending = [...new Set(text.match(/\b\d{4}_[a-z0-9_]+\.sql\b/g) ?? [])];
  const gated = detectGatedMigrations(pending);
  if (gated.length > 0) {
    throw new Error(
      `检测到旧库专项迁移（${gated.join(", ")}），已停止自动升级。请先按文档完成备份与专项升级。`,
    );
  }
}

async function ensureAuth(rl) {
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.log("检测到环境变量 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，跳过浏览器登录。");
    return;
  }
  const check = runCapture(cfBin, ["auth", "whoami"]);
  if (check.ok) {
    console.log("Cloudflare CLI 已登录。");
    return;
  }
  console.log("尚未登录 Cloudflare，即将打开浏览器完成 OAuth 授权登录。");
  const answer = (await rl.question("按回车继续登录 Cloudflare（输入 n 取消）: ")).trim().toLowerCase();
  if (answer === "n") throw new Error("已取消。");
  runInteractive(cfBin, ["auth", "login"]);
}

async function pickAccountId(rl) {
  if (ACCOUNT_ID_RE.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    return process.env.CLOUDFLARE_ACCOUNT_ID.toLowerCase();
  }
  const listed = runCapture(cfBin, ["accounts", "list"]);
  const parsed = listed.ok ? parseJsonOutput(listed.stdout) : null;
  const accounts = Array.isArray(parsed)
    ? parsed.filter((item) => item && ACCOUNT_ID_RE.test(String(item.id ?? "").toLowerCase()))
    : [];

  if (accounts.length === 1) {
    console.log(`已自动识别 Cloudflare 账号：${accounts[0].name ?? "默认账号"} (${accounts[0].id})`);
    return String(accounts[0].id).toLowerCase();
  }
  if (accounts.length > 1) {
    console.log("\n检测到多个 Cloudflare 账号：");
    accounts.forEach((account, index) => {
      console.log(`  [${index + 1}] ${account.name ?? "未命名"} (${account.id})`);
    });
    const choice = (await rl.question(`请选择账号编号 [1-${accounts.length}]（默认 1）: `)).trim();
    const idx = choice ? Number.parseInt(choice, 10) - 1 : 0;
    if (Number.isInteger(idx) && idx >= 0 && idx < accounts.length) {
      return String(accounts[idx].id).toLowerCase();
    }
  }
  return (await rl.question("请输入你的 32 位 Cloudflare Account ID: ")).trim().toLowerCase();
}

async function pickDatabaseId(rl, accountId, workerName) {
  const listed = runCapture(cfBin, ["d1", "list"], { env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
  const parsed = listed.ok ? parseJsonOutput(listed.stdout) : null;
  const databases = Array.isArray(parsed)
    ? parsed.filter((item) => item && UUID_RE.test(String(item.uuid ?? "").toLowerCase()))
    : [];

  const matched = databases.find((item) => item.name === workerName);
  if (matched) {
    const reuse = (
      await rl.question(`发现同名 D1 数据库「${matched.name}」(${matched.uuid})，是否直接使用？[Y/n]: `)
    )
      .trim()
      .toLowerCase();
    if (reuse !== "n") return String(matched.uuid).toLowerCase();
  }

  console.log("\nD1 数据库配置：");
  console.log(`  [1] 自动创建新的 D1 数据库（名称：${workerName}，推荐）`);
  console.log("  [2] 手动输入已有 D1 数据库的 UUID");
  if (databases.length > 0) {
    console.log("  当前账号已有 D1 列表：");
    for (const db of databases) {
      console.log(`      - ${db.name}: ${db.uuid}`);
    }
  }
  const mode = (await rl.question("请选择 [1/2]（默认 1）: ")).trim();
  if (mode === "2") {
    return (await rl.question("请输入已有 D1 数据库 UUID: ")).trim().toLowerCase();
  }

  console.log(`\n正在创建 D1 数据库「${workerName}」…`);
  const created = runCapture(cfBin, ["d1", "create", "--name", workerName], {
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  const createdData = created.ok ? parseJsonOutput(created.stdout) : null;
  const createdUuid = String(createdData?.uuid ?? createdData?.result?.uuid ?? "").toLowerCase();
  if (UUID_RE.test(createdUuid)) {
    console.log(`已创建 D1 数据库：${workerName} (${createdUuid})`);
    return createdUuid;
  }
  console.error(created.stderr || created.stdout || "未能自动解析新建 D1 的 UUID。");
  return (await rl.question("请在 Cloudflare 控制台创建 D1 后粘贴其 UUID: ")).trim().toLowerCase();
}

async function runSetup() {
  checkNodeVersion();
  ensureCfInstalled();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("=== V2Echo Cloudflare 通知助手 · 首次部署向导 ===\n");
    await ensureAuth(rl);

    const deployPath = path.join(ROOT, "deployment.local.json");
    let config;
    if (existsSync(deployPath)) {
      const existing = buildDeploymentConfig(JSON.parse(readFileSync(deployPath, "utf8")));
      console.log(`\n检测到已有 deployment.local.json：`);
      console.log(`  Worker:   ${existing.workerName}`);
      console.log(`  Account:  ${existing.accountId}`);
      console.log(`  D1 UUID:  ${existing.databaseId}`);
      if (existing.domain) console.log(`  Domain:   ${existing.domain}`);
      const reuse = (await rl.question("是否沿用此部署配置？[Y/n]: ")).trim().toLowerCase();
      if (reuse !== "n") config = existing;
    }

    if (!config) {
      const accountId = await pickAccountId(rl);
      const workerInput = (await rl.question("Worker 名称（默认 v2echo-notifier-cf）: ")).trim();
      const workerName = workerInput || "v2echo-notifier-cf";
      const domainInput = (
        await rl.question("自定义域名（可选，例如 notifier.example.com；直接回车使用默认 *.workers.dev）: ")
      ).trim();
      const databaseId = await pickDatabaseId(rl, accountId, workerName);
      config = buildDeploymentConfig({
        accountId,
        databaseId,
        workerName,
        domain: domainInput || undefined,
      });
      writeFileSync(deployPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      console.log("\n已保存部署配置至 deployment.local.json（已在 .gitignore 中忽略）。");
    }

    const secretsPath = path.join(ROOT, "private", "secrets.env");
    const secrets = ensureSecretsFile(secretsPath);
    if (secrets.created) {
      console.log("\n已自动生成管理密钥与加密主密钥，并保存至 private/secrets.env（权限 0600）。");
      console.log("重要：请立即将 private/secrets.env 中的 ADMIN_TOKEN 和 NOTIFIER_KEY 备份到密码管理器。");
      console.log("     丢失 NOTIFIER_KEY 将无法解密已保存的 V2EX 凭据与历史数据。");
    } else if (!secrets.valid) {
      throw new Error(
        "已存在 private/secrets.env，但缺少有效的 ADMIN_TOKEN（>= 32 字符）或 NOTIFIER_KEY（64 位小写十六进制）。请修正后重试。",
      );
    } else {
      console.log("\n检测到已有 private/secrets.env，保留原密钥不覆盖。");
    }

    const uploadSecrets = (
      await rl.question("\n是否随本次部署上传 private/secrets.env 中的密钥？（首次部署请选 Y）[Y/n]: ")
    )
      .trim()
      .toLowerCase();

    const hasPrebuilt = existsSync(
      path.join(ROOT, ".cloudflare", "output", "v0", "workers", "default", "worker.config.json"),
    );
    const hasSourceBuild = existsSync(path.join(ROOT, "vite.config.ts"));
    console.log(
      hasPrebuilt && !hasSourceBuild
        ? "\n即将执行：应用 D1 迁移 → 写入部署配置 → 发布预构建 Worker。"
        : "\n即将执行：应用 D1 迁移 → 构建产物 → 部署 Worker。",
    );
    const proceed = (await rl.question("确认开始部署？[Y/n]: ")).trim().toLowerCase();
    if (proceed === "n") {
      console.log("已取消部署；配置文件已保留，随时可重新运行 npm run setup。");
      return;
    }

    const accountEnv = { CLOUDFLARE_ACCOUNT_ID: config.accountId };
    checkPendingGatedMigrations(config.databaseId, config.accountId);
    runInteractive(cfBin, ["d1", "migrations", "apply", config.databaseId], { env: accountEnv });

    if (hasSourceBuild) {
      runInteractive(npmBin, ["run", "build"]);
    } else if (hasPrebuilt) {
      patchWorkerConfigFile(ROOT, config);
    } else {
      throw new Error("当前目录既无预构建产物也无源码构建配置，请从 GitHub Releases 重新下载发布包。");
    }

    const deployArgs = ["deploy", "--prebuilt", "--mode", "production"];
    if (uploadSecrets !== "n") {
      deployArgs.push("--secrets-file", secretsPath);
    }
    runInteractive(cfBin, deployArgs, { env: accountEnv });

    console.log("\n=== 部署完成 ===");
    console.log("接下来请完成网页端配置：");
    console.log(
      `1. 打开上方输出的 HTTPS 地址${config.domain ? `（https://${config.domain}）` : ""}。`,
    );
    console.log("2. 查看 private/secrets.env 中的 ADMIN_TOKEN 登录管理台。");
    console.log("3. 进入「设置 → 账号与凭据」添加 V2EX 账号（粘贴同一账号的 Cookie 与 PAT）。");
    console.log("4. 进入「设置 → 设备配对」生成二维码，在 V2Echo App 中扫码完成连接。");
    console.log("5. 在「概览」开启「通知服务」，并可发送测试通知验证送达。");
  } finally {
    rl.close();
  }
}

async function runUpdate(args) {
  checkNodeVersion();
  ensureCfInstalled();

  const deployPath = path.join(ROOT, "deployment.local.json");
  if (!existsSync(deployPath)) {
    throw new Error("未找到 deployment.local.json。首次部署请先运行 npm run setup。");
  }
  const config = buildDeploymentConfig(JSON.parse(readFileSync(deployPath, "utf8")));
  const accountEnv = { CLOUDFLARE_ACCOUNT_ID: config.accountId };
  const fromSource = args.includes("--from-source");
  const versionArg = args.find((arg) => !arg.startsWith("-"));

  console.log(`=== 更新 V2Echo 通知助手（${config.workerName}）===`);
  console.log("说明：常规更新仅应用新增数据库迁移并发布新版代码，不会修改云端密钥或清空数据。");

  if (fromSource) {
    if (!existsSync(path.join(ROOT, "vite.config.ts"))) {
      throw new Error("当前目录不含源码构建文件，无法使用 --from-source；请直接运行 npm run update。");
    }
    checkPendingGatedMigrations(config.databaseId, config.accountId);
    runInteractive(cfBin, ["d1", "migrations", "apply", config.databaseId], { env: accountEnv });
    runInteractive(npmBin, ["run", "build"]);
    runInteractive(cfBin, ["deploy", "--prebuilt", "--mode", "production"], { env: accountEnv });
    console.log("\n从本地源码更新完成。");
    return;
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "v2echo-notifier-update-"));
  try {
    const { tag, extractDir } = await downloadAndExtractRelease(versionArg, workDir);
    const migrationsDir = path.join(extractDir, "migrations");
    checkPendingGatedMigrations(config.databaseId, config.accountId, migrationsDir);
    runInteractive(
      cfBin,
      ["d1", "migrations", "apply", config.databaseId, "--dir", migrationsDir],
      { cwd: extractDir, env: accountEnv },
    );
    patchWorkerConfigFile(extractDir, config);
    runInteractive(cfBin, ["deploy", "--prebuilt", "--mode", "production"], {
      cwd: extractDir,
      env: accountEnv,
    });
    console.log(`\n已成功更新到官方版本 ${tag}。`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function printHelp() {
  console.log(
    "用法:\n" +
      "  npm run setup                         交互式首次部署（登录 Cloudflare、创建/绑定 D1、生成密钥、建表并发布）\n" +
      "  npm run update                        从 GitHub Releases 下载最新预构建正式版、校验 SHA-256 并完成更新\n" +
      "  npm run update -- v1.0.0              更新或锁定到指定的官方发布版本\n" +
      "  npm run update -- --from-source       在源码目录内从本地源码重新构建并发布（开发者用）\n",
  );
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "setup") {
      await runSetup();
    } else if (command === "update") {
      await runUpdate(rest);
    } else if (!command || command === "-h" || command === "--help") {
      printHelp();
    } else {
      console.error(`未知子命令：${command}`);
      printHelp();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`\n错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
