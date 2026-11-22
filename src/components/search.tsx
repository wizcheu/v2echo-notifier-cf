import { useEffect, useState } from 'react'
import {
  Activity,
  Bell,
  BellOff,
  BellRing,
  Bookmark,
  LayoutDashboard,
  Mail,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  SearchIcon,
  Settings2,
  Smartphone,
  Sun,
  UserCog,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/api'
import { useTheme } from '@/context/theme-provider'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'

const navLinks = [
  { title: '概览', href: 'overview', keywords: 'dashboard 首页 总览', icon: LayoutDashboard },
  { title: '个人消息', href: 'messages', keywords: 'inbox replies 未读 回复 提及', icon: Mail },
  { title: '关注帖子', href: 'watched-topics', keywords: 'topics 主题 评论 追评', icon: Bookmark },
  { title: '关注成员', href: 'following-topics', keywords: 'members following 动态 发帖', icon: Users },
  { title: '推送记录', href: 'notifications', keywords: 'apns deliveries 投递 通知', icon: BellRing },
  { title: '检查日志', href: 'checks', keywords: 'logs checks 扫描 诊断', icon: Activity },
  { title: '设置 · 通知策略', href: 'settings-notifications', keywords: 'schedule 开关 时段 频率 测试', icon: Bell },
  { title: '设置 · 账号与凭据', href: 'settings-accounts', keywords: 'cookie pat account 验证', icon: UserCog },
  { title: '设置 · 设备配对', href: 'settings-devices', keywords: 'qr pair 设备 二维码 授权', icon: Smartphone },
  { title: '设置 · 网络与诊断', href: 'settings-advanced', keywords: 'proxy quota 代理 额度', icon: Settings2 },
  { title: '设置 · 外观', href: 'settings-appearance', keywords: 'theme color 主题 配色', icon: Palette },
]

export function Search({
  className = '',
  placeholder = '搜索页面或操作…',
  ...props
}: React.ComponentProps<'button'> & { placeholder?: string }) {
  const [open, setOpen] = useState(false)
  const accounts = useStore((s) => s.accounts)
  const selectedAccountId = useStore((s) => s.selectedAccountId)
  const selectAccount = useStore((s) => s.selectAccount)
  const data = useStore((s) => s.data)
  const refresh = useStore((s) => s.refresh)
  const action = useStore((s) => s.action)
  const busy = useStore((s) => s.busy)
  const { setTheme } = useTheme()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const notifier = data?.notifier
  const canToggleService =
    notifier &&
    (Boolean(notifier.enabled) ||
      (notifier.storage_ready &&
        Boolean(notifier.binding_id) &&
        !notifier.blocked))

  const go = (href: string) => {
    window.location.assign(`#${href}`)
    setOpen(false)
  }

  return (
    <>
      <Button
        {...props}
        variant="outline"
        className={cn(
          'group relative h-8 min-w-0 flex-1 justify-start overflow-hidden rounded-md bg-muted/25 px-2.5 text-sm font-normal text-muted-foreground shadow-none hover:bg-accent sm:w-52 sm:flex-none sm:pe-12 lg:w-64',
          className
        )}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
      >
        <SearchIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 opacity-60"
        />
        <span className="truncate">{placeholder}</span>
        <kbd className="pointer-events-none absolute inset-e-[0.3rem] top-[0.3rem] hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 select-none group-hover:bg-accent sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="命令面板"
        description="快速跳转页面或执行常用操作"
      >
        <CommandInput placeholder="输入页面名称或操作…" />
        <CommandList>
          <CommandEmpty>没有找到匹配的结果。</CommandEmpty>
          <CommandGroup heading="页面">
            {navLinks.map((link) => (
              <CommandItem
                key={link.href}
                value={`${link.title} ${link.keywords} ${link.href}`}
                onSelect={() => go(link.href)}
              >
                <link.icon />
                <span>{link.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="快捷操作">
            <CommandItem
              value="刷新数据 refresh"
              disabled={busy}
              onSelect={() => {
                setOpen(false)
                void refresh()
              }}
            >
              <RefreshCw />
              <span>刷新当前数据</span>
            </CommandItem>
            {canToggleService && (
              <CommandItem
                value={
                  notifier.enabled
                    ? '暂停通知服务 pause stop'
                    : '开启通知服务 start resume'
                }
                disabled={busy}
                onSelect={() => {
                  setOpen(false)
                  void action('/notifier/config', 'PUT', {
                    enabled: !notifier.enabled,
                  })
                }}
              >
                {notifier.enabled ? <BellOff /> : <Bell />}
                <span>{notifier.enabled ? '暂停通知服务' : '开启通知服务'}</span>
              </CommandItem>
            )}
            <CommandItem
              value="浅色主题 light theme"
              onSelect={() => {
                setTheme('light')
                setOpen(false)
              }}
            >
              <Sun />
              <span>切换到浅色主题</span>
            </CommandItem>
            <CommandItem
              value="深色主题 dark theme"
              onSelect={() => {
                setTheme('dark')
                setOpen(false)
              }}
            >
              <Moon />
              <span>切换到深色主题</span>
            </CommandItem>
            <CommandItem
              value="跟随系统主题 system theme"
              onSelect={() => {
                setTheme('system')
                setOpen(false)
              }}
            >
              <Monitor />
              <span>主题跟随系统</span>
            </CommandItem>
          </CommandGroup>
          {accounts.length > 1 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="切换账号">
                {accounts
                  .filter((account) => account.id !== selectedAccountId)
                  .map((account) => (
                    <CommandItem
                      key={account.id}
                      value={`切换账号 ${account.username || account.id}`}
                      onSelect={() => {
                        setOpen(false)
                        void selectAccount(account.id)
                      }}
                    >
                      <UserCog />
                      <span>
                        切换到{' '}
                        {account.username ? `@${account.username}` : '待配置账号'}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>
    </>
  )
}
