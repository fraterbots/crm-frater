"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocale,
  type Locale,
} from "@/lib/i18n/locales";
import { dictionaries, type TranslationKey } from "@/lib/i18n/dictionaries";

/**
 * LocaleProvider — mirrors `ThemeProvider` (`src/hooks/use-theme.tsx`)
 * exactly: the boot script in `src/app/layout.tsx` has already
 * applied `lang`/`data-locale` on <html> before hydration, so this
 * provider just reads what's there and keeps it in sync going
 * forward. Persistence is localStorage only (device-scoped), same
 * as theme/mode.
 */

type TranslateParams = Record<string, string | number>;

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TranslationKey, params?: TranslateParams) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const fromAttr = document.documentElement.dataset.locale;
  if (isLocale(fromAttr)) return fromAttr;
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_LOCALE;
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in params ? String(params[key]) : match,
  );
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.locale = next;
      document.documentElement.lang = next;
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Same private-browsing edge case as above; the in-memory state
      // still updates so the current tab works for the session.
    }
  }, []);

  // Sync from other tabs — change language in tab A, tab B catches up
  // without a refresh.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LOCALE_STORAGE_KEY) return;
      if (isLocale(e.newValue) && e.newValue !== locale) {
        setLocaleState(e.newValue);
        document.documentElement.dataset.locale = e.newValue;
        document.documentElement.lang = e.newValue;
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [locale]);

  const t = useCallback(
    (key: TranslationKey, params?: TranslateParams) => {
      const dict = dictionaries[locale];
      // Fall back to English so an in-progress translation (a key
      // only added to en.ts so far) never renders blank.
      const template = dict[key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
      return interpolate(template, params);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider — return
    // English strings and a no-op setter so callers don't crash.
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (key, params) => interpolate(dictionaries[DEFAULT_LOCALE][key] ?? key, params),
    };
  }
  return ctx;
}
