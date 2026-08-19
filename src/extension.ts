import * as vscode from "vscode";
import { formatErrorForUi, getBcp47Locale, t } from "./i18n";
import { loadLocaleDict, webviewI18nBootstrap } from "./i18n/webviewLocale";
import { ConnectionStore } from "./connectionStore";
import { showConnectionForm } from "./connectionFormPanel";
import { DatabaseTreeProvider } from "./databaseTreeProvider";
import {
  ConnectionNodeRef,
  DatabaseGroupNodeRef,
  DatabaseNodeRef,
  DbObjectNodeRef,
  ObjectGroupNodeRef,
  PostgresConnection,
  SchemaNodeRef,
  TableSectionItemNodeRef,
  TreeNodeRef,
} from "./models";
import { PostgresService } from "./postgresService";
import { TableDataPanelManager } from "./tableDataPanel";
import { buildExportContent } from "./tableDataPanel/exportService";
import { SettingsPanelManager } from "./settingsPanel";
import { BackupPanelManager } from "./backupPanel";
import { ConnectionActivityLog } from "./connectionActivityLog";
import { ConnectionManagerPanelManager } from "./connectionManagerPanel";
import { RestorePanelManager } from "./restorePanel";
import { buildTableDdlScript, clearSchema } from "./backupRestoreService";
import { TableMetadataPanelManager } from "./tableMetadataPanel";
import { SqlBookSerializer, SqlBookController } from "./sqlBookNotebook";
import { ensureSqlbookFileIconAssociations } from "./fileIconAssociations";
import {
  getSqlBookIntegratedTableEnabled,
  setSqlBookIntegratedTableEnabled,
  syncSqlBookIntegratedTableContext,
  toggleSqlBookIntegratedTableEnabled,
} from "./sqlBookIntegratedTable";
import {
  syncSqlBookSaveIntegratedTableContext,
  toggleSqlBookSaveIntegratedTableEnabled,
} from "./sqlBookSaveIntegratedTable";
import {
  createSqlBookRunPerQueryCodeLensProvider,
  executeSqlBookStatement,
  syncSqlBookRunPerQueryContext,
  toggleSqlBookRunPerQueryEnabled,
} from "./sqlBookRunPerQuery";
import { copyDbAdminMcpConfig, openDbAdminMcpJson, setupDbAdminMcp } from "./mcp/register";
import { SqlDiagnostics, getSqlBodyLocation } from "./sqlDiagnostics";

const EXPAND_FILTER_RESULTS_SETTING = "dbadmin.expandFilterResults";
const FILTER_INPUT_DEBOUNCE_MS = 180;
const DBADMIN_SQL_ACTIVE_PREFIX = "-- Active:";

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
  type: "table" | "view";
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context.globalStorageUri.fsPath);
  const postgresService = new PostgresService();
  const tablePanels = new TableDataPanelManager(context, postgresService);
  const sqlDiagnostics = new SqlDiagnostics(context);
  context.subscriptions.push(sqlDiagnostics);
  const settingsPanel = new SettingsPanelManager(context, () =>
    store.getStorageFilePath(),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("dbadmin.tableData", {
      deserializeWebviewPanel: (panel, state) =>
        tablePanels.deserializeTablePanel(panel, state, store),
    }),
    vscode.window.registerWebviewPanelSerializer("dbadmin.settings", {
      deserializeWebviewPanel: async (panel, state) => {
        settingsPanel.deserialize(panel, state);
      },
    }),
  );
  void context.globalState.update("dbadmin.openTabs", undefined);

  void ensureSqlbookFileIconAssociations();
  void syncSqlBookIntegratedTableContext();
  void syncSqlBookSaveIntegratedTableContext();
  void syncSqlBookRunPerQueryContext();

  const activityLog = new ConnectionActivityLog();
  const mcpRegistration = setupDbAdminMcp(context);
  context.subscriptions.push(mcpRegistration);
  postgresService.setActivityLog(activityLog);
  const treeProvider = new DatabaseTreeProvider(
    store,
    postgresService,
    context.extensionPath,
  );
  const sqlBookRunPerQueryLenses = createSqlBookRunPerQueryCodeLensProvider();

  const toggleSqlBookIntegratedTable = async (): Promise<void> => {
    await toggleSqlBookIntegratedTableEnabled();
    await syncSqlBookIntegratedTableContext();
    tablePanels.notifyIntegratedTableModeChanged();
  };

  const toggleSqlBookSaveIntegratedTable = async (): Promise<void> => {
    await toggleSqlBookSaveIntegratedTableEnabled();
    await syncSqlBookSaveIntegratedTableContext();
  };

  const toggleSqlBookRunPerQuery = async (): Promise<void> => {
    await toggleSqlBookRunPerQueryEnabled();
    await syncSqlBookRunPerQueryContext();
    sqlBookRunPerQueryLenses.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.toggleSqlBookIntegratedTable",
      toggleSqlBookIntegratedTable,
    ),
    vscode.commands.registerCommand(
      "dbadmin.toggleSqlBookIntegratedTableChecked",
      toggleSqlBookIntegratedTable,
    ),
    vscode.commands.registerCommand(
      "dbadmin.toggleSqlBookSaveIntegratedTable",
      toggleSqlBookSaveIntegratedTable,
    ),
    vscode.commands.registerCommand(
      "dbadmin.toggleSqlBookSaveIntegratedTableChecked",
      toggleSqlBookSaveIntegratedTable,
    ),
    vscode.commands.registerCommand(
      "dbadmin.toggleSqlBookRunPerQuery",
      toggleSqlBookRunPerQuery,
    ),
    vscode.commands.registerCommand(
      "dbadmin.toggleSqlBookRunPerQueryChecked",
      toggleSqlBookRunPerQuery,
    ),
    vscode.languages.registerCodeLensProvider(
      { language: "sql" },
      sqlBookRunPerQueryLenses.provider,
    ),
    { dispose: () => sqlBookRunPerQueryLenses.dispose() },
  );

  const backupPanels = new BackupPanelManager(context);
  const connectionManagerPanels = new ConnectionManagerPanelManager(
    context,
    postgresService,
    activityLog,
  );
  context.subscriptions.push({
    dispose: () => connectionManagerPanels.dispose(),
  });
  const restorePanels = new RestorePanelManager(context, async () => {
    await treeProvider.reloadAllMetadata();
  });
  const metadataPanels = new TableMetadataPanelManager(
    context,
    postgresService,
  );
  const expandedTreeItems = new Set<string>();

  const updateCollapseAllContext = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'setContext',
      'dbadmin.hasExpandedTreeItems',
      expandedTreeItems.size > 0,
    );
  };

  const treeItemKey = (item: TreeNodeRef): string => {
    switch (item.type) {
      case 'connection':
        return `connection:${item.connection.id}`;
      case 'database':
        return `database:${item.connection.id}:${item.databaseName}`;
      case 'databaseGroup':
        return `databaseGroup:${item.connection.id}:${item.databaseName}:${item.kind}`;
      case 'schema':
        return `schema:${item.connection.id}:${item.databaseName}:${item.schemaName}`;
      case 'objectGroup':
        return `objectGroup:${item.connection.id}:${item.databaseName}:${item.schemaName}:${item.kind}`;
      case 'dbObject':
        return `dbObject:${item.connection.id}:${item.databaseName}:${item.schemaName}:${item.kind}:${item.objectName}`;
      case 'extension':
        return `extension:${item.connection.id}:${item.databaseName}:${item.extensionName}`;
      case 'tableSection':
        return `tableSection:${item.connection.id}:${item.databaseName}:${item.schemaName}:${item.tableName}:${item.section}`;
      case 'tableSectionItem':
        return `tableSectionItem:${item.connection.id}:${item.databaseName}:${item.schemaName}:${item.tableName}:${item.section}:${item.itemKind}:${item.itemName}`;
      case 'filterControl':
        return `filterControl:${item.value}`;
      case 'placeholder':
        return `placeholder:${item.message}`;
      default:
        return JSON.stringify(item);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dbadmin.showFilterLabel")) {
        const nextShowFilterLabel = vscode.workspace
          .getConfiguration()
          .get<boolean>("dbadmin.showFilterLabel", true);
        treeProvider.setShowFilterLabel(nextShowFilterLabel);
      }

      if (event.affectsConfiguration(EXPAND_FILTER_RESULTS_SETTING)) {
        if (filterView) {
          void filterView.webview.postMessage({
            type: "setExpandItems",
            value: getExpandFilterResultsSetting(),
          });
        }
        applyFilter(treeProvider.getTableNameFilter(), {
          origin: "config-change",
        });
      }
    }),
  );

  const treeView = vscode.window.createTreeView("databaseExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  const syncExpandedState = async (element: TreeNodeRef, isExpanded: boolean): Promise<void> => {
    const key = treeItemKey(element);
    if (isExpanded) {
      expandedTreeItems.add(key);
    } else {
      expandedTreeItems.delete(key);
    }
    await updateCollapseAllContext();
  };

  context.subscriptions.push(
    treeView.onDidExpandElement((event) => {
      void syncExpandedState(event.element, true);
    }),
  );

  context.subscriptions.push(
    treeView.onDidCollapseElement((event) => {
      void syncExpandedState(event.element, false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.collapseAllExplorer', async () => {
      if (expandedTreeItems.size === 0) {
        return;
      }

      await vscode.commands.executeCommand(
        'workbench.actions.treeView.databaseExplorer.collapseAll',
      );
      expandedTreeItems.clear();
      await updateCollapseAllContext();
    }),
  );

  void updateCollapseAllContext();

  const initialShowFilterLabel = vscode.workspace
    .getConfiguration()
    .get<boolean>("dbadmin.showFilterLabel", true);
  treeProvider.setShowFilterLabel(initialShowFilterLabel);

  let filterView: vscode.WebviewView | undefined;
  let searchOnTypeEnabled = true;

  const getExpandFilterResultsSetting = (): boolean =>
    vscode.workspace
      .getConfiguration()
      .get<boolean>(EXPAND_FILTER_RESULTS_SETTING, false);

  const setExpandFilterResultsSetting = async (
    value: boolean,
  ): Promise<void> => {
    await vscode.workspace
      .getConfiguration()
      .update(
        EXPAND_FILTER_RESULTS_SETTING,
        Boolean(value),
        vscode.ConfigurationTarget.Global,
      );
  };

  const collapseAllExplorer = async (): Promise<void> => {
    await vscode.commands.executeCommand("dbadmin.collapseAllExplorer");
  };

  let filterRunSeq = 0;
  let pendingFilterTimeout: ReturnType<typeof setTimeout> | undefined;

  const runFilter = async (
    rawValue: string,
    _origin: string = "unknown",
  ): Promise<void> => {
    const runId = ++filterRunSeq;
    const isStale = (): boolean => runId !== filterRunSeq;

    const value = rawValue.trim();
    treeProvider.setTableNameFilter(value);

    const shouldShowLabel = vscode.workspace
      .getConfiguration()
      .get<boolean>("dbadmin.showFilterLabel", true);
    treeProvider.setShowFilterLabel(shouldShowLabel);

    if (filterView) {
      await filterView.webview.postMessage({
        type: "setFilterValue",
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

    await vscode.commands.executeCommand("databaseExplorer.focus");
    if (isStale()) {
      return;
    }

    for (const tablesGroup of filteredPaths) {
      if (isStale()) {
        return;
      }

      // Se depender da quickpick, melhor dar um tempinho para o VSCode gerar a treeview com sucesso
      if (_origin === "quickpick") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      await treeView.reveal(tablesGroup, {
        select: false,
        focus: false,
        expand: true,
      });
    }
  };

  const applyFilter = (
    rawValue: string,
    options?: { debounceMs?: number; origin?: string },
  ): void => {
    if (pendingFilterTimeout) {
      clearTimeout(pendingFilterTimeout);
      pendingFilterTimeout = undefined;
    }

    const origin = options?.origin ?? "unknown";
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
        context.extensionPath,
        treeProvider.getTableNameFilter(),
        getExpandFilterResultsSetting(),
        searchOnTypeEnabled,
      );

      webviewView.onDidDispose(() => {
        if (filterView === webviewView) {
          filterView = undefined;
        }
      });

      webviewView.webview.onDidReceiveMessage(
        (message: { type?: string; value?: string; checked?: boolean }) => {
          if (message.type === "filterChanged") {
            if (searchOnTypeEnabled) {
              applyFilter(String(message.value ?? ""), {
                debounceMs: FILTER_INPUT_DEBOUNCE_MS,
                origin: "sidebar-typing",
              });
            }
            return;
          }

          if (message.type === "filterSubmitted") {
            applyFilter(String(message.value ?? ""), {
              origin: "sidebar-enter",
            });
            return;
          }

          if (message.type === "toggleSearchOnType") {
            searchOnTypeEnabled = Boolean(message.checked);
            if (filterView) {
              void filterView.webview.postMessage({
                type: "setSearchOnType",
                value: searchOnTypeEnabled,
              });
            }
            return;
          }

          if (message.type === "toggleExpandItems") {
            void (async () => {
              await setExpandFilterResultsSetting(Boolean(message.checked));
              applyFilter(treeProvider.getTableNameFilter(), {
                origin: "toggle-expand",
              });
            })();
          }
        },
      );
    },
  };

  context.subscriptions.push(treeView);
  // Separate "Table filter" webview is disabled for now (`when: false` in package.json).
  // Search still works via dbadmin.editTableFilter (toolbar button / QuickPick).
  // context.subscriptions.push(
  //   vscode.window.registerWebviewViewProvider(
  //     "databaseExplorerFilter",
  //     filterViewProvider,
  //   ),
  // );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "sql" },
      createSqlRunnerCodeLensProvider(store),
    ),
  );
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "sql" },
      createSqlRunnerCompletionItemProvider(store, postgresService),
      ".",
      " ",
      ",",
    ),
  );

  const sqlActiveLineDeco = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(sqlActiveLineDeco);

  const refreshSqlActiveDecorations = async (
    editor: vscode.TextEditor,
  ): Promise<void> => {
    if (editor.document.languageId !== "sql") {
      editor.setDecorations(sqlActiveLineDeco, []);
      return;
    }

    const allConnections = await store.listConnections();
    const nicknamesById = new Map(
      allConnections.map(
        (connection) => [connection.id, connection.nickname.trim()] as const,
      ),
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
            color: new vscode.ThemeColor("terminal.ansiBrightBlue"),
            fontWeight: "bold",
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
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === event.document) {
        void refreshSqlActiveDecorations(editor);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.refresh", async () => {
      await treeProvider.reloadAllMetadata();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.editTableFilter", async () => {
      const current = treeProvider.getTableNameFilter();
      const expandLabel = t("Expand items");
      const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
      quickPick.title = t("Table filter");
      quickPick.placeholder = t("Type to filter tables...");
      quickPick.value = current;
      quickPick.canSelectMany = true;

      const expandItem: vscode.QuickPickItem = {
        label: expandLabel,
        description: "",
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
          const expandEnabled = quickPick.selectedItems.some(
            (item) => item.label === expandLabel,
          );

          void (async () => {
            if (expandEnabled !== getExpandFilterResultsSetting()) {
              await setExpandFilterResultsSetting(expandEnabled);
            }
            applyFilter(value, { origin: "quickpick" });
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
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.clearTableFilter", () => {
      applyFilter("", { origin: "clear-command" });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.executeSqlFromActiveEditor",
      async () => {
        try {
          const activeEditor = vscode.window.activeTextEditor;
          if (!activeEditor) {
            vscode.window.showInformationMessage(
              t("No active SQL editor to run."),
            );
            return;
          }

          const ran = await executeSqlFromEditorDocument(
            activeEditor.document,
            store,
            postgresService,
            tablePanels,
            sqlDiagnostics,
          );
          if (ran) {
            await treeProvider.reloadAllMetadata();
          }
        } catch (error) {
          showError(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "dbadmin.executeSqlRunnerStatement",
      async (
        uri?: vscode.Uri | string,
        sql?: string,
        sourceOffset?: number,
      ) => {
        try {
          const document = await resolveSqlRunnerDocument(uri);
          if (!document) {
            vscode.window.showInformationMessage(
              t("No active SQL editor to run."),
            );
            return;
          }

          const ran = await executeSqlFromEditorDocument(
            document,
            store,
            postgresService,
            tablePanels,
            sqlDiagnostics,
            {
              sql,
              documentOffset: sourceOffset,
            },
          );
          if (ran) {
            await treeProvider.reloadAllMetadata();
          }
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.sqlRunner.selectConnection",
      async () => {
        try {
          const editor = vscode.window.activeTextEditor;
          const document = editor?.document;
          if (!document || !isDbAdminSqlRunnerDocument(document)) {
            return;
          }

          const allConnections = await store.listConnections();
          if (allConnections.length === 0) {
            vscode.window.showInformationMessage(
              t("No connections registered."),
            );
            return;
          }

          const picked = await vscode.window.showQuickPick(
            allConnections.map((connection) => ({
              label: connection.nickname,
              description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
              connection,
            })),
            { placeHolder: t("Select connection") },
          );

          if (!picked) {
            return;
          }

          const databases = await postgresService.listDatabases(
            picked.connection,
          );
          if (databases.length === 0) {
            vscode.window.showInformationMessage(
              t("No databases available for this connection."),
            );
            return;
          }

          const pickedDatabase = await vscode.window.showQuickPick(databases, {
            placeHolder: t("Select database"),
          });

          if (!pickedDatabase) {
            return;
          }

          const schemas = await postgresService.listSchemas(
            picked.connection,
            pickedDatabase,
          );
          const schemaItems: Array<{
            label: string;
            schemaName?: string;
            description?: string;
          }> = [
            {
              label: t("No schema"),
              description: t("Use connection default search_path"),
              schemaName: undefined,
            },
            ...schemas.map((schemaName) => ({ label: schemaName, schemaName })),
          ];

          const pickedSchema = await vscode.window.showQuickPick(schemaItems, {
            placeHolder: t("Select schema (optional)"),
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
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.sqlRunner.selectDatabase",
      async () => {
        await vscode.commands.executeCommand(
          "dbadmin.sqlRunner.selectConnection",
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.sqlRunner.selectSchema",
      async () => {
        await vscode.commands.executeCommand(
          "dbadmin.sqlRunner.selectConnection",
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.spacer", () => {
      // Noop command for visual spacing in context menus
    }),
  );

  applyFilter(treeProvider.getTableNameFilter(), { origin: "init" });

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.createConnection", async () => {
      try {
        const payload = await showConnectionForm(
          context,
          postgresService,
          "create",
        );
        if (!payload) {
          return;
        }

        await store.createConnection(payload);
        treeProvider.refresh();
        vscode.window.showInformationMessage(t("Connection created successfully."));
      } catch (error) {
        showError(error);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.editConnection",
      async (node?: { connection?: PostgresConnection }) => {
        try {
          const target = await resolveConnectionFromNodeOrPicker(
            store,
            node?.connection,
          );
          if (!target) {
            return;
          }

          const payload = await showConnectionForm(
            context,
            postgresService,
            "edit",
            target,
          );
          if (!payload) {
            return;
          }

          const updated = await store.updateConnection(target.id, payload);
          if (node?.connection) {
            Object.assign(node.connection, updated);
          }
          treeProvider.clearConnectionCache(target.id);
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            t("Connection updated successfully."),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openConnectionManager",
      async (node?: ConnectionNodeRef | { connection?: PostgresConnection }) => {
        try {
          const connection =
            node && "type" in node && node.type === "connection"
              ? node.connection
              : node && "connection" in node && node.connection
                ? node.connection
                : await resolveConnectionFromNodeOrPicker(store);
          if (!connection) {
            return;
          }
          connectionManagerPanels.show(connection);
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.deleteConnection",
      async (node?: { connection?: PostgresConnection }) => {
        try {
          const target = await resolveConnectionFromNodeOrPicker(
            store,
            node?.connection,
          );
          if (!target) {
            return;
          }

          const removeLabel = t("Remove");
          const confirmation = await vscode.window.showWarningMessage(
            t('Remove connection "{0}"?', target.nickname),
            { modal: true },
            removeLabel,
          );

          if (confirmation !== removeLabel) {
            return;
          }

          await store.deleteConnection(target.id);
          treeProvider.clearConnectionCache(target.id);
          treeProvider.refresh();
          vscode.window.showInformationMessage(t("Connection removed successfully."));
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.refreshConnection",
      (node?: ConnectionNodeRef) => {
        if (!node || node.type !== "connection") {
          return;
        }

        treeProvider.reloadConnection(node.connection);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.refreshDatabase",
      (node?: DatabaseNodeRef) => {
        if (!node || node.type !== "database") {
          return;
        }

        treeProvider.reloadDatabase(node.connection, node.databaseName);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.refreshSchema",
      (node?: SchemaNodeRef) => {
        if (!node || node.type !== "schema") {
          return;
        }

        treeProvider.reloadSchema(
          node.connection,
          node.databaseName,
          node.schemaName,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.openSettings", async () => {
      try {
        settingsPanel.show();
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("dbadmin.openMcpSettings", async () => {
      try {
        settingsPanel.show({ section: "mcp" });
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("dbadmin.openMcpJson", async () => {
      try {
        await openDbAdminMcpJson(context);
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("dbadmin.copyMcpConfig", async () => {
      try {
        await copyDbAdminMcpConfig(context);
      } catch (error) {
        showError(error);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openTable",
      async (node?: DbObjectNodeRef) => {
        if (!node || node.type !== "dbObject" || node.kind !== "table") {
          return;
        }

        await tablePanels.openTable({
          node,
          newTab: false,
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openTableInNewTab",
      async (node?: DbObjectNodeRef) => {
        if (!node || node.type !== "dbObject" || node.kind !== "table") {
          return;
        }

        await tablePanels.openTable({
          node,
          newTab: true,
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.truncateTable",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "table") {
            return;
          }

          const truncateLabel = t("Truncate");
          const confirmation = await vscode.window.showWarningMessage(
            t('Truncate table "{0}.{1}"? This removes all rows and may also truncate related tables via foreign keys (CASCADE).', node.schemaName, node.objectName),
            { modal: true },
            truncateLabel,
          );

          if (confirmation !== truncateLabel) {
            return;
          }

          await postgresService.truncateTable(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );

          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Table "{0}.{1}" truncated successfully.', node.schemaName, node.objectName),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.showTableDdl",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "table") {
            return;
          }

          await showTableDdlForNode(node);
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.createTable",
      async (node?: ObjectGroupNodeRef) => {
        try {
          if (!node || node.type !== "objectGroup" || node.kind !== "table") {
            return;
          }

          const initialSql = buildCreateTableTemplate(node.schemaName);
          await openSqlRunnerEditor(
            t("Create table in {0}", node.schemaName),
            initialSql,
            t("Edit the table SQL and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.dropTable",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "table") {
            return;
          }

          const deleteLabel = t("Delete");
          const confirmation = await vscode.window.showWarningMessage(
            t('Permanently delete table "{0}.{1}" and all of its data? This cannot be undone.', node.schemaName, node.objectName),
            { modal: true },
            deleteLabel,
          );

          if (confirmation !== deleteLabel) {
            return;
          }

          await postgresService.dropTable(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );

          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Table "{0}.{1}" deleted successfully.', node.schemaName, node.objectName),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.showInExplorer",
      async (node?: DbObjectNodeRef) => {
        if (!node || node.type !== "dbObject" || node.kind !== "table") {
          return;
        }

        try {
          await vscode.commands.executeCommand(
            "workbench.view.extension.dbadmin",
          );
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
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.createDatabase",
      async (node?: ConnectionNodeRef) => {
        try {
          const connection =
            node?.connection ??
            (await resolveConnectionFromNodeOrPicker(store));
          if (!connection) {
            return;
          }

          const name = await vscode.window.showInputBox({
            title: t("Create database"),
            prompt: t("New database name"),
            validateInput: (value) =>
              value.trim() ? undefined : t("Enter a name."),
          });

          if (!name) {
            return;
          }

          await postgresService.createDatabase(connection, name.trim());
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Database "{0}" created successfully.', name.trim()),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.createSchema",
      async (node?: DatabaseGroupNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "databaseGroup" ||
            node.kind !== "schemas"
          ) {
            return;
          }

          const schemaName = await vscode.window.showInputBox({
            title: t('Create schema in "{0}"', node.databaseName),
            prompt: t("New schema name"),
            validateInput: (value) =>
              value.trim() ? undefined : t("Enter a name."),
          });

          if (!schemaName) {
            return;
          }

          await postgresService.createSchema(
            node.connection,
            node.databaseName,
            schemaName.trim(),
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Schema "{0}" created successfully.', schemaName.trim()),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.renameDatabase",
      async (node?: DatabaseNodeRef) => {
        try {
          if (!node || node.type !== "database") {
            return;
          }

          const newName = await vscode.window.showInputBox({
            title: t('Rename database "{0}"', node.databaseName),
            prompt: t("New name"),
            value: node.databaseName,
            validateInput: (value) =>
              value.trim() ? undefined : t("Enter a name."),
          });

          if (!newName || newName.trim() === node.databaseName) {
            return;
          }

          await postgresService.renameDatabase(
            node.connection,
            node.databaseName,
            newName.trim(),
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Database renamed to "{0}".', newName.trim()),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.duplicateDatabase",
      async (node?: DatabaseNodeRef) => {
        try {
          if (!node || node.type !== "database") {
            return;
          }

          const existingNames = new Set(
            await postgresService.listDatabases(node.connection),
          );
          const suggestedName = `${node.databaseName}_copy`;

          const newName = await vscode.window.showInputBox({
            title: t('Duplicate database "{0}"', node.databaseName),
            prompt: t("Duplicated database name"),
            value: suggestedName,
            validateInput: (value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                return t("Enter a name.");
              }
              if (trimmed === node.databaseName) {
                return t("Enter a name different from the source database.");
              }
              if (existingNames.has(trimmed)) {
                return t("A database with that name already exists.");
              }
              return undefined;
            },
          });

          if (!newName) {
            return;
          }

          await postgresService.duplicateDatabase(
            node.connection,
            node.databaseName,
            newName.trim(),
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Database "{0}" duplicated to "{1}" successfully.', node.databaseName, newName.trim()),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.dropDatabase",
      async (node?: DatabaseNodeRef) => {
        try {
          if (!node || node.type !== "database") {
            return;
          }

          const deleteLabel = t("Delete");
          const confirmation = await vscode.window.showWarningMessage(
            t('Permanently delete database "{0}"? This cannot be undone.', node.databaseName),
            { modal: true },
            deleteLabel,
          );

          if (confirmation !== deleteLabel) {
            return;
          }

          await postgresService.dropDatabase(
            node.connection,
            node.databaseName,
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Database "{0}" deleted successfully.', node.databaseName),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.backupSchema",
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== "schema") {
            return;
          }
          backupPanels.show(context, node);
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.restoreSchema",
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== "schema") {
            return;
          }
          restorePanels.show(context, node);
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.dropSchema",
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== "schema") {
            return;
          }

          const deleteLabel = t("Delete");
          const confirmation = await vscode.window.showWarningMessage(
            t('Permanently delete schema "{0}" and all of its objects? This cannot be undone.', node.schemaName),
            { modal: true },
            deleteLabel,
          );

          if (confirmation !== deleteLabel) {
            return;
          }

          await postgresService.dropSchema(
            node.connection,
            node.databaseName,
            node.schemaName,
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Schema "{0}" deleted successfully.', node.schemaName),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.clearSchema",
      async (node?: SchemaNodeRef) => {
        try {
          if (!node || node.type !== "schema") {
            return;
          }

          const clearLabel = t("Clear");
          const confirmation = await vscode.window.showWarningMessage(
            t('Clear schema "{0}" (DROP CASCADE + CREATE)? All objects will be permanently removed.', node.schemaName),
            { modal: true },
            clearLabel,
          );

          if (confirmation !== clearLabel) {
            return;
          }

          await clearSchema(
            node.connection,
            node.databaseName,
            node.schemaName,
            () => {},
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t('Schema "{0}" cleared successfully.', node.schemaName),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.createFunction",
      async (node?: ObjectGroupNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "objectGroup" ||
            node.kind !== "function"
          ) {
            return;
          }

          const initialSql = buildCreateFunctionTemplate(node.schemaName);
          await openSqlRunnerEditor(
            t("Create function in {0}", node.schemaName),
            initialSql,
            t("Edit the function SQL and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.editFunction",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "function") {
            return;
          }

          const definition = await postgresService.getFunctionDefinition(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );

          await openSqlRunnerEditor(
            t("Edit function {0}.{1}", node.schemaName, node.objectName),
            ensureSqlEndsWithSemicolon(definition),
            t("Edit the definition and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.deleteFunction",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "function") {
            return;
          }

          const deleteLabel = t("Delete");
          const confirmation = await vscode.window.showWarningMessage(
            t('Delete function "{0}.{1}"?', node.schemaName, node.objectName),
            { modal: true },
            deleteLabel,
          );

          if (confirmation !== deleteLabel) {
            return;
          }

          await postgresService.dropFunction(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t("Function deleted successfully."),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.createProcedure",
      async (node?: ObjectGroupNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "objectGroup" ||
            node.kind !== "procedure"
          ) {
            return;
          }

          const initialSql = buildCreateProcedureTemplate(node.schemaName);
          await openSqlRunnerEditor(
            t("Create procedure in {0}", node.schemaName),
            initialSql,
            t("Edit the procedure SQL and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.editProcedure",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "procedure") {
            return;
          }

          const definition = await postgresService.getProcedureDefinition(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );

          await openSqlRunnerEditor(
            t("Edit procedure {0}.{1}", node.schemaName, node.objectName),
            ensureSqlEndsWithSemicolon(definition),
            t("Edit the definition and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.deleteProcedure",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "procedure") {
            return;
          }

          const deleteLabel = t("Delete");
          const confirmation = await vscode.window.showWarningMessage(
            t('Delete procedure "{0}.{1}"?', node.schemaName, node.objectName),
            { modal: true },
            deleteLabel,
          );

          if (confirmation !== deleteLabel) {
            return;
          }

          await postgresService.dropProcedure(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(
            t("Procedure deleted successfully."),
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.createTrigger",
      async (node?: ObjectGroupNodeRef) => {
        try {
          if (!node || node.type !== "objectGroup" || node.kind !== "trigger") {
            return;
          }

          const initialSql = buildCreateTriggerTemplate(node.schemaName);
          await openSqlRunnerEditor(
            t("Create trigger in {0}", node.schemaName),
            initialSql,
            t("Edit the trigger SQL and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.editTrigger",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "trigger") {
            return;
          }

          const trigger = await postgresService.getTriggerDefinition(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );

          const initialSql = [
            `DROP TRIGGER IF EXISTS ${quoteIdentifier(node.objectName)} ON ${quoteIdentifier(node.schemaName)}.${quoteIdentifier(trigger.tableName)};`,
            ensureSqlEndsWithSemicolon(trigger.definition),
          ].join("\n\n");

          await openSqlRunnerEditor(
            t("Edit trigger {0}.{1}", node.schemaName, node.objectName),
            initialSql,
            t("Edit the trigger SQL and run with Ctrl+Enter or CodeLens."),
            {
              connectionId: node.connection.id,
              connectionName: node.connection.nickname,
              connectionHost: node.connection.host,
              connectionPort: node.connection.port,
              databaseName: node.databaseName,
              schemaName: node.schemaName,
            },
          );
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.deleteTrigger",
      async (node?: DbObjectNodeRef) => {
        try {
          if (!node || node.type !== "dbObject" || node.kind !== "trigger") {
            return;
          }

          const deleteLabel = t("Delete");
          const confirmation = await vscode.window.showWarningMessage(
            t('Delete trigger "{0}.{1}"?', node.schemaName, node.objectName),
            { modal: true },
            deleteLabel,
          );

          if (confirmation !== deleteLabel) {
            return;
          }

          await postgresService.dropTrigger(
            node.connection,
            node.databaseName,
            node.schemaName,
            node.objectName,
          );
          await treeProvider.reloadAllMetadata();
          vscode.window.showInformationMessage(t("Trigger deleted successfully."));
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openColumnDetails",
      async (node?: TableSectionItemNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "tableSectionItem" ||
            node.itemKind !== "column"
          ) {
            return;
          }
          await metadataPanels.showColumn(node, { newTab: false });
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openColumnDetailsInNewTab",
      async (node?: TableSectionItemNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "tableSectionItem" ||
            node.itemKind !== "column"
          ) {
            return;
          }
          await metadataPanels.showColumn(node, { newTab: true });
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openConstraintDetails",
      async (node?: TableSectionItemNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "tableSectionItem" ||
            node.itemKind !== "constraint"
          ) {
            return;
          }
          await metadataPanels.showConstraint(node, { newTab: false });
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.openConstraintDetailsInNewTab",
      async (node?: TableSectionItemNodeRef) => {
        try {
          if (
            !node ||
            node.type !== "tableSectionItem" ||
            node.itemKind !== "constraint"
          ) {
            return;
          }
          await metadataPanels.showConstraint(node, { newTab: true });
        } catch (error) {
          showError(error);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "sqlbook",
      new SqlBookSerializer(context.extensionPath),
    ),
  );

  const sqlBookController = new SqlBookController(
    store,
    postgresService,
    async (payload) => {
      if (
        getSqlBookIntegratedTableEnabled() &&
        payload.forceOpenPanel !== true
      ) {
        return;
      }

      await tablePanels.openQueryResult({
        connection: payload.connection,
        databaseName: payload.databaseName,
        schemaName: payload.schemaName,
        sql: payload.sql,
        result: payload.result,
        source: "sqlBook",
        title: `SQL Book: ${payload.connection.nickname}`,
        onRefresh: async () => {
          return postgresService.querySql(
            payload.connection,
            payload.databaseName,
            payload.sql,
          );
        },
      });
    },
    context.extensionPath,
    sqlDiagnostics,
  );

  context.subscriptions.push(sqlBookController);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dbadmin.executeSqlBookStatement",
      async (uri: vscode.Uri | string, sql: string, sourceOffset?: number) => {
        await executeSqlBookStatement(
          sqlBookController,
          uri,
          sql,
          sourceOffset,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("dbadmin.sqlbookIntegratedTable") ||
        event.affectsConfiguration("dbadmin.sqlbook.integratedTable")
      ) {
        void syncSqlBookIntegratedTableContext();
        tablePanels.notifyIntegratedTableModeChanged();
      }
      if (event.affectsConfiguration("dbadmin.sqlbookRunPerQuery")) {
        void syncSqlBookRunPerQueryContext();
        sqlBookRunPerQueryLenses.refresh();
      }
      if (event.affectsConfiguration("dbadmin.sqlbookSaveIntegratedTable")) {
        void syncSqlBookSaveIntegratedTableContext();
      }
    }),
  );

  try {
    const sqlBookTableMessaging = vscode.notebooks.createRendererMessaging(
      "dbadmin-sqlbook-table",
    );
    context.subscriptions.push(
      sqlBookTableMessaging.onDidReceiveMessage((event) => {
        if (event.message?.type === "openLastResult") {
          void sqlBookController.openTableResult(event.message.payload);
        }
        if (event.message?.type === "exportData") {
          void exportSqlBookIntegratedTable(event.message);
        }
      }),
    );
  } catch (error) {
    console.error("[dbadmin] failed to create sqlbook table renderer messaging", error);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("dbadmin.openLastSqlBookResult", async () => {
      await sqlBookController.openLastResultInPanel();
    }),
  );

  // Migrate legacy workspaceState into the flat setting.
  const legacyState = context.workspaceState.get<boolean | undefined>(
    "integratedTableMode",
  );
  if (legacyState === true && !getSqlBookIntegratedTableEnabled()) {
    void setSqlBookIntegratedTableEnabled(true).then(() =>
      syncSqlBookIntegratedTableContext(),
    );
  }
  if (legacyState !== undefined) {
    void context.workspaceState.update("integratedTableMode", undefined);
  }
}

export function deactivate(): void {}

async function exportSqlBookIntegratedTable(message: {
  format?: unknown;
  columns?: unknown;
  rows?: unknown;
}): Promise<void> {
  try {
    const format = message.format === "csv" ? "csv" : "json";
    const columns = Array.isArray(message.columns)
      ? message.columns.map(String)
      : [];
    const rows = Array.isArray(message.rows)
      ? (message.rows as Array<Record<string, unknown>>)
      : [];
    const content = buildExportContent(format, columns, rows);
    const document = await vscode.workspace.openTextDocument({
      language: format,
      content,
    });
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : t("Export failed.");
    void vscode.window.showErrorMessage(`DBAdmin: ${text}`);
  }
}

async function resolveConnectionFromNodeOrPicker(
  store: ConnectionStore,
  selectedFromTree?: PostgresConnection,
): Promise<PostgresConnection | undefined> {
  if (selectedFromTree) {
    return selectedFromTree;
  }

  const all = await store.listConnections();
  if (all.length === 0) {
    vscode.window.showInformationMessage(t("No registered connections."));
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    all.map((connection) => ({
      label: connection.nickname,
      description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
      connection,
    })),
    {
      placeHolder: t("Select connection"),
    },
  );

  return selected?.connection;
}

function showError(error: unknown): void {
  vscode.window.showErrorMessage(formatErrorForUi(error));
}

async function showTableDdlForNode(node: DbObjectNodeRef): Promise<void> {
  const ddl = await buildTableDdlScript(
    node.connection,
    node.databaseName,
    node.schemaName,
    node.objectName,
  );

  await openSqlRunnerEditor(
    t("DDL: {0}.{1}", node.schemaName, node.objectName),
    ddl,
    t("Review or copy the DDL. Run with Ctrl+Enter to execute changes."),
    {
      connectionId: node.connection.id,
      connectionName: node.connection.nickname,
      connectionHost: node.connection.host,
      connectionPort: node.connection.port,
      databaseName: node.databaseName,
      schemaName: node.schemaName,
    },
  );
}

async function openSqlRunnerEditor(
  title: string,
  initialSql: string,
  guidanceMessage: string,
  runnerContext: SqlRunnerContext,
): Promise<void> {
  const content = buildSqlRunnerDocumentContent(initialSql, runnerContext);
  const document = await vscode.workspace.openTextDocument({
    language: "sql",
    content,
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Active,
  });

  void vscode.window.setStatusBarMessage(`${title}. ${guidanceMessage}`, 4500);
}

function buildSqlRunnerDocumentContent(
  sql: string,
  context: SqlRunnerContext,
): string {
  return [
    `${DBADMIN_SQL_ACTIVE_PREFIX} ${serializeSqlRunnerActiveContext(context)}`,
    ensureSqlEndsWithSemicolon(sql),
  ].join("\n");
}

function getExecutableSqlFromDocument(document: vscode.TextDocument): string {
  const parsed = parseSqlRunnerHeader(document.getText());
  return parsed.sql;
}

function isDbAdminSqlRunnerDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "sql";
}

async function rewriteSqlRunnerHeader(
  document: vscode.TextDocument,
  context: SqlRunnerContext,
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
    document.positionAt(document.getText().length),
  );
  edit.replace(document.uri, fullRange, nextContent);
  await vscode.workspace.applyEdit(edit);
}

function parseSqlRunnerHeader(text: string): {
  context: SqlRunnerContext;
  sql: string;
} {
  const lines = String(text || "").split(/\r?\n/);
  const context: SqlRunnerContext = {};
  const sqlLines: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Ignora a marca legada (arquivos antigos)
    if (line === "-- DBADMIN-SQL-RUNNER") {
      continue;
    }

    if (line.startsWith(DBADMIN_SQL_ACTIVE_PREFIX)) {
      const activePayload = line.slice(DBADMIN_SQL_ACTIVE_PREFIX.length).trim();
      Object.assign(context, parseSqlRunnerActiveContext(activePayload));
      continue;
    }

    sqlLines.push(rawLine);
  }

  return { context, sql: sqlLines.join("\n").trim() };
}

function createSqlRunnerCodeLensProvider(
  store: ConnectionStore,
): vscode.CodeLensProvider {
  return {
    async provideCodeLenses(
      document: vscode.TextDocument,
    ): Promise<vscode.CodeLens[]> {
      if (!isDbAdminSqlRunnerDocument(document)) {
        return [];
      }

      const parsed = parseSqlRunnerHeader(document.getText());
      const context = parsed.context;
      const allConnections = await store.listConnections();
      const connectionById = new Map(
        allConnections.map(
          (connection) => [connection.id, connection] as const,
        ),
      );

      let activeLine = 0;
      for (let i = 0; i < document.lineCount; i++) {
        if (
          document.lineAt(i).text.trim().startsWith(DBADMIN_SQL_ACTIVE_PREFIX)
        ) {
          activeLine = i;
          break;
        }
      }
      const range = new vscode.Range(activeLine, 0, activeLine, 0);

      const resolvedConnection = context.connectionId
        ? connectionById.get(context.connectionId)
        : undefined;
      const connectionLabel =
        resolvedConnection?.nickname?.trim() ||
        context.connectionName?.trim() ||
        formatHostPort(context.connectionHost, context.connectionPort) ||
        context.connectionId?.trim() ||
        t("Connection");
      const databaseLabel = context.databaseName?.trim() || t("Database");
      const isConfigSelected =
        Boolean(context.connectionId) && Boolean(context.databaseName);
      const isSchemaSelected = isConfigSelected && Boolean(context.schemaName);
      const schemaLabel = isSchemaSelected
        ? ` $(type-hierarchy-sub) ${context.schemaName?.trim()}`
        : "";
      const contextButtonLabel = isConfigSelected
        ? `$(plug) ${connectionLabel} $(database) ${databaseLabel}` +
          schemaLabel
        : t("$(plug) Select connection");

      return [
        new vscode.CodeLens(range, {
          title: contextButtonLabel,
          command: "dbadmin.sqlRunner.selectConnection",
        }),
        new vscode.CodeLens(range, {
          title: t("$(play) Run"),
          command: "dbadmin.executeSqlFromActiveEditor",
        }),
      ];
    },
  };
}

function createSqlRunnerCompletionItemProvider(
  store: ConnectionStore,
  postgresService: PostgresService,
): vscode.CompletionItemProvider {
  const cacheTtlMs = 15_000;
  const cache = new Map<string, { expiresAt: number; value: unknown }>();

  const getCached = async <T>(
    key: string,
    loader: () => Promise<T>,
  ): Promise<T> => {
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
    databaseName: string,
  ): Promise<string[]> =>
    getCached(`schemas:${connection.id}:${databaseName}`, () =>
      postgresService.listSchemas(connection, databaseName),
    );

  const loadRelations = async (
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<SqlSchemaRelation[]> =>
    getCached(
      `relations:${connection.id}:${databaseName}:${schemaName}`,
      async () => {
        const [tables, views] = await Promise.all([
          postgresService.listTables(connection, databaseName, schemaName),
          postgresService.listViews(connection, databaseName, schemaName),
        ]);

        return [
          ...tables.map((name) => ({ name, type: "table" as const })),
          ...views.map((name) => ({ name, type: "view" as const })),
        ];
      },
    );

  const loadColumns = async (
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ) =>
    getCached(
      `columns:${connection.id}:${databaseName}:${schemaName}:${tableName}`,
      () =>
        postgresService.listTableColumnsDetailed(
          connection,
          databaseName,
          schemaName,
          tableName,
        ),
    );

  return {
    async provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.CompletionItem[]> {
      if (!isDbAdminSqlRunnerDocument(document)) {
        return [];
      }

      const linePrefix = document
        .lineAt(position.line)
        .text.slice(0, position.character);
      if (linePrefix.trimStart().startsWith("--")) {
        return [];
      }

      const fullParsed = parseSqlRunnerHeader(document.getText());
      const beforeCursorParsed = parseSqlRunnerHeader(
        document.getText(new vscode.Range(new vscode.Position(0, 0), position)),
      );
      const runnerContext = fullParsed.context;

      if (!runnerContext.connectionId || !runnerContext.databaseName) {
        return [];
      }

      const allConnections = await store.listConnections();
      const connection = resolveConnectionFromHeaderContext(
        allConnections,
        runnerContext,
      );
      if (!connection) {
        return [];
      }

      const currentSql = beforeCursorParsed.sql;
      const fullSql = fullParsed.sql;
      const currentWordMatch = linePrefix.match(/([a-zA-Z_][\w$]*)$/);
      const currentWord = currentWordMatch?.[1] ?? "";
      const currentRange = new vscode.Range(
        position.line,
        position.character - currentWord.length,
        position.line,
        position.character,
      );

      const tripleQualifiedMatch = linePrefix.match(
        /([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)?$/i,
      );
      if (tripleQualifiedMatch) {
        const [, schemaNameRaw, tableNameRaw, columnPrefixRaw = ""] =
          tripleQualifiedMatch;
        const schemaName = schemaNameRaw.trim();
        const tableName = tableNameRaw.trim();
        const columnPrefix = columnPrefixRaw.trim();
        const range = new vscode.Range(
          position.line,
          position.character - columnPrefix.length,
          position.line,
          position.character,
        );
        const columns = await loadColumns(
          connection,
          runnerContext.databaseName,
          schemaName,
          tableName,
        );
        return columns
          .filter((column) => matchesSqlPrefix(column.name, columnPrefix))
          .map((column) =>
            buildSqlColumnCompletionItem(
              column.name,
              schemaName,
              tableName,
              range,
            ),
          );
      }

      const dottedMatch = linePrefix.match(
        /([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)?$/i,
      );
      if (dottedMatch) {
        const [, leftRaw, rightRaw = ""] = dottedMatch;
        const left = leftRaw.trim();
        const right = rightRaw.trim();
        const range = new vscode.Range(
          position.line,
          position.character - right.length,
          position.line,
          position.character,
        );

        const references = extractSqlTableReferences(
          fullSql,
          runnerContext.schemaName,
        );
        const matchedReference = references.find(
          (reference) =>
            reference.alias === left || reference.tableName === left,
        );

        if (matchedReference?.schemaName) {
          const matchedSchemaName = matchedReference.schemaName;
          const columns = await loadColumns(
            connection,
            runnerContext.databaseName,
            matchedSchemaName,
            matchedReference.tableName,
          );
          return columns
            .filter((column) => matchesSqlPrefix(column.name, right))
            .map((column) =>
              buildSqlColumnCompletionItem(
                column.name,
                matchedSchemaName,
                matchedReference.tableName,
                range,
              ),
            );
        }

        const schemas = await loadSchemas(
          connection,
          runnerContext.databaseName,
        );
        if (schemas.some((schemaName) => schemaName === left)) {
          const relations = await loadRelations(
            connection,
            runnerContext.databaseName,
            left,
          );
          return relations
            .filter((relation) => matchesSqlPrefix(relation.name, right))
            .map((relation) =>
              buildSqlRelationCompletionItem(relation, left, range),
            );
        }
      }

      const wantsRelationSuggestions =
        /\b(from|join|update|into|truncate\s+table|table)\s+[a-zA-Z_\d$]*$/i.test(
          linePrefix,
        );

      if (wantsRelationSuggestions) {
        if (runnerContext.schemaName) {
          const relations = await loadRelations(
            connection,
            runnerContext.databaseName,
            runnerContext.schemaName,
          );
          return relations
            .filter((relation) => matchesSqlPrefix(relation.name, currentWord))
            .map((relation) =>
              buildSqlRelationCompletionItem(
                relation,
                runnerContext.schemaName as string,
                currentRange,
              ),
            );
        }

        const schemas = await loadSchemas(
          connection,
          runnerContext.databaseName,
        );
        return schemas
          .filter((schemaName) => matchesSqlPrefix(schemaName, currentWord))
          .map((schemaName) =>
            buildSqlSchemaCompletionItem(schemaName, currentRange),
          );
      }

      const references = extractSqlTableReferences(
        fullSql,
        runnerContext.schemaName,
      );
      if (references.length === 0) {
        return [];
      }

      const wantsColumnSuggestions =
        /\b(select|where|and|or|on|order\s+by|group\s+by|having|set|returning)\b[\s\S]*$/i.test(
          currentSql,
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
          reference.tableName,
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
                reference.alias || reference.tableName,
              ),
            ),
        );
      }

      return dedupeCompletionItems(items);
    },
  };
}

function serializeSqlRunnerActiveContext(context: SqlRunnerContext): string {
  const id = String(context.connectionId || "").trim();
  const host = String(context.connectionHost || "").trim();
  const port = String(context.connectionPort ?? "").trim();
  const database = String(context.databaseName || "").trim();
  const schema = String(context.schemaName || "").trim();

  return `${id}@@${host}@${port}@${database}${schema ? `@${schema}` : ""}`;
}

function parseSqlRunnerActiveContext(value: string): SqlRunnerContext {
  const raw = String(value || "").trim();
  if (!raw) {
    return {};
  }

  const parts = raw.split("@@");
  let id: string;
  let name: string | undefined;
  let rest: string;

  if (parts.length >= 3) {
    // Formato legado: id@@name@@host@port@database@schema
    id = parts[0];
    name = parts[1];
    rest = parts.slice(2).join("@@");
  } else {
    // Formato atual: id@@host@port@database@schema
    id = parts[0];
    name = undefined;
    rest = parts[1] || "";
  }

  const restParts = rest.split("@");
  const [host = "", portRaw = "", database = "", schema = ""] = restParts;
  const parsedPort = Number(portRaw);

  return {
    connectionId: id.trim() || undefined,
    connectionName: name?.trim() || undefined,
    connectionHost: host.trim() || undefined,
    connectionPort:
      Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined,
    databaseName: database.trim() || undefined,
    schemaName: schema.trim() || undefined,
  };
}

function extractSqlTableReferences(
  sql: string,
  defaultSchemaName?: string,
): SqlRelationRef[] {
  const text = String(sql || "");
  const references: SqlRelationRef[] = [];
  const matcher =
    /\b(?:from|join|update|into)\s+((?:[a-zA-Z_][\w$]*\.)?[a-zA-Z_][\w$]*)(?:\s+(?:as\s+)?([a-zA-Z_][\w$]*))?/gi;

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const rawName = String(match[1] || "").trim();
    if (!rawName) {
      continue;
    }

    const alias = String(match[2] || "").trim() || undefined;
    const parts = rawName
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);
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
  const normalizedValue = String(value || "").toLowerCase();
  const normalizedPrefix = String(prefix || "").toLowerCase();
  return !normalizedPrefix || normalizedValue.startsWith(normalizedPrefix);
}

function buildSqlSchemaCompletionItem(
  schemaName: string,
  range: vscode.Range,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    schemaName,
    vscode.CompletionItemKind.Module,
  );
  item.detail = "Schema";
  item.insertText = schemaName;
  item.range = range;
  item.sortText = `00_schema_${schemaName.toLowerCase()}`;
  item.preselect = true;
  return item;
}

function buildSqlRelationCompletionItem(
  relation: SqlSchemaRelation,
  schemaName: string,
  range: vscode.Range,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    relation.name,
    relation.type === "view"
      ? vscode.CompletionItemKind.Interface
      : vscode.CompletionItemKind.Class,
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
  ownerName?: string,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    columnName,
    vscode.CompletionItemKind.Field,
  );
  item.detail = `${schemaName}.${tableName}.${columnName}`;
  item.documentation = ownerName ? `Origem: ${ownerName}` : undefined;
  item.range = range;
  item.sortText = `00_column_${columnName.toLowerCase()}`;
  item.preselect = true;
  return item;
}

function dedupeCompletionItems(
  items: vscode.CompletionItem[],
): vscode.CompletionItem[] {
  const seen = new Set<string>();
  const deduped: vscode.CompletionItem[] = [];

  for (const item of items) {
    const key = `${item.label}|${item.detail || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function formatHostPort(host?: string, port?: number): string {
  const h = String(host || "").trim();
  const p = Number(port);
  if (!h) {
    return "";
  }
  if (!Number.isFinite(p) || p <= 0) {
    return h;
  }
  return `${h}:${p}`;
}

async function resolveSqlRunnerDocument(
  uri?: vscode.Uri | string,
): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    const target =
      typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === target.toString(),
    );
    if (open) {
      return open;
    }
    try {
      return await vscode.workspace.openTextDocument(target);
    } catch {
      return undefined;
    }
  }
  return vscode.window.activeTextEditor?.document;
}

async function executeSqlFromEditorDocument(
  document: vscode.TextDocument,
  store: ConnectionStore,
  postgresService: PostgresService,
  tablePanels: TableDataPanelManager,
  sqlDiagnostics: SqlDiagnostics,
  options?: { sql?: string; documentOffset?: number },
): Promise<boolean> {
  const parsed = parseSqlRunnerHeader(document.getText());
  const body = getSqlBodyLocation(document.getText());
  const sql = options?.sql?.trim() || body.sql || parsed.sql;

  if (!sql) {
    throw new Error(t("Empty SQL to run."));
  }

  const allConnections = await store.listConnections();
  if (allConnections.length === 0) {
    throw new Error(t("No connections registered."));
  }

  let connection = resolveConnectionFromHeaderContext(
    allConnections,
    parsed.context,
  );
  if (!connection) {
    connection = await resolveConnectionFromNodeOrPicker(store);
  }

  if (!connection) {
    return false;
  }

  const databaseName =
    parsed.context.databaseName?.trim() || connection.database;
  const schemaName = parsed.context.schemaName?.trim();
  const schemaPrefix = schemaName
    ? `SET search_path TO ${quoteIdentifier(schemaName)}, public;\n`
    : "";

  const executableSql = `${schemaPrefix}${sql}`;
  sqlDiagnostics.clear(document.uri);
  let result;
  try {
    result = await postgresService.querySql(
      connection,
      databaseName,
      executableSql,
    );
  } catch (error) {
    sqlDiagnostics.show(
      {
        document,
        executedSql: executableSql,
        executedSqlDocumentStart: schemaPrefix.length,
        documentOffset: options?.documentOffset ?? body.start,
      },
      error,
    );
    return false;
  }

  await tablePanels.openQueryResult({
    connection,
    databaseName,
    schemaName,
    sql,
    result,
    source: "sqlRunner",
    title: t("SQL result: {0}", connection.nickname),
    onRefresh: async () => {
      return postgresService.querySql(
        connection,
        databaseName,
        executableSql,
      );
    },
  });

  return true;
}

function resolveConnectionFromHeaderContext(
  allConnections: PostgresConnection[],
  context: SqlRunnerContext,
): PostgresConnection | undefined {
  const byId = String(context.connectionId || "").trim();
  if (byId) {
    const foundById = allConnections.find(
      (connection) => connection.id === byId,
    );
    if (foundById) {
      return foundById;
    }
  }

  const byName = String(context.connectionName || "")
    .trim()
    .toLowerCase();
  if (byName) {
    return allConnections.find(
      (connection) => connection.nickname.trim().toLowerCase() === byName,
    );
  }

  return undefined;
}

function ensureSqlEndsWithSemicolon(sql: string): string {
  const trimmed = String(sql || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

function quoteIdentifier(identifier: string): string {
  return `"${String(identifier || "").replace(/"/g, '""')}"`;
}

function buildCreateTableTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE TABLE ${schema}.new_table (`,
    "  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
    ");",
  ].join("\n");
}

function buildCreateFunctionTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE OR REPLACE FUNCTION ${schema}.new_function()`,
    "RETURNS void",
    "LANGUAGE plpgsql",
    "AS $$",
    "BEGIN",
    "  -- TODO: implemente a lógica",
    "  RETURN;",
    "END;",
    "$$;",
  ].join("\n");
}

function buildCreateProcedureTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE OR REPLACE PROCEDURE ${schema}.new_procedure()`,
    "LANGUAGE plpgsql",
    "AS $$",
    "BEGIN",
    "  -- TODO: implemente a lógica",
    "END;",
    "$$;",
  ].join("\n");
}

function buildCreateTriggerTemplate(schemaName: string): string {
  const schema = quoteIdentifier(schemaName);
  return [
    `CREATE OR REPLACE FUNCTION ${schema}.new_trigger_fn()`,
    "RETURNS trigger",
    "LANGUAGE plpgsql",
    "AS $$",
    "BEGIN",
    "  RETURN NEW;",
    "END;",
    "$$;",
    "",
    `CREATE TRIGGER new_trigger`,
    `BEFORE INSERT OR UPDATE ON ${schema}.table_name`,
    "FOR EACH ROW",
    `EXECUTE FUNCTION ${schema}.new_trigger_fn();`,
  ].join("\n");
}

function buildFilterViewHtml(
  webview: vscode.Webview,
  extensionPath: string,
  initialValue: string,
  initialExpandItems: boolean,
  initialSearchOnType: boolean,
): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const i18n = loadLocaleDict(extensionPath);
  const i18nScript = webviewI18nBootstrap(extensionPath);
  const i18nLang = getBcp47Locale();
  const L = (key: string, fallback: string) =>
    escapeHtml(i18n[key] || fallback);

  return `<!DOCTYPE html>
<html lang="${i18nLang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script nonce="${nonce}">${i18nScript}</script>
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
    :root { --dbadmin-input-focus: #007acc; accent-color: var(--dbadmin-input-focus); }
    input, textarea, select {
      accent-color: var(--dbadmin-input-focus);
      caret-color: var(--vscode-editorCursor-foreground, var(--dbadmin-input-focus));
    }
    input:focus, textarea:focus, select:focus,
    input:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: none;
      border-color: var(--dbadmin-input-focus);
    }
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--vscode-input-foreground);
      caret-color: var(--dbadmin-input-focus);
      box-shadow: 0 0 0 1000px var(--vscode-input-background) inset;
      border-color: var(--dbadmin-input-focus);
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
      overflow: hidden;
      background-clip: padding-box;
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
      accent-color: var(--dbadmin-input-focus);
    }

  </style>
</head>
<body>
  <div class="wrap">
    <input id="tableFilter" type="text" placeholder="${L('webview.filter.placeholder', 'Filtrar tabelas...')}" value="${escapeHtml(initialValue)}" />
    <label class="check-row" title="${L('webview.filter.expandItemsTitle', 'Expandir apenas conexões e bancos com tabelas encontradas')}">
      <input id="expandItems" type="checkbox" ${initialExpandItems ? "checked" : ""} />
      <span>${L('webview.filter.expandItems', 'Expandir itens')}</span>
    </label>
    <label class="check-row" title="${L('webview.filter.searchOnTypeTitle', 'Quando desativado, aplica o filtro somente ao pressionar Enter')}">
      <input id="searchOnType" type="checkbox" ${initialSearchOnType ? "checked" : ""} />
      <span>${L('webview.filter.searchOnType', 'Pesquisar ao digitar')}</span>
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
