# 架构与开发参考

## 会话与版本

- 管理员用 `ADMIN_TOKEN` 换取 30 天 `HttpOnly` 会话；写操作要求同源 `Origin` 与 `X-Notifier-Request: 1`（接口调用可用 `Authorization: Bearer <ADMIN_TOKEN>`）。
- 构建期将 `APP_VERSION`（默认取 `package.json`，发版时按 Tag 注入）写入前后端。已鉴权的 `GET /api/accounts/:id/state` 返回 `version`；匿名 `GET /api/app/v1/health` 仅返回 `{"status":"ok"}`。
- `GET /api/version/check`（需管理员鉴权）仅在用户手动点击「检查更新」时直连 GitHub Releases API，保持浏览器 `connect-src 'self'` CSP 不变。

## 多账号与隔离

单实例最多管理 **20 个**已验证账号。管理登录、代理与 `NOTIFIER_KEY` 为实例共用；Cookie / PAT、扫描进度、历史缓存、去重、关注规则、发送凭据与设备授权按账号（数字会员号 + 不可变本地 `id`）严格隔离。

| 接口 | 说明 |
| --- | --- |
| `GET /api/accounts` | 返回账号摘要与凭据状态，不返回凭据内容 |
| `POST /api/accounts` | 提交 `{cookie, pat}`，核验身份一致且不重复后原子入库 |
| `GET /api/accounts/:id/state` | 账号状态、近 24 小时未确认异常数、API 用量与实例配额 |
| `/api/accounts/:id/notifier/*` | 凭据更新、配对、手动检查、历史拉取、关注管理、记录查询与 `checks/ack` 清除红点 |
| `DELETE /api/accounts/:id` | 暂停账号、撤销全部持久化 sender 后原子删除本地业务数据 |

旧路径 `/api/state` 与 `/api/notifier/*` 仅兼容迁移账号 `id=1`。同一设备可分别为多个账号扫码配对（每来源 `pairing_policy: explicit`）。

## 通知与加密闭环

- **扫描与去重**：按首页未读数确定 API v2 候选范围，逐页持久化进度，不访问网页 `/notifications`。按 `SHA256(v2ex:<会员号>:<通知ID>)` 精确去重（上限 100,000 条），每条通知独立推送；未识别分类暂存「待分类」不阻塞队列。
- **端到端加密与投递**：向固定 `https://app.v2echo.com/api/push` 上报；每设备用 X25519 / HKDF-SHA256 / AES-256-GCM 加密标题与正文并固定首次密文，S2S 幂等重试并按事件 ID 查回执（`apns_accepted` 仅表示 APNs 接收）。单账号最多 10 台接收设备。
- **凭据存储**：Cookie（≤ 16 KiB）与 PAT（≤ 4 KiB）验证一致后用 `NOTIFIER_KEY` 加密存 D1，优先于历史 `id=1` 的 Worker Secrets。
- **检查日志与清除红点**：`notifier.check_errors` 统计近 24 小时内 `started_at > check_errors_acked_at` 的业务检查失败/中断；`POST /api/accounts/:id/notifier/checks/ack` 推进确认水位线，不删历史日志、不占全局锁、不吞在途检查。

## 关注提醒（iPhone / iPad）

- **规则存储**：规则、修订号与操作回执权威存于用户 D1（加密缓存）；单账号绑定组最多关注 **20 篇**帖子（含暂停项），外加「关注成员新帖」总开关。
- **采集边界**：帖子评论按稳定回复 ID 与楼层聚合非本人新评论；关注成员从 `/?tab=members` 结合 `/my/following?p=1` 核验新帖（不补已滑出窗口的旧帖）。每次关注分片最多 1 目标、3 次网页请求、25 秒超时。
- **App 直连接口**：
  - `POST /api/app/v1/pair`（限流 20 次/分/IP）：统一二维码直连，一次完成个人接收绑定与独立 Bearer 关注管理授权（最多 20 台管理设备，可在网页 **设置 → 设备配对** 单台撤销）。
  - `GET` / `PUT /api/app/v1/watches`：使用独立管理凭据读写规则，不授予网页管理员或发送权限。
  - **换助手实例**：在新未绑定助手生成 `V2T-` 二维码，由已绑定设备扫码原子切换来源并撤销旧 sender。

## 网络代理

在 **设置 → 网络与诊断** 支持配置 `http://主机:端口`（CONNECT）或 `socks5://主机:端口`（可选认证），加密存于 D1，默认关闭。启用后所有上游 V2EX 与推送请求经代理隧道出站，由固定版本 `tunnelfetch` 端到端校验证书，异常不回退直连。`POST /api/proxy-settings/test` 在不保存、不带凭据前提下测试 V2EX 连通性。

## 调度与安全边界

- **时段与间隔**：默认北京时间 `08:00–24:00`；默认间隔个人消息 3 分钟、关注成员 10 分钟、关注帖子 5 分钟（帖子连续 6 / 12 次无更新自动降频至 30 / 60 分钟）。时段外仅继续重试已入队推送、回执与数据维护。
- **并发与限流**：全实例每分钟最多一轮，D1 条件更新租约（90 秒）+ 公平账号游标。Cookie 仅发往固定 `https://www.v2ex.com` 只读路径、不跟重定向，PAT 不带 Cookie；上游超时 12 秒、单响应上限 1 MiB；403 / 429 与人机验证独立通道退避。
- **数据留存**：推送详情（约 10,000 条）、历史消息（约 1,000 条）、检查日志（约 5,000 条）、API 明细（约 5,000 条）保留 7 天，日统计保留 35 天，小时维护分批清理；精确去重独立保留。

## 验证与源码入口

```bash
npm test            # Vitest + Miniflare 真实 D1 与 HTMLRewriter 测试
npm run typecheck   # 前端与 Worker 类型检查
npm run lint        # oxlint 静态检查
npm run build       # 构建前端与 Worker
npm run release:pack # 生成预构建发布包与 SHA256SUMS.txt
```

- `worker/`：Worker 入口、D1 封装、鉴权、版本检查、代理与统计；`worker/notifier/` 为核心业务模块。
- `migrations/`：D1 SQL 迁移；`shared/`：前后端共享契约与版本工具。
- `src/`：React 19 + shadcn/ui 管理台；`scripts/`：本地初始化、独立部署与打包脚本；`.github/workflows/`：CI 与 Release 流水线。
