import * as vscode from "vscode";

export const SQLBOOK_INTEGRATED_TABLE_SETTING =
  "dbadmin.sqlbookIntegratedTable";

/** @deprecated Migrated to {@link SQLBOOK_INTEGRATED_TABLE_SETTING}. */
const LEGACY_SQLBOOK_INTEGRATED_TABLE_SETTING =
  "dbadmin.sqlbook.integratedTable";

function dbadminConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("dbadmin");
}

export function getSqlBookIntegratedTableEnabled(): boolean {
  const current = dbadminConfig().get<boolean>("sqlbookIntegratedTable");
  if (typeof current === "boolean") {
    return current;
  }

  return vscode.workspace
    .getConfiguration()
    .get<boolean>(LEGACY_SQLBOOK_INTEGRATED_TABLE_SETTING, false);
}

export async function setSqlBookIntegratedTableEnabled(
  enabled: boolean,
): Promise<void> {
  await dbadminConfig().update(
    "sqlbookIntegratedTable",
    enabled,
    vscode.ConfigurationTarget.Global,
  );

  const legacyInspect = vscode.workspace
    .getConfiguration()
    .inspect<boolean>(LEGACY_SQLBOOK_INTEGRATED_TABLE_SETTING);

  if (legacyInspect?.workspaceFolderValue !== undefined) {
    await vscode.workspace.getConfiguration().update(
      LEGACY_SQLBOOK_INTEGRATED_TABLE_SETTING,
      undefined,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }
  if (legacyInspect?.workspaceValue !== undefined) {
    await vscode.workspace.getConfiguration().update(
      LEGACY_SQLBOOK_INTEGRATED_TABLE_SETTING,
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  }
  if (legacyInspect?.globalValue !== undefined) {
    await vscode.workspace.getConfiguration().update(
      LEGACY_SQLBOOK_INTEGRATED_TABLE_SETTING,
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  }
}

export async function toggleSqlBookIntegratedTableEnabled(): Promise<boolean> {
  const next = !getSqlBookIntegratedTableEnabled();
  await setSqlBookIntegratedTableEnabled(next);
  return next;
}

export async function syncSqlBookIntegratedTableContext(): Promise<void> {
  const enabled = getSqlBookIntegratedTableEnabled();
  // Flip first so notebook overflow menus re-evaluate `when` clauses.
  await vscode.commands.executeCommand(
    "setContext",
    "dbadmin.sqlbookIntegratedTable",
    !enabled,
  );
  await vscode.commands.executeCommand(
    "setContext",
    "dbadmin.sqlbookIntegratedTable",
    enabled,
  );
}
