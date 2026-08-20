import * as fs from "node:fs";
import * as path from "node:path";

export type McpLocale =
  | "en"
  | "pt-br"
  | "es"
  | "de"
  | "fr"
  | "ru"
  | "ja"
  | "zh-cn";

export type LocaleDict = Record<string, string>;

let dict: LocaleDict | undefined;
let locale: McpLocale = "en";

function resolveLocale(raw: string | undefined): McpLocale {
  const normalized = String(raw || "en")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  // Any Portuguese UI (pt, pt-pt, pt-br, …) uses the pt-br pack.
  if (normalized === "pt" || normalized.startsWith("pt-")) {
    return "pt-br";
  }
  if (normalized === "es" || normalized.startsWith("es-")) {
    return "es";
  }
  if (normalized === "de" || normalized.startsWith("de-")) {
    return "de";
  }
  if (normalized === "fr" || normalized.startsWith("fr-")) {
    return "fr";
  }
  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru";
  }
  if (normalized === "ja" || normalized.startsWith("ja-")) {
    return "ja";
  }
  if (
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-cn-") ||
    normalized.startsWith("zh-hans-") ||
    normalized.startsWith("zh-sg-")
  ) {
    return "zh-cn";
  }
  return "en";
}

/**
 * Load locale JSON for the MCP child process (no vscode API).
 * Prefers DBADMIN_MCP_LOCALE; falls back to en.
 */
export function initMcpLocale(options?: {
  extensionRoot?: string;
  locale?: string;
}): void {
  locale = resolveLocale(options?.locale || process.env.DBADMIN_MCP_LOCALE);
  const roots = [
    options?.extensionRoot,
    process.env.DBADMIN_EXTENSION_ROOT,
    path.resolve(__dirname, "..", ".."),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const filePath = path.join(root, "locales", `${locale}.json`);
    const fallbackPath = path.join(root, "locales", "en.json");
    try {
      let fallback: LocaleDict = {};
      if (fs.existsSync(fallbackPath)) {
        fallback = JSON.parse(fs.readFileSync(fallbackPath, "utf8")) as LocaleDict;
      }
      if (fs.existsSync(filePath)) {
        const localized = JSON.parse(fs.readFileSync(filePath, "utf8")) as LocaleDict;
        dict = { ...fallback, ...localized };
        return;
      }
      if (Object.keys(fallback).length > 0) {
        dict = fallback;
        locale = "en";
        return;
      }
    } catch {
      // try next root
    }
  }
  dict = {};
}

export function mcpT(
  key: string,
  vars?: Record<string, string | number | boolean>,
): string {
  if (!dict) {
    initMcpLocale();
  }
  let text = (dict && dict[key]) || key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (_, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
    );
  }
  return text;
}

export function getMcpLocale(): McpLocale {
  return locale;
}

export function formatMcpError(
  error: unknown,
  envelopeKey = "error.queryFailed",
): string {
  const detail =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : String(error ?? "").trim() || mcpT("error.unexpected");
  const envelope = mcpT(envelopeKey, { detail });
  // If envelope key missing, mcpT returns key — fall back to detail-only style.
  if (envelope === envelopeKey) {
    return `${mcpT("error.failed", { detail })}`;
  }
  // Support both {detail} and {0} styles in locale files.
  if (envelope.includes("{detail}") || envelope.includes("{0}")) {
    return envelope
      .replace(/\{detail\}/g, detail)
      .replace(/\{0\}/g, detail);
  }
  return envelope.includes(detail) ? envelope : `${envelope}: ${detail}`;
}
