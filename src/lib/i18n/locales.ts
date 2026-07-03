/**
 * Single source of truth for the language catalog.
 *
 * Mirrors `src/lib/themes.ts` exactly: a boot script (in
 * `src/app/layout.tsx`) reads the persisted choice from localStorage
 * before hydration and applies it to `<html>`, so there's no
 * flash-of-wrong-language on load. Adding a locale means:
 *   1. Add its id below and a matching dictionary in
 *      `src/lib/i18n/dictionaries/`.
 *   2. Register the dictionary in `src/lib/i18n/dictionaries/index.ts`.
 */

export const LOCALE_IDS = ["en", "pt-BR"] as const;

export type Locale = (typeof LOCALE_IDS)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_STORAGE_KEY = "frater.locale";

export interface LocaleMeta {
  id: Locale;
  name: string;
  shortLabel: string;
}

export const LOCALES: ReadonlyArray<LocaleMeta> = [
  { id: "en", name: "English", shortLabel: "EN" },
  { id: "pt-BR", name: "Português (Brasil)", shortLabel: "PT" },
];

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (LOCALE_IDS as ReadonlyArray<string>).includes(value)
  );
}
