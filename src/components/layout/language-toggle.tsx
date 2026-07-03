"use client";

import { useTranslation } from "@/lib/i18n/use-translation";
import { LOCALES } from "@/lib/i18n/locales";
import { cn } from "@/lib/utils";

/**
 * Quick language switch — a single button cycling through the two
 * locales, mirroring `ModeToggle` (`src/components/layout/mode-toggle.tsx`).
 * Shows the *current* language's short code; clicking advances to the
 * next one in `LOCALES`.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useTranslation();
  const currentIndex = LOCALES.findIndex((l) => l.id === locale);
  const next = LOCALES[(currentIndex + 1) % LOCALES.length];

  return (
    <button
      type="button"
      onClick={() => setLocale(next.id)}
      aria-label={t("language.switchTo", { name: next.name })}
      title={t("language.switchTo", { name: next.name })}
      className={cn(
        "flex h-10 min-w-10 items-center justify-center rounded-md px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {LOCALES[currentIndex]?.shortLabel ?? locale}
    </button>
  );
}
