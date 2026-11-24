import { useState } from 'react'
import {
  ArrowRight,
  Bell,
  BellOff,
  Bookmark,
  ChevronRight,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Users,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { format, time, useStore } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { checkScheduleLabel, checkWindow } from '../../shared/check-schedule'
import type { NotificationRecord, NotifierState } from '../../shared/contracts'
import { MetricCard } from '@/components/metric-card'
import { PageHeader } from '@/components/page-header'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { EventDetailDialog, EventTypeIcon } from '@/components/notifier-event'
import { eventLabel, eventStatusMeta } from '@/components/notifier-labels'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

type ChannelItem = {
  id: string
  name: string
  href: string
  last: number
  errors: number
  enabled: boolean
  waitingDevice?: boolean
  detail: string
}

export default function Notifier() {
  const data = useStore((s) => s.data)!
  const busy = useStore((s) => s.busy)
  const refresh = useStore((s) => s.refresh)
  const action = useStore((s) => s.action)
  const [selectedEvent, setSelectedEvent] = useState<NotificationRecord | null>(
    null
  )

  const s = data.notifier
  const watchConfig = s.watches.config
  const following = s.watches.targets.find((target) => target.topic_id === 0)
  const topicTargets = s.watches.targets.filter((target) => target.topic_id > 0)
  const lastTopicCheck = Math.max(
    0,
    ...topicTargets.map((target) => target.last_checked)
  )
  const activeTopics =
    watchConfig?.topics.filter((topic) => topic.enabled).length ?? 0

  const checkErrors: Record<
    NotifierState['check_errors'][number]['source'],
    number
  > = {
    scan: 0,
    following_topic: 0,
    topic_reply: 0,
  }
  for (const item of s.check_errors) checkErrors[item.source] = item.count

  const queued = s.counts
    .filter((x) => ['pending', 'submitted'].includes(x.status))
    .reduce((n, x) => n + x.count, 0)
  const accepted = s.counts
    .filter((x) => x.status === 'apns_accepted')
    .reduce((n, x) => n + x.count, 0)
  const failed = s.counts
    .filter((x) => ['rejected', 'expired'].includes(x.status))
    .reduce((n, x) => n + x.count, 0)
  const unclassified = s.counts.some(
    (x) => x.status === 'unclassified' && x.count > 0
  )

  const currentWindow = checkWindow(data.now, s)
  const paired = Boolean(s.binding_id) && s.blocked !== 'pairing'
  const credentialsReady =
    data.credentials.cookie && data.credentials.pat && s.storage_ready
  const needsSetup = !credentialsReady || !paired || !s.verified_at
  const errors = [s.scan_error, s.relay_error, s.watches.error].filter(Boolean)
  const needsAttention = Boolean(s.blocked) || errors.length > 0
  const canToggleService =
    Boolean(s.enabled) || (s.storage_ready && Boolean(s.binding_id) && !s.blocked)

  const cooldowns = [
    { label: '通知 API', until: data.control.api_until },
    { label: '网页检查', until: data.control.web_until },
    { label: '个人通知扫描', until: s.scan_until },
  ].filter((item) => item.until > data.now)

  const serviceBadge: { label: string; tone: StatusTone } = needsAttention
    ? { label: '需要处理', tone: 'danger' }
    : needsSetup
      ? { label: '待完成配置', tone: 'warning' }
      : !s.enabled
        ? { label: '已暂停', tone: 'neutral' }
        : !currentWindow.open
          ? { label: `静默中 · ${checkScheduleLabel(s)}`, tone: 'neutral' }
          : cooldowns.length
            ? { label: '部分暂缓', tone: 'warning' }
            : { label: `运行中 · ${checkScheduleLabel(s)}`, tone: 'success' }

  const watchCapable = Boolean(watchConfig?.capable_recipient_count)
  const channels: ChannelItem[] = [
    {
      id: 'scan',
      name: '个人消息',
      href: 'checks-scan',
      detail: paired ? '未读扫描已配对' : '等待配对 App',
      last: s.last_scan,
      errors: checkErrors.scan,
      enabled: Boolean(s.enabled),
    },
    {
      id: 'following',
      name: '关注成员',
      href: 'checks-following',
      detail: !watchConfig
        ? '等待规则同步'
        : !watchConfig.following.enabled
          ? '新帖提醒未开启'
          : !watchCapable
            ? '待接收设备，监测已暂停'
            : '新帖提醒已开启',
      last: following?.last_checked ?? 0,
      errors: checkErrors.following_topic,
      enabled: Boolean(s.enabled) && Boolean(watchConfig?.following.enabled),
      waitingDevice: Boolean(watchConfig?.following.enabled) && !watchCapable,
    },
    {
      id: 'topics',
      name: '关注帖子',
      href: 'checks-topics',
      detail: watchConfig
        ? activeTopics > 0
          ? !watchCapable
            ? `${activeTopics} 篇待接收设备`
            : `${activeTopics} 篇监测中`
          : '暂无开启的帖子'
        : '等待规则同步',
      last: lastTopicCheck,
      errors: checkErrors.topic_reply,
      enabled: Boolean(s.enabled) && activeTopics > 0,
      waitingDevice: activeTopics > 0 && !watchCapable,
    },
  ]

  const channelState = (
    channel: ChannelItem
  ): { label: string; tone: StatusTone } =>
    !s.enabled
      ? { label: '已暂停', tone: 'neutral' }
      : !channel.enabled
        ? { label: '未开启', tone: 'neutral' }
        : channel.waitingDevice
          ? { label: '待接收设备', tone: 'warning' }
          : channel.errors > 0
            ? { label: `${channel.errors} 次异常`, tone: 'danger' }
            : { label: '正常', tone: 'success' }

  const recent = [...s.events]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5)

  // Match the backend's 7-day window so there are never empty leading columns.
  const dailyMap = new Map(data.daily.map((day) => [day.day, day]))
  const todayDate = new Date(data.now)
  const todayKey = todayDate.toISOString().slice(0, 10)
  const chartData = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(
      Date.UTC(
        todayDate.getUTCFullYear(),
        todayDate.getUTCMonth(),
        todayDate.getUTCDate()
      )
    )
    date.setUTCDate(date.getUTCDate() - (6 - index))
    const key = date.toISOString().slice(0, 10)
    const entry = dailyMap.get(key)
    return {
      day: key.slice(5),
      invocations: entry?.invocations ?? 0,
      cron: entry?.cron ?? 0,
      http: entry?.http ?? 0,
    }
  })
  const todayInvocations = dailyMap.get(todayKey)?.invocations ?? 0
  const quotaPct =
    data.limits.requests > 0
      ? (todayInvocations / data.limits.requests) * 100
      : 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            <span>概览</span>
            <StatusBadge tone={serviceBadge.tone}>
              {serviceBadge.label}
            </StatusBadge>
          </span>
        }
        actions={
          <>
            {canToggleService && !needsSetup && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void action('/notifier/config', 'PUT', {
                    enabled: !s.enabled,
                  })
                }
              >
                {s.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {s.enabled ? '暂停服务' : '开启服务'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
              刷新
            </Button>
            {(needsSetup || needsAttention) && (
              <Button
                size="sm"
                onClick={() => {
                  window.location.hash =
                    s.blocked === 'pairing'
                      ? 'settings-devices'
                      : needsSetup
                        ? 'settings-accounts'
                        : 'settings-notifications'
                }}
              >
                {needsSetup ? '完成配置' : '去处理'}
              </Button>
            )}
          </>
        }
      />

      {needsAttention && (
        <Alert variant="destructive">
          <AlertTitle>
            {s.blocked === 'pairing'
              ? 'App 配对已失效，请重新配对'
              : '通知服务存在异常'}
          </AlertTitle>
          <AlertDescription>
            {errors.length
              ? errors.join('；')
              : '请检查账号凭据或设备连接状态。'}
          </AlertDescription>
        </Alert>
      )}

      {needsSetup && !needsAttention && (
        <Alert>
          <AlertTitle>尚未完成初始配置</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              请先确认 V2EX 凭据并扫码配对 App，完成后即可自动推送通知。
            </span>
            <Button
              size="sm"
              onClick={() =>
                (window.location.hash = credentialsReady
                  ? 'settings-devices'
                  : 'settings-accounts')
              }
            >
              前往配置
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {Boolean(s.enabled) && cooldowns.length > 0 && (
        <Alert>
          <AlertTitle>部分请求冷却中</AlertTitle>
          <AlertDescription>
            {cooldowns
              .map((item) => `${item.label}（${time(item.until)} 后重试）`)
              .join(' · ')}
          </AlertDescription>
        </Alert>
      )}

      {unclassified && (
        <Alert>
          <AlertTitle className="flex items-center gap-2">
            存在待分类通知
            <Badge variant="outline">已暂缓</Badge>
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>未识别类型的通知未自动推送，可在推送记录中查看详情。</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => (window.location.hash = 'notifications')}
            >
              查看记录
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="未读消息"
          value={s.observed_at ? format(s.unread) : '—'}
          hint={
            s.last_scan
              ? `检查于 ${relativeTime(s.last_scan, data.now)}`
              : '尚未检查'
          }
          icon={Mail}
          href="messages"
        />
        <MetricCard
          label="关注帖子"
          value={watchConfig ? format(watchConfig.topics.length) : '—'}
          hint={
            watchConfig
              ? activeTopics > 0
                ? `${activeTopics} 篇监测中`
                : '点击添加追评'
              : '等待同步'
          }
          icon={Bookmark}
          href="watched-topics"
        />
        <MetricCard
          label="关注成员"
          value={
            following?.member_count == null
              ? '—'
              : format(following.member_count)
          }
          hint={
            !watchConfig?.following.enabled
              ? '新帖提醒未开启'
              : !watchCapable
                ? '待接收设备，监测已暂停'
                : '新帖提醒已开启'
          }
          icon={Users}
          href="following-topics"
        />
        <MetricCard
          label="待推送"
          value={format(queued)}
          hint={
            failed > 0
              ? `含 ${format(failed)} 条异常`
              : accepted > 0
                ? `累计已接收 ${format(accepted)} 条`
                : '当前无积压'
          }
          tone={failed > 0 ? 'danger' : unclassified ? 'warning' : 'default'}
          icon={s.enabled ? Bell : BellOff}
          href="notifications"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-7">
        <Card className="gap-4 py-5 lg:col-span-4">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle>近 7 天运行趋势</CardTitle>
              <CardDescription className="mt-1 tabular-nums">
                今日调用 {format(todayInvocations)} 次
                {quotaPct > 0
                  ? `（占日额度 ${quotaPct < 1 ? quotaPct.toFixed(1) : Math.round(quotaPct)}%）`
                  : ''}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild className="shrink-0">
              <a href="#settings-advanced" className="text-muted-foreground">
                额度详情
                <ArrowRight className="size-3.5" />
              </a>
            </Button>
          </CardHeader>
          <CardContent className="ps-2">
            {chartData.some((day) => day.invocations > 0) ? (
              <div className="h-[228px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barCategoryGap="24%">
                    <XAxis
                      dataKey="day"
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                      stroke="#888888"
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={46}
                      fontSize={12}
                      stroke="#888888"
                      tickFormatter={(value: number) => format(value)}
                    />
                    <Tooltip
                      cursor={{ fill: 'var(--muted)', opacity: 0.45 }}
                      contentStyle={{
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--popover)',
                        color: 'var(--popover-foreground)',
                        fontSize: 12,
                        boxShadow: '0 4px 12px rgb(0 0 0 / 0.08)',
                      }}
                      formatter={(value) => [
                        `${format(Number(value))} 次`,
                        '总调用',
                      ]}
                      labelFormatter={(label) => `日期 ${String(label)}`}
                    />
                    <Bar
                      dataKey="invocations"
                      maxBarSize={44}
                      fill="currentColor"
                      radius={[5, 5, 0, 0]}
                      className="fill-primary"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="grid h-[228px] place-items-center text-sm text-muted-foreground">
                暂无近 7 天调用数据。
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4 py-5 lg:col-span-3">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle>最近通知</CardTitle>
              <CardDescription className="mt-1">
                点击条目查看推送内容与回执
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <a href="#notifications" className="text-muted-foreground">
                全部
                <ArrowRight className="size-3.5" />
              </a>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-0.5">
            {recent.length ? (
              recent.map((event) => {
                const status = eventStatusMeta(event)
                return (
                  <button
                    key={event.event_id}
                    type="button"
                    onClick={() => setSelectedEvent(event)}
                    className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground transition-colors group-hover:bg-background">
                      <EventTypeIcon type={event.type} className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {eventLabel(event)}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {relativeTime(event.created_at, data.now)}
                      </p>
                    </div>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    <ChevronRight
                      className="size-3.5 shrink-0 text-muted-foreground opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </button>
                )
              })
            ) : (
              <div className="grid h-[240px] place-items-center text-sm text-muted-foreground">
                暂时没有推送记录。
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-center justify-between gap-2 border-b px-5 py-3.5">
          <p className="text-sm font-semibold">监测通道</p>
          <a
            href="#checks"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            检查日志
            <ArrowRight className="size-3.5" />
          </a>
        </div>
        <div className="grid divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
          {channels.map((channel) => {
            const state = channelState(channel)
            return (
              <a
                key={channel.id}
                href={`#${channel.href}`}
                className="group flex flex-col gap-1.5 px-5 py-4 transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{channel.name}</span>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{channel.detail}</span>
                  <span className="shrink-0 tabular-nums">
                    {relativeTime(channel.last, data.now)}
                  </span>
                </div>
              </a>
            )
          })}
        </div>
      </Card>

      <EventDetailDialog
        event={selectedEvent}
        open={selectedEvent !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedEvent(null)
        }}
      />
    </div>
  )
}
