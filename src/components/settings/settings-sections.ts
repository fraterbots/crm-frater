import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Languages,
  MessageSquareText,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import type { TranslationKey } from '@/lib/i18n/dictionaries';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'language',
  'whatsapp',
  'templates',
  'canned-responses',
  'fields',
  'deals',
  'members',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/**
 * Rail grouping. `label` is a translation key (looked up via `t()` at
 * render sites — this module has no React context to call `t()` from
 * directly).
 */
export interface SectionMeta {
  id: SettingsSection;
  label: TranslationKey;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'settings.sections.overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'settings.sections.profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'settings.sections.security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'settings.sections.appearance', icon: Palette, group: 'account' },
  language: { id: 'language', label: 'settings.sections.language', icon: Languages, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'settings.sections.whatsapp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', label: 'settings.sections.templates', icon: FileText, group: 'workspace' },
  'canned-responses': { id: 'canned-responses', label: 'settings.sections.cannedResponses', icon: MessageSquareText, group: 'workspace' },
  fields: { id: 'fields', label: 'settings.sections.fields', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'settings.sections.deals', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'settings.sections.members', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', label: 'settings.sections.api', icon: KeyRound, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
