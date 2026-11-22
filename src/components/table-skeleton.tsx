import { Skeleton } from '@/components/ui/skeleton'

export function TableSkeleton({
  rows = 6,
  withAvatar = false,
}: {
  rows?: number
  withAvatar?: boolean
}) {
  return (
    <div className="divide-y" aria-busy="true" aria-label="正在加载列表">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-4 px-4 py-3.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {withAvatar && <Skeleton className="size-8 shrink-0 rounded-lg" />}
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton
                className="h-4"
                style={{ width: `${55 + ((index * 17) % 30)}%` }}
              />
              <Skeleton
                className="h-3"
                style={{ width: `${30 + ((index * 13) % 25)}%` }}
              />
            </div>
          </div>
          <Skeleton className="hidden h-5 w-16 rounded-md sm:block" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
        </div>
      ))}
    </div>
  )
}
