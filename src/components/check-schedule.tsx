import {
  CHECK_INTERVAL_OPTIONS,
  checkHourLabel,
  validCheckHours,
  validCheckIntervals,
  type CheckPolicy,
} from '../../shared/check-schedule'
import { useStore } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const startHours = Array.from({ length: 24 }, (_, value) => ({
  value: String(value),
  label: checkHourLabel(value),
}))
const endHours = Array.from({ length: 24 }, (_, index) => ({
  value: String(index + 1),
  label: checkHourLabel(index + 1),
}))

const windowPresets = [
  { label: '全天 00–24', start: 0, end: 24 },
  { label: '日间 08–24', start: 8, end: 24 },
  { label: '常规 09–22', start: 9, end: 22 },
]

const intervalFields = [
  {
    key: 'scan_interval_minutes',
    label: '未读消息',
    options: CHECK_INTERVAL_OPTIONS.scan,
  },
  {
    key: 'following_interval_minutes',
    label: '成员新帖',
    options: CHECK_INTERVAL_OPTIONS.following,
  },
  {
    key: 'topic_interval_minutes',
    label: '帖子评论',
    options: CHECK_INTERVAL_OPTIONS.topic,
  },
] as const

export function CheckSchedule({
  draft,
  onChange,
}: {
  draft: Partial<CheckPolicy>
  onChange: (draft: Partial<CheckPolicy>) => void
}) {
  const s = useStore((state) => state.data!.notifier)
  const busy = useStore((state) => state.busy)
  const policy = { ...s, ...draft }
  const start = policy.check_start_hour
  const end = policy.check_end_hour
  const validHours = validCheckHours(start, end)
  const valid =
    validHours &&
    validCheckIntervals(
      policy.scan_interval_minutes,
      policy.following_interval_minutes,
      policy.topic_interval_minutes
    )

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-sm font-medium">每日运行时段</Label>
          <div className="flex flex-wrap gap-1.5">
            {windowPresets.map((preset) => {
              const active = start === preset.start && end === preset.end
              return (
                <Button
                  key={preset.label}
                  type="button"
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  className="h-7 px-2 text-xs tabular-nums"
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      ...draft,
                      check_start_hour: preset.start,
                      check_end_hour: preset.end,
                    })
                  }
                >
                  {preset.label}
                </Button>
              )
            })}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label
              htmlFor="check-start-hour"
              className="text-xs text-muted-foreground"
            >
              开始时刻
            </Label>
            <Select
              value={String(start)}
              disabled={busy}
              onValueChange={(value) =>
                onChange({ ...draft, check_start_hour: Number(value) })
              }
            >
              <SelectTrigger id="check-start-hour" aria-label="开始时刻" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {startHours.map((hour) => (
                  <SelectItem key={hour.value} value={hour.value}>
                    {hour.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="check-end-hour"
              className="text-xs text-muted-foreground"
            >
              结束时刻
            </Label>
            <Select
              value={String(end)}
              disabled={busy}
              onValueChange={(value) =>
                onChange({ ...draft, check_end_hour: Number(value) })
              }
            >
              <SelectTrigger
                id="check-end-hour"
                aria-label="结束时刻"
                aria-invalid={!validHours || undefined}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {endHours.map((hour) => (
                  <SelectItem key={hour.value} value={hour.value}>
                    {hour.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!validHours ? (
          <p className="text-xs text-destructive" role="alert">
            开始与结束时刻不能相同，全天检查请选择 00:00–24:00。
          </p>
        ) : start > end ? (
          <p className="text-xs text-muted-foreground">
            结束时刻早于开始时刻，表示跨午夜运行至次日 {checkHourLabel(end)}。
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <div>
          <Label className="text-sm font-medium">常规检查间隔</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            帖子无新增时自动降频，遇到限流或异常时自动退避。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {intervalFields.map(({ key, label, options }) => (
            <div key={key} className="grid gap-1.5">
              <Label
                htmlFor={`interval-${key}`}
                className="text-xs text-muted-foreground"
              >
                {label}
              </Label>
              <Select
                value={String(policy[key])}
                disabled={busy}
                onValueChange={(value) =>
                  onChange({ ...draft, [key]: Number(value) })
                }
              >
                <SelectTrigger
                  id={`interval-${key}`}
                  aria-label={label}
                  aria-invalid={!valid || undefined}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      每 {minutes} 分钟
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
