import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { NavGroupData, NavItem, NavSubItem } from './types'

export function NavGroup({
  title,
  items,
  hash,
}: NavGroupData & { hash: string }) {
  const { state, isMobile } = useSidebar()
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const key = `${item.title}-${item.href ?? ''}`
          if (!item.items)
            return <SidebarMenuLink key={key} item={item} hash={hash} />
          if (state === 'collapsed' && !isMobile)
            return (
              <SidebarMenuCollapsedDropdown key={key} item={item} hash={hash} />
            )
          return <SidebarMenuCollapsible key={key} item={item} hash={hash} />
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function NavBadge({
  children,
  title,
  variant = 'default',
}: {
  children: ReactNode
  title?: string
  variant?: 'default' | 'destructive'
}) {
  return (
    <Badge
      title={title}
      variant={variant === 'destructive' ? 'destructive' : 'secondary'}
      className={cn(
        'ms-auto h-5 min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px] tabular-nums'
      )}
    >
      {children}
    </Badge>
  )
}

function isActive(hash: string, item: NavItem | NavSubItem) {
  if ('match' in item && item.match) return item.match(hash)
  if ('href' in item && item.href) return item.href === hash
  return false
}

function isParentActive(hash: string, item: NavItem) {
  return item.items?.some((sub) => isActive(hash, sub)) ?? false
}

function SidebarMenuLink({ item, hash }: { item: NavItem; hash: string }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive(hash, item)}
        tooltip={item.title}
      >
        <a href={`#${item.href}`} onClick={() => setOpenMobile(false)}>
          {item.icon && <item.icon />}
          <span>{item.title}</span>
          {item.badge !== undefined && (
            <NavBadge title={item.badgeTitle} variant={item.badgeVariant}>
              {item.badge}
            </NavBadge>
          )}
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SidebarMenuCollapsible({
  item,
  hash,
}: {
  item: NavItem
  hash: string
}) {
  const { setOpenMobile } = useSidebar()
  const active = isParentActive(hash, item)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? active
  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={setUserOpen}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={active}>
            {item.icon && <item.icon />}
            <span>{item.title}</span>
            {item.badge !== undefined && (
              <NavBadge variant={item.badgeVariant}>{item.badge}</NavBadge>
            )}
            <ChevronRight className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 rtl:rotate-180" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="CollapsibleContent">
          <SidebarMenuSub>
            {item.items?.map((subItem) => (
              <SidebarMenuSubItem key={subItem.title}>
                <SidebarMenuSubButton asChild isActive={isActive(hash, subItem)}>
                  <a
                    href={`#${subItem.href}`}
                    onClick={() => setOpenMobile(false)}
                  >
                    {subItem.icon && <subItem.icon />}
                    <span>{subItem.title}</span>
                    {subItem.badge !== undefined && (
                      <NavBadge>{subItem.badge}</NavBadge>
                    )}
                  </a>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

function SidebarMenuCollapsedDropdown({
  item,
  hash,
}: {
  item: NavItem
  hash: string
}) {
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={item.title}
            isActive={isParentActive(hash, item)}
          >
            {item.icon && <item.icon />}
            <span>{item.title}</span>
            {item.badge !== undefined && (
              <NavBadge variant={item.badgeVariant}>{item.badge}</NavBadge>
            )}
            <ChevronRight className="ms-auto" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={4}>
          <DropdownMenuLabel>
            {item.title} {item.badge ? `(${item.badge})` : ''}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {item.items?.map((sub) => (
            <DropdownMenuItem key={`${sub.title}-${sub.href}`} asChild>
              <a
                href={`#${sub.href}`}
                className={isActive(hash, sub) ? 'bg-secondary' : ''}
              >
                {sub.icon && <sub.icon />}
                <span className="max-w-52 text-wrap">{sub.title}</span>
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
