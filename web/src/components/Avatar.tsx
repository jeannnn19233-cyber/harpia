import type { User } from '../../../shared/types.ts'
import { initials, userColor } from '../lib/format.ts'

export function Avatar({ user, size = 'md', online }: { user: User | undefined; size?: 'sm' | 'md'; online?: boolean }) {
  const dimension = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs'
  if (!user) {
    return <span className={`${dimension} inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-700`}>?</span>
  }
  return (
    <span className="relative inline-flex shrink-0" title={user.name}>
      <span
        className={`${dimension} ${userColor(user.id)} inline-flex items-center justify-center rounded-full font-semibold text-white`}
      >
        {initials(user.name)}
      </span>
      {online !== undefined && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-950 ${
            online ? 'bg-emerald-400' : 'bg-zinc-600'
          }`}
        />
      )}
    </span>
  )
}
