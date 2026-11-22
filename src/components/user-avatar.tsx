import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { initials } from '@/lib/format'
import { cn } from '@/lib/utils'

export function UserAvatar({
  src,
  name,
  className,
}: {
  src?: string
  name: string
  className?: string
}) {
  return (
    <Avatar className={cn('size-8 rounded-lg', className)}>
      {src && <AvatarImage src={src} alt={name} />}
      <AvatarFallback className="rounded-lg text-xs">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}
