import * as vscode from "vscode";
import { ConnectionStore } from "./connectionStore";
import { DatabaseTreeProvider } from "./databaseTreeProvider";
import { TableDataPanelManager } from "./tableDataPanel";
import { log } from "./output";
import { sqliteDatabaseName } from "./connectionIdentity";
import { t } from "./i18n";
import { isSqliteFilePath, SQLITE_FILE_GLOBS, SQLITE_SCHEMA } from "./engines/types";
import { isSqliteConnection } from "./models";

export interface DbAdminApi {
  getSupportedFileGlobs(): string[];
  canOpenFile(uri: vscode.Uri): boolean;
  openDatabaseFile(
    uri: vscode.Uri,
    options?: { persistConnection?: boolean },
  ): Promise<void>;
}

export const OPEN_SQLITE_IN_EXPLORER_SETTING = "dbadmin.openSqliteInExplorer";

export function getOpenSqliteInExplorerEnabled(): boolean {
  return vscode.workspace
    .getConfiguration()
    .get<boolean>(OPEN_SQLITE_IN_EXPLORER_SETTING, true);
}

export async function setOpenSqliteInExplorerEnabled(
  enabled: boolean,
): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    OPEN_SQLITE_IN_EXPLORER_SETTING,
    enabled,
    vscode.ConfigurationTarget.Global,
  );
}

export function canOpenDatabaseFile(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && isSqliteFilePath(uri.fsPath);
}

export async function openDatabaseFile(
  uri: vscode.Uri,
  options: {
    store: ConnectionStore;
    treeProvider: DatabaseTreeProvider;
    tablePanels: TableDataPanelManager;
    persistConnection?: boolean;
    openFirstTable?: boolean;
  },
): Promise<void> {
  if (!canOpenDatabaseFile(uri)) {
    throw new Error(t("This file type is not a supported SQLite database."));
  }

  const filePath = uri.fsPath;
  log(`Opening database file: ${filePath}`);
  const nickname = filePath.split(/[/\\]/).pop() || "sqlite";
  const existing = await options.store.findSqliteByFilePath(filePath);
  const connection = existing
    ? existing
    : options.persistConnection
      ? await options.store.createConnection({
          engine: "sqlite",
          nickname,
          filePath,
        })
      : await options.store.createEphemeralSqlite({ nickname, filePath });

  options.treeProvider.refresh();
  if (getOpenSqliteInExplorerEnabled()) {
    void vscode.commands.executeCommand("workbench.view.extension.dbadmin");
  }

  if (options.openFirstTable && isSqliteConnection(connection)) {
    try {
      const tables = await waitForTables(options.treeProvider, connection.id);
      if (tables[0]) {
        await options.tablePanels.openTable({
          node: {
            type: "dbObject",
            connection,
            databaseName: sqliteDatabaseName(connection),
            schemaName: SQLITE_SCHEMA,
            kind: "table",
            objectName: tables[0],
          },
          newTab: false,
        });
      }
    } catch {
      // Explorer is enough if the first table cannot be opened yet.
    }
  }
}

async function waitForTables(
  treeProvider: DatabaseTreeProvider,
  _connectionId: string,
): Promise<string[]> {
  void treeProvider;
  void _connectionId;
  return [];
}

export function createDbAdminApi(handlers: {
  openDatabaseFile: (uri: vscode.Uri, options?: { persistConnection?: boolean }) => Promise<void>;
}): DbAdminApi {
  return {
    getSupportedFileGlobs: () => [...SQLITE_FILE_GLOBS],
    canOpenFile: canOpenDatabaseFile,
    openDatabaseFile: handlers.openDatabaseFile,
  };
}
