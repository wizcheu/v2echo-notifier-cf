#!/usr/bin/env node
/**
 * Package a clean, self-contained prebuilt release tarball for GitHub Releases.
 * Users can deploy and update from this tarball without forking, cloning Git,
 * or compiling TypeScript/Vite locally.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_DB_ID = "00000000-0000-4000-8000-000000000001";
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function sanitizeReleaseWorkerConfig(config) {
  const sanitized = structuredClone(config);
  sanitized.name = "v2echo-notifier-cf";
  delete sanitized.domains;
  sanitized.workersDev = true;
  sanitized.previewUrls = false;
  if (sanitized.env && typeof sanitized.env === "object") {
    delete sanitized.env.PUSH_SERVICE;
    if (sanitized.env.DB && typeof sanitized.env.DB === "object") {
      sanitized.env.DB.name = "v2echo-notifier-cf";
      sanitized.env.DB.id = PLACEHOLDER_DB_ID;
    }
  }
  return sanitized;
}

export function assertCleanReleaseWorkerConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("worker.config.json 无效。");
  }
  if (config.domains !== undefined) {
    throw new Error("发布产物中不得包含私有 domains 配置。");
  }
  if (config.env?.PUSH_SERVICE !== undefined) {
    throw new Error("发布产物中不得包含 PUSH_SERVICE 内部绑定。");
  }
  if (config.env?.DB?.id !== PLACEHOLDER_DB_ID) {
    throw new Error("发布产物的 DB.id 须为占位 UUID，请使用 RELEASE_BUILD=1 构建。");
  }
}

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function packRelease({ rootDir = ROOT, outDir = path.join(ROOT, "dist-release"), version } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const resolvedVersion = String(version ?? process.env.APP_VERSION ?? pkg.version ?? "")
    .trim()
    .replace(/^v/, "");
  if (!SEMVER_RE.test(resolvedVersion)) {
    throw new Error(`发布版本号无效：${resolvedVersion}`);
  }

  const cfPkgPath = path.join(rootDir, "node_modules", "cf", "package.json");
  const cfVersion = existsSync(cfPkgPath)
    ? JSON.parse(readFileSync(cfPkgPath, "utf8")).version
    : String(pkg.devDependencies?.cf ?? "").replace(/^\^/, "");
  if (!cfVersion) {
    throw new Error("无法确定固定 cf CLI 版本号。");
  }

  const buildRootDir = path.join(rootDir, ".cloudflare", "output", "v0");
  const rootConfigPath = path.join(buildRootDir, "config.json");
  const buildWorkerDir = path.join(buildRootDir, "workers", "default");
  const workerConfigPath = path.join(buildWorkerDir, "worker.config.json");
  if (!existsSync(rootConfigPath) || !existsSync(workerConfigPath)) {
    throw new Error("未找到构建产物，请先运行 RELEASE_BUILD=1 npm run build。");
  }

  const rawWorkerConfig = JSON.parse(readFileSync(workerConfigPath, "utf8"));
  const cleanWorkerConfig = sanitizeReleaseWorkerConfig(rawWorkerConfig);
  assertCleanReleaseWorkerConfig(cleanWorkerConfig);

  const migrationsDir = path.join(rootDir, "migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrations.length === 0) {
    throw new Error("migrations 目录为空。");
  }

  const tag = `v${resolvedVersion}`;
  const archiveName = `v2echo-notifier-cf-${tag}.tar.gz`;
  const stageDir = path.join(outDir, `.stage-${tag}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(stageDir, ".cloudflare", "output", "v0", "workers", "default"), { recursive: true });

  cpSync(rootConfigPath, path.join(stageDir, ".cloudflare", "output", "v0", "config.json"));
  cpSync(
    path.join(buildWorkerDir, "bundle"),
    path.join(stageDir, ".cloudflare", "output", "v0", "workers", "default", "bundle"),
    { recursive: true },
  );
  cpSync(
    path.join(buildWorkerDir, "assets"),
    path.join(stageDir, ".cloudflare", "output", "v0", "workers", "default", "assets"),
    { recursive: true },
  );
  writeFileSync(
    path.join(stageDir, ".cloudflare", "output", "v0", "workers", "default", "worker.config.json"),
    `${JSON.stringify(cleanWorkerConfig, null, 2)}\n`,
  );

  mkdirSync(path.join(stageDir, "migrations"), { recursive: true });
  for (const file of migrations) {
    cpSync(path.join(migrationsDir, file), path.join(stageDir, "migrations", file));
  }

  cpSync(path.join(rootDir, "scripts", "self-host.mjs"), path.join(stageDir, "self-host.mjs"));
  cpSync(path.join(rootDir, "deployment.example.json"), path.join(stageDir, "deployment.example.json"));
  cpSync(path.join(rootDir, "README.md"), path.join(stageDir, "README.md"));

  const runtimePkg = {
    name: "v2echo-notifier-cf-runtime",
    private: true,
    version: resolvedVersion,
    type: "module",
    scripts: {
      setup: "node self-host.mjs setup",
      update: "node self-host.mjs update",
    },
    dependencies: {
      cf: cfVersion,
    },
    engines: pkg.engines,
  };
  writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

  const releaseMeta = {
    version: resolvedVersion,
    tag,
    cfVersion,
    migrationsCount: migrations.length,
    latestMigration: migrations.at(-1),
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(stageDir, "release.json"), `${JSON.stringify(releaseMeta, null, 2)}\n`);

  const archivePath = path.join(outDir, archiveName);
  rmSync(archivePath, { force: true });
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", stageDir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "pipe",
    encoding: "utf8",
  });
  rmSync(stageDir, { recursive: true, force: true });
  if (tar.status !== 0) {
    throw new Error(`打包失败：${tar.stderr || tar.stdout}`);
  }

  const digest = sha256File(archivePath);
  const checksumPath = path.join(outDir, "SHA256SUMS.txt");
  writeFileSync(checksumPath, `${digest}  ${archiveName}\n`);

  return { version: resolvedVersion, tag, archiveName, archivePath, checksumPath, digest, releaseMeta };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = packRelease();
    console.log(`已生成预构建发布包：${path.relative(ROOT, result.archivePath)}`);
    console.log(`SHA-256: ${result.digest}`);
    console.log(`校验文件：${path.relative(ROOT, result.checksumPath)}`);
  } catch (error) {
    console.error(`打包失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
