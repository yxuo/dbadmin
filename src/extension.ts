import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { showConnectionForm } from './connectionFormPanel';
import { DatabaseTreeProvider } from './databaseTreeProvider';
import {
  ConnectionNodeRef,
  DatabaseGroupNodeRef,
  DatabaseNodeRef,
  DbObjectNodeRef,
  ObjectGroupNodeRef,
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
import { SqlBookSerializer, SqlBookController } from './sqlBookNotebook';

const EXPAND_FILTER_RESULTS_SETTING = 'dbadmin.expandFilterResults';
const FILTER_INPUT_DEBOUNCE_MS = 180;
const DBADMIN_SQL_ACTIVE_PREFIX = '-- Active:';

interface SqlRunnerContext {
  connectionId?: string;
  connectionName?: string;
  connectionHost?: string;
  connectionPort?: number;
  databaseName?: string;
  schemaName?: string;
}

interface SqlRelationRef {
  schemaName?: string;
  tableName: string;
  alias?: string;
}

interface SqlSchemaRelation {
  name: string;
  type: 'table' | 'view';
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = ConnectionStore.getWorkspaceRoot();
  const storageRoot = workspaceRoot || context.globalStorageUri.fsPath;
  const store = new ConnectionStore(storageRoot);
  const postgresService = new PostgresService();
  const treeProvider = new DatabaseTreeProvider(store, postgresService, context.extensionPath);
  const tablePanels = new TableDataPanelManager(context, postgresService);
  const settingsPanel = new SettingsPanelManager(context, () => store.getStorageFilePath());
  const backupPanels = new BackupPanelManager(context);
  const restorePanels = new RestorePanelManager(context, async () => {
    await treeProvider.reloadAllMetadata();
  });
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
        applyFilter(treeProvider.getTableNameFilter(), { origin: 'config-change' });
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
  let searchOnTypeEnabled = true;

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

  const runFilter = async (rawValue: string, _origin: string = 'unknown'): Promise<void> => {
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

    await vscode.commands.executeCommand('databaseExplorer.focus');
    if (isStale()) {
      return;
    }

    for (const tablesGroup of filteredPaths) {
      if (isStale()) {
        return;
      }

      // Se depender da quickpick, melhor dar um tempinho para o VSCode gerar a treeview com sucesso
      if (_origin === 'quickpick') {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      await treeView.reveal(tablesGroup, {
        select: false,
        focus: false,
        expand: true,
      });
    }
  };

  const applyFilter = (rawValue: string, options?: { debounceMs?: number; origin?: string }): void => {
    if (pendingFilterTimeout) {
      clearTimeout(pendingFilterTimeout);
      pendingFilterTimeout = undefined;
    }

    const origin = options?.origin ?? 'unknown';
    const debounceMs = options?.debounceMs ?? 0;
    if (debounceMs > 0) {
      pendingFilterTimeout = setTimeout(() => {
        pendingFilterTimeout = undefined;
        void runFilter(rawValue, origin);
      }, debounceMs);
      return;
    }

    void runFilter(rawValue, origin);
  };

  const filterViewProvider: vscode.WebviewViewProvider = {
    resolveWebviewView: (webviewView) => {
      filterView = webviewView;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = buildFilterViewHtml(
        webviewView.webview,
        treeProvider.getTableNameFilter(),
        getExpandFilterResultsSetting(),
        searchOnTypeEnabled
      );

      webviewView.onDidDispose(() => {
        if (filterView === webviewView) {
          filterView = undefined;
        }
      });

      webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: string; checked?: boolean }) => {
        if (message.type === 'filterChanged') {
          if (searchOnTypeEnabled) {
            applyFilter(String(message.value ?? ''), { debounceMs: FILTER_INPUT_DEBOUNCE_MS, origin: 'sidebar-typing' });
          }
          return;
        }

        if (message.type === 'filterSubmitted') {
          applyFilter(String(message.value ?? ''), { origin: 'sidebar-enter' });
          return;
        }

        if (message.type === 'toggleSearchOnType') {
          searchOnTypeEnabled = Boolean(message.checked);
          if (filterView) {
            void filterView.webview.postMessage({
              type: 'setSearchOnType',
              value: searchOnTypeEnabled,
            });
          }
          return;
        }

        if (message.type === 'toggleExpandItems') {
          void (async () => {
            await setExpandFilterResultsSetting(Boolean(message.checked));
            applyFilter(treeProvider.getTableNameFilter(), { origin: 'toggle-expand' });
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
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, createSqlRunnerCodeLensProvider(store))
  );
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      createSqlRunnerCompletionItemProvider(store, postgresService),
      '.',
      ' ',
      ','
    )
  );

  const sqlActiveLineDeco = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(sqlActiveLineDeco);

  const refreshSqlActiveDecorations = async (editor: vscode.TextEditor): Promise<void> => {
    if (editor.document.languageId !== 'sql') {
      editor.setDecorations(sqlActiveLineDeco, []);
      return;
    }

    const allConnections = await store.listConnections();
    const nicknamesById = new Map(
      allConnections.map((connection) => [connection.id, connection.nickname.trim()] as const)
    );

    const lines = editor.document.getText().split(/\r?\n/);
    const decorations: vscode.DecorationOptions[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith(DBADMIN_SQL_ACTIVE_PREFIX)) {
        continue;
      }
      const payload = trimmed.slice(DBADMIN_SQL_ACTIVE_PREFIX.length).trim();
      const ctx = parseSqlRunnerActiveContext(payload);
      const nickname =
        (ctx.connectionId ? nicknamesById.get(ctx.connectionId) : undefined) ||
        ctx.connectionName?.trim();
      if (!nickname) {
        continue;
      }
      const lineRange = editor.document.lineAt(i).range;
      decorations.push({
        range: lineRange,
        renderOptions: {
          after: {
            contentText: `  ${nickname}`,
            color: new vscode.ThemeColor('terminal.ansiBrightBlue'),
            fontWeight: 'bold',
          },
        },
      });
    }

    editor.setDecorations(sqlActiveLineDeco, decorations);
  };

  if (vscode.window.activeTextEditor) {
    void refreshSqlActiveDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void refreshSqlActiveDecorations(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === event.document) {
        void refreshSqlActiveDecorations(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.refresh', async () => {
      await treeProvider.reloadAllMetadata();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editTableFilter', async () => {
      const current = treeProvider.getTableNameFilter();
      const expandLabel = 'Expandir itens';
      const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
      quickPick.title = 'Filtro de tabelas';
      quickPick.placeholder = 'Digite para filtrar tabelas...';
      quickPick.value = current;
      quickPick.canSelectMany = true;

      const expandItem: vscode.QuickPickItem = {
        label: expandLabel,
        description: '',
        alwaysShow: true,
        picked: getExpandFilterResultsSetting(),
      };

      quickPick.items = [expandItem];
      if (expandItem.picked) {
        quickPick.selectedItems = [expandItem];
      }

      await new Promise<void>((resolve) => {
        let accepted = false;

        quickPick.onDidAccept(() => {
          accepted = true;
          const value = quickPick.value;
          const expandEnabled = quickPick.selectedItems.some((item) => item.label === expandLabel);

          void (async () => {
            if (expandEnabled !== getExpandFilterResultsSetting()) {
              await setExpandFilterResultsSetting(expandEnabled);
            }
            applyFilter(value, { origin: 'quickpick' });
            resolve();
          })();

          quickPick.hide();
        });

        quickPick.onDidHide(() => {
          quickPick.dispose();
          if (!accepted) {
            resolve();
          }
        });

        quickPick.show();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.clearTableFilter', () => {
      applyFilter('', { origin: 'clear-command' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.executeSqlFromActiveEditor', async () => {
      try {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          vscode.window.showInformationMessage('Nenhum editor SQL ativo para execução.');
          return;
        }

        await executeSqlFromEditorDocument(activeEditor.document, store, postgresService);
        await treeProvider.reloadAllMetadata();
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.sqlRunner.selectConnection', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        const document = editor?.document;
        if (!document || !isDbAdminSqlRunnerDocument(document)) {
          return;
        }

        const allConnections = await store.listConnections();
        if (allConnections.length === 0) {
          vscode.window.showInformationMessage('Não há conexões cadastradas.');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          allConnections.map((connection) => ({
            label: connection.nickname,
            description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
            connection,
          })),
          { placeHolder: 'Selecione a conexão' }
        );

        if (!picked) {
          return;
        }

        const databases = await postgresService.listDatabases(picked.connection);
        if (databases.length === 0) {
          vscode.window.showInformationMessage('Nenhum banco disponível para essa conexão.');
          return;
        }

        const pickedDatabase = await vscode.window.showQuickPick(databases, {
          placeHolder: 'Selecione o banco',
        });

        if (!pickedDatabase) {
          return;
        }

        const schemas = await postgresService.listSchemas(picked.connection, pickedDatabase);
        const schemaItems: Array<{ label: string; schemaName?: string; description?: string }> = [
          {
            label: 'Sem schema',
            description: 'Usar search_path padrão da conexão',
            schemaName: undefined,
          },
          ...schemas.map((schemaName) => ({ label: schemaName, schemaName })),
        ];

        const pickedSchema = await vscode.window.showQuickPick(schemaItems, {
          placeHolder: 'Selecione o schema (opcional)',
        });

        if (!pickedSchema) {
          return;
        }

        const parsed = parseSqlRunnerHeader(document.getText());
        await rewriteSqlRunnerHeader(document, {
          ...parsed.context,
          connectionId: picked.connection.id,
          connectionHost: picked.connection.host,
          connectionPort: picked.connection.port,
          databaseName: pickedDatabase,
          schemaName: pickedSchema.schemaName,
        });
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.sqlRunner.selectDatabase', async () => {
      await vscode.commands.executeCommand('dbadmin.sqlRunner.selectConnection');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.sqlRunner.selectSchema', async () => {
      await vscode.commands.executeCommand('dbadmin.sqlRunner.selectConnection');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.spacer', () => {
      // Noop command for visual spacing in context menus
    })
  );

  applyFilter(treeProvider.getTableNameFilter(), { origin: 'init' });



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
    vscode.commands.registerCommand('dbadmin.refreshConnection', (node?: ConnectionNodeRef) => {
      if (!node || node.type !== 'connection') {
        return;
      }

      treeProvider.reloadConnection(node.connection);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.refreshDatabase', (node?: DatabaseNodeRef) => {
      if (!node || node.type !== 'database') {
        return;
      }

      treeProvider.reloadDatabase(node.connection, node.databaseName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.refreshSchema', (node?: SchemaNodeRef) => {
      if (!node || node.type !== 'schema') {
        return;
      }

      treeProvider.reloadSchema(node.connection, node.databaseName, node.schemaName);
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
    vscode.commands.registerCommand('dbadmin.truncateTable', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'table') {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Deseja esvaziar a tabela "${node.schemaName}.${node.objectName}"? Esta ação remove todos os registros e também pode esvaziar tabelas relacionadas por chave estrangeira (CASCADE).`,
          { modal: true },
          'Esvaziar'
        );

        if (confirmation !== 'Esvaziar') {
          return;
        }

        await postgresService.truncateTable(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );

        await treeProvider.reloadAllMetadata();
        vscode.window.showInformationMessage(
          `Tabela "${node.schemaName}.${node.objectName}" esvaziada com sucesso.`
        );
      } catch (error) {
        showError(error);
      }
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
      'dbadmin.createSchema',
      async (node?: DatabaseGroupNodeRef) => {
        try {
          if (!node || node.type !== 'databaseGroup' || node.kind !== 'schemas') {
            return;
          }

          const schemaName = await vscode.window.showInputBox({
            title: `Criar schema em "${node.databaseName}"`,
            prompt: 'Nome do novo schema',
            validateInput: (value) => (value.trim() ? undefined : 'Informe um nome.'),
          });

          if (!schemaName) {
            return;
          }

          await postgresService.createSchema(node.connection, node.databaseName, schemaName.trim());
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            `Schema "${schemaName.trim()}" criado com sucesso.`
          );
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
    vscode.commands.registerCommand(
      'dbadmin.dropSchema',
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== 'schema') {
            return;
          }

          const confirmation = await vscode.window.showWarningMessage(
            `Deseja excluir permanentemente o schema "${node.schemaName}" e todos os seus objetos? Esta ação não pode ser desfeita.`,
            { modal: true },
            'Excluir'
          );

          if (confirmation !== 'Excluir') {
            return;
          }

          await postgresService.dropSchema(node.connection, node.databaseName, node.schemaName);
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            `Schema "${node.schemaName}" excluído com sucesso.`
          );
        } catch (error) {
          showError(error);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.createFunction', async (node?: ObjectGroupNodeRef) => {
      try {
        if (!node || node.type !== 'objectGroup' || node.kind !== 'function') {
          return;
        }

        const initialSql = buildCreateFunctionTemplate(node.schemaName);
        await openSqlRunnerEditor(
          `Criar function em ${node.schemaName}`,
          initialSql,
          'Edite o SQL da function e execute com Ctrl+Enter ou CodeLens.',
          {
            connectionId: node.connection.id,
            connectionName: node.connection.nickname,
            connectionHost: node.connection.host,
            connectionPort: node.connection.port,
            databaseName: node.databaseName,
            schemaName: node.schemaName,
          }
        );
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editFunction', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'function') {
          return;
        }

        const definition = await postgresService.getFunctionDefinition(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );

        await openSqlRunnerEditor(
          `Editar function ${node.schemaName}.${node.objectName}`,
          ensureSqlEndsWithSemicolon(definition),
          'Edite a definição e execute com Ctrl+Enter ou CodeLens.',
          {
            connectionId: node.connection.id,
            connectionName: node.connection.nickname,
            connectionHost: node.connection.host,
            connectionPort: node.connection.port,
            databaseName: node.databaseName,
            schemaName: node.schemaName,
          }
        );
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.deleteFunction', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'function') {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Excluir function "${node.schemaName}.${node.objectName}"?`,
          { modal: true },
          'Excluir'
        );

        if (confirmation !== 'Excluir') {
          return;
        }

        await postgresService.dropFunction(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );
        await treeProvider.reloadAllMetadata();
        vscode.window.showInformationMessage('Function excluída com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.createProcedure', async (node?: ObjectGroupNodeRef) => {
      try {
        if (!node || node.type !== 'objectGroup' || node.kind !== 'procedure') {
          return;
        }

        const initialSql = buildCreateProcedureTemplate(node.schemaName);
        await openSqlRunnerEditor(
          `Criar procedure em ${node.schemaName}`,
          initialSql,
          'Edite o SQL da procedure e execute com Ctrl+Enter ou CodeLens.',
          {
            connectionId: node.connection.id,
            connectionName: node.connection.nickname,
            connectionHost: node.connection.host,
            connectionPort: node.connection.port,
            databaseName: node.databaseName,
            schemaName: node.schemaName,
          }
        );
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editProcedure', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'procedure') {
          return;
        }

        const definition = await postgresService.getProcedureDefinition(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );

        await openSqlRunnerEditor(
          `Editar procedure ${node.schemaName}.${node.objectName}`,
          ensureSqlEndsWithSemicolon(definition),
          'Edite a definição e execute com Ctrl+Enter ou CodeLens.',
          {
            connectionId: node.connection.id,
            connectionName: node.connection.nickname,
            connectionHost: node.connection.host,
            connectionPort: node.connection.port,
            databaseName: node.databaseName,
            schemaName: node.schemaName,
          }
        );
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.deleteProcedure', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'procedure') {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Excluir procedure "${node.schemaName}.${node.objectName}"?`,
          { modal: true },
          'Excluir'
        );

        if (confirmation !== 'Excluir') {
          return;
        }

        await postgresService.dropProcedure(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );
        await treeProvider.reloadAllMetadata();
        vscode.window.showInformationMessage('Procedure excluída com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.createTrigger', async (node?: ObjectGroupNodeRef) => {
      try {
        if (!node || node.type !== 'objectGroup' || node.kind !== 'trigger') {
          return;
        }

        const initialSql = buildCreateTriggerTemplate(node.schemaName);
        await openSqlRunnerEditor(
          `Criar trigger em ${node.schemaName}`,
          initialSql,
          'Edite o SQL da trigger e execute com Ctrl+Enter ou CodeLens.',
          {
            connectionId: node.connection.id,
            connectionName: node.connection.nickname,
            connectionHost: node.connection.host,
            connectionPort: node.connection.port,
            databaseName: node.databaseName,
            schemaName: node.schemaName,
          }
        );
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editTrigger', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'trigger') {
          return;
        }

        const trigger = await postgresService.getTriggerDefinition(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );

        const initialSql = [
          `DROP TRIGGER IF EXISTS ${quoteIdentifier(node.objectName)} ON ${quoteIdentifier(node.schemaName)}.${quoteIdentifier(trigger.tableName)};`,
          ensureSqlEndsWithSemicolon(trigger.definition),
        ].join('\n\n');

        await openSqlRunnerEditor(
          `Editar trigger ${node.schemaName}.${node.objectName}`,
          initialSql,
          'Edite o SQL da trigger e execute com Ctrl+Enter ou CodeLens.',
          {
            connectionId: node.connection.id,
            connectionName: node.connection.nickname,
            connectionHost: node.connection.host,
            connectionPort: node.connection.port,
            databaseName: node.databaseName,
            schemaName: node.schemaName,
          }
        );
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.deleteTrigger', async (node?: DbObjectNodeRef) => {
      try {
        if (!node || node.type !== 'dbObject' || node.kind !== 'trigger') {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Excluir trigger "${node.schemaName}.${node.objectName}"?`,
          { modal: true },
          'Excluir'
        );

        if (confirmation !== 'Excluir') {
          return;
        }

        await postgresService.dropTrigger(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName
        );
        await treeProvider.reloadAllMetadata();
        vscode.window.showInformationMessage('Trigger excluída com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
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

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('sqlbook', new SqlBookSerializer())
  );
  context.subscriptions.push(new SqlBookController(store, postgresService));
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

async function openSqlRunnerEditor(
  title: string,
  initialSql: string,
  guidanceMessage: string,
  runnerContext: SqlRunnerContext
): Promise<void> {
  const content = buildSqlRunnerDocumentContent(initialSql, runnerContext);
  const document = await vscode.workspace.openTextDocument({
    language: 'sql',
    content,
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Active,
  });

  void vscode.window.setStatusBarMessage(`${title}. ${guidanceMessage}`, 4500);
}

function buildSqlRunnerDocumentContent(sql: string, context: SqlRunnerContext): string {
  return [
    `${DBADMIN_SQL_ACTIVE_PREFIX} ${serializeSqlRunnerActiveContext(context)}`,
    ensureSqlEndsWithSemicolon(sql),
  ].join('\n');
}

function getExecutableSqlFromDocument(document: vscode.TextDocument): string {
  const parsed = parseSqlRunnerHeader(document.getText());
  return parsed.sql;
}

function isDbAdminSqlRunnerDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'sql';
}

async function rewriteSqlRunnerHeader(
  document: vscode.TextDocument,
  context: SqlRunnerContext
): Promise<void> {
  const parsed = parseSqlRunnerHeader(document.getText());
  const mergedContext: SqlRunnerContext = {
    ...parsed.context,
    ...context,
  };
  const nextContent = buildSqlRunnerDocumentContent(parsed.sql, mergedContext);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  edit.replace(document.uri, fullRange, nextContent);
  await vscode.workspace.applyEdit(edit);
}

function parseSqlRunnerHeader(text: string): { context: SqlRunnerContext; sql: string } {
  const lines = String(text || '').split(/\r?\n/);
  const context: SqlRunnerContext = {};
  const sqlLines: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Ignora a marca legada (arquivos antigos)
    if (line === '-- DBADMIN-SQL-RUNNER') {
      continue;
    }

    if (line.startsWith(DBADMIN_SQL_ACTIVE_PREFIX)) {
      const activePayload = line.slice(DBADMIN_SQL_ACTIVE_PREFIX.length).trim();
      Object.assign(context, parseSqlRunnerActiveContext(activePayload));
      continue;
    }

    sqlLines.push(rawLine);
  }

  return { context, sql: sqlLines.join('\n').trim() };
}

function createSqlRunnerCodeLensProvider(store: ConnectionStore): vscode.CodeLensProvider {
  return {
    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
      if (!isDbAdminSqlRunnerDocument(document)) {
        return [];
      }

      const parsed = parseSqlRunnerHeader(document.getText());
      const context = parsed.context;
      const allConnections = await store.listConnections();
      const connectionById = new Map(
        allConnections.map((connection) => [connection.id, connection] as const)
      );

      let activeLine = 0;
      for (let i = 0; i < document.lineCount; i++) {
        if (document.lineAt(i).text.trim().startsWith(DBADMIN_SQL_ACTIVE_PREFIX)) {
          activeLine = i;
          break;
        }
      }
      const range = new vscode.Range(activeLine, 0, activeLine, 0);

      const resolvedConnection = context.connectionId
        ? connectionById.get(context.connectionId)
        : undefined;
      const connectionLabel = resolvedConnection?.nickname?.trim() ||
        context.connectionName?.trim() ||
        formatHostPort(context.connectionHost, context.connectionPort) ||
        context.connectionId?.trim() || 'Conexão';
      const databaseLabel = context.databaseName?.trim() || 'Banco';
      const isConfigSelected = Boolean(context.connectionId) && Boolean(context.databaseName);
      const isSchemaSelected = isConfigSelected && Boolean(context.schemaName);
      const schemaLabel = isSchemaSelected ? ` $(type-hierarchy-sub) ${context.schemaName?.trim()}` : '';
      const contextButtonLabel = isConfigSelected
        ? `$(plug) ${connectionLabel} $(database) ${databaseLabel}` + schemaLabel
        : "$(plug) Selecionar conexão";

      return [
        new vscode.CodeLens(range, {
          title: contextButtonLabel,
          command: 'dbadmin.sqlRunner.selectConnection',
        }),
        new vscode.CodeLens(range, {
          title: '$(play) Executar',
          command: 'dbadmin.executeSqlFromActiveEditor',
        }),
      ];
    },
  };
}

function createSqlRunnerCompletionItemProvider(
  store: ConnectionStore,
  postgresService: PostgresService
): vscode.CompletionItemProvider {
  const cacheTtlMs = 15_000;
  const cache = new Map<string, { expiresAt: number; value: unknown }>();

  const getCached = async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const value = await loader();
    cache.set(key, { expiresAt: now + cacheTtlMs, value });
    return value;
  };

  const loadSchemas = async (
    connection: PostgresConnection,
    databaseName: string
  ): Promise<string[]> => getCached(
    `schemas:${connection.id}:${databaseName}`,
    () => postgresService.listSchemas(connection, databaseName)
  );

  const loadRelations = async (
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<SqlSchemaRelation[]> => getCached(
    `relations:${connection.id}:${databaseName}:${schemaName}`,
    async () => {
      const [tables, views] = await Promise.all([
        postgresService.listTables(connection, databaseName, schemaName),
        postgresService.listViews(connection, databaseName, schemaName),
      ]);

      return [
        ...tables.map((name) => ({ name, type: 'table' as const })),
        ...views.map((name) => ({ name, type: 'view' as const })),
      ];
    }
  );

  const loadColumns = async (
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string
  ) => getCached(
    `columns:${connection.id}:${databaseName}:${schemaName}:${tableName}`,
    () => postgresService.listTableColumnsDetailed(connection, databaseName, schemaName, tableName)
  );

  return {
    async provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position
    ): Promise<vscode.CompletionItem[]> {
      if (!isDbAdminSqlRunnerDocument(document)) {
        return [];
      }

      const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
      if (linePrefix.trimStart().startsWith('--')) {
        return [];
      }

      const fullParsed = parseSqlRunnerHeader(document.getText());
      const beforeCursorParsed = parseSqlRunnerHeader(
        document.getText(new vscode.Range(new vscode.Position(0, 0), position))
      );
      const runnerContext = fullParsed.context;

      if (!runnerContext.connectionId || !runnerContext.databaseName) {
        return [];
      }

      const allConnections = await store.listConnections();
      const connection = resolveConnectionFromHeaderContext(allConnections, runnerContext);
      if (!connection) {
        return [];
      }

      const currentSql = beforeCursorParsed.sql;
      const fullSql = fullParsed.sql;
      const currentWordMatch = linePrefix.match(/([a-zA-Z_][\w$]*)$/);
      const currentWord = currentWordMatch?.[1] ?? '';
      const currentRange = new vscode.Range(
        position.line,
        position.character - currentWord.length,
        position.line,
        position.character
      );

      const tripleQualifiedMatch = linePrefix.match(
        /([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)?$/i
      );
      if (tripleQualifiedMatch) {
        const [, schemaNameRaw, tableNameRaw, columnPrefixRaw = ''] = tripleQualifiedMatch;
        const schemaName = schemaNameRaw.trim();
        const tableName = tableNameRaw.trim();
        const columnPrefix = columnPrefixRaw.trim();
        const range = new vscode.Range(
          position.line,
          position.character - columnPrefix.length,
          position.line,
          position.character
        );
        const columns = await loadColumns(connection, runnerContext.databaseName, schemaName, tableName);
        return columns
          .filter((column) => matchesSqlPrefix(column.name, columnPrefix))
          .map((column) => buildSqlColumnCompletionItem(column.name, schemaName, tableName, range));
      }

      const dottedMatch = linePrefix.match(/([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)?$/i);
      if (dottedMatch) {
        const [, leftRaw, rightRaw = ''] = dottedMatch;
        const left = leftRaw.trim();
        const right = rightRaw.trim();
        const range = new vscode.Range(
          position.line,
          position.character - right.length,
          position.line,
          position.character
        );

        const references = extractSqlTableReferences(fullSql, runnerContext.schemaName);
        const matchedReference = references.find(
          (reference) => reference.alias === left || reference.tableName === left
        );

        if (matchedReference?.schemaName) {
          const matchedSchemaName = matchedReference.schemaName;
          const columns = await loadColumns(
            connection,
            runnerContext.databaseName,
            matchedSchemaName,
            matchedReference.tableName
          );
          return columns
            .filter((column) => matchesSqlPrefix(column.name, right))
            .map((column) =>
              buildSqlColumnCompletionItem(
                column.name,
                matchedSchemaName,
                matchedReference.tableName,
                range
              )
            );
        }

        const schemas = await loadSchemas(connection, runnerContext.databaseName);
        if (schemas.some((schemaName) => schemaName === left)) {
          const relations = await loadRelations(connection, runnerContext.databaseName, left);
          return relations
            .filter((relation) => matchesSqlPrefix(relation.name, right))
            .map((relation) => buildSqlRelationCompletionItem(relation, left, range));
        }
      }

      const wantsRelationSuggestions = /\b(from|join|update|into|truncate\s+table|table)\s+[a-zA-Z_\d$]*$/i.test(
        linePrefix
      );

      if (wantsRelationSuggestions) {
        if (runnerContext.schemaName) {
          const relations = await loadRelations(
            connection,
            runnerContext.databaseName,
            runnerContext.schemaName
          );
          return relations
            .filter((relation) => matchesSqlPrefix(relation.name, currentWord))
            .map((relation) =>
              buildSqlRelationCompletionItem(relation, runnerContext.schemaName as string, currentRange)
            );
        }

        const schemas = await loadSchemas(connection, runnerContext.databaseName);
        return schemas
          .filter((schemaName) => matchesSqlPrefix(schemaName, currentWord))
          .map((schemaName) => buildSqlSchemaCompletionItem(schemaName, currentRange));
      }

      const references = extractSqlTableReferences(fullSql, runnerContext.schemaName);
      if (references.length === 0) {
        return [];
      }

      const wantsColumnSuggestions = /\b(select|where|and|or|on|order\s+by|group\s+by|having|set|returning)\b[\s\S]*$/i.test(
        currentSql
      ) || /,\s*[a-zA-Z_\d$]*$/i.test(linePrefix);

      if (!wantsColumnSuggestions) {
        return [];
      }

      const items: vscode.CompletionItem[] = [];
      for (const reference of references) {
        if (!reference.schemaName) {
          continue;
        }

        const columns = await loadColumns(
          connection,
          runnerContext.databaseName,
          reference.schemaName,
          reference.tableName
        );

        items.push(
          ...columns
            .filter((column) => matchesSqlPrefix(column.name, currentWord))
            .map((column) =>
              buildSqlColumnCompletionItem(
                column.name,
                reference.schemaName as string,
                reference.tableName,
                currentRange,
                reference.alias || reference.tableName
              )
            )
        );
      }

      return dedupeCompletionItems(items);
    },
  };
}

function serializeSqlRunnerActiveContext(context: SqlRunnerContext): string {
  const id = String(context.connectionId || '').trim();
  const host = String(context.connectionHost || '').trim();
  const port = String(context.connectionPort ?? '').trim();
  const database = String(context.databaseName || '').trim();
  const schema = String(context.schemaName || '').trim();

  return `${id}@@${host}@${port}@${database}${schema ? `@${schema}` : ''}`;
}

function parseSqlRunnerActiveContext(value: string): SqlRunnerContext {
  const raw = String(value || '').trim();
  if (!raw) {
    return {};
  }

  const parts = raw.split('@@');
  let id: string;
  let name: string | undefined;
  let rest: string;

  if (parts.length >= 3) {
    // Formato legado: id@@name@@host@port@database@schema
    id = parts[0];
    name = parts[1];
    rest = parts.slice(2).join('@@');
  } else {
    // Formato atual: id@@host@port@database@schema
    id = parts[0];
    name = undefined;
    rest = parts[1] || '';
  }

  const restParts = rest.split('@');
  const [host = '', portRaw = '', database = '', schema = ''] = restParts;
  const parsedPort = Number(portRaw);

  return {
    connectionId: id.trim() || undefined,
    connectionName: name?.trim() || undefined,
    connectionHost: host.trim() || undefined,
    connectionPort: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined,
    databaseName: database.trim() || undefined,
    schemaName: schema.trim() || undefined,
  };
}

function extractSqlTableReferences(sql: string, defaultSchemaName?: string): SqlRelationRef[] {
  const text = String(sql || '');
  const references: SqlRelationRef[] = [];
  const matcher = /\b(?:from|join|update|into)\s+((?:[a-zA-Z_][\w$]*\.)?[a-zA-Z_][\w$]*)(?:\s+(?:as\s+)?([a-zA-Z_][\w$]*))?/gi;

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const rawName = String(match[1] || '').trim();
    if (!rawName) {
      continue;
    }

    const alias = String(match[2] || '').trim() || undefined;
    const parts = rawName.split('.').map((part) => part.trim()).filter(Boolean);
    const schemaName = parts.length > 1 ? parts[0] : defaultSchemaName;
    const tableName = parts.length > 1 ? parts[1] : parts[0];

    if (!tableName) {
      continue;
    }

    references.push({ schemaName, tableName, alias });
  }

  return references;
}

function matchesSqlPrefix(value: string, prefix: string): boolean {
  const normalizedValue = String(value || '').toLowerCase();
  const normalizedPrefix = String(prefix || '').toLowerCase();
  return !normalizedPrefix || normalizedValue.startsWith(normalizedPrefix);
}

function buildSqlSchemaCompletionItem(
  schemaName: string,
  range: vscode.Range
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(schemaName, vscode.CompletionItemKind.Module);
  item.detail = 'Schema';
  item.insertText = schemaName;
  item.range = range;
  item.sortText = `00_schema_${schemaName.toLowerCase()}`;
  item.preselect = true;
  return item;
}

function buildSqlRelationCompletionItem(
  relation: SqlSchemaRelation,
  schemaName: string,
  range: vscode.Range
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    relation.name,
    relation.type === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
  );
  item.detail = `${schemaName}.${relation.name}`;
  item.range = range;
  item.sortText = `00_relation_${relation.name.toLowerCase()}`;
  item.preselect = true;
  return item;
}

function buildSqlColumnCompletionItem(
  columnName: string,
  schemaName: string,
  tableName: string,
  range: vscode.Range,
  ownerName?: string
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(columnName, vscode.CompletionItemKind.Field);
  item.detail = `${schemaName}.${tableName}.${columnName}`;
  item.documentation = ownerName ? `Origem: ${ownerName}` : undefined;
  item.range = range;
  item.sortText = `00_column_${columnName.toLowerCase()}`;
  item.preselect = true;
  return item;
}

function dedupeCompletionItems(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
  const seen = new Set<string>();
  const deduped: vscode.CompletionItem[] = [];

  for (const item of items) {
    const key = `${item.label}|${item.detail || ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function formatHostPort(host?: string, port?: number): string {
  const h = String(host || '').trim();
  const p = Number(port);
  if (!h) {
    return '';
  }
  if (!Number.isFinite(p) || p <= 0) {
    return h;
  }
  return `${h}:${p}`;
}

async function executeSqlFromEditorDocument(
  document: vscode.TextDocument,
  store: ConnectionStore,
  postgresService: PostgresService
): Promise<void> {
  const parsed = parseSqlRunnerHeader(document.getText());
  const sql = parsed.sql;

  if (!sql) {
    throw new Error('SQL vazio para execução.');
  }

  const allConnections = await store.listConnections();
  if (allConnections.length === 0) {
    throw new Error('Não há conexões cadastradas.');
  }

  let connection = resolveConnectionFromHeaderContext(allConnections, parsed.context);
  if (!connection) {
    connection = await resolveConnectionFromNodeOrPicker(store);
  }

  if (!connection) {
    return;
  }

  const databaseName = parsed.context.databaseName?.trim() || connection.database;
  const schemaName = parsed.context.schemaName?.trim();
  const schemaPrefix = schemaName
    ? `SET search_path TO ${quoteIdentifier(schemaName)}, public;\n`
    : '';

  await postgresService.executeSql(connection, databaseName, `${schemaPrefix}${sql}`);
  vscode.window.showInformationMessage('SQL executado com sucesso.');
}

function resolveConnectionFromHeaderContext(
  allConnections: PostgresConnection[],
  context: SqlRunnerContext
): PostgresConnection | undefined {
  const byId = String(context.connectionId || '').trim();
  if (byId) {
    const foundById = allConnections.find((connection) => connection.id === byId);
    if (foundById) {
      return foundById;
    }
  }

  const byName = String(context.connectionName || '').trim().toLowerCase();
  if (byName) {
    return allConnections.find((connection) => connection.nickname.trim().toLowerCase() === byName);
  }

  return undefined;
}

function ensureSqlEndsWithSemicolon(sql: string): string {
  const trimmed = String(sql || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function quoteIdentifier(identifier: string): string {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function buildCreateFunctionTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE OR REPLACE FUNCTION ${schema}.new_function()`,
    'RETURNS void',
    'LANGUAGE plpgsql',
    'AS $$',
    'BEGIN',
    '  -- TODO: implemente a lógica',
    '  RETURN;',
    'END;',
    '$$;',
  ].join('\n');
}

function buildCreateProcedureTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE OR REPLACE PROCEDURE ${schema}.new_procedure()`,
    'LANGUAGE plpgsql',
    'AS $$',
    'BEGIN',
    '  -- TODO: implemente a lógica',
    'END;',
    '$$;',
  ].join('\n');
}

function buildCreateTriggerTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE OR REPLACE FUNCTION ${schema}.new_trigger_fn()`,
    'RETURNS trigger',
    'LANGUAGE plpgsql',
    'AS $$',
    'BEGIN',
    '  RETURN NEW;',
    'END;',
    '$$;',
    '',
    `CREATE TRIGGER new_trigger`,
    `BEFORE INSERT OR UPDATE ON ${schema}.table_name`,
    'FOR EACH ROW',
    `EXECUTE FUNCTION ${schema}.new_trigger_fn();`,
  ].join('\n');
}

function buildFilterViewHtml(
  webview: vscode.Webview,
  initialValue: string,
  initialExpandItems: boolean,
  initialSearchOnType: boolean
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
    <label class="check-row" title="Quando desativado, aplica o filtro somente ao pressionar Enter">
      <input id="searchOnType" type="checkbox" ${initialSearchOnType ? 'checked' : ''} />
      <span>Pesquisar ao digitar</span>
    </label>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('tableFilter');
    const expandItems = document.getElementById('expandItems');
    const searchOnType = document.getElementById('searchOnType');
    let searchOnTypeEnabled = Boolean(searchOnType.checked);

    input.addEventListener('input', () => {
      vscode.postMessage({
        type: 'filterChanged',
        value: input.value,
      });
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }

      if (!searchOnTypeEnabled) {
        event.preventDefault();
      }

      vscode.postMessage({
        type: 'filterSubmitted',
        value: input.value,
      });
    });

    expandItems.addEventListener('change', () => {
      vscode.postMessage({
        type: 'toggleExpandItems',
        checked: Boolean(expandItems.checked),
      });
    });

    searchOnType.addEventListener('change', () => {
      searchOnTypeEnabled = Boolean(searchOnType.checked);
      vscode.postMessage({
        type: 'toggleSearchOnType',
        checked: searchOnTypeEnabled,
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
        return;
      }

      if (message.type === 'setSearchOnType') {
        searchOnTypeEnabled = Boolean(message.value);
        searchOnType.checked = searchOnTypeEnabled;
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
