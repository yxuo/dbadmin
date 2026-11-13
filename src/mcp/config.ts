import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initMcpLocale, mcpT } from "../i18n/mcpLocale";

export const DEFAULT_MCP_MAX_ROWS = 200;
export const DEFAULT_MCP_STATEMENT_TIMEOUT_MS = 15_000;
export const EXTENSION_GLOBAL_STORAGE_ID = "yxuo.dbadmin";
/** Extension Development Host / sideload installs use publisher "local". */
export const LOCAL_EXTENSION_GLOBAL_STORAGE_ID = "local.dbadmin";

const APP_NAMES = ["Cursor", "Code", "Code - Insiders", "VSCodium"];
const STORAGE_IDS = [EXTENSION_GLOBAL_STORAGE_ID, LOCAL_EXTENSION_GLOBAL_STORAGE_ID];

export interface McpRuntimeConfig {
  storageRoot: string;
  allowWrites: boolean;
  maxRows: number;
  statementTimeoutMs: number;
  extensionRoot: string;
}

export function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function listStorageRootCandidates(): string[] {
  const homes: string[] = [];
  const pushFor = (base: string): void => {
    for (const appName of APP_NAMES) {
      for (const storageId of STORAGE_IDS) {
        homes.push(path.join(base, appName, "User", "globalStorage", storageId));
      }
    }
  };

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    pushFor(appData);
    return homes;
  }

  if (process.platform === "darwin") {
    pushFor(path.join(os.homedir(), "Library", "Application Support"));
    return homes;
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  pushFor(configHome);
  return homes;
}

export async function resolveStorageRoot(): Promise<string> {
  const fromEnv = String(process.env.DBADMIN_STORAGE_ROOT || "").trim();
  if (fromEnv) {
    return fromEnv;
  }

  for (const candidate of listStorageRootCandidates()) {
    try {
      await fs.access(path.join(candidate, ".dbadmin", "connections.json"));
      return candidate;
    } catch {
      // try next known editor storage location
    }
  }

  initMcpLocale();
  throw new Error(mcpT("mcp.config.storageMissing"));
}

export async function loadMcpRuntimeConfig(): Promise<McpRuntimeConfig> {
  return {
    storageRoot: await resolveStorageRoot(),
    allowWrites: parseBooleanEnv(process.env.DBADMIN_MCP_ALLOW_WRITES),
    maxRows: parsePositiveIntEnv(
      process.env.DBADMIN_MCP_MAX_ROWS,
      DEFAULT_MCP_MAX_ROWS,
      1,
      5000,
    ),
    statementTimeoutMs: parsePositiveIntEnv(
      process.env.DBADMIN_MCP_STATEMENT_TIMEOUT_MS,
      DEFAULT_MCP_STATEMENT_TIMEOUT_MS,
      1000,
      120_000,
    ),
    extensionRoot: String(process.env.DBADMIN_EXTENSION_ROOT || process.cwd()),
  };
}

export function buildMcpClientConfig(options: {
  serverJsPath: string;
  storageRoot: string;
  allowWrites: boolean;
  maxRows: number;
  command?: string;
}): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        dbadmin: {
          command: options.command || "node",
          args: [options.serverJsPath],
          env: {
            DBADMIN_STORAGE_ROOT: options.storageRoot,
            DBADMIN_MCP_ALLOW_WRITES: options.allowWrites ? "true" : "false",
            DBADMIN_MCP_MAX_ROWS: String(options.maxRows),
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}
