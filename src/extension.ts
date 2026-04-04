import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { showConnectionForm } from './connectionFormPanel';
import { DatabaseTreeProvider } from './databaseTreeProvider';
import {
  ConnectionNodeRef,
  DatabaseNodeRef,
  DbObjectNodeRef,
  PostgresConnection,
  SchemaNodeRef,
  TableSectionItemNodeRef,
} from './models';
import { PostgresService } from './postgresService';
import { TableDataPanelManager } from './tableDataPanel';
import { SettingsPanelManager } from './settingsPanel';
import { BackupPanelManager } from './backupPanel';
import { RestorePanelManager } from './restorePanel';
import { TableMetadataPanelManager } from './tableMetadataPanel';

const EXPAND_FILTER_RESULTS_SETTING = 'dbadmin.expandFilterResults';
const FILTER_INPUT_DEBOUNCE_MS = 180;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = ConnectionStore.getWorkspaceRoot();
  const storageRoot = workspaceRoot || context.globalStorageUri.fsPath;
  const store = new ConnectionStore(storageRoot);
  const postgresService = new PostgresService();
  const treeProvider = new DatabaseTreeProvider(store, postgresService, context.extensionPath);
  const tablePanels = new TableDataPanelManager(context, postgresService);
  const settingsPanel = new SettingsPanelManager(context, () => store.getStorageFilePath());
  const backupPanels = new BackupPanelManager(context);
  const restorePanels = new RestorePanelManager(context);
  const metadataPanels = new TableMetadataPanelManager(context, postgresService);

  if (!workspaceRoot) {
    // void vscode.window.showWarningMessage(
    //   'Nenhuma pasta aberta no Extension Host. As conexoes serao salvas no armazenamento global da extensão.'
    // );
  }

  // Restaura abas abertas anteriormente
  void tablePanels.restoreOpenTabs(store);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dbadmin.showQueryEditor')) {
        tablePanels.notifyQueryVisibilityChanged();
      }

      if (event.affectsConfiguration('dbadmin.hideTabHeader')) {
        tablePanels.notifyHeaderVisibilityChanged();
      }

      if (event.affectsConfiguration('dbadmin.showFilterLabel')) {
        const nextShowFilterLabel = vscode.workspace
          .getConfiguration()
          .get<boolean>('dbadmin.showFilterLabel', true);
        treeProvider.setShowFilterLabel(nextShowFilterLabel);
      }

      if (event.affectsConfiguration(EXPAND_FILTER_RESULTS_SETTING)) {
        if (filterView) {
          void filterView.webview.postMessage({
            type: 'setExpandItems',
            value: getExpandFilterResultsSetting(),
          });
        }
        applyFilter(treeProvider.getTableNameFilter());
      }
    })
  );

  const treeView = vscode.window.createTreeView('databaseExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const initialShowFilterLabel = vscode.workspace
    .getConfiguration()
    .get<boolean>('dbadmin.showFilterLabel', true);
  treeProvider.setShowFilterLabel(initialShowFilterLabel);

  let filterView: vscode.WebviewView | undefined;

  const getExpandFilterResultsSetting = (): boolean =>
    vscode.workspace.getConfiguration().get<boolean>(EXPAND_FILTER_RESULTS_SETTING, false);

  const setExpandFilterResultsSetting = async (value: boolean): Promise<void> => {
    await vscode.workspace
      .getConfiguration()
      .update(EXPAND_FILTER_RESULTS_SETTING, Boolean(value), vscode.ConfigurationTarget.Global);
  };

  const collapseAllExplorer = async (): Promise<void> => {
    await vscode.commands.executeCommand('workbench.actions.treeView.databaseExplorer.collapseAll');
  };

  let filterRunSeq = 0;
  let pendingFilterTimeout: ReturnType<typeof setTimeout> | undefined;

  const runFilter = async (rawValue: string): Promise<void> => {
    const runId = ++filterRunSeq;
    const isStale = (): boolean => runId !== filterRunSeq;

    const value = rawValue.trim();
    treeProvider.setTableNameFilter(value);

    const shouldShowLabel = vscode.workspace
      .getConfiguration()
      .get<boolean>('dbadmin.showFilterLabel', true);
    treeProvider.setShowFilterLabel(shouldShowLabel);

    if (filterView) {
      await filterView.webview.postMessage({
        type: 'setFilterValue',
        value,
      });
    }

    if (isStale()) {
      return;
    }

    if (!value) {
      treeProvider.setFilterHasResults(true);
      if (getExpandFilterResultsSetting()) {
        await collapseAllExplorer();
      }
      return;
    }

    const filteredPaths = treeProvider.getFilteredTableExpandPaths();
    if (isStale()) {
      return;
    }

    treeProvider.setFilterHasResults(filteredPaths.length > 0);

    if (!getExpandFilterResultsSetting()) {
      return;
    }

    await collapseAllExplorer();
    if (isStale()) {
      return;
    }

    for (const tablesGroup of filteredPaths) {
      if (isStale()) {
        return;
      }

      await treeView.reveal(tablesGroup, {
        select: false,
        focus: false,
        expand: true,
      });
    }
  };

  const applyFilter = (rawValue: string, options?: { debounceMs?: number }): void => {
    if (pendingFilterTimeout) {
      clearTimeout(pendingFilterTimeout);
      pendingFilterTimeout = undefined;
    }

    const debounceMs = options?.debounceMs ?? 0;
    if (debounceMs > 0) {
      pendingFilterTimeout = setTimeout(() => {
        pendingFilterTimeout = undefined;
        void runFilter(rawValue);
      }, debounceMs);
      return;
    }

    void runFilter(rawValue);
  };

  const filterViewProvider: vscode.WebviewViewProvider = {
    resolveWebviewView: (webviewView) => {
      filterView = webviewView;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = buildFilterViewHtml(
        webviewView.webview,
        treeProvider.getTableNameFilter(),
        getExpandFilterResultsSetting()
      );

      webviewView.onDidDispose(() => {
        if (filterView === webviewView) {
          filterView = undefined;
        }
      });

      webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: string; checked?: boolean }) => {
        if (message.type === 'filterChanged') {
          applyFilter(String(message.value ?? ''), { debounceMs: FILTER_INPUT_DEBOUNCE_MS });
          return;
        }

        if (message.type === 'toggleExpandItems') {
          void (async () => {
            await setExpandFilterResultsSetting(Boolean(message.checked));
            applyFilter(treeProvider.getTableNameFilter());
          })();
        }
      });
    },
  };

  context.subscriptions.push(treeView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('databaseExplorerFilter', filterViewProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.refresh', async () => {
      await treeProvider.reloadAllMetadata();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editTableFilter', async () => {
      const current = treeProvider.getTableNameFilter();
      const value = await vscode.window.showInputBox({
        title: 'Filtro de tabelas',
        value: current,
        valueSelection: [0, current.length],
      });

      if (value === undefined) {
        return;
      }

      applyFilter(value);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.clearTableFilter', () => {
      applyFilter('');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.spacer', () => {
      // Noop command for visual spacing in context menus
    })
  );

  applyFilter(treeProvider.getTableNameFilter());
  treeProvider.initializeMetadataCache();



  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.createConnection', async () => {
      try {
        const payload = await showConnectionForm(context, postgresService, 'create');
        if (!payload) {
          return;
        }

        await store.createConnection(payload);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexão criada com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editConnection', async (node?: { connection?: PostgresConnection }) => {
      try {
        const target = await resolveConnectionFromNodeOrPicker(store, node?.connection);
        if (!target) {
          return;
        }

        const payload = await showConnectionForm(context, postgresService, 'edit', target);
        if (!payload) {
          return;
        }

        const updated = await store.updateConnection(target.id, payload);
        if (node?.connection) {
          Object.assign(node.connection, updated);
        }
        treeProvider.clearConnectionCache(target.id);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexão atualizada com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.deleteConnection', async (node?: { connection?: PostgresConnection }) => {
      try {
        const target = await resolveConnectionFromNodeOrPicker(store, node?.connection);
        if (!target) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Deseja remover a conexão "${target.nickname}"?`,
          { modal: true },
          'Remover'
        );

        if (confirmation !== 'Remover') {
          return;
        }

        await store.deleteConnection(target.id);
        treeProvider.clearConnectionCache(target.id);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexão removida com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openSettings', async () => {
      try {
        settingsPanel.show();
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openTable', async (node?: DbObjectNodeRef) => {
      if (!node || node.type !== 'dbObject' || node.kind !== 'table') {
        return;
      }

      await tablePanels.openTable({
        node,
        newTab: false,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openTableInNewTab', async (node?: DbObjectNodeRef) => {
      if (!node || node.type !== 'dbObject' || node.kind !== 'table') {
        return;
      }

      await tablePanels.openTable({
        node,
        newTab: true,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.showInExplorer', async (node?: DbObjectNodeRef) => {
      if (!node || node.type !== 'dbObject' || node.kind !== 'table') {
        return;
      }

      try {
        await vscode.commands.executeCommand('workbench.view.extension.dbadmin');
      } catch {
        // Ignore if host does not support the command.
      }

      try {
        await treeView.reveal(node, {
          select: true,
          focus: true,
          expand: false,
        });
      } catch {
        treeProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbadmin.createDatabase',
      async (node?: ConnectionNodeRef) => {
        try {
          const connection = node?.connection ?? (await resolveConnectionFromNodeOrPicker(store));
          if (!connection) {
            return;
          }

          const name = await vscode.window.showInputBox({
            title: 'Criar banco de dados',
            prompt: 'Nome do novo banco de dados',
            validateInput: (value) => (value.trim() ? undefined : 'Informe um nome.'),
          });

          if (!name) {
            return;
          }

          await postgresService.createDatabase(connection, name.trim());
          treeProvider.refresh();
          vscode.window.showInformationMessage(`Banco de dados "${name.trim()}" criado com sucesso.`);
        } catch (error) {
          showError(error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbadmin.renameDatabase',
      async (node?: DatabaseNodeRef) => {
        try {
          if (!node || node.type !== 'database') {
            return;
          }

          const newName = await vscode.window.showInputBox({
            title: `Renomear banco de dados "${node.databaseName}"`,
            prompt: 'Novo nome',
            value: node.databaseName,
            validateInput: (value) => (value.trim() ? undefined : 'Informe um nome.'),
          });

          if (!newName || newName.trim() === node.databaseName) {
            return;
          }

          await postgresService.renameDatabase(node.connection, node.databaseName, newName.trim());
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            `Banco de dados renomeado para "${newName.trim()}".`
          );
        } catch (error) {
          showError(error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbadmin.dropDatabase',
      async (node?: DatabaseNodeRef) => {
        try {
          if (!node || node.type !== 'database') {
            return;
          }

          const confirmation = await vscode.window.showWarningMessage(
            `Deseja excluir permanentemente o banco de dados "${node.databaseName}"? Esta ação não pode ser desfeita.`,
            { modal: true },
            'Excluir'
          );

          if (confirmation !== 'Excluir') {
            return;
          }

          await postgresService.dropDatabase(node.connection, node.databaseName);
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            `Banco de dados "${node.databaseName}" excluído com sucesso.`
          );
        } catch (error) {
          showError(error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbadmin.backupSchema',
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== 'schema') {
            return;
          }
          backupPanels.show(context, node);
        } catch (error) {
          showError(error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbadmin.restoreSchema',
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== 'schema') {
            return;
          }
          restorePanels.show(context, node);
        } catch (error) {
          showError(error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openColumnDetails', async (node?: TableSectionItemNodeRef) => {
      try {
        if (!node || node.type !== 'tableSectionItem' || node.itemKind !== 'column') {
          return;
        }
        await metadataPanels.showColumn(node, { newTab: false });
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openColumnDetailsInNewTab', async (node?: TableSectionItemNodeRef) => {
      try {
        if (!node || node.type !== 'tableSectionItem' || node.itemKind !== 'column') {
          return;
        }
        await metadataPanels.showColumn(node, { newTab: true });
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openConstraintDetails', async (node?: TableSectionItemNodeRef) => {
      try {
        if (!node || node.type !== 'tableSectionItem' || node.itemKind !== 'constraint') {
          return;
        }
        await metadataPanels.showConstraint(node, { newTab: false });
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dbadmin.openConstraintDetailsInNewTab',
      async (node?: TableSectionItemNodeRef) => {
        try {
          if (!node || node.type !== 'tableSectionItem' || node.itemKind !== 'constraint') {
            return;
          }
          await metadataPanels.showConstraint(node, { newTab: true });
        } catch (error) {
          showError(error);
        }
      }
    )
  );
}

export function deactivate(): void {}

async function resolveConnectionFromNodeOrPicker(
  store: ConnectionStore,
  selectedFromTree?: PostgresConnection
): Promise<PostgresConnection | undefined> {
  if (selectedFromTree) {
    return selectedFromTree;
  }

  const all = await store.listConnections();
  if (all.length === 0) {
    vscode.window.showInformationMessage('Não existem conexões cadastradas.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    all.map((connection) => ({
      label: connection.nickname,
      description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
      connection,
    })),
    {
      placeHolder: 'Selecione a conexão',
    }
  );

  return selected?.connection;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Erro inesperado';
  vscode.window.showErrorMessage(message);
}

function buildFilterViewHtml(
  webview: vscode.Webview,
  initialValue: string,
  initialExpandItems: boolean
): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      min-height: 40px;
      height: 100%;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
    }

    .wrap {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      min-height: 40px;
      padding: 6px;
      box-sizing: border-box;
    }

    #tableFilter {
      flex: 1;
      min-width: 0;
      height: 28px;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 12px;
    }

    .check-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      user-select: none;
    }

    .check-row input {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      min-width: 14px;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      border-radius: 0;
      accent-color: var(--vscode-focusBorder);
    }

  </style>
</head>
<body>
  <div class="wrap">
    <input id="tableFilter" type="text" placeholder="Filtrar tabelas..." value="${escapeHtml(initialValue)}" />
    <label class="check-row" title="Expandir apenas conexões e bancos com tabelas encontradas">
      <input id="expandItems" type="checkbox" ${initialExpandItems ? 'checked' : ''} />
      <span>Expandir itens</span>
    </label>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('tableFilter');
    const expandItems = document.getElementById('expandItems');

    input.addEventListener('input', () => {
      vscode.postMessage({
        type: 'filterChanged',
        value: input.value,
      });
    });

    expandItems.addEventListener('change', () => {
      vscode.postMessage({
        type: 'toggleExpandItems',
        checked: Boolean(expandItems.checked),
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'setFilterValue') {
        input.value = String(message.value ?? '');
        return;
      }

      if (message.type === 'setExpandItems') {
        expandItems.checked = Boolean(message.value);
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
