import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Inbox,
  RefreshCw,
  X,
} from 'lucide-react'
import { format, request, time, useStore } from '@/lib/api'
import { shortTime } from '@/lib/format'
import type {
  CheckRecord,
  NotificationRecord,
  RecordsPage,
} from '../../shared/contracts'
import { EventDetailDialog, EventRow } from './notifier-event'
import { stages, statuses } from './notifier-labels'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/status-badge'
import { TableSkeleton } from '@/components/table-skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

type View = 'checks' | 'deliveries'
type Row = CheckRecord | NotificationRecord

const outcomes: Record<string, string> = {
  running: '执行中',
  ok: '完成',
  waiting: '等待重试',
  error: '失败',
  interrupted: '执行中断',
}

const checkOutcomeFilters: Record<string, string> = {
  all: '全部结果',
  issues: '异常（失败/中断）',
  ...outcomes,
}

const errorSourceLabels: Record<string, string> = {
  scan: '个人消息',
  following_topic: '关注成员',
  topic_reply: '关注帖子',
}

const sources: Record<string, string> = {
  scan: '未读消息检查',
  following_topic: '关注成员发帖',
  topic_reply: '关注帖子评论',
  verify: '账号验证',
  history: '历史读取',
  pairing: '配对连接',
}

const checkTabs = [
  { value: 'all', label: '全部' },
  { value: 'scan', label: '个人消息' },
  { value: 'following_topic', label: '成员' },
  { value: 'topic_reply', label: '帖子' },
]

const checkHashes: Record<string, string> = {
  all: 'checks',
  scan: 'checks-scan',
  following_topic: 'checks-following',
  topic_reply: 'checks-topics',
}

function currentCheckSource(): string {
  const hash = window.location.hash.slice(1)
  if (hash === 'checks-all') return 'all'
  return (
    checkTabs.find((tab) => checkHashes[tab.value] === hash)?.value ?? 'all'
  )
}

const checkStages: Record<string, string> = {
  ...stages,
  watch_scan: '读取关注内容',
  pairing_qr: '生成二维码',
  pairing_complete: '确认连接',
  pairing_app: 'App 连接',
}

function checkOutcomeMeta(item: CheckRecord) {
  const isWatch = ['following_topic', 'topic_reply'].includes(item.source)
  const label =
    isWatch && item.outcome === 'ok' && item.stage_after === 'watch_scan'
      ? '分片完成'
      : (outcomes[item.outcome] ?? item.outcome)
  const tone = ['error', 'interrupted'].includes(item.outcome)
    ? ('danger' as const)
    : item.outcome === 'ok'
      ? ('success' as const)
      : ('neutral' as const)
  return { label, tone, isWatch }
}

function CheckRow({
  item,
  onSelect,
}: {
  item: CheckRecord
  onSelect: (item: CheckRecord) => void
}) {
  const source = sources[item.source] ?? item.source
  const { label, tone } = checkOutcomeMeta(item)
  const showDetailHint =
    Boolean(item.detail) &&
    (item.source === 'topic_reply' ||
      ['error', 'interrupted', 'waiting'].includes(item.outcome))

  return (
    <TableRow
      onClick={() => onSelect(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(item)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`查看 ${source} 检查详情`}
      className="cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none"
    >
      <TableCell className="py-3 ps-4 whitespace-normal">
        <p className="truncate font-medium">{source}</p>
        {showDetailHint && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {item.detail}
          </p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums sm:hidden">
          {shortTime(item.started_at)}
        </p>
      </TableCell>
      <TableCell>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </TableCell>
      <TableCell className="hidden text-end text-xs text-muted-foreground tabular-nums md:table-cell">
        {format(item.requests)} 次
      </TableCell>
      <TableCell className="hidden text-end text-xs text-muted-foreground tabular-nums sm:table-cell">
        {shortTime(item.started_at)}
      </TableCell>
      <TableCell className="pe-4 text-end text-muted-foreground">
        <ChevronRight className="ms-auto size-4" aria-hidden="true" />
      </TableCell>
    </TableRow>
  )
}

function CheckDetailDialog({
  item,
  open,
  onOpenChange,
}: {
  item: CheckRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!item) return null
  const source = sources[item.source] ?? item.source
  const { label, tone, isWatch } = checkOutcomeMeta(item)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{source}</span>
            <StatusBadge tone={tone}>{label}</StatusBadge>
          </DialogTitle>
          <DialogDescription>
            开始于 {time(item.started_at)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {item.detail && (
            <div className="rounded-lg border bg-muted/30 p-3.5 text-sm leading-relaxed">
              {item.detail}
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 text-sm">
            {!isWatch && item.source !== 'pairing' && (
              <>
                <dt className="text-muted-foreground">未读快照</dt>
                <dd className="tabular-nums">{format(item.unread)} 条</dd>
              </>
            )}
            <dt className="text-muted-foreground">网络请求</dt>
            <dd className="tabular-nums">
              共 {format(item.requests)} 次（API {format(item.api_requests)} 次）
            </dd>
            <dt className="text-muted-foreground">状态流转</dt>
            <dd>
              {checkStages[item.stage_before] ?? item.stage_before}
              {item.stage_after && (
                <> → {checkStages[item.stage_after] ?? item.stage_after}</>
              )}
            </dd>
            {item.finished_at && (
              <>
                <dt className="text-muted-foreground">完成时间</dt>
                <dd className="tabular-nums">{time(item.finished_at)}</dd>
              </>
            )}
          </dl>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RecordsView({ view }: { view: View }) {
  const requestVersion = useStore((s) => s.requestVersion)
  const data = useStore((s) => s.data)!
  const busy = useStore((s) => s.busy)
  const refresh = useStore((s) => s.refresh)
  const action = useStore((s) => s.action)

  const [filter, setFilter] = useState('all')
  const [type, setType] = useState('all')
  const [source, setSource] = useState(currentCheckSource)
  const [cursors, setCursors] = useState<string[]>([])
  const [retry, setRetry] = useState(0)
  const [selectedEvent, setSelectedEvent] = useState<NotificationRecord | null>(
    null
  )
  const [selectedCheck, setSelectedCheck] = useState<CheckRecord | null>(null)
  const [result, setResult] = useState<{
    key: string
    path: string
    page?: RecordsPage<Row>
    error?: string
  } | null>(null)

  const query = new URLSearchParams({
    view,
    [view === 'checks' ? 'outcome' : 'status']: filter,
  })
  if (view === 'deliveries') query.set('type', type)
  if (view === 'checks' && source !== 'all') query.set('source', source)
  if (cursors.length) query.set('cursor', cursors.at(-1)!)
  const path = `/notifier/records?${query}`
  const key = `${path}:${data.now}:${retry}`
  const page = result?.path === path ? result.page : undefined
  const loading = result?.key !== key
  const error = result?.key === key ? result.error : ''

  useEffect(() => {
    if (view !== 'checks') return
    const changed = () => {
      setSource(currentCheckSource())
      setCursors([])
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [view])

  useEffect(() => {
    let cancelled = false
    void request<RecordsPage<Row>>(requestVersion, path).then(
      (loaded) => {
        if (!cancelled) setResult({ key, path, page: loaded })
      },
      (e) => {
        if (!cancelled)
          setResult((previous) => ({
            key,
            path,
            page: previous?.path === path ? previous.page : undefined,
            error: e instanceof Error ? e.message : '读取记录失败',
          }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [requestVersion, path, key])

  const filtered = filter !== 'all' || type !== 'all'
  const selectedCheckTab = checkTabs.find((tab) => tab.value === source)!
  const countOf = (...values: string[]) =>
    data.notifier.counts
      .filter((item) => values.includes(item.status))
      .reduce((sum, item) => sum + item.count, 0)

  const clearFilters = () => {
    setFilter('all')
    setType('all')
    setCursors([])
  }

  const deliveryQuickPills = [
    { value: 'all', label: '全部', count: null },
    {
      value: 'apns_accepted',
      label: '已接收',
      count: countOf('apns_accepted'),
    },
    { value: 'pending', label: '等待发送', count: countOf('pending') },
    { value: 'submitted', label: '已提交', count: countOf('submitted') },
    { value: 'rejected', label: '已拒绝', count: countOf('rejected') },
    { value: 'expired', label: '已过期', count: countOf('expired') },
    {
      value: 'unclassified',
      label: '待分类',
      count: countOf('unclassified'),
    },
  ]

  const title = view === 'checks' ? '检查日志' : '推送记录'
  const description =
    view === 'checks'
      ? '定时与手动检查的执行结果，点击条目查看细节。'
      : '推送通知的投递状态，点击条目查看完整内容与回执。'
  const checkErrorItems = data.notifier.check_errors.filter(
    (item) => item.count > 0
  )
  const checkErrorTotal = checkErrorItems.reduce(
    (sum, item) => sum + item.count,
    0
  )
  const checkErrorBreakdown = checkErrorItems
    .map(
      (item) =>
        `${errorSourceLabels[item.source] ?? item.source} ${format(item.count)} 次`
    )
    .join('、')

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            刷新
          </Button>
        }
      />

      {view === 'checks' && checkErrorTotal > 0 && (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/5"
        >
          <AlertTriangle className="size-4" />
          <AlertTitle>
            近 24 小时有 {format(checkErrorTotal)} 次检查异常
          </AlertTitle>
          <AlertDescription className="flex w-full flex-wrap items-center justify-between gap-3">
            <span>
              {checkErrorBreakdown}（失败或执行中断，并非未读消息；清除红点后仅新发生的异常会再次提示）。
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-destructive/30 bg-background text-foreground hover:bg-accent"
                onClick={() => {
                  if (filter === 'issues') {
                    setFilter('all')
                  } else {
                    setSource('all')
                    setFilter('issues')
                    if (window.location.hash !== '#checks') {
                      window.location.hash = 'checks'
                    }
                  }
                  setCursors([])
                }}
              >
                {filter === 'issues' ? '显示全部日志' : '只看异常记录'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                title="清除侧栏异常红点，保留历史日志"
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void action('/notifier/checks/ack', 'POST')}
              >
                <CheckCheck className="size-3.5" />
                清除红点
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>记录读取失败</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {error}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Unified Compact Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {view === 'checks' ? (
          <>
            <Tabs
              value={source}
              onValueChange={(value) => {
                setSource(value)
                setCursors([])
                window.location.hash = checkHashes[value] ?? 'checks'
              }}
            >
              <TabsList className="h-8">
                {checkTabs.map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="px-2.5 text-xs"
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Select
              value={filter}
              onValueChange={(value) => {
                setFilter(value)
                setCursors([])
              }}
            >
              <SelectTrigger
                className="h-8 w-auto min-w-32 gap-1.5 border-dashed text-xs"
                aria-label="执行结果"
              >
                <CirclePlus className="size-3.5" />
                <SelectValue placeholder="全部结果" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(checkOutcomeFilters).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : (
          <>
            <div
              role="group"
              aria-label="按状态筛选"
              className="flex flex-wrap items-center gap-1"
            >
              {deliveryQuickPills.map((pill) => {
                const activePill = filter === pill.value
                if (
                  pill.value !== 'all' &&
                  pill.value !== 'apns_accepted' &&
                  pill.count === 0 &&
                  !activePill
                )
                  return null
                return (
                  <Button
                    key={pill.value}
                    type="button"
                    size="sm"
                    variant={activePill ? 'secondary' : 'outline'}
                    className={cn(
                      'h-8 px-2.5 text-xs',
                      !activePill && 'border-dashed text-muted-foreground'
                    )}
                    onClick={() => {
                      setFilter(pill.value)
                      setCursors([])
                    }}
                  >
                    {pill.label}
                    {pill.count !== null && pill.count > 0 && (
                      <span className="ms-1 text-[11px] text-muted-foreground tabular-nums">
                        {format(pill.count)}
                      </span>
                    )}
                  </Button>
                )
              })}
            </div>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value)
                setCursors([])
              }}
            >
              <SelectTrigger
                className="h-8 w-auto min-w-32 gap-1.5 border-dashed text-xs"
                aria-label="通知来源"
              >
                <CirclePlus className="size-3.5" />
                <SelectValue placeholder="全部来源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="notification">个人通知</SelectItem>
                <SelectItem value="watch_update">关注提醒</SelectItem>
                <SelectItem value="test">测试通知</SelectItem>
              </SelectContent>
            </Select>
            {/* Fallback full status selector only if a rare status isn't in pills */}
            {!deliveryQuickPills.some((p) => p.value === filter) && (
              <Select
                value={filter}
                onValueChange={(value) => {
                  setFilter(value)
                  setCursors([])
                }}
              >
                <SelectTrigger className="h-8 w-auto text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries({ all: '全部状态', ...statuses }).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            )}
          </>
        )}
        {filtered && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            onClick={clearFilters}
          >
            重置
            <X className="size-3.5" />
          </Button>
        )}
        {loading && page && (
          <span
            className="ms-auto text-xs text-muted-foreground"
            role="status"
          >
            正在更新…
          </span>
        )}
      </div>

      <div
        aria-busy={loading}
        className="overflow-hidden rounded-lg border bg-card"
      >
        {loading && !page ? (
          <TableSkeleton rows={7} withAvatar={view === 'deliveries'} />
        ) : page?.items.length ? (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="ps-4">
                  {view === 'checks' ? '检查项' : '通知'}
                </TableHead>
                <TableHead className="w-32">
                  {view === 'checks' ? '结果' : '状态'}
                </TableHead>
                {view === 'checks' && (
                  <TableHead className="hidden w-24 text-end md:table-cell">
                    请求
                  </TableHead>
                )}
                <TableHead className="hidden w-32 text-end sm:table-cell">
                  {view === 'checks' ? '检查时间' : '更新时间'}
                </TableHead>
                <TableHead className="w-12 pe-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) =>
                'event_id' in item ? (
                  <EventRow
                    key={item.event_id}
                    event={item}
                    onSelect={setSelectedEvent}
                  />
                ) : (
                  <CheckRow
                    key={item.id}
                    item={item}
                    onSelect={setSelectedCheck}
                  />
                )
              )}
            </TableBody>
          </Table>
        ) : !error ? (
          <div className="p-4">
            <EmptyState
              icon={<Inbox className="size-5" />}
              title={
                filtered
                  ? '没有符合条件的记录'
                  : view === 'checks'
                    ? `暂无${selectedCheckTab.label === '全部' ? '' : selectedCheckTab.label}检查日志`
                    : '暂无推送记录'
              }
              action={
                filtered ? (
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    清除筛选
                  </Button>
                ) : undefined
              }
            >
              {filtered
                ? '尝试切换筛选条件查看其他记录。'
                : view === 'checks'
                  ? '助手执行检查后，结果会自动记录在这里。'
                  : '收到个人消息或关注更新后，投递记录会显示在这里。'}
            </EmptyState>
          </div>
        ) : null}
      </div>

      {(cursors.length > 0 || page?.next_cursor) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            第 {cursors.length + 1} 页
          </p>
          <div className="flex flex-wrap gap-2">
            {cursors.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => setCursors([])}
              >
                返回首页
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !cursors.length}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              <ChevronLeft className="size-4" />
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !page?.next_cursor}
              onClick={() => {
                if (page?.next_cursor)
                  setCursors((value) => [...value, page.next_cursor!])
              }}
            >
              下一页
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <EventDetailDialog
        event={selectedEvent}
        open={selectedEvent !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedEvent(null)
        }}
      />
      <CheckDetailDialog
        item={selectedCheck}
        open={selectedCheck !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCheck(null)
        }}
      />
    </div>
  )
}

export default function NotificationRecords({
  view = 'deliveries',
}: {
  view?: View
}) {
  const requestVersion = useStore((s) => s.requestVersion)
  const account = useStore((s) => s.data?.notifier.account_id)
  return (
    <RecordsView key={`${view}:${requestVersion}:${account}`} view={view} />
  )
}
