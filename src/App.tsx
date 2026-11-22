import { lazy, Suspense, useEffect, useState } from 'react'
import { AlertCircle, LogIn, PauseCircle, RefreshCw } from 'lucide-react'
import { ThemeProvider } from '@/context/theme-provider'
import { AccentProvider } from '@/context/accent-provider'
import { DirectionProvider } from '@/context/direction-provider'
import { LayoutProvider } from '@/context/layout-provider'
import { getCookie } from '@/lib/cookies'
import { useStore } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { BrandMark } from '@/components/brand-mark'
import { AccountManagement } from '@/components/accounts'
import { HttpProxySettings } from '@/components/http-proxy-settings'
import { PageHeader } from '@/components/page-header'
import { Toaster } from '@/components/toaster'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

const Records = lazy(() => import('@/components/notifier-records'))
const WatchedTopics = lazy(() => import('@/components/watched-topics'))
const FollowingMembers = lazy(() => import('@/components/following-members'))
const Notifier = lazy(() => import('@/components/notifier'))
const Messages = lazy(() => import('@/components/messages'))
const Settings = lazy(() =>
  import('@/components/settings').then((m) => ({ default: m.Settings }))
)

const pages = [
  'overview',
  'messages',
  'watched-topics',
  'following-topics',
  'checks',
  'notifications',
  'settings',
] as const
type Page = (typeof pages)[number]

function currentPage(): Page {
  const hash = window.location.hash.slice(1)
  if (hash === 'following-topics') return 'following-topics'
  if (['watched-topics', 'watches'].includes(hash)) return 'watched-topics'
  if (['unread', 'history', 'messages'].includes(hash)) return 'messages'
  if (['deliveries', 'notifications'].includes(hash)) return 'notifications'
  if (hash.startsWith('checks-') || hash === 'checks') return 'checks'
  if (hash === 'quota' || hash.startsWith('settings-') || hash === 'settings')
    return 'settings'
  return pages.find((page) => page === hash) ?? 'overview'
}

function currentHash() {
  return window.location.hash.slice(1) || 'overview'
}

function BrandLockup({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2', className)}>
      <BrandMark className="size-7" />
      <span className="text-2xl font-semibold tracking-tight">V2Echo</span>
    </div>
  )
}

function Login() {
  const [input, setInput] = useState('')
  const login = useStore((s) => s.login)
  const busy = useStore((s) => s.busy)
  const error = useStore((s) => s.error)
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <BrandLockup className="mb-1" />
      <Card className="animate-page-in w-full max-w-sm gap-4">
        <CardHeader>
          <CardTitle className="text-lg tracking-tight">登录通知助手</CardTitle>
          <CardDescription>输入部署时设置的 ADMIN_TOKEN。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (input.trim().length >= 32) void login(input.trim())
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="admin-token">管理密钥</Label>
              <Input
                id="admin-token"
                type="password"
                autoComplete="off"
                autoFocus
                readOnly={busy}
                placeholder="输入管理密钥"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertTitle>登录未完成</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              className="mt-1 w-full"
              disabled={busy || input.trim().length < 32}
            >
              {busy ? <Spinner className="size-4" /> : <LogIn />}
              进入助手
            </Button>
          </form>
        </CardContent>
        <CardFooter>
          <p className="w-full text-center text-xs text-muted-foreground">
            会话有效期 30 天 · Cookie 仅同源传输
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}

function Connecting() {
  const { error, busy, refresh, logout } = useStore()
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6">
      <BrandLockup />
      {error ? (
        <Card className="animate-page-in w-full max-w-sm">
          <CardContent className="flex flex-col gap-4">
            <Alert variant="destructive">
              <AlertTitle>暂时无法连接</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void refresh()}>
                <RefreshCw />
                重试连接
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void logout()}
              >
                重新登录
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Spinner label="正在恢复会话…" />
      )}
    </main>
  )
}

function HeaderStatusCue() {
  const data = useStore((s) => s.data)
  if (!data) return null
  const s = data.notifier
  const hasError = Boolean(
    s.blocked || s.scan_error || s.relay_error || s.watches.error
  )
  if (hasError) {
    return (
      <a
        href={
          s.blocked === 'pairing'
            ? '#settings-devices'
            : '#settings-accounts'
        }
        className="hidden items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 sm:inline-flex dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950/80"
      >
        <AlertCircle className="size-3.5" aria-hidden="true" />
        需要处理
      </a>
    )
  }
  if (!s.enabled && s.binding_id) {
    return (
      <a
        href="#settings-notifications"
        className="hidden items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 sm:inline-flex dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-950/80"
      >
        <PauseCircle className="size-3.5" aria-hidden="true" />
        服务已暂停
      </a>
    )
  }
  return null
}

function Dashboard() {
  const { data, proxy, accounts, selectedAccountId, requestVersion, refresh } =
    useStore()
  const [page, setPage] = useState<Page>(currentPage)
  const [hash, setHash] = useState(currentHash)

  useEffect(() => {
    const changed = () => {
      setPage(currentPage())
      setHash(currentHash())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])

  return (
    <LayoutProvider>
      <SidebarProvider defaultOpen={getCookie('sidebar_state') !== 'false'}>
        <AppSidebar hash={hash} />
        <SidebarInset className="@container/content overflow-x-clip">
          <Header fixed>
            <Search className="me-auto" />
            <HeaderStatusCue />
            <ThemeSwitch />
            <ConfigDrawer />
            <ProfileDropdown />
          </Header>
          <Main className="flex flex-col">
            <Suspense
              key={`${selectedAccountId}:${requestVersion}`}
              fallback={
                <div className="grid place-items-center py-24">
                  <Spinner label="正在加载…" />
                </div>
              }
            >
              {!accounts.length ? (
                <div className="animate-page-in flex flex-col gap-6">
                  <PageHeader
                    title="连接你的第一个账号"
                    description="填写 V2EX Cookie 与个人访问令牌，验证通过后即可开始接收通知。"
                  />
                  <AccountManagement />
                  {proxy && (
                    <Card>
                      <CardHeader>
                        <CardTitle>网络代理</CardTitle>
                        <CardDescription>
                          可选；未配置时直接连接 V2EX 与推送服务。
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <HttpProxySettings />
                      </CardContent>
                    </Card>
                  )}
                </div>
              ) : !data ? (
                <div className="grid place-items-center gap-3 py-24">
                  <Spinner label="正在读取所选账号…" />
                  <Button variant="outline" onClick={() => void refresh()}>
                    重试读取账号
                  </Button>
                </div>
              ) : (
                <div
                  key={page}
                  className="animate-page-in flex flex-1 flex-col"
                >
                  {page === 'overview' ? (
                    <Notifier />
                  ) : page === 'messages' ? (
                    <Messages />
                  ) : page === 'watched-topics' ? (
                    <WatchedTopics />
                  ) : page === 'following-topics' ? (
                    <FollowingMembers />
                  ) : page === 'notifications' ? (
                    <Records view="deliveries" />
                  ) : page === 'checks' ? (
                    <Records view="checks" />
                  ) : (
                    <Settings />
                  )}
                </div>
              )}
            </Suspense>
          </Main>
          <Toaster />
        </SidebarInset>
      </SidebarProvider>
    </LayoutProvider>
  )
}

export default function App() {
  const { accountsLoaded, auth, refresh } = useStore()
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <ThemeProvider>
      <AccentProvider>
        <DirectionProvider>
          {accountsLoaded && auth === 'authenticated' ? (
            <Dashboard />
          ) : auth !== 'anonymous' ? (
            <Connecting />
          ) : (
            <Login />
          )}
        </DirectionProvider>
      </AccentProvider>
    </ThemeProvider>
  )
}
