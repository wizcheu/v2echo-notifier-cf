import { format, time } from '@/lib/api'

export { format, time }

export function shortTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function relativeTime(
  timestamp: number | null | undefined,
  now = Date.now()
): string {
  if (!timestamp) return '尚未检查'
  const diff = now - timestamp
  if (diff < 0) return shortTime(timestamp)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return shortTime(timestamp)
}

export function initials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'V2'
  return /^[一-鿿]/.test(trimmed)
    ? trimmed.slice(0, 1)
    : trimmed.replace(/^@/, '').slice(0, 2).toUpperCase()
}
