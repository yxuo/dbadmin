import * as fs from "node:fs";
import * as path from "node:path";
import { DbAdminLocale, getLocale } from "../i18n";

export type LocaleDict = Record<string, string>;

let cached: { locale: DbAdminLocale; dict: LocaleDict } | undefined;

function localeToBcp47(locale: DbAdminLocale): string {
  const map: Record<DbAdminLocale, string> = {
    en: "en",
    "pt-br": "pt-BR",
    es: "es",
    de: "de",
    fr: "fr",
    ru: "ru",
    ja: "ja",
    "zh-cn": "zh-CN",
  };
  return map[locale] || "en";
}

function localesDirFromExtensionPath(extensionPath: string): string {
  return path.join(extensionPath, "locales");
}

export function loadLocaleDict(
  extensionPath: string,
  locale: DbAdminLocale = getLocale(),
): LocaleDict {
  if (cached && cached.locale === locale) {
    return cached.dict;
  }

  const dir = localesDirFromExtensionPath(extensionPath);
  const filePath = path.join(dir, `${locale}.json`);
  const fallbackPath = path.join(dir, "en.json");

  let dict: LocaleDict = {};
  let fallback: LocaleDict = {};
  try {
    fallback = JSON.parse(fs.readFileSync(fallbackPath, "utf8")) as LocaleDict;
  } catch {
    fallback = {};
  }
  try {
    const localized = JSON.parse(fs.readFileSync(filePath, "utf8")) as LocaleDict;
    dict = { ...fallback, ...localized };
  } catch {
    dict = fallback;
  }

  cached = { locale, dict };
  return dict;
}

export function clearLocaleCache(): void {
  cached = undefined;
}

export function webviewI18nBootstrap(
  extensionPath: string,
  locale: DbAdminLocale = getLocale(),
): string {
  const dict = loadLocaleDict(extensionPath, locale);
  const lang = localeToBcp47(locale);
  return `window.__DBADMIN_I18N__=${JSON.stringify(dict)};window.__DBADMIN_LANG__=${JSON.stringify(lang)};document.documentElement.lang=${JSON.stringify(lang)};function t(key,fallback){var d=window.__DBADMIN_I18N__||{};return (d[key]!=null&&d[key]!=="")?d[key]:(fallback!=null?fallback:key);}function tf(key,vars,fallback){var s=t(key,fallback);if(!vars)return s;return String(s).replace(/\\{(\\w+)\\}/g,function(_,k){return vars[k]!=null?String(vars[k]):"{"+k+"}";});}`;
}

export function serializeLocaleForWebview(
  extensionPath: string,
  locale?: DbAdminLocale,
): { lang: string; i18nJson: string } {
  const resolved = locale ?? getLocale();
  const dict = loadLocaleDict(extensionPath, resolved);
  return {
    lang: localeToBcp47(resolved),
    i18nJson: JSON.stringify(dict),
  };
}
