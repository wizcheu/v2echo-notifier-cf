# 部署与运维指南

## 环境要求

- **Node.js**：`^22.23.0 || ^24.22.0 || ^26.12.0`（`.node-version` 固定为 `22.23.0`）。
- **Cloudflare 账号**：Free 或 Paid 均可，请为本助手创建独立的 Worker 与 D1 数据库。

## 预构建包部署（推荐）

从 [Releases](https://github.com/wizcheu/v2echo-notifier-cf/releases) 下载 `v2echo-notifier-cf-vX.Y.Z.tar.gz` 与 `SHA256SUMS.txt`，校验后解压运行：

```bash
shasum -a 256 -c SHA256SUMS.txt
mkdir -p ~/v2echo-notifier && cd ~/v2echo-notifier
tar -xzf /你的下载路径/v2echo-notifier-cf-vX.Y.Z.tar.gz
npm install
npm run setup
```

`npm run setup` 自动完成登录、创建/选择 D1、写入 `deployment.local.json`、生成 `private/secrets.env`（`0600`，不覆盖已有密钥）、建表与发布。

## 手动分步部署（源码 / CI）

```bash
git clone https://github.com/wizcheu/v2echo-notifier-cf.git
cd v2echo-notifier-cf
npm ci
npx cf auth login                      # CI 可改为导出 CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
npx cf d1 create --name v2echo-notifier-cf
```

1. 复制 `deployment.example.json` 为 `deployment.local.json` 并填写真实值：
   ```json
   {
     "accountId": "32位小写Cloudflare账号ID",
     "databaseId": "D1数据库真实UUID",
     "workerName": "v2echo-notifier-cf"
   }
   ```
   如需绑定自定义域名，增加 `"domain": "notifier.example.com"`（不含 `https://`，不填则默认使用 `*.workers.dev`）。
2. 生成密钥文件 `private/secrets.env`（权限 `0600`，请备份到密码管理器）：
   ```bash
   mkdir -p private && chmod 700 private
   cat <<EOF > private/secrets.env
   ADMIN_TOKEN="$(openssl rand -hex 32)"
   NOTIFIER_KEY="$(openssl rand -hex 32)"
   EOF
   chmod 600 private/secrets.env
   ```
3. 迁移、构建并首次发布：
   ```bash
   npx cf d1 migrations apply <D1数据库UUID>
   npm run build
   npx cf deploy --prebuilt --mode production --secrets-file private/secrets.env
   ```
4. 访问 `https://<助手域名>/api/app/v1/health` 返回 `{"status":"ok"}` 后，打开首页登录并添加账号。

> **自定义域名 HTTPS**：App 直连要求 HTTPS 且不跟随重定向，请在 Cloudflare 开启 **Always Use HTTPS**（`cloudflare/https-redirect.json` 为示例模板）。

## 日常更新

```bash
npm run update                   # 拉取最新官方预构建包、校验 SHA-256、增量迁移并发布
npm run update -- v1.0.0         # 更新到指定版本
npm run update -- --from-source  # 源码目录内本地构建发布
```

常规更新不覆盖云端 `ADMIN_TOKEN`、`NOTIFIER_KEY`、D1 数据与通知开关。单独轮换登录密码：

```bash
npx cf workers secrets update ADMIN_TOKEN --worker <Worker名称> --type secret_text
```

## 数据库迁移

迁移脚本位于 `migrations/`，由 D1 的 `d1_migrations` 自动记账：

- **新库与常规升级**：先执行 `npx cf d1 migrations apply <databaseId>`，再发布代码（`npm run setup` / `npm run update` 已内置该顺序）。
- **历史老库专项升级**：若旧库仍待执行 `0005_remove_probes.sql` 或 `0018_multi_account.sql`，`npm run update` 会主动阻断。升级前先暂停旧 Worker Cron、保留 D1 恢复点与原 `NOTIFIER_KEY`，按编号执行迁移并核对 `d1_migrations` 后再部署新版。迁移后不可仅回滚 Worker 代码。

## 从旧 Docker 助手迁移

1. 部署本助手（保留旧 Docker 实例），在 **设置 → 账号与凭据** 添加对应 V2EX 账号的 Cookie 与 PAT。
2. 在 **设置 → 设备配对** 生成二维码，在各台设备的 V2Echo 扫码迁移（多设备用 **添加接收设备**；整组一次切换可在新未绑定实例使用 **接替已有通知助手**）。
3. 开启通知服务并确认全部设备正常接收后，再停止旧 Docker 容器。

> 旧 SQLite 的历史通知、去重与未发队列不自动迁移；避免新旧实例长时间并行以免重复提醒。

## 本地开发

```bash
npm ci
node scripts/init-local.mjs
npm run db:local
npm run dev
```

访问 `http://127.0.0.1:5188`，用 `.dev.vars` 中的 `ADMIN_TOKEN` 登录。本地不自动触发 Cron，可在 **设置 → 网络与诊断** 点击 **执行到期检查**。

## 维护者发版

- `.github/workflows/ci.yml`：PR / `main` 推送自动执行检查、测试、打包与 `cf deploy --dry-run`。
- `.github/workflows/release.yml`：更新 `package.json` 的 `version` 后推送 `v*` 标签（或在 Actions 手动触发），自动生成并发布预构建包 `v2echo-notifier-cf-v<version>.tar.gz` 与 `SHA256SUMS.txt`。

## 如何判定免费额度是否足够

建议在实际 **Workers Free** 账号连续运行 **72 小时**后综合核对：

1. 在 **推送记录** 与 **检查日志** 核对真实通知与错误类型（429、验证页、中断）。
2. 在 **设置 → 网络与诊断** 核对应用记录的 Worker 调用、D1 读写行与 V2EX API 消耗，并在 Cloudflare **Worker Observability** 核对实际 CPU 时间。
3. 如用量偏高，可在 **设置 → 通知策略** 调大检查间隔或缩窄每日检查时段。

**Free 参考限额（2026-10-21 核对）**：Workers 100,000 请求/天、10 ms CPU/次；D1 读 5,000,000 行/天、写 100,000 行/天、单库 500 MB。最新口径见 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 与 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。
