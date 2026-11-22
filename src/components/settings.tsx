import { useEffect, useState } from 'react'
import {
  Bell,
  Palette,
  RefreshCw,
  Send,
  Settings2,
  Smartphone,
  UserCog,
} from 'lucide-react'
import { time, useStore } from '@/lib/api'
import {
  validCheckHours,
  validCheckIntervals,
  type CheckPolicy,
} from '../../shared/check-schedule'
import { kinds } from './notifier-labels'
import { CheckSchedule } from './check-schedule'
import { PairingQR } from './pairing-qr'
import { WatchPairing } from './watch-pairing'
import { HttpProxySettings } from './http-proxy-settings'
import { Quota } from './quota'
import { VersionInfo } from './version-info'
import { CredentialsSettings } from './credentials-settings'
import { Appearance } from './appearance'
import { AccountManagement } from './accounts'
import { SettingsRow, SettingsSection } from './settings-section'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const watchTestKinds = [
  { value: 'topic_reply', label: '关注帖子 · 单条评论' },
  { value: 'topic_replies', label: '关注帖子 · 多条评论' },
  { value: 'following_topic', label: '关注成员 · 新帖' },
]
const testKinds = [
  ...Object.entries(kinds)
    .filter(([kind]) => kind !== 'other')
    .map(([value, label]) => ({ value, label })),
  ...watchTestKinds,
]

type SettingsTab =
  | 'notifications'
  | 'accounts'
  | 'devices'
  | 'advanced'
  | 'appearance'

const tabs: Array<{
  value: SettingsTab
  label: string
  icon: typeof Bell
}> = [
  { value: 'notifications', label: '通知策略', icon: Bell },
  { value: 'accounts', label: '账号与凭据', icon: UserCog },
  { value: 'devices', label: '设备配对', icon: Smartphone },
  { value: 'advanced', label: '网络与诊断', icon: Settings2 },
  { value: 'appearance', label: '外观', icon: Palette },
]

const settingsTabHashes: Record<SettingsTab, string> = {
  notifications: 'settings-notifications',
  accounts: 'settings-accounts',
  devices: 'settings-devices',
  advanced: 'settings-advanced',
  appearance: 'settings-appearance',
}

function currentSettingsTab(): SettingsTab {
  const hash = window.location.hash.slice(1)
  if (hash === 'settings-general' || hash === 'settings') return 'notifications'
  if (hash === 'quota' || hash === 'settings-network') return 'advanced'
  return (
    tabs.find((tab) => settingsTabHashes[tab.value] === hash)?.value ??
    'notifications'
  )
}

export function Settings() {
  const data = useStore((state) => state.data)!
  const s = data.notifier
  const action = useStore((state) => state.action)
  const busy = useStore((state) => state.busy)
  const [tab, setTab] = useState<SettingsTab>(currentSettingsTab)

  useEffect(() => {
    const changed = () => setTab(currentSettingsTab())
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])

  function changeTab(value: SettingsTab) {
    setTab(value)
    window.location.hash = settingsTabHashes[value]
  }

  const pairingInvalid = s.blocked === 'pairing'
  const paired = Boolean(s.binding_id) && !pairingInvalid
  const watchClients = s.watches.clients.length
  const watchAuthMissing = paired && watchClients === 0
  const credentialsReady =
    data.credentials.cookie && data.credentials.pat && s.storage_ready

  const verificationRetryAt = Math.max(
    data.control.api_until,
    data.control.web_until,
    s.verify_until
  )
  const [now, setNow] = useState(Date.now)
  const verificationCoolingDown =
    verificationRetryAt > Math.max(data.now, now)
  useEffect(() => {
    const delay = verificationRetryAt - Date.now()
    if (delay <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [verificationRetryAt])

  const [pairOpen, setPairOpen] = useState(!s.binding_id || pairingInvalid)
  const [testKind, setTestKind] = useState('reply')
  const [scheduleDraft, setScheduleDraft] = useState<Partial<CheckPolicy>>({})
  const [saving, setSaving] = useState(false)

  const canTest =
    s.storage_ready &&
    Boolean(s.binding_id) &&
    !s.blocked &&
    Boolean(s.enabled)

  const policy = { ...s, ...scheduleDraft }
  const scheduleValid =
    validCheckHours(policy.check_start_hour, policy.check_end_hour) &&
    validCheckIntervals(
      policy.scan_interval_minutes,
      policy.following_interval_minutes,
      policy.topic_interval_minutes
    )
  const scheduleDirty = (
    [
      'check_start_hour',
      'check_end_hour',
      'scan_interval_minutes',
      'following_interval_minutes',
      'topic_interval_minutes',
    ] as const
  ).some((key) => policy[key] !== s[key])

  function resetSchedule() {
    setScheduleDraft({})
    window.requestAnimationFrame(() =>
      document.getElementById('check-start-hour')?.focus()
    )
  }

  async function saveSchedule() {
    if (!scheduleDirty || !scheduleValid || saving) return
    setSaving(true)
    const saved = await action('/notifier/schedule', 'PUT', {
      startHour: policy.check_start_hour,
      endHour: policy.check_end_hour,
      scanIntervalMinutes: policy.scan_interval_minutes,
      followingIntervalMinutes: policy.following_interval_minutes,
      topicIntervalMinutes: policy.topic_interval_minutes,
    })
    setSaving(false)
    if (saved) setScheduleDraft({})
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        large
        title="设置"
        description="按职责管理通知策略、账号凭据、接收设备与系统诊断。"
        separator
      />

      <div className="flex flex-1 flex-col gap-6 lg:flex-row lg:gap-10">
        <aside className="lg:sticky lg:top-20 lg:w-48 lg:shrink-0 lg:self-start">
          <div className="md:hidden">
            <Select
              value={tab}
              onValueChange={(value) => changeTab(value as SettingsTab)}
            >
              <SelectTrigger className="h-10 w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tabs.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    <div className="flex items-center gap-2.5">
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <nav
            aria-label="设置分类"
            className="hidden gap-1 md:flex lg:flex-col"
          >
            {tabs.map((item) => {
              const active = tab === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => changeTab(item.value)}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'sm' }),
                    'h-9 justify-start gap-2.5 px-3 font-medium',
                    active
                      ? 'bg-muted text-foreground hover:bg-muted'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <div key={tab} className="animate-page-in flex flex-col gap-8">
            {tab === 'notifications' && (
              <>
                <SettingsSection
                  title="通知服务"
                  description="控制当前账号的定时检查与推送总开关。"
                >
                  <SettingsRow
                    label="启用自动检查与推送"
                    description={
                      !s.enabled &&
                      !(s.storage_ready && Boolean(s.binding_id) && !s.blocked)
                        ? '请先完成账号验证与 App 配对后再开启。'
                        : '关闭后暂停自动抓取与提醒，仍可手动查看缓存。'
                    }
                  >
                    <NotificationServiceSwitch />
                  </SettingsRow>
                </SettingsSection>

                <SettingsSection
                  title="检查时段与频率"
                  description="北京时间运行窗口及三类内容的常规检查间隔。"
                >
                  <CheckSchedule
                    draft={scheduleDraft}
                    onChange={setScheduleDraft}
                  />
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      disabled={busy || !scheduleDirty || !scheduleValid}
                      onClick={() => void saveSchedule()}
                    >
                      {saving && <RefreshCw className="size-3.5 animate-spin" />}
                      保存策略
                    </Button>
                    {scheduleDirty && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || saving}
                        onClick={resetSchedule}
                      >
                        还原
                      </Button>
                    )}
                  </div>
                </SettingsSection>

                <SettingsSection
                  title="测试推送"
                  description="发送一条测试通知以验证 APNs 链路，不影响真实未读数。"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Select
                      value={testKind}
                      onValueChange={setTestKind}
                      disabled={busy}
                    >
                      <SelectTrigger
                        id="test-kind"
                        aria-label="测试通知类型"
                        className="h-9 w-full sm:w-56"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {testKinds.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      disabled={busy || !canTest}
                      onClick={() =>
                        void action('/notifier/test', 'POST', {
                          kind: testKind,
                        })
                      }
                    >
                      <Send className="size-3.5" />
                      发送测试通知
                    </Button>
                  </div>
                  {!canTest && (
                    <p className="text-xs text-muted-foreground">
                      需要完成设备配对并开启通知服务后才可发送测试通知。
                    </p>
                  )}
                </SettingsSection>
              </>
            )}

            {tab === 'accounts' && (
              <>
                <AccountManagement />
                <SettingsSection
                  title="当前账号验证与凭据"
                  description="凭据加密保存在服务端，仅用于当前选中的账号。"
                >
                  {!credentialsReady && (
                    <Alert variant="destructive">
                      <AlertTitle>访问凭据尚未就绪</AlertTitle>
                      <AlertDescription>
                        {s.storage_ready
                          ? '请补齐 Cookie 与 PAT，验证通过后即可配对 App。'
                          : '请先在 Cloudflare Secrets 配置 NOTIFIER_KEY，再保存访问凭据。'}
                      </AlertDescription>
                    </Alert>
                  )}
                  <SettingsRow
                    label={s.username ? `@${s.username}` : '尚未验证 V2EX 账号'}
                    description={
                      verificationCoolingDown
                        ? `验证冷却中，可于 ${time(verificationRetryAt)} 后重试。`
                        : s.verified_at
                          ? `上次验证于 ${time(s.verified_at)}`
                          : '验证账号身份后可绑定接收设备。'
                    }
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || !s.storage_ready || verificationCoolingDown
                      }
                      onClick={() => void action('/notifier/verify', 'POST')}
                    >
                      {s.verified_at ? '重新验证' : '验证账号'}
                    </Button>
                  </SettingsRow>
                  <CredentialsSettings
                    isCoolingDown={verificationCoolingDown}
                  />
                </SettingsSection>
              </>
            )}

            {tab === 'devices' && (
              <>
                <SettingsSection
                  title="连接状态与授权设备"
                  description="管理已绑定个人提醒的通道及可修改关注规则的 App 设备。"
                >
                  {pairingInvalid && (
                    <Alert variant="destructive">
                      <AlertTitle>旧连接已失效</AlertTitle>
                      <AlertDescription>
                        请在下方重新生成配对二维码并扫码连接。
                      </AlertDescription>
                    </Alert>
                  )}
                  {watchAuthMissing && (
                    <Alert>
                      <AlertTitle>关注管理授权已全部撤销</AlertTitle>
                      <AlertDescription>
                        个人消息提醒仍正常接收；如需在 App 管理关注规则，请重新扫码授权。
                      </AlertDescription>
                    </Alert>
                  )}
                  <SettingsRow
                    label="推送通道"
                    description={
                      s.binding_id && s.paired_at > 0
                        ? `配对于 ${time(s.paired_at)}`
                        : '扫码后自动绑定当前账号的推送通道。'
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge
                        tone={
                          pairingInvalid
                            ? 'danger'
                            : paired
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {pairingInvalid
                          ? '连接已失效'
                          : paired
                            ? '个人提醒已连接'
                            : '尚未配对'}
                      </StatusBadge>
                      {watchAuthMissing && (
                        <StatusBadge tone="warning">
                          关注管理未授权
                        </StatusBadge>
                      )}
                    </div>
                  </SettingsRow>
                  <WatchPairing />
                </SettingsSection>

                <SettingsSection
                  title={
                    pairingInvalid
                      ? '重新配对 App'
                      : s.binding_id
                        ? '添加接收设备'
                        : '配对 App'
                  }
                  description="在 V2Echo App 的「通知设置 → 个人提醒」中扫描下方二维码。"
                >
                  {s.binding_id && !pairingInvalid ? (
                    <Collapsible open={pairOpen} onOpenChange={setPairOpen}>
                      <CollapsibleTrigger asChild>
                        <Button variant="outline" size="sm">
                          {pairOpen ? '收起配对二维码' : '添加新设备二维码'}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="CollapsibleContent pt-4">
                        <PairingQR onPaired={() => setPairOpen(false)} />
                      </CollapsibleContent>
                    </Collapsible>
                  ) : (
                    <PairingQR onPaired={() => setPairOpen(false)} />
                  )}

                  {!s.binding_id && (
                    <div className="border-t pt-4">
                      <TransferPairing onPaired={() => setPairOpen(false)} />
                    </div>
                  )}
                </SettingsSection>
              </>
            )}

            {tab === 'advanced' && (
              <>
                <SettingsSection
                  title="网络代理"
                  description="全局生效，V2EX 与推送服务共用此出口。"
                >
                  <HttpProxySettings />
                </SettingsSection>
                <SettingsSection
                  title="今日配额与诊断"
                  description="按 UTC 统计本助手记录的 Cloudflare 与 V2EX API 用量。"
                >
                  <Quota />
                </SettingsSection>
                <SettingsSection
                  title="版本与更新"
                  description="查看当前运行的助手版本，并按需检查 GitHub 官方新版本。"
                >
                  <VersionInfo />
                </SettingsSection>
              </>
            )}

            {tab === 'appearance' && <Appearance />}
          </div>
        </div>
      </div>
    </div>
  )
}

function NotificationServiceSwitch() {
  const s = useStore((state) => state.data!.notifier)
  const busy = useStore((state) => state.busy)
  const action = useStore((state) => state.action)
  const enabled = Boolean(s.enabled)
  const canEnable = s.storage_ready && Boolean(s.binding_id) && !s.blocked
  return (
    <div className="flex items-center gap-2.5">
      <StatusBadge tone={enabled ? 'success' : 'neutral'}>
        {enabled ? '运行中' : '已暂停'}
      </StatusBadge>
      <Switch
        checked={enabled}
        disabled={busy || (!enabled && !canEnable)}
        onCheckedChange={(checked) =>
          void action('/notifier/config', 'PUT', { enabled: checked })
        }
        aria-label="通知服务开关"
      />
    </div>
  )
}

function TransferPairing({ onPaired }: { onPaired: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
        >
          {open ? '收起迁移选项' : '从旧版通知助手迁移设备…'}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="CollapsibleContent pt-4">
        <PairingQR transfer onPaired={onPaired} />
      </CollapsibleContent>
    </Collapsible>
  )
}
