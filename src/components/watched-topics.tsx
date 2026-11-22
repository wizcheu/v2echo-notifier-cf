import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  Bookmark,
  Info,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { format, time, useStore } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { useBatchRefresh } from '@/lib/use-batch-refresh'
import { cn } from '@/lib/utils'
import {
  MAX_WATCH_TOPICS,
  type WatchRefreshResult,
  type WatchRule,
  type WatchTarget,
} from '../../shared/watch-contracts'
import type { NotifierState } from '../../shared/contracts'
import { checkWindow } from '../../shared/check-schedule'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { UserAvatar } from '@/components/user-avatar'
import { ConfirmDialog } from '@/components/confirm-dialog'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function targetStatus(
  state: NotifierState,
  target: WatchTarget | undefined,
  enabled: boolean,
  now: number
): { label: string; tone: StatusTone } {
  if (!enabled) return { label: '已暂停', tone: 'neutral' }
  if (!state.enabled) return { label: '服务已暂停', tone: 'neutral' }
  if (state.blocked) return { label: '账号异常', tone: 'danger' }
  if (!state.watches.config?.capable_recipient_count)
    return { label: '待接收设备', tone: 'warning' }
  if (target?.error) return { label: '检查异常', tone: 'danger' }
  if (!checkWindow(now, state).open)
    return { label: '静默时段', tone: 'neutral' }
  if (target?.checking)
    return {
      label: target.last_checked ? '分页检查中' : '建立基线中',
      tone: 'info',
    }
  return target?.last_checked
    ? { label: '监测中', tone: 'success' }
    : { label: '待首次检查', tone: 'neutral' }
}

function parseTopicID(input: string): number | null {
  const value = input.trim()
  if (!value) return null
  let digits = value
  if (!/^\d+$/.test(value)) {
    try {
      const url = new URL(value)
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        !['v2ex.com', 'www.v2ex.com'].includes(url.hostname)
      )
        return null
      digits = /^\/t\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1] ?? ''
    } catch {
      return null
    }
  }
  const id = Number(digits)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export default function WatchedTopics() {
  const data = useStore((store) => store.data!)
  const state = data.notifier
  const now = data.now
  const busy = useStore((store) => store.busy)
  const action = useStore((store) => store.action)

  const [addOpen, setAddOpen] = useState(false)
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState('')
  const [query, setQuery] = useState('')
  const [removing, setRemoving] = useState<number | null>(null)
  const [inspectRule, setInspectRule] = useState<WatchRule | null>(null)

  const refresh = useBatchRefresh<WatchRefreshResult>(
    '/notifier/watch/refresh',
    (progress) => ({ started_at: progress.started_at })
  )

  const watch = state.watches
  const config = watch.config
  const available = Boolean(
    watch.direct_ready &&
      config &&
      state.binding_id &&
      state.storage_ready &&
      state.blocked !== 'pairing'
  )
  const topics = useMemo(() => config?.topics ?? [], [config?.topics])
  const full = topics.length >= MAX_WATCH_TOPICS
  const parsedPreview = parseTopicID(input)

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

  async function submitAdd() {
    if (busy || !available || full) return
    const id = parseTopicID(input)
    if (!id) {
      setInputError('请输入有效的主题编号或 v2ex.com/t/… 链接')
      return
    }
    if (topics.some((t) => t.topic_id === id)) {
      setInputError(`主题 #${id} 已在关注列表中`)
      return
    }
    setInputError('')
    const ok = await change('add_topic', { topic_id: id })
    if (ok) {
      setInput('')
      setAddOpen(false)
    }
  }

  const targetMap = useMemo(
    () => new Map(watch.targets.map((target) => [target.topic_id, target])),
    [watch.targets]
  )

  const needle = query.trim().toLowerCase()
  const filteredTopics = useMemo(
    () =>
      topics.filter((rule) => {
        if (!needle) return true
        const target = targetMap.get(rule.topic_id)
        const haystack =
          `${rule.topic_id} ${target?.title ?? ''} ${target?.author ?? ''}`.toLowerCase()
        return haystack.includes(needle)
      }),
    [topics, targetMap, needle]
  )

  const unavailableMessage = !state.storage_ready
    ? '请先在设置中完成加密存储配置。'
    : !state.binding_id || state.blocked === 'pairing'
      ? '请先在「设备配对」中连接 App。'
      : '正在同步关注规则，请稍后刷新。'

  const inspectedTarget = inspectRule
    ? targetMap.get(inspectRule.topic_id)
    : undefined
  const checkTime = checkWindow(now, state)
  const inspectedNextCheck = inspectedTarget
    ? Math.max(
        inspectedTarget.next_check ?? 0,
        data.control.web_until,
        checkTime.open ? 0 : checkTime.opensAt
      )
    : 0

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <span>关注帖子</span>
            <Badge variant="secondary" className="font-normal tabular-nums">
              {topics.length} / {MAX_WATCH_TOPICS}
            </Badge>
          </span>
        }
        description="追踪主题的新评论，有新回复时推送提醒。"
        actions={
          <>
            {refresh.progress &&
              !refresh.progress.complete &&
              !refresh.running && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !available}
                  onClick={() =>
                    void refresh.run({
                      started_at: refresh.progress!.started_at,
                    })
                  }
                >
                  继续获取
                </Button>
              )}
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
              刷新检查
            </Button>
            <Button
              size="sm"
              disabled={busy || !available || full}
              onClick={() => {
                setInput('')
                setInputError('')
                setAddOpen(true)
              }}
            >
              <Plus className="size-3.5" />
              添加帖子
            </Button>
          </>
        }
      />

      {refresh.progress && !refresh.progress.complete && (
        <Alert>
          <AlertTitle>
            {refresh.running ? '正在检查关注帖子…' : '本轮检查尚未全部完成'}
          </AlertTitle>
          <AlertDescription>
            还有 {format(refresh.progress.remaining)} 项待完成
            {refresh.progress.retry_at > now
              ? `，可于 ${time(refresh.progress.retry_at)} 后继续。`
              : '。'}
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
      {!available ? (
        <Alert>
          <AlertTitle>关注功能尚未就绪</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{unavailableMessage}</span>
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
      ) : !config?.capable_recipient_count ? (
        <Alert>
          <AlertTitle>等待接收设备</AlertTitle>
          <AlertDescription>
            请在 V2Echo App 中启用有效的 Pro 个人远程提醒。
          </AlertDescription>
        </Alert>
      ) : null}

      {topics.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            aria-label="筛选关注帖子"
            placeholder="搜索标题、作者或编号…"
            className="h-8 w-full sm:w-64"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {needle && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
              onClick={() => setQuery('')}
            >
              重置
              <X className="size-3.5" />
            </Button>
          )}
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {needle
              ? `匹配 ${format(filteredTopics.length)} / ${format(topics.length)} 篇`
              : `共 ${format(topics.length)} 篇`}
          </span>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        {!topics.length ? (
          <div className="p-4">
            <EmptyState
              icon={<Bookmark className="size-5" />}
              title="还没有关注的帖子"
              action={
                <Button
                  size="sm"
                  disabled={busy || !available}
                  onClick={() => {
                    setInput('')
                    setInputError('')
                    setAddOpen(true)
                  }}
                >
                  <Plus className="size-3.5" />
                  添加第一个帖子
                </Button>
              }
            >
              粘贴 V2EX 主题链接或编号，有新回复时自动推送；也可在「关注成员」中一键追评。
            </EmptyState>
          </div>
        ) : !filteredTopics.length ? (
          <div className="p-4">
            <EmptyState
              icon={<Bookmark className="size-5" />}
              title="没有匹配的帖子"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setQuery('')}
                >
                  清空搜索
                </Button>
              }
            >
              尝试其他关键词或主题编号。
            </EmptyState>
          </div>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="ps-4">帖子</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="hidden w-32 text-end md:table-cell">
                  最近检查
                </TableHead>
                <TableHead className="w-24 pe-4 text-end">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTopics.map((rule) => {
                const target = targetMap.get(rule.topic_id)
                const title = target?.title || `主题 #${rule.topic_id}`
                const status = targetStatus(state, target, rule.enabled, now)
                return (
                  <TableRow key={rule.topic_id}>
                    <TableCell className="py-3 ps-4 whitespace-normal">
                      <div className="flex items-start gap-3">
                        <UserAvatar
                          src={target?.avatar_url || undefined}
                          name={target?.author || 'V2EX'}
                        />
                        <div className="min-w-0 flex-1">
                          <a
                            href={`https://www.v2ex.com/t/${rule.topic_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-baseline gap-1 font-medium underline-offset-4 hover:underline"
                          >
                            <span className="line-clamp-2">{title}</span>
                          </a>
                          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                            {target?.author ? `@${target.author} · ` : ''}#
                            {rule.topic_id}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setInspectRule(rule)}
                        className="inline-flex items-center rounded-md transition-opacity hover:opacity-80"
                        title="查看检查进度与详情"
                      >
                        <StatusBadge tone={status.tone}>
                          {status.label}
                        </StatusBadge>
                      </button>
                    </TableCell>
                    <TableCell className="hidden text-end text-xs text-muted-foreground tabular-nums md:table-cell">
                      {relativeTime(target?.last_checked, now)}
                    </TableCell>
                    <TableCell className="pe-4 text-end">
                      <div className="inline-flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground"
                          aria-label={`查看 ${title} 检查详情`}
                          onClick={() => setInspectRule(rule)}
                        >
                          <Info className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          aria-label={`移除提醒：${title}`}
                          disabled={busy || !available}
                          onClick={() => setRemoving(rule.topic_id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {topics.some((rule) => !rule.enabled) && (
        <p className="text-xs text-muted-foreground">
          已暂停的帖子仍占名额，移除后重新添加即可恢复追踪。
        </p>
      )}

      {/* Add Topic Dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!busy) setAddOpen(next)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加关注帖子</DialogTitle>
            <DialogDescription>
              粘贴 V2EX 主题链接或编号，新回复将推送到已配对设备。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAdd()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="watch-topic-input">主题链接或编号</Label>
              <Input
                id="watch-topic-input"
                placeholder="例如 1082450 或 https://www.v2ex.com/t/1082450"
                value={input}
                autoFocus
                disabled={busy}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(inputError)}
                onChange={(event) => {
                  setInput(event.target.value)
                  setInputError('')
                }}
              />
              {inputError ? (
                <p className="text-xs text-destructive" role="alert">
                  {inputError}
                </p>
              ) : parsedPreview ? (
                <p className="text-xs text-muted-foreground tabular-nums">
                  识别为主题 #{parsedPreview} · 当前剩余{' '}
                  {MAX_WATCH_TOPICS - topics.length} 个名额
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setAddOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={busy || !available || full || !input.trim()}
              >
                添加提醒
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Inspect Target Dialog */}
      <Dialog
        open={inspectRule !== null}
        onOpenChange={(open) => {
          if (!open) setInspectRule(null)
        }}
      >
        {inspectRule && (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="leading-snug">
                {inspectedTarget?.title || `主题 #${inspectRule.topic_id}`}
              </DialogTitle>
              <DialogDescription>
                {inspectedTarget?.author
                  ? `@${inspectedTarget.author} · `
                  : ''}
                主题 #{inspectRule.topic_id}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              {inspectedTarget?.error && (
                <Alert variant="destructive">
                  <AlertTitle>最近检查异常</AlertTitle>
                  <AlertDescription>{inspectedTarget.error}</AlertDescription>
                </Alert>
              )}
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">状态</dt>
                <dd>
                  {(() => {
                    const status = targetStatus(
                      state,
                      inspectedTarget,
                      inspectRule.enabled,
                      now
                    )
                    return (
                      <StatusBadge tone={status.tone}>
                        {status.label}
                      </StatusBadge>
                    )
                  })()}
                </dd>
                <dt className="text-muted-foreground">最近检查</dt>
                <dd className="tabular-nums">
                  {inspectedTarget?.last_checked
                    ? time(inspectedTarget.last_checked)
                    : '尚未检查（首次仅建立基线）'}
                </dd>
                {inspectRule.enabled &&
                  Boolean(state.enabled) &&
                  !state.blocked && (
                    <>
                      <dt className="text-muted-foreground">下次计划</dt>
                      <dd className="tabular-nums">
                        {inspectedNextCheck > now
                          ? time(inspectedNextCheck)
                          : '等待本轮调度'}
                      </dd>
                    </>
                  )}
                {inspectedTarget?.progress && (
                  <>
                    <dt className="text-muted-foreground">检查进度</dt>
                    <dd className="tabular-nums">
                      {inspectedTarget.progress.kind === 'candidates'
                        ? `待核验 ${format(inspectedTarget.progress.pending_topics)} 篇`
                        : `已读取 ${format(inspectedTarget.progress.completed_pages)} / ${format(inspectedTarget.progress.total_pages)} 页`}
                    </dd>
                  </>
                )}
              </dl>
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="outline" size="sm" asChild>
                <a
                  href={`https://www.v2ex.com/t/${inspectRule.topic_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开原帖
                  <ArrowUpRight className="size-3.5" />
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setInspectRule(null)}
              >
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setRemoving(null)
        }}
        title="移除这篇帖子的提醒？"
        desc="移除后将停止追踪后续新评论，并释放 1 个关注名额。"
        confirmText="确认移除"
        destructive
        isLoading={busy || !available}
        handleConfirm={() => {
          if (removing !== null)
            void change('remove_topic', { topic_id: removing }).then((ok) => {
              if (ok) setRemoving(null)
            })
        }}
        className="sm:max-w-sm"
      />
    </div>
  )
}
