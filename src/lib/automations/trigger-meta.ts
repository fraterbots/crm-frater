import type { AutomationTriggerType } from '@/types'
import type { TranslationKey } from '@/lib/i18n/dictionaries'
import type { Locale } from '@/lib/i18n/locales'

export interface TriggerMeta {
  /** Translation key for the pill label — set for every known trigger type. */
  labelKey?: TranslationKey
  /** Raw fallback label — only set when the trigger type isn't recognized. */
  label?: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    labelKey: 'automations.page.triggerNewMessage',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    labelKey: 'automations.page.triggerFirstMessage',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    labelKey: 'automations.page.triggerKeywordMatch',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    labelKey: 'automations.page.triggerNewContact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    labelKey: 'automations.page.triggerConversationAssigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    labelKey: 'automations.page.triggerTagAdded',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    labelKey: 'automations.page.triggerTimeBased',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export function formatRelative(
  iso: string | null | undefined,
  t: Translate,
  locale: Locale,
): string {
  if (!iso) return t('automations.relative.never')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('automations.relative.never')
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('automations.relative.justNow')
  if (diffSec < 3600) return t('automations.relative.minutesAgo', { count: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('automations.relative.hoursAgo', { count: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('automations.relative.daysAgo', { count: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString(locale === 'pt-BR' ? 'pt-BR' : 'en-US')
}
