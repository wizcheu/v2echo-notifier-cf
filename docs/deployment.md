# 部署、升级与运维指南

本指南涵盖 `v2echo-notifier-cf` 的预构建发布包部署与更新（推荐）、从源码手动部署、自定义域名、密钥管理、数据库迁移、从旧 Docker 助手迁移、维护者 GitHub Actions 发版流程以及 Cloudflare 免费额度评估。

---

## 环境要求

- **Node.js**：`^22.23.0 || ^24.22.0 || ^26.12.0`（项目根目录 `.node-version` 固定为 `22.23.0`）。若使用 nvm，可在目录内运行 `nvm use` 或先安装对应版本。
- **Cloudflare 账号**：Free 或 Paid 均可。
- **不要复用其他服务的资源**：请为通知助手创建独立的 Worker 与 D1 数据库，不要复用其他项目的数据库或密钥。

---

## 方式一：从 GitHub Release 预构建包部署（推荐，无需 Fork 与编译）

适合绝大多数自托管用户，全程不依赖 Git、不安装前端/后端编译工具链：

1. 前往 [Releases 页面](https://github.com/wizcheu/v2echo-notifier-cf/releases) 下载最新 `v2echo-notifier-cf-vX.Y.Z.tar.gz` 与 `SHA256SUMS.txt`（可选校验完整性：`shasum -a 256 -c SHA256SUMS.txt`）。
2. 在本机新建一个持久目录解压并运行部署向导：

```bash
mkdir -p ~/v2echo-notifier && cd ~/v2echo-notifier
tar -xzf /你的下载路径/v2echo-notifier-cf-v1.0.0.tar.gz
npm install
npm run setup
```

向导脚本 `self-host.mjs` 仅使用 Node.js 内置模块，按顺序执行：

1. 检查 Cloudflare 登录态（未登录时调用 `npx cf auth login` 打开浏览器 OAuth 授权）。
2. 自动识别或让你选择 Cloudflare Account ID，确认 Worker 名称与可选自定义域名。
3. 自动创建或复用独立的 D1 数据库，生成本地文件 `deployment.local.json`。
4. 若 `private/secrets.env` 不存在，以 `0600` 权限生成随机 64 位十六进制 `ADMIN_TOKEN` 与 `NOTIFIER_KEY`（已有文件永不覆盖）。
5. 执行 `cf d1 migrations apply` 初始化数据库，将你的部署参数写入预构建的 `worker.config.json`，直接调用 `cf deploy --prebuilt --mode production --secrets-file private/secrets.env` 完成发布。

---

## 方式二：从源码克隆并部署（开发者 / 手动控制）

如果你希望从源码自行审查和构建，或准备在无交互环境（如 CI）中执行，可按以下 6 步完成：

### 1. 克隆代码、安装依赖并登录 Cloudflare

```bash
git clone https://github.com/wizcheu/v2echo-notifier-cf.git
cd v2echo-notifier-cf
npm ci
npx cf auth login
```

> **使用 API Token（非交互 / CI 场景）**：可不运行 `cf auth login`，改为在环境中导出 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN`。Token 需授予目标账号的 **Workers Scripts: Edit**、**D1: Edit**（如需自定义域名还需 **Workers Routes / Zone Settings** 对应权限）。不要把部署 Token 写入项目文件或提交 Git。

### 2. 创建独立 D1 数据库

```bash
npx cf d1 create --name v2echo-notifier-cf
```

记下输出的 36 位数据库 UUID（`uuid` 字段），同时确认你的 32 位 Cloudflare Account ID（可通过 `npx cf accounts list` 或 Cloudflare 控制台右侧栏查看）。

### 3. 编写部署配置文件 `deployment.local.json`

复制示例文件（已被 `.gitignore` 忽略，请勿提交）：

```bash
cp deployment.example.json deployment.local.json
```

填入你的真实信息：

```json
{
  "accountId": "你的32位小写Cloudflare账号ID",
  "databaseId": "你的D1数据库真实UUID",
  "workerName": "v2echo-notifier-cf"
}
```

- 如需绑定自定义域名，增加 `"domain": "notifier.example.com"`（仅填写域名，不含 `https://`，且该域名需已托管在同一个 Cloudflare 账号下）。
- 未配置 `domain` 时，自动启用 Cloudflare 默认的 `https://<workerName>.<子域>.workers.dev` 地址。
- 普通用户**不需要**填写 `pushService` 字段。

### 4. 生成并保管 Worker Secrets

创建仅当前用户可读的密钥文件（`private/` 已在 `.gitignore` 中忽略）：

```bash
mkdir -p private && chmod 700 private
cat <<EOF > private/secrets.env
ADMIN_TOKEN="$(openssl rand -hex 32)"
NOTIFIER_KEY="$(openssl rand -hex 32)"
EOF
chmod 600 private/secrets.env
```

- `ADMIN_TOKEN`：Web 管理台登录密码（至少 32 字符）。
- `NOTIFIER_KEY`：D1 中加密 V2EX Cookie/PAT、发送凭据、历史消息与关注进度的主密钥（必须为 64 位小写十六进制）。**请立即备份到密码管理器，后续更新切勿修改。**
- V2EX 的 Cookie 和 PAT **不需要**写进这里，部署后直接在 Web 管理台「设置 → 账号与凭据」添加即可。

### 5. 初始化数据库、构建并发布

```bash
# 1) 应用全部 D1 迁移（替换为你自己的 databaseId）
npx cf d1 migrations apply <你的D1数据库UUID>

# 2) 构建前端与 Worker
npm run build

# 3) 首次发布并上传 Secrets
npx cf deploy --prebuilt --mode production --secrets-file private/secrets.env
```

### 6. 验证存活与登录配置

访问 `https://<你的助手域名>/api/app/v1/health`，返回 `{"status":"ok"}` 说明 Worker 入口已上线。随后打开 `https://<你的助手域名>`，用 `ADMIN_TOKEN` 登录并完成添加账号、扫码配对与开启通知服务。

---

## 自定义域名与 HTTPS

- 在 `deployment.local.json` 中设置 `"domain": "notifier.example.com"` 后重新发布（`npm run update`），Cloudflare 会自动绑定该自定义域名的 Workers 路由与证书。
- V2Echo App 直连配对要求助手使用公开 **HTTPS** 地址且不支持 HTTP 重定向跳转。请在 Cloudflare 控制台的 SSL/TLS 中启用 **Always Use HTTPS**（或为你的主机名配置 308 HTTPS 跳转规则）。
- 仓库中的 `cloudflare/https-redirect.json` 仅为示例规则模板，切勿直接套用其中的示例主机名。

---

## 日常更新

在管理台 **设置 → 网络与诊断 → 版本与更新** 中可随时手动点击 **检查更新** 查看是否有新版本。

### 方式 A：一条命令拉取官方预构建包更新（推荐，无需编译）

在你的部署目录（含 `deployment.local.json`）中执行：

```bash
# 自动下载最新官方 Release 预构建包、校验 SHA-256、执行新增迁移并部署
npm run update

# 或指定目标版本
npm run update -- v1.1.0
```

脚本仅接受来自 `github.com` / `githubusercontent.com` 的官方 Release 下载，并在解压前严格核对 `SHA256SUMS.txt`；随后在临时目录套用你的 `deployment.local.json` 执行 `cf d1 migrations apply` 与 `cf deploy --prebuilt --mode production`，云端已有的 `ADMIN_TOKEN`、`NOTIFIER_KEY`、自定义域名、D1 数据与通知开关都会完整保留。

### 方式 B：从本地源码更新（开发者）

如果你在本地修改了源码并希望自行构建发布：

```bash
git pull
npm ci
npm run update -- --from-source
```

### 更换 `ADMIN_TOKEN`（管理员登录密钥）

如需更换登录密码，可单独更新 `ADMIN_TOKEN`（不会改动 `NOTIFIER_KEY`）：

```bash
npx cf workers secrets update ADMIN_TOKEN --worker <你的Worker名称> --type secret_text
```

修改后，旧的 30 天浏览器会话会立即失效。

---

## 维护者发版流程（GitHub Actions）

仓库内置两条工作流，用于集中构建、校验并分发预构建版本包，用户无需 Fork：

- **`.github/workflows/ci.yml`**：PR 与推送 `main` 时自动运行 `npm ci`、`typecheck`、`lint`、`test`、`RELEASE_BUILD=1 npm run build`、`npm run release:pack`，并对解压后的发布包执行 `cf deploy --dry-run --prebuilt` 冒烟验证。
- **`.github/workflows/release.yml`**：支持两种触发方式：
  1. **打 SemVer 标签自动发布**（推荐正式版）：先更新 `package.json` 的 `version`（例如 `1.0.0`）并提交，再推送标签：
     ```bash
     git tag v1.0.0
     git push origin v1.0.0
     ```
  2. **手动触发（`workflow_dispatch`）**：在 GitHub Actions 页面填写 SemVer 版本号与是否标记为 Pre-release。
  - 工作流会自动校验版本号、跑全量测试、以 `RELEASE_BUILD=1` 与 `APP_VERSION` 构建干净的预构建包（不含任何私有域名、数据库 ID 或 `PUSH_SERVICE` 绑定）、生成 `v2echo-notifier-cf-v<version>.tar.gz` 与 `SHA256SUMS.txt`、在隔离临时目录完成 `cf deploy --dry-run --prebuilt` 验证，最后自动创建并上传到 GitHub Release。

---

## 数据库迁移

所有迁移脚本位于 `migrations/`，按编号顺序自动记录在 D1 的 `d1_migrations` 表中：

- **全新空库**：直接执行 `npx cf d1 migrations apply <databaseId>` 即可一次性完成全部建表。
- **常规版本升级**（例如 `0019_account_avatar.sql`、`0020_check_interval_defaults.sql`、`0021_check_errors_ack.sql` 等）：先执行 `cf d1 migrations apply`，再发布新版 Worker；原有账号、配对、通知开关、历史记录与检查冷却均保留。
  - `0019_account_avatar.sql`：新增 `notifier.avatar_url` 字段用于缓存账号头像。
  - `0020_check_interval_defaults.sql`：将关注成员默认间隔调整为 10 分钟、关注帖子调整为 5 分钟（仅更新仍为旧默认值的行，保留自定义间隔）。
  - `0021_check_errors_ack.sql`：新增 `notifier.check_errors_acked_at` 字段用于记录「清除红点」确认水位线。
- **历史老库专项升级（`0005_remove_probes.sql`、`0018_multi_account.sql`）**：
  - 若你的旧实例仍停留在 `0005` 或 `0018` 之前，`npm run update` 会主动停止自动升级以保护数据。
  - 升级前请先在 Cloudflare 控制台暂停旧 Worker Cron、为 D1 创建 Time Travel 恢复点并确认已备份 `NOTIFIER_KEY`；按编号执行完迁移并核对 `d1_migrations` 表后，再部署新版代码恢复调度。
  - 应用 `0018_multi_account.sql` 后，原有单账号会保留为本地 `id=1`（含原身份、配对、关注规则与在途事件），但不能只回滚 Worker 代码而不恢复数据库。

---

## 从旧 Docker 助手迁移

旧版 Docker / Go 通知助手（`v2echo-notifier`）已停止维护，既有推送连接仍兼容以便平滑迁移：

1. 在你自己的 Cloudflare 账号部署本助手（先保留旧 Docker 实例运行）。
2. 打开新助手管理台，进入 **设置 → 账号与凭据**，添加同一 V2EX 账号的 Cookie 与 PAT 并完成验证（多个账号可添加到同一个 Cloudflare 实例，分别填写各自凭据）。
3. 进入 **设置 → 设备配对** 生成二维码：
   - **逐台迁移**：在每台设备的新版 V2Echo 中登录对应账号，扫描普通配对二维码（已有连接时使用 **添加接收设备**），确认你的 HTTPS 地址。普通扫码仅迁移当前设备，不影响旧组内其他设备。
   - **整组切换**：若希望一次切换整个共享组的所有设备，可在**全新的未绑定助手**中使用「接替已有通知助手」生成 `V2T-` 更换二维码，由原组内设备扫码授权切换，再扫描普通配对二维码取得关注管理授权。
4. 在 **概览** 开启通知服务，确认检查日志与测试推送在所有目标设备上均正常接收后，再自行停止旧 Docker 容器。

> **迁移数据边界**：Cookie / PAT 需在新助手重新填写；不会自动迁移旧 SQLite 中的历史通知、去重记录或未发队列。新助手首次启动会针对当前未读建立基线，请避免让新旧两个实例长时间同时推送，以免产生重复提醒。

---

## 本地开发与调试

```bash
npm ci
node scripts/init-local.mjs
npm run db:local
npm run dev
```

- `scripts/init-local.mjs` 会创建 `0600` 权限的 `.dev.vars`（不覆盖已有文件，不在终端打印密钥）。
- 本地开发使用专用占位 D1 UUID `00000000-0000-4000-8000-000000000001`，本地状态持久化在 `.cloudflare/state/`，不会写入云端。
- 访问 `http://127.0.0.1:5188`，用 `.dev.vars` 中的 `ADMIN_TOKEN` 登录。
- 本地 `cf dev` 不会自动触发 Cron；可在网页 **设置 → 网络与诊断** 点击 **执行到期检查** 触发一轮到期调度（仍受检查时段与间隔约束）。

---

## 如何判定免费额度是否足够

建议在**实际 Workers Free 账号**连续运行并采样至少 **72 小时**，覆盖不同时间段（不要把本机网络出口或 Paid 账号的表现等同于 Workers Free 环境的实际表现）：

1. 在 **推送记录** 与 **检查日志** 核对真实通知流程，区分人机验证、429 限流、凭据失效、解析异常和执行中断；合成测试推送不能替代真实通知验证。
2. 在 **设置 → 网络与诊断** 查看今日 Worker 调用、D1 读取 / 写入行数以及 V2EX API 尝试与剩余额度采样。页面刷新只读 D1，不额外请求 V2EX。
3. 在 Cloudflare 控制台的 **Worker Observability** 中核对实际 CPU time、执行结果与账号总用量（应用内计数是实测下限，不包含统计写入本身、鉴权失败或平台提前终止；请求墙钟耗时不能用于推算 CPU 时间）。
4. 若同时管理多个账号或关注较多帖子，可在 **设置 → 通知策略** 适当调大检查间隔或缩窄每日检查时段，以显著降低请求与 D1 读写消耗。

**2026-10-21 核对的 Cloudflare Free 参考限额**：
- Workers：100,000 请求 / 天，HTTP / Cron CPU 上限 10 ms / 次；
- D1：读取 5,000,000 行 / 天，写入 100,000 行 / 天，单库 500 MB，账号合计 5 GB。
- 每分钟全实例最多执行一轮调度（原个人通知每轮最多 5 次外部请求，关注分片另最多 3 次网页请求，实际受未读数、重试与主动刷新影响）。

官方最新限额请以 Cloudflare 文档为准：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [cf 配置文档](https://developers.cloudflare.com/cf/projects/cloudflare-config/)。
