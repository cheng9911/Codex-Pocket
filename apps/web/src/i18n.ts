import { useSyncExternalStore } from 'react';
import { english } from './messages.ts';

export type Locale = 'zh-CN' | 'en';
const storageKey = 'pocket:locale';
const listeners = new Set<() => void>();
export function resolveLocale(saved: string | null, browserLanguage: string): Locale {
  if (saved === 'zh-CN' || saved === 'en') return saved;
  return browserLanguage.toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}
function initialLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(storageKey), navigator.language);
  } catch {
    return 'zh-CN';
  }
}
let locale = initialLocale();
export const getLocale = () => locale;
function publish(next: Locale) {
  locale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
export function setLocale(next: Locale) {
  if (next !== 'en' && next !== 'zh-CN') return;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* Still works for this visit. */
  }
  publish(next);
}
if (typeof window !== 'undefined') {
  document.documentElement.lang = locale;
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null)
      publish(resolveLocale(event.newValue, navigator.language));
  });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => 'zh-CN' as Locale);
}
export function translate(
  text: string,
  language: Locale,
  values: Record<string, string | number> = {},
) {
  const key = text.trim().replace(/\s+/g, ' ');
  const translated = language === 'en' && Object.hasOwn(english, key) ? english[key] : undefined;
  const template = translated === undefined ? text : text.replace(text.trim(), translated);
  // Function replacement preserves literal "$&" and other special characters in values.
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
export function t(text: string, values?: Record<string, string | number>) {
  return translate(text, locale, values);
}
