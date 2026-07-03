import type { Locale } from "../locales";
import { en, type TranslationKey } from "./en";
import { ptBR } from "./pt-BR";

export const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  "pt-BR": ptBR,
};

export type { TranslationKey };
