import {
  AtSign,
  HeartHandshake,
  MessageSquare,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type NotificationCategory = {
  label: string
  icon: LucideIcon
  className: string
}

const categories = {
  reply: {
    label: '回复',
    icon: MessageSquare,
    className:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  },
  mention: {
    label: '提及',
    icon: AtSign,
    className:
      'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300',
  },
  thanks: {
    label: '感谢',
    icon: HeartHandshake,
    className:
      'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300',
  },
  favorite: {
    label: '收藏',
    icon: Star,
    className:
      'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900/60 dark:bg-teal-950/40 dark:text-teal-300',
  },
} satisfies Record<string, NotificationCategory>

function notificationCategory(kind: string): NotificationCategory | null {
  switch (kind) {
    case 'reply':
      return categories.reply
    case 'mention':
      return categories.mention
    case 'thanks_topic':
    case 'thanks_reply':
      return categories.thanks
    case 'favorite':
      return categories.favorite
    default:
      return null
  }
}

export function NotificationCategoryBadge({ kind }: { kind: string }) {
  const category = notificationCategory(kind)
  if (!category) return <span className="text-xs text-muted-foreground">—</span>
  const Icon = category.icon
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        category.className
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {category.label}
    </span>
  )
}
