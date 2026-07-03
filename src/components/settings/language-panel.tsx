"use client";

import { Check, Languages } from "lucide-react";

import { useTranslation } from "@/lib/i18n/use-translation";
import { LOCALES, type Locale } from "@/lib/i18n/locales";
import { cn } from "@/lib/utils";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Language panel — mirrors `AppearancePanel` (mode/theme picker):
 * a single radiogroup of the available locales, applied + persisted
 * immediately on click, no save button.
 */
export function LanguagePanel() {
  const { locale, setLocale, t } = useTranslation();
  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("language.title")}
        description={t("language.description")}
      />

      <div
        role="radiogroup"
        aria-label={t("language.title")}
        className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {LOCALES.map((l) => (
          <LocaleCard
            key={l.id}
            id={l.id}
            name={l.name}
            shortLabel={l.shortLabel}
            isActive={l.id === locale}
            onPick={() => setLocale(l.id)}
            activeLabel={t("settings.appearance.active")}
          />
        ))}
      </div>
    </section>
  );
}

function LocaleCard({
  id,
  name,
  shortLabel,
  isActive,
  onPick,
  activeLabel,
}: {
  id: Locale;
  name: string;
  shortLabel: string;
  isActive: boolean;
  onPick: () => void;
  activeLabel: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={name}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Languages className="h-4 w-4" />
      </span>
      <span className="flex-1 text-sm font-semibold text-foreground">
        {name}
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
          ({shortLabel})
        </span>
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          {activeLabel}
        </span>
      )}
      <span className="sr-only">{id}</span>
    </button>
  );
}
