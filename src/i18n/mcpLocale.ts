import * as fs from "node:fs";
import * as path from "node:path";

export type McpLocale = "en" | "pt-br";

export type LocaleDict = Record<string, string>;

let dict: LocaleDict | undefined;
let locale: McpLocale = "en";

function resolveLocale(raw: string | undefined): McpLocale {
  const normalized = String(raw || "en")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (normalized === "pt-br" || normalized === "pt") {
    return "pt-br";
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
    const fallback = path.join(root, "locales", "en.json");
    try {
      if (fs.existsSync(filePath)) {
        dict = JSON.parse(fs.readFileSync(filePath, "utf8")) as LocaleDict;
        return;
      }
      if (fs.existsSync(fallback)) {
        dict = JSON.parse(fs.readFileSync(fallback, "utf8")) as LocaleDict;
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
