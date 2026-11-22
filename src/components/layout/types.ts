import type { LucideIcon } from 'lucide-react'

export type NavSubItem = {
  title: string
  href: string
  icon?: LucideIcon
  badge?: string | number
  match?: (hash: string) => boolean
}

export type NavItem = {
  title: string
  href?: string
  icon?: LucideIcon
  badge?: string | number
  badgeTitle?: string
  badgeVariant?: 'default' | 'destructive'
  items?: NavSubItem[]
  match?: (hash: string) => boolean
}

export type NavGroupData = {
  title: string
  items: NavItem[]
}
