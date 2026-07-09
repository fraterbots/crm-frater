'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n/use-translation';
import { LOCALES } from '@/lib/i18n/locales';
import { THEMES } from '@/lib/themes';
import { CURRENCIES } from '@/lib/currency';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { SECTION_META, type SettingsSection } from './settings-sections';
import { SettingsChip, StatusDot } from './settings-chip';
import { ROLE_META } from './role-meta';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  tags: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
  provider: 'meta_cloud' | 'evolution' | null;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { user, profile, accountId, accountRole, defaultCurrency, canManageMembers } =
    useAuth();
  const { mode, theme } = useTheme();
  const { locale, t } = useTranslation();

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  // WhatsApp status is tracked separately: its health check decrypts the
  // token and pings Meta, which is far slower than the cheap count
  // queries. Gating it independently keeps a slow/flaky Meta round-trip
  // from blanking the rest of the landing.
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(true);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const userId = user.id;
    const acctId = accountId;

    // Cheap counts — resolve fast, render immediately.
    (async () => {
      setCountsLoading(true);
      const [membersRes, invitesRes, templatesTotal, templatesPending, tagsRes, fieldsRes] =
        await Promise.allSettled([
          fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
          canManageMembers
            ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
                r.json(),
              )
            : Promise.resolve(null),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'PENDING'),
          supabase
            .from('tags')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase.from('custom_fields').select('id', { count: 'exact', head: true }),
        ]);

      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const pendingInvites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setCounts({
        members,
        pendingInvites,
        templates:
          templatesTotal.status === 'fulfilled'
            ? templatesTotal.value.count ?? null
            : null,
        templatesPending:
          templatesPending.status === 'fulfilled'
            ? templatesPending.value.count ?? null
            : null,
        tags: tagsRes.status === 'fulfilled' ? tagsRes.value.count ?? null : null,
        customFields:
          fieldsRes.status === 'fulfilled' ? fieldsRes.value.count ?? null : null,
      });
      setCountsLoading(false);
    })();

    // WhatsApp connection status — slower, independent. The health
    // endpoint depends on which provider the row is on (an 'evolution'
    // row has no access_token, so the Meta health-check would try to
    // decrypt null and error) — fetch the row first, then pick.
    (async () => {
      setWhatsappLoading(true);
      const row = await supabase
        .from('whatsapp_config')
        .select('phone_number_id, provider')
        .eq('account_id', acctId)
        .maybeSingle();
      if (cancelled) return;

      const provider = (row.data?.provider as 'meta_cloud' | 'evolution' | undefined) ?? null;
      const configured =
        provider === 'evolution' ? !!row.data : !!row.data?.phone_number_id;

      if (!configured) {
        setWhatsapp({ configured: false, connected: false, provider: null });
        setWhatsappLoading(false);
        return;
      }

      const healthUrl =
        provider === 'evolution' ? '/api/whatsapp/evolution/status' : '/api/whatsapp/config';
      const health = await fetch(healthUrl, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled) return;

      setWhatsapp({ configured: true, connected: !!health?.connected, provider });
      setWhatsappLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, accountId, canManageMembers]);

  const displayName = profile?.full_name || profile?.email || 'Your account';
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const currencyLabel =
    CURRENCIES.find((c) => c.code === defaultCurrency)?.label ?? defaultCurrency;
  const themeName = THEMES.find((th) => th.id === theme)?.name ?? theme;
  const modeLabel = t(mode === 'light' ? 'settings.appearance.modeLight' : 'settings.appearance.modeDark');
  const localeName = LOCALES.find((l) => l.id === locale)?.name ?? locale;

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const tiles: {
    section: SettingsSection;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'whatsapp',
      loading: whatsappLoading,
      subtitle: !whatsapp?.configured ? (
        t('settings.overview.whatsappNotSetUp')
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('settings.overview.whatsappConnected')}
          {' · '}
          {t(
            whatsapp.provider === 'evolution'
              ? 'settings.overview.whatsappProviderEvolution'
              : 'settings.overview.whatsappProviderMeta',
          )}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('settings.overview.whatsappNeedsReconnect')}
        </>
      ),
    },
    {
      section: 'members',
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? t('settings.overview.membersViewTeam')
          : `${t(
              counts.members === 1 ? 'settings.overview.memberCount' : 'settings.overview.memberCountPlural',
              { count: counts.members },
            )}${
              counts.pendingInvites
                ? ` · ${t(
                    counts.pendingInvites === 1
                      ? 'settings.overview.pendingInvite'
                      : 'settings.overview.pendingInvitePlural',
                    { count: counts.pendingInvites },
                  )}`
                : ''
            }`,
    },
    {
      section: 'templates',
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? t('settings.overview.templatesManage')
          : `${t(
              counts.templates === 1 ? 'settings.overview.templateCount' : 'settings.overview.templateCountPlural',
              { count: counts.templates },
            )}${
              counts.templatesPending
                ? ` · ${t('settings.overview.templatesPendingReview', { count: counts.templatesPending })}`
                : ''
            }`,
    },
    {
      section: 'deals',
      loading: false,
      subtitle: `${defaultCurrency} — ${currencyLabel}`,
    },
    {
      section: 'fields',
      loading: countsLoading,
      subtitle:
        counts?.tags == null && counts?.customFields == null
          ? t('settings.overview.fieldsTagsDefault')
          : `${t(
              counts?.tags === 1 ? 'settings.overview.tagCount' : 'settings.overview.tagCountPlural',
              { count: counts?.tags ?? 0 },
            )} · ${t(
              counts?.customFields === 1
                ? 'settings.overview.customFieldCount'
                : 'settings.overview.customFieldCountPlural',
              { count: counts?.customFields ?? 0 },
            )}`,
    },
    {
      section: 'appearance',
      loading: false,
      subtitle: t('settings.overview.appearanceSubtitle', { mode: modeLabel, theme: themeName }),
    },
    {
      section: 'language',
      loading: false,
      subtitle: localeName,
    },
  ];

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity */}
      <Card className="flex-row items-center gap-4 px-5 py-5">
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-xl text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="truncate text-sm text-muted-foreground">
              {profile.email}
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {roleMeta.label}
          </SettingsChip>
        ) : null}
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map(({ section, loading, subtitle }) => {
          const meta = SECTION_META[section];
          const Icon = meta.icon;
          return (
            <button
              key={section}
              type="button"
              onClick={() => onSelect(section)}
              className={cn(
                'group flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors',
                'hover:border-primary-soft-2 hover:bg-card-2',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {t(meta.label)}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> {t('settings.overview.loading')}
                    </>
                  ) : (
                    subtitle
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
