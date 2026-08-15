import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Same shape as quickdb: lowercase key in ~/.cursor/mcp.json */
export const CURSOR_MCP_SERVER_KEY = "dbadmin";

/** Older keys we used while iterating; remove on sync to avoid duplicates. */
const LEGACY_CURSOR_MCP_SERVER_KEYS = ["DBAdmin"];

export function getCursorMcpJsonPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

export function buildDbAdminMcpServerEntry(options: {
  serverJsPath: string;
  storageRoot: string;
  allowWrites: boolean;
  maxRows: number;
  locale?: string;
  extensionRoot?: string;
}): Record<string, unknown> {
  const env: Record<string, string> = {
    DBADMIN_STORAGE_ROOT: options.storageRoot,
    DBADMIN_MCP_ALLOW_WRITES: options.allowWrites ? "true" : "false",
    DBADMIN_MCP_MAX_ROWS: String(options.maxRows),
  };
  if (options.locale) {
    env.DBADMIN_MCP_LOCALE = options.locale;
  }
  if (options.extensionRoot) {
    env.DBADMIN_EXTENSION_ROOT = options.extensionRoot;
  }
  return {
    command: "node",
    args: [options.serverJsPath],
    env,
  };
}

/**
 * Upsert only the dbadmin entry in ~/.cursor/mcp.json, preserving other servers
 * (quickdb, GitKraken, etc.). Never wipe the file on parse errors.
 */
export async function upsertDbAdminInCursorMcpJson(options: {
  serverJsPath: string;
  storageRoot: string;
  allowWrites: boolean;
  maxRows: number;
  locale?: string;
  extensionRoot?: string;
}): Promise<string> {
  const filePath = getCursorMcpJsonPath();
  let root: Record<string, unknown> = {};
  let existingRaw: string | undefined;

  try {
    existingRaw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (existingRaw !== undefined) {
    const trimmed = existingRaw.replace(/^\uFEFF/, "").trim();
    if (trimmed) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid mcp.json at ${filePath}; fix the JSON before syncing DBAdmin (${message}).`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          `Invalid mcp.json at ${filePath}: expected a root object.`,
        );
      }
      root = parsed as Record<string, unknown>;
    }
  }

  const mcpServers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? ({ ...(root.mcpServers as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  for (const legacyKey of LEGACY_CURSOR_MCP_SERVER_KEYS) {
    delete mcpServers[legacyKey];
  }

  mcpServers[CURSOR_MCP_SERVER_KEY] = buildDbAdminMcpServerEntry(options);
  root.mcpServers = mcpServers;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return filePath;
}
