import { useMemo } from 'react'
import {
  Activity,
  BellRing,
  Bookmark,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  Mail,
  Plus,
  Settings,
  Users,
} from 'lucide-react'
import { useStore } from '@/lib/api'
import { BrandMark } from '@/components/brand-mark'
import { UserAvatar } from '@/components/user-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useLayout } from '@/context/layout-provider'
import { NavGroup } from './nav-group'
import { NavUser, type AccountUser } from './nav-user'
import type { NavGroupData } from './types'

function accountSummary(
  blocked: string | null,
  accountId: number | null,
  bindingId: string | null,
  enabled: boolean
): { label: string; tone: AccountUser['statusTone'] } {
  if (blocked === 'deleting') return { label: '删除中', tone: 'danger' }
  if (blocked === 'credentials') return { label: '凭据需更新', tone: 'danger' }
  if (blocked === 'pairing') return { label: '需重新配对', tone: 'danger' }
  if (blocked) return { label: '账号异常', tone: 'danger' }
  if (!accountId) return { label: '待配置凭据', tone: 'neutral' }
  if (!bindingId) return { label: '待配对 App', tone: 'warning' }
  return enabled
    ? { label: '运行中', tone: 'success' }
    : { label: '已暂停', tone: 'neutral' }
}

function AccountSwitcher() {
  const { isMobile, setOpenMobile } = useSidebar()
  const accounts = useStore((state) => state.accounts)
  const selectedAccountId = useStore((state) => state.selectedAccountId)
  const selectAccount = useStore((state) => state.selectAccount)
  const accountsPending = useStore((state) => state.accountsPending)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-sm ring-1 ring-black/5">
                <BrandMark className="size-8" />
              </div>
              <div className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-semibold">V2Echo</span>
                <span className="truncate text-xs text-muted-foreground">
                  通知助手
                </span>
              </div>
              <ChevronsUpDown className="ms-auto size-4 opacity-60" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              切换账号
            </DropdownMenuLabel>
            {accounts.map((account) => {
              const name = account.username ? `@${account.username}` : '待配置账号'
              const status = accountSummary(
                account.blocked,
                account.account_id,
                account.binding_id,
                Boolean(account.enabled)
              )
              return (
                <DropdownMenuItem
                  key={account.id}
                  className="gap-2 p-2"
                  disabled={accountsPending}
                  onClick={() => {
                    void selectAccount(account.id)
                    setOpenMobile(false)
                  }}
                >
                  <UserAvatar
                    src={account.avatar_url || undefined}
                    name={account.username || '待配置账号'}
                    className="size-6"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm leading-tight">{name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {status.label}
                    </p>
                  </div>
                  {account.id === selectedAccountId && (
                    <Check className="size-4 shrink-0" />
                  )}
                </DropdownMenuItem>
              )
            })}
            {!accounts.length && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                还没有连接账号。
              </p>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2" asChild>
              <a
                href="#settings-accounts"
                onClick={() => setOpenMobile(false)}
              >
                <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                  <Plus className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">添加账号</div>
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function AppSidebar({ hash }: { hash: string }) {
  const { collapsible, variant } = useLayout()
  const data = useStore((state) => state.data)
  const accounts = useStore((state) => state.accounts)
  const selectedAccountId = useStore((state) => state.selectedAccountId)
  const current = accounts.find((account) => account.id === selectedAccountId)

  const unread = data?.notifier.observed_at ? data.notifier.unread : 0
  const queued = useMemo(
    () =>
      data?.notifier.counts
        .filter((count) => ['pending', 'submitted'].includes(count.status))
        .reduce((sum, count) => sum + count.count, 0) ?? 0,
    [data]
  )
  const checkErrors = useMemo(
    () =>
      data?.notifier.check_errors.reduce((sum, item) => sum + item.count, 0) ??
      0,
    [data]
  )

  const navGroups: NavGroupData[] = [
    {
      title: '动态',
      items: [
        {
          title: '概览',
          href: 'overview',
          icon: LayoutDashboard,
          match: (h) => h === '' || h === 'overview',
        },
        {
          title: '个人消息',
          href: 'messages',
          icon: Mail,
          badge: unread > 0 ? unread : undefined,
          match: (h) => ['messages', 'unread', 'history'].includes(h),
        },
        {
          title: '关注帖子',
          href: 'watched-topics',
          icon: Bookmark,
          match: (h) => ['watched-topics', 'watches'].includes(h),
        },
        {
          title: '关注成员',
          href: 'following-topics',
          icon: Users,
          match: (h) => h === 'following-topics',
        },
      ],
    },
    {
      title: '记录',
      items: [
        {
          title: '推送记录',
          href: 'notifications',
          icon: BellRing,
          badge: queued > 0 ? queued : undefined,
          match: (h) => ['notifications', 'deliveries'].includes(h),
        },
        {
          title: '检查日志',
          href: 'checks',
          icon: Activity,
          badge: checkErrors > 0 ? `${checkErrors} 异常` : undefined,
          badgeTitle:
            checkErrors > 0
              ? `近 24 小时内有 ${checkErrors} 次检查失败或中断`
              : undefined,
          badgeVariant: 'destructive',
          match: (h) => h === 'checks' || h.startsWith('checks-'),
        },
      ],
    },
    {
      title: '系统',
      items: [
        {
          title: '设置',
          href: 'settings-notifications',
          icon: Settings,
          match: (h) =>
            h === 'settings' || h === 'quota' || h.startsWith('settings-'),
        },
      ],
    },
  ]

  const status = current
    ? accountSummary(
        current.blocked,
        current.account_id,
        current.binding_id,
        Boolean(current.enabled)
      )
    : { label: '尚未连接账号', tone: 'neutral' as const }

  const user: AccountUser = {
    name: current?.username ? `@${current.username}` : '待配置账号',
    detail: status.label,
    avatar: current?.avatar_url || undefined,
    statusTone: status.tone,
  }

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AccountSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <NavGroup key={group.title} {...group} hash={hash} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
