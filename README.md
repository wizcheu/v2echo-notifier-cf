# V2Echo Cloudflare 通知助手（`v2echo-notifier-cf`）

> [V2Echo](https://app.v2echo.com) 的自托管多账号通知助手，运行在你自己的 **Cloudflare Workers + D1** 上，为 iPhone / iPad / Mac 提供实时个人消息提醒与关注提醒。

- **无需服务器 / NAS，无需 Fork 仓库**：直接下载官方预构建 Release 包部署到你自己的 Cloudflare 账号即可全天候运行（可先在 Free 套餐实际评估额度）。
- **一条命令原地更新**：在管理台「设置 → 网络与诊断」一键检查新版本，本地运行 `npm run update` 即可自动拉取官方预构建包、校验 SHA-256、执行增量数据库迁移并部署，无需本地编译。
- **多账号隔离**：单个实例最多管理 20 个 V2EX 账号，账号凭据、扫描进度、去重记录与设备授权完全隔离。
- **隐私与端到端加密**：Cookie、PAT 与本地缓存均使用你的独立 `NOTIFIER_KEY` 加密存放在你自己的 D1；推送标题与正文在助手内按设备公钥端到端加密（X25519 + HKDF-SHA256 + AES-256-GCM），中转服务与 APNs 无法读取明文。
- **不标记已读**：通过首页未读数 + V2EX API v2 检查新通知，不访问会触发全部已读的网页 `/notifications`。
- **关注提醒（iOS / iPadOS）**：支持关注最多 20 篇帖子的新评论提醒与关注成员发新帖提醒，App 扫码后与网页端同步管理。
- **开箱即用的 Web 管理台**：支持概览趋势图、个人消息历史缓存、关注帖子/成员管理、推送记录与检查日志（含异常筛选与一键清除红点）、版本检查、可选 HTTP/SOCKS5 代理。

> **说明**：个人远程提醒与关注提醒属于 V2Echo Pro 功能，且需要自行部署与维护本助手；应用内本地未读检查与热帖推荐无需部署本助手。旧 Docker 版助手已停止维护，迁移步骤见 [从旧 Docker 助手迁移](docs/deployment.md#从旧-docker-助手迁移)。

---

## 部署前准备

1. **一个 Cloudflare 账号**（免费版即可开始，需在控制台完成邮箱验证；首次使用 Workers 需开通默认的 `*.workers.dev` 子域，或绑定你托管在 Cloudflare 的自有域名）。
2. **Node.js `22.23+`**（支持 `^22.23.0 || ^24.22.0 || ^26.12.0`）。
3. **V2EX 账号的 Cookie 与 PAT**（部署完成后直接在网页管理台里填写，**不需要**提前写入本地配置文件）。

---

## 5 分钟快速部署（无需 Fork、无需 Git、无需本地编译）

1. 前往本仓库 [Releases 页面](https://github.com/wizcheu/v2echo-notifier-cf/releases)，下载最新正式版压缩包 `v2echo-notifier-cf-vX.Y.Z.tar.gz`（可选核对同页的 `SHA256SUMS.txt`）。
2. 在本机创建一个长期保留的部署目录并解压（以 `v1.0.0` 为例）：

```bash
mkdir -p ~/v2echo-notifier && cd ~/v2echo-notifier
tar -xzf /你的下载路径/v2echo-notifier-cf-v1.0.0.tar.gz
npm install
npm run setup
```

`npm install` 只会安装一个运行时依赖（`cf` CLI），不安装开发工具链、不编译前端和 Worker。随后 `npm run setup` 会自动引导你完成全部步骤：

1. **登录 Cloudflare**：自动打开浏览器完成 OAuth 授权，并识别你的 Cloudflare Account ID。
2. **创建数据库**：自动为你创建独立的 D1 数据库（或选择已有 D1），写入本地配置 `deployment.local.json`。
3. **自动生成密钥**：自动生成随机的管理员登录密钥 `ADMIN_TOKEN` 与数据加密主密钥 `NOTIFIER_KEY`，以 `0600` 权限保存到 `private/secrets.env`（不打印在终端）。
4. **建表并发布**：自动执行 D1 数据库迁移，并将预构建产物直接上传到你的 Cloudflare Worker。

> **请务必备份密钥**：部署完成后，请立即将 `private/secrets.env` 中的 `ADMIN_TOKEN` 和 `NOTIFIER_KEY` 保存到你的密码管理器。
> - `ADMIN_TOKEN` 用于登录 Web 管理台，可随时轮换；
> - `NOTIFIER_KEY` 用于加密 D1 中的凭据与缓存，**丢失后将无法解密已保存的数据**，后续更新请勿更换。

如果你想从源码部署、手工分步执行每一条命令、通过 API Token / CI 部署或绑定自定义域名，请查看 [完整部署、升级与运维指南](docs/deployment.md)。

---

## 首次配置（网页端 4 步启用推送）

部署完成后，终端会输出你的助手 HTTPS 地址（例如 `https://v2echo-notifier-cf.<你的子域>.workers.dev` 或你绑定的自定义域名）：

1. **登录管理台**：打开助手 HTTPS 地址，输入 `private/secrets.env` 中的 `ADMIN_TOKEN` 登录（登录会话有效期 30 天）。
2. **添加 V2EX 账号**：进入 **设置 → 账号与凭据**，点击 **添加账号**，粘贴同一个 V2EX 账号的：
   - **Cookie**：在浏览器登录 `https://www.v2ex.com` 后，打开开发者工具（F12）→ Network → 点击首页请求 → 复制 Request Headers 中的完整 `cookie` 值（需包含 `A2=`）。
   - **Personal Access Token (PAT)**：在 [V2EX Tokens 页面](https://www.v2ex.com/settings/tokens) 创建一个读取权限的个人访问令牌。
   - 提交后助手会自动验证两者是否属于同一 V2EX 账号，并加密保存。
3. **配对 V2Echo App**：进入 **设置 → 设备配对**，生成 10 分钟有效的配对二维码：
   - **iPhone / iPad**：在 V2Echo 的 **通知设置 → 个人远程提醒** 中扫码，核对助手 HTTPS 地址后确认连接；
   - **macOS**：在助手页面复制配对内容，在 V2Echo 的 **远程推送** 中粘贴并确认连接；
   - 需要推送到多台设备时，继续在 **设备配对** 使用 **添加接收设备** 扫码即可（同账号最多 10 台设备）。
4. **开启通知服务并测试**：在 **概览** 或 **设置 → 通知策略** 中打开 **通知服务**，并点击 **发送测试通知** 验证手机是否收到推送。

> 如需添加多个 V2EX 账号，在 **设置 → 账号与凭据** 继续添加，通过侧栏左上角切换账号，并在 V2Echo App 中切换到对应账号分别扫码配对即可。

---

## 日常检查与更新（一条命令）

在管理台 **设置 → 网络与诊断 → 版本与更新** 中可随时查看当前运行版本并手动点击 **检查更新**。发现新版本后，进入你本地的部署目录（包含 `deployment.local.json`）运行一条命令即可：

```bash
# 更新到最新官方正式版（自动下载预构建包 + 校验 SHA-256 + 增量 D1 迁移 + 部署）
npm run update

# 或更新/锁定到指定的官方版本
npm run update -- v1.1.0
```

全程约 10 秒完成，无需 Fork、无需 `git pull`、无需本地编译，且**不会覆盖**云端已有的 `NOTIFIER_KEY`、`ADMIN_TOKEN`、D1 数据或通知开关状态。

---

## 常见问题

<details>
<summary><strong>1. 我的 Cookie、PAT 和通知正文会传给 V2Echo 服务器吗？</strong></summary>

- **不会**。Cookie 和 PAT 只保存在你自己 Cloudflare 账号下的 D1 数据库中（使用 `NOTIFIER_KEY` 加密），仅用于你的 Worker 直接请求 `https://www.v2ex.com`。
- 推送标题与正文在你的 Worker 内按每台接收设备的公钥做端到端加密后，才经固定中转入口 `https://app.v2echo.com/api/push` 发往 APNs；中转服务与 APNs 看不到明文标题、正文，也不持有你的 Cookie 或 PAT。

</details>

<details>
<summary><strong>2. Cloudflare 免费套餐额度够用吗？</strong></summary>

多数个人单账号 / 轻度多账号场景可在 Cloudflare Workers Free 套餐内运行，默认检查时段为每天 **08:00–24:00（北京时间）**，默认间隔为个人消息 3 分钟、关注成员 10 分钟、关注帖子 5 分钟（均可在 **设置 → 通知策略** 中调大以进一步节省调用）。实际消耗取决于账号数量、关注帖子数与上游重试情况，建议连续运行 72 小时并在 **设置 → 网络与诊断** 与 Cloudflare Observability 中核对真实用量。详见 [如何判定免费额度是否足够](docs/deployment.md#如何判定免费额度是否足够)。

</details>

<details>
<summary><strong>3. V2EX 偶尔返回 403 / 人机验证，或者检查日志出现红色「N 异常」怎么办？</strong></summary>

- 侧栏「检查日志」上的红色 `N 异常` 代表近 24 小时内有检查失败或执行中断（**不是未读消息**），进入 **检查日志** 后可点击顶部的 **只看异常记录** 排查原因，确认已处理后点 **清除红点** 即可消退提醒（历史日志仍保留，后续新异常会再次提醒）。
- 助手内置了自动退避机制，偶发 403 / 429 不会误判凭据失效。如果你的 Cloudflare 出口持续被 V2EX 拦截，可在 **设置 → 网络与诊断** 中配置并测试自己的 HTTP CONNECT 或 SOCKS5 代理。

</details>

<details>
<summary><strong>4. 忘记 <code>ADMIN_TOKEN</code> 或需要更换管理员密码怎么办？</strong></summary>

管理员密钥可以随时独立更换，不影响已保存的账号、配对与历史数据：

```bash
# 更新管理员登录密钥（不会改动 NOTIFIER_KEY）
npx cf workers secrets update ADMIN_TOKEN --worker <你的Worker名称> --type secret_text
```

更换后旧的浏览器登录会话会立即失效，使用新密钥重新登录即可。**切勿随意修改 `NOTIFIER_KEY`**。

</details>

<details>
<summary><strong>5. 本地如何从源码启动开发环境？</strong></summary>

```bash
git clone https://github.com/wizcheu/v2echo-notifier-cf.git
cd v2echo-notifier-cf
npm ci
node scripts/init-local.mjs
npm run db:local
npm run dev
```

打开 `http://127.0.0.1:5188`，使用自动生成的 `.dev.vars` 中的 `ADMIN_TOKEN` 登录。本地开发不会自动触发 Cron，可在 **设置 → 网络与诊断** 点击 **执行到期检查** 手动触发。

</details>

---

## 更多文档

- [部署、升级与运维指南](docs/deployment.md)：预构建包部署与更新、从源码手动部署、API Token / CI 部署、自定义域名、密钥备份、数据库迁移、从旧 Docker 助手迁移、维护者发版流水线与免费额度评估。
- [架构、协议与开发参考](docs/architecture.md)：多账号隔离、真实通知与关注提醒契约、App 直连配对与撤销、网页接口与版本检查、代理安全边界、调度策略与自动化测试。
