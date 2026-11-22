# V2Echo 通知助手 · 网页设计规范（shadcn-admin）

网页端以 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) 为唯一视觉基线。界面可参照 [shadcn-admin 演示](https://shadcn-admin.netlify.app/)。

## 0. 技术基线

- React 19 + Vite + TypeScript。
- Tailwind CSS v4（`@tailwindcss/vite`，无 `tailwind.config.ts`）。
- shadcn/ui 组件（Radix 原语 + class-variance-authority + tailwind-merge），源码位于 `src/components/ui/`，与 shadcn-admin 上游保持一致。
- 图标：`lucide-react`；字体：`@fontsource-variable/inter`，`<html class="font-inter">`。
- 状态：Zustand（`src/lib/api.ts`）；登录使用 HttpOnly Cookie。
- 主题：`.dark` 类 + `vite-ui-theme` Cookie；`public/theme.js` 在首屏前恢复主题与主题色，避免闪烁。

## 1. 信息架构与导航

- `SidebarProvider` + `SidebarInset`，默认侧栏 `collapsible="icon"`、`variant="inset"`；侧栏样式与展开方式可通过页头“外观与布局”抽屉切换并写入 Cookie。
- 侧栏分组保持扁平、无重复二级菜单：
  - **动态**：概览（`#overview`）、个人消息（`#messages`）、关注帖子（`#watched-topics`）、关注成员（`#following-topics`）。
  - **记录**：推送记录（`#notifications`）、检查日志（`#checks`）。
  - **系统**：设置（`#settings-*`，进入后由页面内二级导航切换：通知策略 / 账号与凭据 / 设备配对 / 网络与诊断 / 外观）。
- 页头固定 56px（`h-14`）：`SidebarTrigger` + 竖分隔线 + 命令面板触发器（`Search`，`⌘K`，支持页面跳转、刷新、启停服务、主题与账号切换）；右侧按需展示异常/暂停提示胶囊，随后依次为主题、外观抽屉与头像菜单。
- 主区域 `px-4 py-6`，内容宽度超过 `@7xl` 时居中并限制 `max-w-7xl`；断点 `md`（768px）以下侧栏改为 Sheet 抽屉。

## 2. 颜色与令牌

令牌定义在 `src/styles/theme.css`，全部为 `oklch`；`src/index.css` 只包含 Tailwind 入口、`tw-animate-css`、shadcn 基样与轻量化动效（折叠与页面入场，遵循 `prefers-reduced-motion`）。

| 令牌 | 用途 |
|---|---|
| `--background` / `--foreground` | 页面与正文 |
| `--card` / `--card-foreground` | 卡片 |
| `--popover` / `--popover-foreground` | 菜单、浮层、Toast |
| `--primary` / `--primary-foreground` | 主按钮、选中态 |
| `--muted` / `--muted-foreground` | 次级面、说明文字 |
| `--accent` / `--accent-foreground` | 悬停与侧栏选中 |
| `--destructive` | 危险操作 |
| `--border` / `--input` / `--ring` | 描边、输入框、焦点环 |
| `--sidebar-*` | 侧栏语义色 |
| `--chart-1…5` | 图表 |

### 2.1 主题色

在 shadcn 默认中性主色之外，`src/styles/theme.css` 定义五组低饱和 accent：雾蓝、鼠尾草、豆沙、蜜杏、香芋。每组只覆盖 `--primary`、`--primary-foreground` 与 `--ring`，通过 `html[data-accent]` 生效并持久化到 `vite-ui-accent` Cookie；可在页头“外观与布局”抽屉或“设置 → 外观”中切换。

## 3. 字体与排版

- 字体：Inter Variable（同源打包），中文回退系统字体。
- 页面标题：`text-2xl font-bold tracking-tight`；设置页在 `md` 以上使用 `text-2xl md:text-3xl`。
- 页面说明：`text-muted-foreground`；卡片与设置分区标题 `font-semibold`。
- 正文 14px，辅助元信息 12px；数字与时间统一使用 `tabular-nums`。

## 4. 组件与交互模式

- **指标卡**：紧凑型 `Card`（`gap-2 py-4`），点击直接跳转目标页面，副标题提供真实上下文而非重复单位。
- **概览页**：页头（含状态胶囊与一键启停/刷新）→ 四列指标卡 → `lg:grid-cols-7` 的近 7 天运行趋势图（4）与可点击查看详情的最近通知（3）→ 三列监测通道状态条。不放置禁用占位 Tab。
- **数据列表页**（个人消息、关注帖子、关注成员、推送记录、检查日志）：页头 → 紧凑筛选工具栏（搜索 / 分类胶囊 / 来源筛选 / 一键重置）→ `table-fixed overflow-hidden rounded-lg border bg-card` 表格（加载态使用 `TableSkeleton`）→ 卡片外分页。行直接可点击打开详情弹窗；低频辅助信息收进详情弹窗或按需展开。
- **关注动态工作流**：`关注帖子` 通过页头弹窗添加；`关注成员` 提供成员头像筛选胶囊、分页动态表与单行一键“追评”。
- **设置页**：左侧 `lg:w-48` 粘性导航，右侧分区统一限制 `lg:max-w-2xl`；表单优先轻量网格排布，仅在独立业务单元（服务开关、账号列表、授权设备、代理出口、配额卡片）使用边框容器；代理表单与配对二维码按需展开。
- **瞬态反馈**：操作结果经右下角浮动 `Toaster`（`src/components/toaster.tsx`）展示，成功提示自动收起，不引发页面布局跳动；持久异常仍以页内 `Alert` 呈现。

## 5. 可访问性与约束

- 所有图标按钮提供 `aria-label`，可点击表格行支持键盘 Enter/Space。
- 业务代码中不写十六进制颜色（品牌 SVG、外观预览缩略图与图表坐标轴 `#888888` 除外）。
- 尊重 `prefers-reduced-motion`，动效保持克制快速（150–300ms）。
