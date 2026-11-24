import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  BookmarkCheck,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  RefreshCw,
  Users,
  X,
} from 'lucide-react'
import { format, time, useStore } from '@/lib/api'
import { relativeTime, shortTime } from '@/lib/format'
import { useBatchRefresh } from '@/lib/use-batch-refresh'
import { cn } from '@/lib/utils'
import {
  MAX_WATCH_TOPICS,
  type WatchRefreshResult,
  type WatchTarget,
} from '../../shared/watch-contracts'
import type { NotifierState } from '../../shared/contracts'
import { checkWindow } from '../../shared/check-schedule'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { UserAvatar } from '@/components/user-avatar'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function followingStatus(
  state: NotifierState,
  target: WatchTarget | undefined,
  enabled: boolean,
  now: number
): { label: string; tone: StatusTone } {
  if (!enabled) return { label: '提醒已关闭', tone: 'neutral' }
  if (!state.enabled) return { label: '服务已暂停', tone: 'neutral' }
  if (state.blocked) return { label: '账号异常', tone: 'danger' }
  if (!state.watches.config?.capable_recipient_count)
    return { label: '待接收设备', tone: 'warning' }
  if (target?.error) return { label: '检查异常', tone: 'danger' }
  if (!checkWindow(now, state).open)
    return { label: '静默时段', tone: 'neutral' }
  if (target?.checking)
    return {
      label: target.last_checked ? '核验新帖中' : '建立基线中',
      tone: 'info',
    }
  return target?.last_checked
    ? { label: '监测中', tone: 'success' }
    : { label: '待首次检查', tone: 'neutral' }
}

export default function FollowingMembers() {
  const data = useStore((store) => store.data!)
  const state = data.notifier
  const now = data.now
  const busy = useStore((store) => store.busy)
  const action = useStore((store) => store.action)

  const [selectedMember, setSelectedMember] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [pageSize, setPageSize] = useState(10)
  const [pageIndex, setPageIndex] = useState(0)
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const [watchingTopicId, setWatchingTopicId] = useState<number | null>(null)

  const refresh = useBatchRefresh<WatchRefreshResult>(
    '/notifier/watch/refresh',
    (progress) => ({ started_at: progress.started_at })
  )

  const watch = state.watches
  const config = watch.config
  const target = watch.targets.find((item) => item.topic_id === 0)
  const followingEnabled = config?.following.enabled ?? false
  const available = Boolean(
    watch.direct_ready &&
      config &&
      state.binding_id &&
      state.storage_ready &&
      state.blocked !== 'pairing'
  )

  useEffect(() => {
    const refreshStore = () => {
      if (document.visibilityState === 'visible')
        void useStore.getState().refresh()
    }
    const timer = window.setInterval(refreshStore, 15_000)
    document.addEventListener('visibilitychange', refreshStore)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshStore)
    }
  }, [])

  async function change(
    actionName: string,
    extra: Record<string, unknown> = {}
  ) {
    if (!config) return false
    return action('/notifier/watch/config', 'POST', {
      operation_id: crypto.randomUUID(),
      profile_id: config.profile_id,
      source_generation: config.source_generation,
      base_revision: config.revision,
      action: actionName,
      ...extra,
    })
  }

  async function quickWatchTopic(topicId: number) {
    if (busy || !available || !config) return
    setWatchingTopicId(topicId)
    await change('add_topic', { topic_id: topicId })
    setWatchingTopicId(null)
  }

  const members = target?.followed_members
  const feed = target?.member_feed
  const watchCapable = Boolean(config?.capable_recipient_count)
  const lastSyncedAt = Math.max(
    feed?.observed_at ?? 0,
    target?.members_observed_at ?? 0
  )
  const activeMember = useMemo(() => {
    if (!selectedMember) return null
    if (!members) return selectedMember
    return members.some(
      (member) =>
        member.username.toLowerCase() === selectedMember.toLowerCase()
    )
      ? selectedMember
      : null
  }, [selectedMember, members])
  const watchedIds = useMemo(
    () => new Set((config?.topics ?? []).map((t) => t.topic_id)),
    [config]
  )
  const topicsFull = (config?.topics.length ?? 0) >= MAX_WATCH_TOPICS

  const memberPostCounts = useMemo(() => {
    const map = new Map<string, number>()
    const list = target?.member_feed?.topics ?? []
    for (const topic of list) {
      const key = topic.author.toLowerCase()
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [target?.member_feed?.topics])

  const needle = query.trim().toLowerCase()
  const filteredTopics = useMemo(() => {
    const list = target?.member_feed?.topics ?? []
    return list.filter((topic) => {
      if (
        activeMember &&
        topic.author.toLowerCase() !== activeMember.toLowerCase()
      )
        return false
      if (!needle) return true
      return `${topic.title} ${topic.author} ${topic.node_title ?? ''}`
        .toLowerCase()
        .includes(needle)
    })
  }, [target?.member_feed?.topics, activeMember, needle])

  const totalPages = Math.max(1, Math.ceil(filteredTopics.length / pageSize))
  const safePage = Math.min(pageIndex, totalPages - 1)
  const pagedTopics = filteredTopics.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize
  )

  const status = followingStatus(state, target, followingEnabled, now)
  const checkTime = checkWindow(now, state)
  const nextCheck = Math.max(
    target?.next_check ?? 0,
    data.control.web_until,
    checkTime.open ? 0 : checkTime.opensAt
  )
  const hasFilter = Boolean(activeMember || needle)

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            <span>关注成员</span>
            <button
              type="button"
              onClick={() => setStatusDialogOpen(true)}
              className="inline-flex items-center rounded-md transition-opacity hover:opacity-80"
              title="查看检查进度与详情"
            >
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </button>
          </span>
        }
        description={
          lastSyncedAt > 0
            ? `${members ? `${format(members.length)} 位成员 · ` : ''}最近同步 ${shortTime(lastSyncedAt)}`
            : '关注成员发布新主题时推送提醒。'
        }
        actions={
          <>
            <div className="flex h-8 items-center gap-2 rounded-md border bg-card px-3">
              <Label
                htmlFor="following-switch"
                className="cursor-pointer text-xs font-medium"
              >
                新帖提醒
              </Label>
              <Switch
                id="following-switch"
                checked={followingEnabled}
                disabled={busy || !available}
                onCheckedChange={(enabled) =>
                  void change('set_following', { enabled })
                }
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !available ||
                !config?.capable_recipient_count ||
                Boolean(state.blocked)
              }
              onClick={() => void refresh.run()}
            >
              <RefreshCw
                className={cn('size-3.5', refresh.running && 'animate-spin')}
              />
              获取最新
            </Button>
            <Button size="sm" variant="ghost" asChild className="hidden sm:inline-flex">
              <a
                href="https://www.v2ex.com/?tab=members"
                target="_blank"
                rel="noreferrer"
              >
                V2EX
                <ArrowUpRight className="size-3.5" />
              </a>
            </Button>
          </>
        }
      />

      {refresh.progress && !refresh.progress.complete && (
        <Alert>
          <AlertTitle>
            {refresh.running ? '正在获取成员最新动态…' : '本轮获取尚未完成'}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              还有 {format(refresh.progress.remaining)} 项待完成
              {refresh.progress.retry_at > now
                ? `，可于 ${time(refresh.progress.retry_at)} 后继续。`
                : '。'}
            </span>
            {!refresh.running && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !available}
                onClick={() =>
                  void refresh.run({ started_at: refresh.progress!.started_at })
                }
              >
                继续获取
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {refresh.notice && (
        <Alert>
          <AlertTitle>{refresh.notice}</AlertTitle>
        </Alert>
      )}
      {watch.error && (
        <Alert variant="destructive">
          <AlertTitle>关注服务异常</AlertTitle>
          <AlertDescription>{watch.error}</AlertDescription>
        </Alert>
      )}
      {target?.error && (
        <Alert variant="destructive">
          <AlertTitle>检查暂未完成</AlertTitle>
          <AlertDescription>{target.error}</AlertDescription>
        </Alert>
      )}
      {target?.member_feed_error && (
        <Alert>
          <AlertTitle>
            {feed ? '动态暂未更新，显示上次缓存' : '成员动态暂未获取'}
          </AlertTitle>
          <AlertDescription>{target.member_feed_error}</AlertDescription>
        </Alert>
      )}
      {!available ? (
        <Alert>
          <AlertTitle>关注功能尚未就绪</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>请先完成账号验证与 App 配对。</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => (window.location.hash = 'settings-devices')}
            >
              前往设置
            </Button>
          </AlertDescription>
        </Alert>
      ) : state.blocked ? (
        <Alert variant="destructive">
          <AlertTitle>检查已暂停</AlertTitle>
          <AlertDescription>
            账号或配对存在异常，请前往设置处理后自动恢复。
          </AlertDescription>
        </Alert>
      ) : !watchCapable ? (
        <Alert>
          <AlertTitle>等待接收设备，定时同步已暂停</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {config?.recipient_count
                ? `已连接 ${format(config.recipient_count)} 台接收设备，但暂无支持关注提醒的 iOS/iPadOS 设备；恢复前不会定时同步关注名单与新帖。`
                : '当前有效推送接收设备为 0 台（可能是 App 已注销推送、重装或切换构建环境），关注名单与新帖监测已暂停。请在 V2Echo App 中确认开启 Pro 个人远程提醒后同步状态。'}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void action('/notifier/watch/sync', 'POST')}
              >
                <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
                同步连接状态
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => (window.location.hash = 'settings-devices')}
              >
                设备配对
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Interactive Followed Members Filter Strip */}
      {members && members.length > 0 && (
        <div
          role="group"
          aria-label="按关注成员筛选"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            onClick={() => {
              setSelectedMember(null)
              setPageIndex(0)
            }}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
              activeMember === null
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Users className="size-3.5" aria-hidden="true" />
            <span>全部成员</span>
            {feed && (
              <span
                className={cn(
                  'tabular-nums',
                  activeMember === null
                    ? 'text-primary-foreground/80'
                    : 'text-muted-foreground'
                )}
              >
                {feed.topics.length}
              </span>
            )}
          </button>
          {members.map((member) => {
            const key = member.username.toLowerCase()
            const activePill = activeMember?.toLowerCase() === key
            const count = memberPostCounts.get(key) ?? 0
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedMember(activePill ? null : member.username)
                  setPageIndex(0)
                }}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border ps-1.5 pe-3 text-xs font-medium transition-colors',
                  activePill
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-card text-foreground hover:bg-accent'
                )}
              >
                <UserAvatar
                  src={member.avatar_url}
                  name={member.username}
                  className="size-5 rounded-full"
                />
                <span>{member.username}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      'tabular-nums',
                      activePill
                        ? 'text-primary-foreground/80'
                        : 'text-muted-foreground'
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Search & Count Toolbar */}
      {feed && feed.topics.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            aria-label="搜索成员发布的帖子"
            placeholder="搜索标题、作者或节点…"
            className="h-8 w-full sm:w-64"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPageIndex(0)
            }}
          />
          {hasFilter && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
              onClick={() => {
                setSelectedMember(null)
                setQuery('')
                setPageIndex(0)
              }}
            >
              重置筛选
              <X className="size-3.5" />
            </Button>
          )}
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {hasFilter
              ? `匹配 ${format(filteredTopics.length)} / ${format(feed.topics.length)} 篇`
              : `共 ${format(feed.topics.length)} 篇帖子`}
          </span>
        </div>
      )}

      {/* Member Feed DataTable */}
      <div className="overflow-hidden rounded-lg border bg-card">
        {!feed ? (
          <div className="p-4">
            <EmptyState
              icon={<Users className="size-5" />}
              title="尚未获取成员动态"
              action={
                available && (
                  <Button
                    size="sm"
                    disabled={busy || !config?.capable_recipient_count}
                    onClick={() => void refresh.run()}
                  >
                    获取最新数据
                  </Button>
                )
              }
            >
              {followingEnabled
                ? '下一次关注检查会自动同步成员名单与最新发帖。'
                : '开启右上角「新帖提醒」后，助手会同步 V2EX 关注名单与动态。'}
            </EmptyState>
          </div>
        ) : !filteredTopics.length ? (
          <div className="p-4">
            <EmptyState
              icon={<MessageSquare className="size-5" />}
              title={hasFilter ? '没有匹配的帖子' : '近期暂无成员发帖'}
              action={
                hasFilter && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedMember(null)
                      setQuery('')
                      setPageIndex(0)
                    }}
                  >
                    显示全部帖子
                  </Button>
                )
              }
            >
              {hasFilter
                ? '尝试切换成员或清空搜索关键词。'
                : '关注成员发布新主题后会显示在这里。'}
            </EmptyState>
          </div>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="ps-4">帖子</TableHead>
                <TableHead className="hidden w-36 md:table-cell">节点</TableHead>
                <TableHead className="w-16 pe-4 text-end sm:w-20 sm:pe-2">
                  回复
                </TableHead>
                <TableHead className="hidden w-24 pe-4 text-end sm:table-cell">
                  追评
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedTopics.map((topic) => {
                const isWatched = watchedIds.has(topic.id)
                const isAdding = watchingTopicId === topic.id
                return (
                  <TableRow key={topic.id} className="group">
                    <TableCell className="py-3 ps-4 whitespace-normal">
                      <div className="flex items-start gap-3">
                        <UserAvatar
                          src={topic.avatar_url}
                          name={topic.author}
                        />
                        <div className="min-w-0 flex-1">
                          <a
                            href={`https://www.v2ex.com/t/${topic.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="line-clamp-2 text-sm font-medium leading-snug underline-offset-4 hover:underline"
                          >
                            {topic.title}
                          </a>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                            <a
                              href={`https://www.v2ex.com/member/${encodeURIComponent(topic.author)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-foreground hover:underline"
                            >
                              @{topic.author}
                            </a>
                            {topic.node_title && (
                              <span className="md:hidden">
                                · {topic.node_title}
                              </span>
                            )}
                            <span className="sm:hidden">
                              {isWatched ? (
                                <a
                                  href="#watched-topics"
                                  className="inline-flex items-center gap-0.5 font-medium text-emerald-600 dark:text-emerald-400"
                                >
                                  · 已追评
                                </a>
                              ) : (
                                <button
                                  type="button"
                                  disabled={
                                    busy || !available || topicsFull || isAdding
                                  }
                                  onClick={() => void quickWatchTopic(topic.id)}
                                  className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline disabled:opacity-50"
                                >
                                  · {isAdding ? '添加中' : '+ 追评'}
                                </button>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {topic.node_title ? (
                        <Badge
                          variant="secondary"
                          className="max-w-full truncate font-normal"
                        >
                          {topic.node_title}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="pe-4 text-end text-sm text-muted-foreground tabular-nums sm:pe-2">
                      {format(topic.reply_count)}
                    </TableCell>
                    <TableCell className="hidden pe-4 text-end sm:table-cell">
                      {isWatched ? (
                        <a
                          href="#watched-topics"
                          className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                        >
                          <BookmarkCheck className="size-3.5" />
                          已追评
                        </a>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="-me-2 h-7 px-2 text-xs text-muted-foreground opacity-80 transition-opacity hover:text-foreground group-hover:opacity-100"
                          disabled={busy || !available || topicsFull || isAdding}
                          title={
                            topicsFull
                              ? `关注帖子已达上限（${MAX_WATCH_TOPICS} 篇）`
                              : '加入关注帖子，追踪新回复'
                          }
                          onClick={() => void quickWatchTopic(topic.id)}
                        >
                          <BookmarkPlus className="size-3.5" />
                          {isAdding ? '添加中' : '追评'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination Footer (shadcn-admin DataTable style) */}
      {filteredTopics.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>每页</span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value))
                setPageIndex(0)
              }}
            >
              <SelectTrigger
                className="h-8 w-16 text-xs"
                aria-label="每页显示条数"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span>条</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              第 {safePage + 1} / {totalPages} 页
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2.5"
                disabled={safePage === 0}
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="size-4" />
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2.5"
                disabled={safePage >= totalPages - 1}
                onClick={() =>
                  setPageIndex((p) => Math.min(totalPages - 1, p + 1))
                }
              >
                下一页
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Check Status & Member Directory Dialog */}
      <Dialog open={statusDialogOpen} onOpenChange={setStatusDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>关注成员监测状态</span>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </DialogTitle>
            <DialogDescription>
              自动同步你的 V2EX 关注名单并检测新发布的主题。
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">最近检查</dt>
            <dd className="tabular-nums">
              {target?.last_checked
                ? `${time(target.last_checked)}（${relativeTime(target.last_checked, now)}）`
                : '尚未检查'}
            </dd>
            {followingEnabled && Boolean(state.enabled) && !state.blocked && (
              <>
                <dt className="text-muted-foreground">下次计划</dt>
                <dd className="tabular-nums">
                  {!watchCapable
                    ? '已暂停（等待有效接收设备）'
                    : nextCheck > now
                      ? time(nextCheck)
                      : '等待本轮调度'}
                </dd>
              </>
            )}
            {config && (
              <>
                <dt className="text-muted-foreground">接收设备</dt>
                <dd className="tabular-nums">
                  支持关注 {format(config.capable_recipient_count)} / 有效{' '}
                  {format(config.recipient_count)} 台
                </dd>
              </>
            )}
            {Boolean(target?.members_observed_at) && (
              <>
                <dt className="text-muted-foreground">名单同步</dt>
                <dd className="tabular-nums">
                  {time(target!.members_observed_at!)}
                </dd>
              </>
            )}
            {target?.progress && (
              <>
                <dt className="text-muted-foreground">当前进度</dt>
                <dd className="tabular-nums">
                  {target.progress.kind === 'candidates'
                    ? `待核验 ${format(target.progress.pending_topics)} 篇`
                    : `已读取 ${format(target.progress.completed_pages)} / ${format(target.progress.total_pages)} 页`}
                </dd>
              </>
            )}
          </dl>
          {members && members.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  已关注成员（{format(members.length)} 人）
                </p>
                <a
                  href="https://www.v2ex.com/my/following"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  在 V2EX 查看
                  <ArrowUpRight className="size-3" />
                </a>
              </div>
              <div className="flex flex-wrap gap-2">
                {members.map((member) => (
                  <a
                    key={member.username.toLowerCase()}
                    href={`https://www.v2ex.com/member/${encodeURIComponent(member.username)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
                  >
                    <UserAvatar
                      src={member.avatar_url}
                      name={member.username}
                      className="size-4 rounded-full"
                    />
                    <span>{member.username}</span>
                    <ArrowUpRight className="size-3 text-muted-foreground" />
                  </a>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStatusDialogOpen(false)}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
