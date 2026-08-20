import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConnectionStore } from "./connectionStore";
import { t } from "./i18n";
import { ConnectionsFile, PostgresConnection } from "./models";
import {
  getSqlBookIntegratedTableEnabled,
  setSqlBookIntegratedTableEnabled,
  syncSqlBookIntegratedTableContext,
} from "./sqlBookIntegratedTable";
import {
  getSqlBookRunPerQueryEnabled,
  setSqlBookRunPerQueryEnabled,
  syncSqlBookRunPerQueryContext,
} from "./sqlBookRunPerQuery";
import {
  getSqlBookSaveIntegratedTableEnabled,
  setSqlBookSaveIntegratedTableEnabled,
  syncSqlBookSaveIntegratedTableContext,
} from "./sqlBookSaveIntegratedTable";
import { TableLayoutState } from "./tableDataPanel/types";

const CONFIG_KIND = "dbadmin.config";
const CONFIG_VERSION = 1;
const TABLE_LAYOUT_PREFIX = "dbadmin.tableLayout:";

const SETTING_KEYS = [
  "persistColumnLayout",
  "pgAdminBinPath",
  "showFilterLabel",
  "defaultPageSize",
  "managerPollIntervalSeconds",
  "managerTimeWindowMinutes",
  "dynamicDefaultColumnWidth",
  "expandFilterResults",
  "mcpAllowWrites",
  "mcpMaxRows",
  "sqlbookIntegratedTable",
  "sqlbookSaveIntegratedTable",
  "sqlbookRunPerQuery",
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

export interface DbAdminConfigBackup {
  kind: typeof CONFIG_KIND;
  version: typeof CONFIG_VERSION;
  exportedAt: string;
  settings: Partial<Record<SettingKey, unknown>>;
  connections: ConnectionsFile;
  tableLayouts: Record<string, TableLayoutState>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCurrentSettings(): Record<SettingKey, unknown> {
  const config = vscode.workspace.getConfiguration("dbadmin");
  const settings = {} as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) {
    settings[key] = config.get(key);
  }
  settings.sqlbookIntegratedTable = getSqlBookIntegratedTableEnabled();
  settings.sqlbookSaveIntegratedTable = getSqlBookSaveIntegratedTableEnabled();
  settings.sqlbookRunPerQuery = getSqlBookRunPerQueryEnabled();
  return settings;
}

function readTableLayouts(
  context: vscode.ExtensionContext,
): Record<string, TableLayoutState> {
  const layouts: Record<string, TableLayoutState> = {};
  for (const key of context.globalState.keys()) {
    if (!key.startsWith(TABLE_LAYOUT_PREFIX)) {
      continue;
    }
    const value = context.globalState.get<TableLayoutState>(key);
    if (value && typeof value === "object") {
      layouts[key] = value;
    }
  }
  return layouts;
}

export async function exportDbAdminConfig(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
): Promise<void> {
  const connections = await store.listConnections();
  const payload: DbAdminConfigBackup = {
    kind: CONFIG_KIND,
    version: CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
    settings: readCurrentSettings(),
    connections: { version: 1, connections },
    tableLayouts: readTableLayouts(context),
  };

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), "dbadmin-config.json")),
    filters: {
      JSON: ["json"],
    },
    saveLabel: t("Export"),
    title: t("Export DBAdmin settings"),
  });
  if (!uri) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    t(
      "The file will include saved connections and passwords. Store it securely.",
    ),
    { modal: true },
    t("Export"),
  );
  if (confirmed !== t("Export")) {
    return;
  }

  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
  );
  void vscode.window.showInformationMessage(t("Settings exported successfully."));
}

function parseBackup(raw: unknown): DbAdminConfigBackup {
  if (!isRecord(raw) || raw.kind !== CONFIG_KIND) {
    throw new Error("Invalid DBAdmin settings file.");
  }
  const version = Number(raw.version);
  if (version !== CONFIG_VERSION) {
    throw new Error("Invalid DBAdmin settings file.");
  }

  const settings = isRecord(raw.settings) ? raw.settings : {};
  const connectionsRaw = isRecord(raw.connections) ? raw.connections : {};
  if (
    connectionsRaw.version !== 1 ||
    !Array.isArray(connectionsRaw.connections)
  ) {
    throw new Error("Invalid DBAdmin settings file.");
  }

  const connections = (connectionsRaw.connections as PostgresConnection[]).map(
    (item) => {
      if (!item || typeof item !== "object") {
        throw new Error("Invalid DBAdmin settings file.");
      }
      return item;
    },
  );

  const tableLayouts = isRecord(raw.tableLayouts)
    ? (raw.tableLayouts as Record<string, TableLayoutState>)
    : {};

  return {
    kind: CONFIG_KIND,
    version: CONFIG_VERSION,
    exportedAt: String(raw.exportedAt || ""),
    settings,
    connections: { version: 1, connections },
    tableLayouts,
  };
}

async function applySettings(settings: Partial<Record<SettingKey, unknown>>): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const updates: Array<Thenable<void>> = [];
  for (const key of SETTING_KEYS) {
    if (!(key in settings)) {
      continue;
    }
    if (
      key === "sqlbookIntegratedTable" ||
      key === "sqlbookSaveIntegratedTable" ||
      key === "sqlbookRunPerQuery"
    ) {
      continue;
    }
    updates.push(
      config.update(
        `dbadmin.${key}`,
        settings[key],
        vscode.ConfigurationTarget.Global,
      ),
    );
  }
  await Promise.all(updates);

  if ("sqlbookIntegratedTable" in settings) {
    await setSqlBookIntegratedTableEnabled(Boolean(settings.sqlbookIntegratedTable));
  }
  if ("sqlbookSaveIntegratedTable" in settings) {
    await setSqlBookSaveIntegratedTableEnabled(
      Boolean(settings.sqlbookSaveIntegratedTable),
    );
  }
  if ("sqlbookRunPerQuery" in settings) {
    await setSqlBookRunPerQueryEnabled(Boolean(settings.sqlbookRunPerQuery));
  }

  await Promise.all([
    syncSqlBookIntegratedTableContext(),
    syncSqlBookSaveIntegratedTableContext(),
    syncSqlBookRunPerQueryContext(),
  ]);
}

async function replaceTableLayouts(
  context: vscode.ExtensionContext,
  next: Record<string, TableLayoutState>,
): Promise<void> {
  const existing = context.globalState.keys().filter((key) =>
    key.startsWith(TABLE_LAYOUT_PREFIX),
  );
  await Promise.all(
    existing.map((key) => context.globalState.update(key, undefined)),
  );
  await Promise.all(
    Object.entries(next).map(([key, value]) =>
      key.startsWith(TABLE_LAYOUT_PREFIX)
        ? context.globalState.update(key, value)
        : Promise.resolve(),
    ),
  );
}

export async function importDbAdminConfig(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  afterImport?: () => void,
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      JSON: ["json"],
    },
    openLabel: t("Import"),
    title: t("Import DBAdmin settings"),
  });
  const uri = picked?.[0];
  if (!uri) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    t(
      "Import replaces DBAdmin settings, connections, and table layouts. Continue?",
    ),
    { modal: true },
    t("Import"),
  );
  if (confirmed !== t("Import")) {
    return;
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  const backup = parseBackup(parsed);

  await store.replaceAllConnections(backup.connections.connections);
  await applySettings(backup.settings);
  await replaceTableLayouts(context, backup.tableLayouts);
  afterImport?.();
  void vscode.window.showInformationMessage(t("Settings imported successfully."));
}
