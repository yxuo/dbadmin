import * as vscode from "vscode";

export const SQLBOOK_SAVE_INTEGRATED_TABLE_SETTING =
  "dbadmin.sqlbookSaveIntegratedTable";

function dbadminConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("dbadmin");
}

export function getSqlBookSaveIntegratedTableEnabled(): boolean {
  return dbadminConfig().get<boolean>("sqlbookSaveIntegratedTable") !== false;
}

export async function setSqlBookSaveIntegratedTableEnabled(
  enabled: boolean,
): Promise<void> {
  await dbadminConfig().update(
    "sqlbookSaveIntegratedTable",
    enabled,
    vscode.ConfigurationTarget.Global,
  );
}

export async function toggleSqlBookSaveIntegratedTableEnabled(): Promise<boolean> {
  const next = !getSqlBookSaveIntegratedTableEnabled();
  await setSqlBookSaveIntegratedTableEnabled(next);
  return next;
}

export async function syncSqlBookSaveIntegratedTableContext(): Promise<void> {
  const enabled = getSqlBookSaveIntegratedTableEnabled();
  await vscode.commands.executeCommand(
    "setContext",
    "dbadmin.sqlbookSaveIntegratedTable",
    !enabled,
  );
  await vscode.commands.executeCommand(
    "setContext",
    "dbadmin.sqlbookSaveIntegratedTable",
    enabled,
  );
}
