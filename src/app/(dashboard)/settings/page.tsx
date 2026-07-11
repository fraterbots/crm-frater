'use client';

import { useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n/use-translation';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { LanguagePanel } from '@/components/settings/language-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { CannedResponsesManager } from '@/components/settings/canned-responses-manager';
import { MacrosManager } from '@/components/settings/macros-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { TeamsManager } from '@/components/settings/teams-manager';
import { BusinessHoursManager } from '@/components/settings/business-hours-manager';
import { AuditLogManager } from '@/components/settings/audit-log-manager';
import { SlaPoliciesManager } from '@/components/settings/sla-policies-manager';
import { CsatManager } from '@/components/settings/csat-manager';
import { WebhooksManager } from '@/components/settings/webhooks-manager';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const { t } = useTranslation();

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: t(mode === 'light' ? 'settings.appearance.modeLight' : 'settings.appearance.modeDark'),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency, t],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    language: <LanguagePanel />,
    whatsapp: <WhatsAppConfig />,
    templates: <TemplateManager />,
    'canned-responses': <CannedResponsesManager />,
    macros: <MacrosManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    teams: <TeamsManager />,
    'business-hours': <BusinessHoursManager />,
    'sla-policies': <SlaPoliciesManager />,
    csat: <CsatManager />,
    'audit-log': <AuditLogManager />,
    webhooks: <WebhooksManager />,
    api: <ApiKeysSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('settings.page.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.page.subtitle')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
