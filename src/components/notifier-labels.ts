import type { NotificationRecord } from '../../shared/contracts'
import type { StatusTone } from '@/components/status-badge'

export const kinds: Record<string, string> = {
  reply: '回复',
  mention: '提及',
  thanks_topic: '主题感谢',
  thanks_reply: '回复感谢',
  favorite: '收藏',
  other: '未识别',
}

export const statuses: Record<string, string> = {
  pending: '等待发送',
  submitted: '服务端已收件',
  unclassified: '等待分类',
  apns_accepted: 'APNs 已接收',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
}

export const stages: Record<string, string> = {
  idle: '等待下轮检查',
  page: '读取通知分页',
  verify: '复查通知首屏',
  commit: '保存未读候选',
}

const watchTestLabels: Record<string, string> = {
  topic_reply: '关注帖子 · 单条评论',
  topic_replies: '关注帖子 · 多条评论',
  following_topic: '关注成员 · 新帖',
}

export function eventLabel(event: NotificationRecord): string {
  if (event.type === 'watch_update') return '关注更新'
  if (event.type === 'test') {
    const suffix = watchTestLabels[event.kind] ?? kinds[event.kind]
    return suffix ? `测试 · ${suffix}` : '测试通知'
  }
  return kinds[event.kind] ?? '未识别通知'
}

export function eventSourceLabel(event: NotificationRecord): string {
  if (event.type === 'test') return '测试通知'
  if (event.type === 'watch_update') return '关注动态'
  return '个人通知'
}

export function eventStatusMeta(event: NotificationRecord): {
  label: string
  tone: StatusTone
} {
  const label =
    event.status === 'pending' && event.attempts > 0
      ? '等待重试'
      : (statuses[event.status] ?? event.status)
  const tone: StatusTone =
    event.status === 'rejected' || event.status === 'expired'
      ? 'danger'
      : event.status === 'apns_accepted'
        ? 'success'
        : event.status === 'unclassified'
          ? 'warning'
          : 'neutral'
  return { label, tone }
}
