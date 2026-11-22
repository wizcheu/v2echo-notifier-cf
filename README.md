# V2Echo Cloudflare 通知助手

[V2Echo](https://app.v2echo.com) 的自托管多账号通知助手，运行在你自己的 **Cloudflare Workers + D1** 上，为 iPhone / iPad / Mac 提供个人消息提醒与关注提醒。

- **无需服务器与 Fork**：下载官方预构建包部署到自己的 Cloudflare 账号，一条命令原地更新。
- **多账号隔离**：单实例最多管理 20 个 V2EX 账号，凭据、扫描进度与设备授权相互隔离。
- **端到端加密**：Cookie、PAT 与本地缓存使用你的独立 `NOTIFIER_KEY` 加密存于 D1；推送正文按设备公钥加密（X25519 + AES-256-GCM），中转服务与 APNs 无法读取明文。
- **不标记已读**：仅检查首页未读数与 API v2，不访问网页 `/notifications`。
- **关注提醒（iOS / iPadOS）**：支持最多 20 篇帖子新评论提醒与关注成员新帖提醒，App 扫码后同步管理。

> 个人远程提醒与关注提醒需 V2Echo Pro，且需自行部署维护本助手。旧 Docker 助手已停止维护，迁移见 [从旧 Docker 助手迁移](docs/deployment.md#从旧-docker-助手迁移)。

## 环境要求

- Cloudflare 账号（免费版即可开始）
- Node.js `22.23+`（或 `24.22+` / `26.12+`）

## 快速部署

前往 [Releases](https://github.com/wizcheu/v2echo-notifier-cf/releases) 下载最新 `v2echo-notifier-cf-vX.Y.Z.tar.gz`，在本地新建持久目录解压并执行：

```bash
mkdir -p ~/v2echo-notifier && cd ~/v2echo-notifier
tar -xzf /你的下载路径/v2echo-notifier-cf-vX.Y.Z.tar.gz
npm install
npm run setup
```

`npm run setup` 会自动引导完成：浏览器登录 Cloudflare → 创建或选择 D1 → 自动生成密钥（保存在 `private/secrets.env`）→ 建表并发布。

> **务必备份 `private/secrets.env` 中的 `ADMIN_TOKEN` 与 `NOTIFIER_KEY`**。丢失 `NOTIFIER_KEY` 将无法解密 D1 中已保存的凭据与历史数据。

## 首次配置

打开终端输出的助手 HTTPS 地址：

1. **登录**：输入 `private/secrets.env` 中的 `ADMIN_TOKEN`。
2. **添加账号**：进入 **设置 → 账号与凭据 → 添加账号**，粘贴同一 V2EX 账号的完整 Cookie（含 `A2=`）和 [PAT](https://www.v2ex.com/settings/tokens)。
3. **配对 App**：进入 **设置 → 设备配对** 生成二维码，在 V2Echo 的个人远程提醒中扫码（macOS 复制粘贴）并确认地址。
4. **开启通知**：在 **概览** 打开 **通知服务**，可在 **设置 → 通知策略** 发送测试通知确认送达。

## 更新

可在管理台 **设置 → 网络与诊断 → 版本与更新** 手动检查新版，然后在本机部署目录执行：

```bash
npm run update              # 更新到最新正式版
npm run update -- v1.0.0    # 更新到指定版本
```

更新会自动校验 `SHA256SUMS.txt`、执行增量 D1 迁移并发布，保留云端密钥、数据与通知开关。

## 常见问题

- **Cookie 和通知内容会经过 V2Echo 服务器吗？** Cookie / PAT 仅存在你自己的 D1 并直连 V2EX；推送标题与正文在你的 Worker 内按设备公钥加密后才经中转投递。
- **Cloudflare 免费额度够用吗？** 多数个人场景可用，默认北京时间 08:00–24:00 运行，可在 **设置 → 通知策略** 调大检查间隔。判定方法见 [免费额度评估](docs/deployment.md#如何判定免费额度是否足够)。
- **检查日志出现红色「N 异常」怎么办？** 代表近 24 小时有检查失败或中断（非未读消息），可在 **检查日志** 筛选排查后点击 **清除红点**；若出口持续 403，可在 **设置 → 网络与诊断** 配置代理。
- **忘记 `ADMIN_TOKEN` 怎么办？** 可单独更换，不影响已有数据：
  ```bash
  npx cf workers secrets update ADMIN_TOKEN --worker <Worker名称> --type secret_text
  ```

## 更多文档

- [部署与运维指南](docs/deployment.md)：手动分步部署、自定义域名、数据库迁移、从 Docker 迁移与免费额度评估。
- [架构与开发参考](docs/architecture.md)：多账号隔离、推送与关注契约、接口说明、代理与本地开发测试。
