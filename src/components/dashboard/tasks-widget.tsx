'use client'

import Link from 'next/link'
import { ListTodo } from 'lucide-react'
import type { TasksDueSummary } from '@/lib/dashboard/types'
import { useTranslation } from '@/lib/i18n/use-translation'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface TasksWidgetProps {
  data: TasksDueSummary | null
  loading: boolean
}

/**
 * Dashboard "Follow-ups" widget — the top due/overdue tasks across
 * every contact, so a rep can see what needs a call today without
 * opening each contact one by one. Mirrors `ActivityFeed`'s
 * header+list shape.
 */
export function TasksWidget({ data, loading }: TasksWidgetProps) {
  const { t, locale } = useTranslation()
  const hasItems = (data?.items.length ?? 0) > 0

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('dashboard.tasksWidget.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('dashboard.tasksWidget.subtitle')}</p>
        </div>
        {data && (data.overdueCount > 0 || data.dueTodayCount > 0) && (
          <div className="flex items-center gap-2 text-xs">
            {data.overdueCount > 0 && (
              <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-medium text-red-400 tabular-nums">
                {t('dashboard.tasksWidget.overdueCount', { count: data.overdueCount })}
              </span>
            )}
            {data.dueTodayCount > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300 tabular-nums">
                {t('dashboard.tasksWidget.dueTodayCount', { count: data.dueTodayCount })}
              </span>
            )}
          </div>
        )}
      </header>

      {loading || !data ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !hasItems ? (
        <div className="p-5">
          <EmptyState
            icon={ListTodo}
            title={t('dashboard.tasksWidget.emptyTitle')}
            hint={t('dashboard.tasksWidget.emptyHint')}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {data.items.map((item) => {
            const dueLabel = new Date(item.dueAt).toLocaleDateString(
              locale === 'pt-BR' ? 'pt-BR' : 'en-US',
              { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
            )
            const row = (
              <div className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.contactName ?? dueLabel}
                    {item.contactName ? ` · ${dueLabel}` : ''}
                  </p>
                </div>
                {item.overdue && (
                  <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                    {t('dashboard.tasksWidget.overdueBadge')}
                  </span>
                )}
              </div>
            )
            return (
              <li key={item.id}>
                {item.contactId ? (
                  <Link href="/contacts" className="block transition-colors hover:bg-muted/40">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
