import * as vscode from "vscode";

export type DbAdminLocale =
  | "en"
  | "pt-br"
  | "es"
  | "de"
  | "fr"
  | "ru"
  | "ja"
  | "zh-cn";

function resolveLocale(rawLocale: string | undefined): DbAdminLocale {
  const raw = String(rawLocale || "en")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

  // Any Portuguese UI (pt, pt-pt, pt-br, …) uses the pt-br pack.
  if (raw === "pt" || raw.startsWith("pt-")) {
    return "pt-br";
  }
  if (raw === "es" || raw.startsWith("es-")) {
    return "es";
  }
  if (raw === "de" || raw.startsWith("de-")) {
    return "de";
  }
  if (raw === "fr" || raw.startsWith("fr-")) {
    return "fr";
  }
  if (raw === "ru" || raw.startsWith("ru-")) {
    return "ru";
  }
  if (raw === "ja" || raw.startsWith("ja-")) {
    return "ja";
  }
  if (
    raw === "zh-cn" ||
    raw === "zh-hans" ||
    raw === "zh-sg" ||
    raw.startsWith("zh-cn-") ||
    raw.startsWith("zh-hans-") ||
    raw.startsWith("zh-sg-")
  ) {
    return "zh-cn";
  }
  return "en";
}

/**
 * Resolve UI locale from the editor. Supported locales are en, pt-br,
 * es, de, fr, ru, ja and zh-cn;
 * everything else falls back to English.
 */
export function getLocale(): DbAdminLocale {
  return resolveLocale(vscode.env.language);
}

export function getBcp47Locale(): string {
  const locale = getLocale();
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

/**
 * Host translations: English message in source is the default key for vscode.l10n.
 */
export function t(
  message: string,
  ...args: Array<string | number | boolean | Record<string, string | number | boolean>>
): string {
  const l10n = (vscode as typeof vscode & { l10n?: { t: Function } }).l10n;
  if (l10n && typeof l10n.t === "function") {
    return String(
      l10n.t(
        message,
        ...(args as Array<string | number | boolean>),
      ),
    );
  }
  // Fallback when l10n API is unavailable: simple {name} / {0} substitution.
  if (args.length === 0) {
    return message;
  }
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    return message.replace(/\{(\w+)\}/g, (_, key: string) =>
      first[key] !== undefined ? String(first[key]) : `{${key}}`,
    );
  }
  return message.replace(/\{(\d+)\}/g, (_, index: string) => {
    const value = args[Number(index)];
    return value !== undefined ? String(value) : `{${index}}`;
  });
}

/**
 * Policy 2 — translated envelope + raw driver/Postgres detail.
 */
export function formatErrorForUi(
  error: unknown,
  envelopeKey:
    | "error.failed"
    | "error.connectionFailed"
    | "error.queryFailed" = "error.failed",
): string {
  const detail =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : String(error ?? "").trim() || t("Unexpected error.");

  const envelopes: Record<string, string> = {
    "error.failed": t("Failed: {0}", detail),
    "error.connectionFailed": t("Connection failed: {0}", detail),
    "error.queryFailed": t("Query failed: {0}", detail),
  };
  return envelopes[envelopeKey] || envelopes["error.failed"];
}

export function unexpectedErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return t("Unexpected error.");
}
