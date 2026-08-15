import * as fs from "fs";
import * as vscode from "vscode";
import { getBcp47Locale, t } from "./i18n";
import { loadLocaleDict, webviewI18nBootstrap } from "./i18n/webviewLocale";
import { DbObjectNodeRef, PostgresConnection } from "./models";
import {
  DiagramDataResult,
  PostgresService,
  SqlQueryResult,
  TableColumnMeta,
} from "./postgresService";
import { ConnectionStore } from "./connectionStore";
import {
  buildCodeEditorMarkup,
  buildCodeEditorScript,
  buildCodeEditorStyles,
} from "./webview/codeEditor";
import {
  buildExportContent,
  fetchAllRowsForExport,
} from "./tableDataPanel/exportService";
import {
  buildOpenTabsSnapshot,
  buildTableLayoutStorageKey,
  cloneTableStateWithPageSize,
  createDefaultTableState,
  getStoredOpenTabs,
  persistLayout as persistStoredLayout,
  persistOpenTabs,
  readStoredLayout as readLayoutFromStore,
  StoredOpenTab,
} from "./tableDataPanel/stateStore";
import {
  buildNativePreviewFilePrefix,
  cleanupNativePreviewTempFilesByPrefix,
  cleanupStaleNativePreviewTempFiles,
  createNativePreviewTempDocument,
  formatPreviewJson,
} from "./tableDataPanel/nativePreviewTemp";
import {
  closeDocumentTabByUri,
  findPreviewTabGroupViewColumn,
  getVisibleEditorForDocument,
  isDocumentActiveInEditor,
  scrollPreviewDocumentToTop,
} from "./tableDataPanel/nativePreviewEditor";
import {
  GLOBAL_REUSED_KEY,
  NativeJsonPreviewState,
  OpenTableInput,
  TableLayoutState,
  TableState,
  WebviewMessage,
} from "./tableDataPanel/types";
import {
  PanelConfig,
} from "./tableDataPanel/config";
import { PanelRegistry } from "./tableDataPanel/panelRegistry";
import {
  getSqlBookIntegratedTableEnabled,
  toggleSqlBookIntegratedTableEnabled,
  syncSqlBookIntegratedTableContext,
} from "./sqlBookIntegratedTable";

export interface OpenQueryResultInput {
  connection: PostgresConnection;
  databaseName: string;
  schemaName?: string;
  sql: string;
  result: SqlQueryResult;
  source: "sqlRunner" | "sqlBook";
  title?: string;
  onRefresh?: () => Promise<SqlQueryResult>;
}

interface QueryResultPanelContext {
  input: OpenQueryResultInput;
  state: TableState;
}

export class TableDataPanelManager {
  private readonly panelConfig = new PanelConfig();
  private readonly panelRegistry = new PanelRegistry();
  private readonly nativePreviewSaveDisposable: vscode.Disposable;
  private readonly nativePreviewCloseDisposable: vscode.Disposable;
  private queryResultPanel: vscode.WebviewPanel | undefined;
  private readonly queryContextByPanel = new WeakMap<
    vscode.WebviewPanel,
    QueryResultPanelContext
  >();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postgresService: PostgresService,
  ) {
    cleanupStaleNativePreviewTempFiles();
    this.nativePreviewSaveDisposable = vscode.workspace.onDidSaveTextDocument(
      (document) => {
        this.handleNativePreviewDocumentSave(document);
      },
    );
    this.nativePreviewCloseDisposable = vscode.workspace.onDidCloseTextDocument(
      (document) => {
        this.handleNativePreviewDocumentClose(document);
      },
    );
  }

  public async openTable(input: OpenTableInput): Promise<void> {
    const key = input.newTab
      ? this.panelKey(input.node, true)
      : GLOBAL_REUSED_KEY;
    const shouldPersistOutsideRestore = this.getPersistLayoutOutsideRestore();
    const initialLayout =
      input.layout ??
      (shouldPersistOutsideRestore
        ? this.readStoredLayout(input.node)
        : undefined);

    const initialState = input.initialState ?? this.defaultState();

    if (!input.newTab) {
      const reused = this.panelRegistry.getReusedPanel(key);
      if (reused) {
        this.panelRegistry.setNode(reused, input.node);
        this.panelRegistry.setState(reused, this.cloneTableState(initialState));
        if (initialLayout) {
          this.panelRegistry.setLayout(reused, initialLayout);
        } else {
          this.panelRegistry.deleteLayout(reused);
        }
        reused.title = `${input.node.objectName}`;
        reused.reveal(vscode.ViewColumn.Active, false);
        await this.refreshPanel(reused, input.node, initialState, {
          retryTimeout: input.restoringOnStartup === true,
        });
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "dbadmin.tableData",
      `${input.node.objectName}`,
      {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    panel.webview.html = this.buildHtml(panel.webview);
    this.panelRegistry.setNode(panel, input.node);
    this.panelRegistry.setIsNewTab(panel, input.newTab);
    this.panelRegistry.setState(panel, this.cloneTableState(initialState));
    if (initialLayout) {
      this.panelRegistry.setLayout(panel, initialLayout);
    } else {
      this.panelRegistry.deleteLayout(panel);
    }

    if (input.newTab) {
      panel.iconPath = vscode.Uri.file(
        this.context.asAbsolutePath("resources/icons/table-colored.svg"),
      );
      this.panelRegistry.setReusedPanel(key, panel);
    } else {
      panel.iconPath = {
        light: vscode.Uri.file(
          this.context.asAbsolutePath("resources/icons/light/table.svg"),
        ),
        dark: vscode.Uri.file(
          this.context.asAbsolutePath("resources/icons/dark/table.svg"),
        ),
      };
    }

    this.saveOpenTabs();

    const disposable = panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        const currentNode = this.panelRegistry.getNode(panel) ?? input.node;

        if (message.type === "ready") {
          await this.refreshPanel(panel, currentNode, initialState, {
            retryTimeout: input.restoringOnStartup === true,
          });
          return;
        }

        if (message.type === "reload") {
          this.panelRegistry.setState(
            panel,
            this.cloneTableState(message.state),
          );
          this.saveOpenTabs();
          if (message.clearSelectionAndPreview === true) {
            await this.clearNativePreviewContent(panel);
          }
          await this.refreshPanel(panel, currentNode, message.state);
          return;
        }

        if (message.type === "updateState") {
          this.panelRegistry.setState(
            panel,
            this.cloneTableState(message.state),
          );
          this.saveOpenTabs();
          return;
        }

        if (message.type === "save") {
          try {
            this.panelRegistry.setState(
              panel,
              this.cloneTableState(message.state),
            );
            this.saveOpenTabs();
            await this.postgresService.saveTableData(
              currentNode.connection,
              currentNode.databaseName,
              currentNode.schemaName,
              currentNode.objectName,
              message.payload,
            );

            panel.webview.postMessage({
              type: "status",
              kind: "ok",
              message: t("Changes saved successfully."),
            });

            await this.refreshPanel(panel, currentNode, message.state);
          } catch (error) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: this.errorMessage(error),
            });
          }
          return;
        }

        if (message.type === "exportData") {
          try {
            await this.exportTableData(panel, currentNode, message);
          } catch (error) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: this.errorMessage(error),
            });
          }
          return;
        }

        if (message.type === "copyAdvancedClipboard") {
          try {
            const content = buildExportContent(
              message.format,
              message.columns,
              message.rows,
            );
            await vscode.env.clipboard.writeText(content);
            panel.webview.postMessage({
              type: "status",
              kind: "ok",
              message: t("Content copied to the clipboard."),
            });
          } catch (error) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: this.errorMessage(error),
            });
          }
          return;
        }

        if (message.type === "openInNewTab") {
          await this.openTable({ node: currentNode, newTab: true });
          return;
        }

        if (message.type === "openSettings") {
          await vscode.commands.executeCommand("dbadmin.openSettings");
          return;
        }

        if (message.type === "showInExplorer") {
          await vscode.commands.executeCommand(
            "dbadmin.showInExplorer",
            currentNode,
          );
          return;
        }

        if (message.type === "openJsonInNativeEditor") {
          await this.openOrSyncNativePreview(panel, message, true);
          return;
        }

        if (message.type === "syncNativeJsonPreview") {
          await this.openOrSyncNativePreview(panel, message, false);
          return;
        }

        if (message.type === "openForeignKeyTarget") {
          const targetSchemaName = String(
            message.targetSchemaName || "",
          ).trim();
          const targetTableName = String(message.targetTableName || "").trim();
          const targetColumnName = String(
            message.targetColumnName || "",
          ).trim();

          if (!targetSchemaName || !targetTableName || !targetColumnName) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message:
                "Incomplete foreign key metadata to open the related table.",
            });
            return;
          }

          const initialTargetState = this.defaultState();
          initialTargetState.searchMode = "query";
          const sourceValue = String(message.sourceValue ?? "").trim();
          if (sourceValue.length > 0) {
            initialTargetState.columnFilters[targetColumnName] = sourceValue;
          }

          await this.openTable({
            node: {
              type: "dbObject",
              connection: currentNode.connection,
              databaseName: currentNode.databaseName,
              schemaName: targetSchemaName,
              kind: "table",
              objectName: targetTableName,
            },
            newTab: true,
            initialState: initialTargetState,
          });
          return;
        }

        if (message.type === "searchForeignKeyMentions") {
          const targetSchemaName = String(
            message.targetSchemaName || "",
          ).trim();
          const targetTableName = String(message.targetTableName || "").trim();
          const targetColumnName = String(
            message.targetColumnName || "",
          ).trim();
          const sourceValue = String(message.sourceValue ?? "").trim();

          if (!targetSchemaName || !targetTableName || !targetColumnName) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message:
                t("Incomplete metadata to search key mentions."),
            });
            return;
          }

          if (!sourceValue) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: t("Empty value to search mentions."),
            });
            return;
          }

          try {
            const mentions =
              await this.postgresService.findForeignKeyMentions(
                currentNode.connection,
                currentNode.databaseName,
                targetSchemaName,
                targetTableName,
                targetColumnName,
                sourceValue,
              );

            await this.openQueryResult({
              connection: currentNode.connection,
              databaseName: currentNode.databaseName,
              schemaName: targetSchemaName,
              sql: mentions.sql,
              result: {
                columns: mentions.columns,
                rows: mentions.rows,
                rowCount: mentions.rowCount,
                command: mentions.command,
              },
              source: "sqlRunner",
              title: t("Mentions: {0}.{1}.{2} = {3}", targetSchemaName, targetTableName, targetColumnName, sourceValue),
              onRefresh: async () => {
                const refreshed =
                  await this.postgresService.findForeignKeyMentions(
                    currentNode.connection,
                    currentNode.databaseName,
                    targetSchemaName,
                    targetTableName,
                    targetColumnName,
                    sourceValue,
                  );
                return {
                  columns: refreshed.columns,
                  rows: refreshed.rows,
                  rowCount: refreshed.rowCount,
                  command: refreshed.command,
                };
              },
            });
          } catch (error) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: this.errorMessage(error),
            });
          }
          return;
        }

        if (message.type === "openConnectionManager") {
          await vscode.commands.executeCommand(
            "dbadmin.openConnectionManager",
            {
              type: "connection",
              connection: currentNode.connection,
            },
          );
          return;
        }

        if (message.type === "toggleIntegratedTable") {
          await toggleSqlBookIntegratedTableEnabled();
          await syncSqlBookIntegratedTableContext();
          this.notifyIntegratedTableModeChanged();
          return;
        }

        if (message.type === "updateLayout") {
          this.panelRegistry.setLayout(panel, message.layout);
          if (this.getPersistLayoutOutsideRestore()) {
            await this.persistLayout(currentNode, message.layout);
          }
          this.saveOpenTabs();
          return;
        }

        if (message.type === "openDiagramTableInNewTab") {
          const schemaName = String(message.schemaName || "").trim();
          const tableName = String(message.tableName || "").trim();
          if (!schemaName || !tableName) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message:
                "Nome de schema ou tabela invalido para abrir em nova aba.",
            });
            return;
          }
          await this.openTable({
            node: {
              type: "dbObject",
              connection: currentNode.connection,
              databaseName: currentNode.databaseName,
              schemaName,
              kind: "table",
              objectName: tableName,
            },
            newTab: true,
          });
          return;
        }

        if (message.type === "loadDiagram") {
          try {
            const diagramData = await this.postgresService.getTableDiagramData(
              currentNode.connection,
              currentNode.databaseName,
              currentNode.schemaName,
              currentNode.objectName,
              message.mainColumns,
            );
            panel.webview.postMessage({
              type: "diagramData",
              data: diagramData,
            });
          } catch (error) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: this.errorMessage(error),
            });
          }
          return;
        }

        if (message.type === "exportDiagram") {
          try {
            if (message.format === "png" && message.target === "file") {
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${message.tableName}.png`),
                filters: { "PNG Image": ["png"] },
              });
              if (uri) {
                const base64 = message.data.replace(
                  /^data:image\/png;base64,/,
                  "",
                );
                const buffer = Buffer.from(base64, "base64");
                await vscode.workspace.fs.writeFile(uri, buffer);
                vscode.window.showInformationMessage(
                  t("Diagram exported: {0}", uri.fsPath),
                );
              }
            } else if (
              message.format === "drawio" &&
              message.target === "file"
            ) {
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${message.tableName}.drawio`),
                filters: { "Draw.io Diagram": ["drawio", "xml"] },
              });
              if (uri) {
                await vscode.workspace.fs.writeFile(
                  uri,
                  Buffer.from(message.data, "utf-8"),
                );
                vscode.window.showInformationMessage(
                  t("Diagram exported: {0}", uri.fsPath),
                );
              }
            } else if (
              message.format === "drawio" &&
              message.target === "clipboard"
            ) {
              await vscode.env.clipboard.writeText(message.data);
              panel.webview.postMessage({
                type: "status",
                kind: "ok",
                message:
                  t("Diagram XML copied to the clipboard."),
              });
            }
          } catch (error) {
            panel.webview.postMessage({
              type: "status",
              kind: "error",
              message: this.errorMessage(error),
            });
          }
          return;
        }
      },
    );

    panel.onDidDispose(() => {
      disposable.dispose();
      void this.closeAndClearNativePreviewState(panel);
      this.panelRegistry.clearPanel(panel);
      if (!input.newTab) {
        this.panelRegistry.deleteReusedPanel(key);
      }
      this.saveOpenTabs();
    });
  }

  public async openQueryResult(input: OpenQueryResultInput): Promise<void> {
    const initialState: TableState = {
      searchText: "",
      searchMode: "local",
      sortColumn: undefined,
      sortDirection: undefined,
      columnFilters: {},
      limit: this.getDefaultPageSize(),
      page: 1,
    };

    let panel = this.queryResultPanel;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "dbadmin.queryResult",
        input.title || t("SQL result: {0}", input.connection.nickname),
        {
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.Active,
        },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      panel.webview.html = this.buildHtml(panel.webview);

      panel.iconPath = vscode.Uri.file(
        this.context.asAbsolutePath("resources/icons/table-colored.svg"),
      );

      const disposable = panel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          const context = this.queryContextByPanel.get(panel!);
          if (!context) {
            return;
          }

          if (message.type === "ready") {
            await this.postQueryResultData(panel!, context.input, context.state);
            return;
          }

          if (message.type === "reload") {
            context.state = this.cloneTableState({
              ...message.state,
              searchMode: "local",
            });

            if (context.input.onRefresh) {
              try {
                const refreshed = await context.input.onRefresh();
                context.input = { ...context.input, result: refreshed };
              } catch (error) {
                panel!.webview.postMessage({
                  type: "status",
                  kind: "error",
                  message: this.errorMessage(error),
                });
              }
            }

            await this.postQueryResultData(panel!, context.input, context.state);
            return;
          }

          if (message.type === "updateState") {
            context.state = this.cloneTableState({
              ...message.state,
              searchMode: "local",
            });
            return;
          }

          if (message.type === "save") {
            panel!.webview.postMessage({
              type: "status",
              kind: "error",
              message:
                t("Result view is read-only. Changes are not persisted."),
            });
            return;
          }

          if (message.type === "toggleIntegratedTable") {
            await vscode.commands.executeCommand(
              "dbadmin.toggleSqlBookIntegratedTable",
            );
            return;
          }

          if (message.type === "openSettings") {
            await vscode.commands.executeCommand("dbadmin.openSettings");
            return;
          }

          if (message.type === "exportData") {
            try {
              const format = message.format === "csv" ? "csv" : "json";
              const content = buildExportContent(
                format,
                message.columns,
                message.rows,
              );
              const language = format === "csv" ? "csv" : "json";
              const document = await vscode.workspace.openTextDocument({
                language,
                content,
              });

              await vscode.window.showTextDocument(document, {
                preview: false,
                preserveFocus: false,
                viewColumn: panel!.viewColumn ?? vscode.ViewColumn.Active,
              });

              panel!.webview.postMessage({
                type: "status",
                kind: "ok",
                message: t("Export opened in a new tab."),
              });
            } catch (error) {
              panel!.webview.postMessage({
                type: "status",
                kind: "error",
                message: this.errorMessage(error),
              });
            }
          }
        },
      );

      panel.onDidDispose(() => {
        disposable.dispose();
        void this.closeAndClearNativePreviewState(panel!);
        this.queryResultPanel = undefined;
      });

      this.queryResultPanel = panel;
      await this.tryMoveActiveEditorToBelowGroup();
    }

    this.queryContextByPanel.set(panel, {
      input,
      state: this.cloneTableState(initialState),
    });

    panel.title = input.title || t("SQL result: {0}", input.connection.nickname);
    panel.reveal(vscode.ViewColumn.Active, false);
    await this.postQueryResultData(panel, input, initialState);
  }

  private async postQueryResultData(
    panel: vscode.WebviewPanel,
    input: OpenQueryResultInput,
    state: TableState,
  ): Promise<void> {
    const effectiveResult = this.getEffectiveQueryResult(input.result);
    const columnsMeta: TableColumnMeta[] = effectiveResult.columns.map((name) => ({
      name,
      dataType: "text",
      isNullable: true,
      hasDefault: false,
      isPrimaryKey: false,
      isUnique: false,
      isForeignKey: false,
      foreignKeyTargetSchema: null,
      foreignKeyTargetTable: null,
      foreignKeyTargetColumn: null,
    }));

    const rowCount = Number.isFinite(effectiveResult.rowCount)
      ? Number(effectiveResult.rowCount)
      : effectiveResult.rows.length;

    panel.webview.postMessage({
      type: "data",
      title:
        input.title ||
        `${input.databaseName} / ${input.schemaName || "public"}.query_result`,
      connectionName:
        input.connection.nickname?.trim() ||
        input.connection.database?.trim() ||
        input.connection.host,
      databaseName: input.databaseName,
      schemaName: input.schemaName || "public",
      result: {
        query: input.sql,
        columns: columnsMeta,
        rows: effectiveResult.rows,
        totalRows: rowCount,
      },
      state: {
        ...state,
        searchMode: "local",
      },
      dynamicDefaultColumnWidth: this.getDynamicDefaultColumnWidth(),
      layout: undefined,
      readOnlyResultMode: true,
      hideDiagramMode: true,
      integratedTableMode: getSqlBookIntegratedTableEnabled(),
    });
  }

  private getEffectiveQueryResult(result: SqlQueryResult): SqlQueryResult {
    if (!Array.isArray(result.results) || result.results.length === 0) {
      return result;
    }

    const last = result.results[result.results.length - 1];
    return {
      columns: last.columns,
      rows: last.rows,
      rowCount: last.rowCount,
      command: last.command,
      results: result.results,
    };
  }

  private async tryMoveActiveEditorToBelowGroup(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        "workbench.action.moveEditorToBelowGroup",
      );
    } catch {
      // Best effort only.
    }
  }

  private async refreshPanel(
    panel: vscode.WebviewPanel,
    node: DbObjectNodeRef,
    state: TableState,
    options?: { retryTimeout?: boolean },
  ): Promise<void> {
    const maxAttempts = options?.retryTimeout ? 3 : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.postgresService.getTableData(
          node.connection,
          node.databaseName,
          node.schemaName,
          node.objectName,
          {
            searchText: state.searchText,
            searchMode: state.searchMode,
            sortColumn: state.sortColumn,
            sortDirection: state.sortDirection,
            columnFilters: state.columnFilters,
            limit: state.limit,
            page: state.page,
          },
        );

        panel.webview.postMessage({
          type: "data",
          title: `${node.databaseName} / ${node.schemaName}.${node.objectName}`,
          connectionName:
            node.connection.nickname?.trim() ||
            node.connection.database?.trim() ||
            node.connection.host,
          databaseName: node.databaseName,
          schemaName: node.schemaName,
          tableName: node.objectName,
          result,
          state,
          dynamicDefaultColumnWidth: this.getDynamicDefaultColumnWidth(),
          layout: this.panelRegistry.getLayout(panel),
        });
        return;
      } catch (error) {
        lastError = error;

        const shouldRetry =
          options?.retryTimeout &&
          this.isTimeoutError(error) &&
          attempt < maxAttempts;
        if (shouldRetry) {
          await this.wait(350);
          continue;
        }

        break;
      }
    }

    panel.webview.postMessage({
      type: "status",
      kind: "error",
      message: this.errorMessage(lastError),
    });
  }

  private async exportTableData(
    panel: vscode.WebviewPanel,
    node: DbObjectNodeRef,
    message: Extract<WebviewMessage, { type: "exportData" }>,
  ): Promise<void> {
    let columns = Array.isArray(message.columns) ? [...message.columns] : [];
    let rows = Array.isArray(message.rows) ? [...message.rows] : [];

    if (message.dataScope === "all") {
      const allResult = await fetchAllRowsForExport(
        this.postgresService,
        node,
        message.state,
      );
      columns = allResult.columns;
      rows = allResult.rows;
    }

    const format = message.format === "csv" ? "csv" : "json";
    const content = buildExportContent(format, columns, rows);
    const language = format === "csv" ? "csv" : "json";
    const document = await vscode.workspace.openTextDocument({
      language,
      content,
    });

    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: panel.viewColumn ?? vscode.ViewColumn.Active,
    });

    panel.webview.postMessage({
      type: "status",
      kind: "ok",
      message: t("Export opened in a new tab."),
    });
  }

  private isTimeoutError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("etimedout")
    );
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private panelKey(_node: DbObjectNodeRef, _newTab: boolean): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  private defaultState(): TableState {
    return createDefaultTableState(this.getDefaultPageSize());
  }

  private cloneTableState(state: TableState): TableState {
    return cloneTableStateWithPageSize(state, this.getDefaultPageSize());
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Erro inesperado";
  }

  private layoutStorageKey(node: DbObjectNodeRef): string {
    return buildTableLayoutStorageKey(node);
  }

  private readStoredLayout(
    node: DbObjectNodeRef,
  ): TableLayoutState | undefined {
    return readLayoutFromStore(this.context, node);
  }

  private async persistLayout(
    node: DbObjectNodeRef,
    layout: TableLayoutState,
  ): Promise<void> {
    await persistStoredLayout(this.context, node, layout);
  }

  private getPersistLayoutOutsideRestore(): boolean {
    return this.panelConfig.getPersistLayoutOutsideRestore();
  }

  private getDefaultPageSize(): number {
    return this.panelConfig.getDefaultPageSize();
  }

  private getDynamicDefaultColumnWidth(): boolean {
    return this.panelConfig.getDynamicDefaultColumnWidth();
  }

  public notifyIntegratedTableModeChanged(): void {
    const integratedTableMode = getSqlBookIntegratedTableEnabled();
    if (this.queryResultPanel) {
      this.queryResultPanel.webview.postMessage({
        type: "integratedTableMode",
        integratedTableMode,
      });
    }
    for (const [panel] of this.panelRegistry.getAllNodes()) {
      panel.webview.postMessage({
        type: "integratedTableMode",
        integratedTableMode,
      });
    }
  }

  private async updateNativePreviewContent(
    state: NativeJsonPreviewState,
    content: string,
    options?: { preserveFocus?: boolean },
  ): Promise<void> {
    const formatted = formatPreviewJson(String(content ?? ""));
    if (state.document.getText() === formatted) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      state.document.positionAt(0),
      state.document.positionAt(state.document.getText().length),
    );
    edit.replace(state.document.uri, fullRange, formatted);
    await vscode.workspace.applyEdit(edit);
  }

  private async clearNativePreviewContent(
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const state = this.panelRegistry.getNativePreview(panel);
    if (!state) {
      return;
    }
    await this.updateNativePreviewContent(state, "", { preserveFocus: true });
    state.ctid = null;
    state.rowKey = null;
  }

  private getOrCreatePanelPreviewTabId(panel: vscode.WebviewPanel): string {
    const existing = this.panelRegistry.getPreviewTabId(panel);
    if (existing) {
      return existing;
    }
    const id = this.panelRegistry.generatePreviewTabId();
    this.panelRegistry.setPreviewTabId(panel, id);
    return id;
  }

  private getNativePreviewFilePrefix(panel: vscode.WebviewPanel): string {
    const node = this.panelRegistry.getNode(panel);
    return buildNativePreviewFilePrefix(
      node?.objectName ?? "tabela",
      this.getOrCreatePanelPreviewTabId(panel),
    );
  }

  private async openOrSyncNativePreview(
    panel: vscode.WebviewPanel,
    payload: {
      content: string;
      columnName: string;
      isJson?: boolean;
      ctid?: string | null;
      rowKey?: string | null;
      open?: boolean;
      preserveFocus?: boolean;
    },
    forceOpen: boolean,
  ): Promise<void> {
    const isJson = payload.isJson !== false;
    let state = this.panelRegistry.getNativePreview(panel);

    if (!state && !forceOpen && payload.open !== true) {
      return;
    }

    if (!state) {
      const tmpFilePrefix = this.getNativePreviewFilePrefix(panel);
      const {
        document,
        tmpFilePath,
        tmpFilePrefix: createdTmpFilePrefix,
      } = await createNativePreviewTempDocument(payload.content, tmpFilePrefix);
      cleanupNativePreviewTempFilesByPrefix(tmpFilePrefix, tmpFilePath);

      let targetViewColumn = vscode.ViewColumn.Active;
      const previewTabGroupViewColumn = findPreviewTabGroupViewColumn();

      if (previewTabGroupViewColumn) {
        // Reutiliza tab group existente com preview
        targetViewColumn = previewTabGroupViewColumn;
      } else {
        // Cria novo container com split down
        try {
          await vscode.commands.executeCommand(
            "workbench.action.splitEditorDown",
          );
        } catch {
          // Fallback: open beside if split command is unavailable.
        }
      }

      const shownEditor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: payload.preserveFocus === true,
        viewColumn: targetViewColumn,
      });

      state = {
        document,
        tmpFilePath,
        tmpFilePrefix: createdTmpFilePrefix,
        isJson,
        ctid: payload.ctid ?? null,
        rowKey: payload.rowKey ?? null,
        columnName: payload.columnName,
        viewColumn: shownEditor.viewColumn,
      };
      this.panelRegistry.setNativePreview(panel, state);
      this.panelRegistry.setPreviewDocumentPanel(
        document.uri.toString(),
        panel,
      );

      if (payload.preserveFocus) {
        panel.reveal(panel.viewColumn, false);
        panel.webview.postMessage({ type: "restoreGridFocus" });
      }
      return;
    }

    state.isJson = isJson;
    state.ctid = payload.ctid ?? null;
    state.rowKey = payload.rowKey ?? null;
    state.columnName = payload.columnName;
    await this.updateNativePreviewContent(state, payload.content, {
      preserveFocus: !forceOpen,
    });

    if (!forceOpen && !isDocumentActiveInEditor(state.document)) {
      scrollPreviewDocumentToTop(state.document);
    }

    if (forceOpen) {
      const existingVisibleEditor = getVisibleEditorForDocument(state.document);
      if (!existingVisibleEditor) {
        try {
          await vscode.commands.executeCommand(
            "workbench.action.splitEditorDown",
          );
        } catch {
          // Fallback: keep current group when split command is unavailable.
        }
      }

      const targetViewColumn =
        existingVisibleEditor?.viewColumn ?? vscode.ViewColumn.Active;

      const shownEditor = await vscode.window.showTextDocument(state.document, {
        preview: false,
        preserveFocus: payload.preserveFocus === true,
        viewColumn: targetViewColumn,
      });
      state.viewColumn = shownEditor.viewColumn;

      if (payload.preserveFocus) {
        panel.reveal(panel.viewColumn, false);
        panel.webview.postMessage({ type: "restoreGridFocus" });
      }
    }
  }

  private handleNativePreviewDocumentSave(document: vscode.TextDocument): void {
    const panel = this.panelRegistry.getPanelByPreviewDocument(
      document.uri.toString(),
    );
    if (!panel) {
      return;
    }

    const state = this.panelRegistry.getNativePreview(panel);
    if (!state || state.document.uri.toString() !== document.uri.toString()) {
      this.panelRegistry.deletePreviewDocumentPanel(document.uri.toString());
      return;
    }

    panel.webview.postMessage({
      type: "nativeJsonPreviewContentChanged",
      content: document.getText(),
      ctid: state.ctid,
      rowKey: state.rowKey,
      columnName: state.columnName,
    });
  }

  private handleNativePreviewDocumentClose(
    document: vscode.TextDocument,
  ): void {
    const panel = this.panelRegistry.getPanelByPreviewDocument(
      document.uri.toString(),
    );

    if (!panel) {
      return;
    }
    this.clearNativePreviewState(panel);
  }

  private async closeAndClearNativePreviewState(
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const state = this.panelRegistry.getNativePreview(panel);
    if (!state) {
      return;
    }

    try {
      await closeDocumentTabByUri(state.document.uri);
    } catch {
      // Best effort: still clear state if closing the editor tab fails.
    }

    this.clearNativePreviewState(panel);
  }

  private clearNativePreviewState(panel: vscode.WebviewPanel): void {
    const state = this.panelRegistry.getNativePreview(panel);
    if (!state) {
      return;
    }
    this.panelRegistry.deletePreviewDocumentPanel(
      state.document.uri.toString(),
    );
    this.panelRegistry.deleteNativePreview(panel);
    try {
      fs.unlinkSync(state.tmpFilePath);
    } catch {
      // Temp file may already be gone or locked.
    }
    cleanupNativePreviewTempFilesByPrefix(state.tmpFilePrefix);
  }

  private saveOpenTabs(): void {
    const panelNodesMap = new Map(this.panelRegistry.getAllNodes());
    const panelIsNewTabMap = new Map(this.panelRegistry.getAllIsNewTab());
    const panelLayoutsMap = new Map(this.panelRegistry.getAllLayouts());
    const panelStatesMap = new Map(this.panelRegistry.getAllStates());
    const openTabs = buildOpenTabsSnapshot(
      panelNodesMap,
      panelIsNewTabMap,
      panelLayoutsMap,
      panelStatesMap,
      (state) => this.cloneTableState(state),
      this.defaultState(),
    );
    void persistOpenTabs(this.context, openTabs);
  }

  public async restoreOpenTabs(store: ConnectionStore): Promise<void> {
    try {
      const openTabs = getStoredOpenTabs(this.context) as StoredOpenTab[];

      if (!openTabs || openTabs.length === 0) {
        return;
      }

      for (const tab of openTabs) {
        try {
          const connection = await store.getConnection(tab.connectionId);
          if (!connection) {
            continue;
          }

          const node: DbObjectNodeRef = {
            type: "dbObject",
            kind: "table",
            connection,
            databaseName: tab.databaseName,
            schemaName: tab.schemaName,
            objectName: tab.objectName,
          };

          await this.openTable({
            node,
            newTab: tab.newTab,
            restoringOnStartup: true,
            layout: tab.layout,
            initialState: this.cloneTableState(
              tab.state ?? this.defaultState(),
            ),
          });
        } catch (error) {
          console.error(`Falha ao restaurar aba ${tab.objectName}:`, error);
        }
      }
    } catch (error) {
      console.error("Falha ao restaurar abas abertas:", error);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};`;
    const defaultPageSize = this.getDefaultPageSize();
    const codeEditorStyles = buildCodeEditorStyles();
    const codeEditorMarkup = buildCodeEditorMarkup();
    const queryCodeEditorMarkup = buildCodeEditorMarkup("queryCodeEditor");
    const codeEditorScript = buildCodeEditorScript();
    const extensionPath = this.context.extensionPath;
    const i18n = loadLocaleDict(extensionPath);
    const i18nScript = webviewI18nBootstrap(extensionPath);
    const i18nLang = getBcp47Locale();
    const L = (key: string, fallback: string) =>
      String(i18n[key] || fallback)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const codiconsCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "@vscode",
        "codicons",
        "dist",
        "codicon.css",
      ),
    );
    const tableAdvancedFilterScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "webview",
        "tableAdvancedFilter.js",
      ),
    );
    const initialDynamicDefaultColumnWidth =
      this.getDynamicDefaultColumnWidth();

    return `<!DOCTYPE html>
<html lang="${i18nLang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconsCssUri}" rel="stylesheet" />
  <script nonce="${nonce}">${i18nScript}</script>
  <style>
    html, body { height: 100%; }
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; overflow: hidden; }
    .shell { height: 100vh; min-height: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; margin-top: 2px; position: relative; }
    .loading-bar { position: fixed; top: 0; left: 0; right: 0; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; transition: opacity 120ms ease; z-index: 90; }
    .loading-bar.active { opacity: 1; }
    .loading-bar::before { content: ''; position: absolute; top: 0; left: 0; height: 100%; width: 21%; background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); animation: dbadmin-loading 2s ease-in-out infinite; }
    @keyframes dbadmin-loading {
      0% { left: -21%; }
      100% { left: 100%; }
    }
    .header { display: none; }
    .title { font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .title svg { width: 14px; height: 14px; margin-top: 4px; }
    .title .info-item { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
    .title .info-item .codicon { font-size: 14.5px; line-height: 1; margin-top: 1.5px; }
    .title .info-fixed { flex: 0 0 auto; white-space: nowrap; }
    .title .info-conn { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .header-menu-wrap { position: relative; }
    .overlay-backdrop { position: fixed; inset: 0; display: none; }
    .overlay-backdrop.open { display: block; }
    .overlay-surface { position: fixed; display: none; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 11%, var(--vscode-panel-border)); background: var(--vscode-editorWidget-background); border-radius: 8px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.18); }
    .overlay-surface.open { display: block; }
    .overlay-scroll,
    .overlay-submenu {
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent) transparent;
    }
    .overlay-scroll::-webkit-scrollbar,
    .overlay-submenu::-webkit-scrollbar { width: 8px; height: 8px; }
    .overlay-scroll::-webkit-scrollbar-button,
    .overlay-submenu::-webkit-scrollbar-button { display: none; }
    .overlay-scroll::-webkit-scrollbar-track,
    .overlay-submenu::-webkit-scrollbar-track { background: transparent; }
    .overlay-scroll::-webkit-scrollbar-thumb,
    .overlay-submenu::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
    .overlay-scroll::-webkit-scrollbar-corner,
    .overlay-submenu::-webkit-scrollbar-corner { background: transparent; }
    .overlay-surface button,
    .overlay-submenu button { width: 100%; min-height: 28px; border: 0; border-radius: 0; text-align: left; background: transparent; color: var(--vscode-foreground); white-space: nowrap; display: flex; align-items: center; gap: 8px; padding: 0 10px; justify-content: flex-start; }
    .overlay-surface button:hover,
    .overlay-submenu button:hover { background: var(--vscode-list-hoverBackground); }
    .overlay-item-icon { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
    .simple-menu { padding: 4px; }
    .simple-menu button,
    .simple-menu .menu-submenu > button { border-radius: 6px; padding: 0 4px; }
    .query-container { padding: 0 4px; flex: 0 0 auto; margin-bottom: -2px; position: relative; }
    .query { width: 100%; box-sizing: border-box; resize: none; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 6px 34px 6px 8px; line-height: 1.2; height: 28px; min-height: 28px; overflow: auto; outline: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .query:focus { border-color: var(--dbadmin-input-focus); }
    .query { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent) transparent; }
    .query::-webkit-scrollbar { width: 8px; height: 8px; }
    .query::-webkit-scrollbar-button { display: none; }
    .query::-webkit-scrollbar-track { background: transparent; }
    .query::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
    .query::-webkit-scrollbar-corner { background: transparent; }
    .query-resizer { position: absolute; right: 5px; bottom: 4px; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; cursor: ns-resize; user-select: none; }
    .query-resizer svg { width: 14px; height: 14px; pointer-events: none; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 4px; flex: 0 0 auto; }
    #toolbarMenuBtn { display: inline-flex; margin-left: auto; }
    .grow { flex: 1 1 150px; min-width: 150px; }
    .search-wrap { position: relative; border-radius: 6px; overflow: hidden; }
    .search-wrap .input {
      width: 100%;
      border: 1px solid transparent;
      background: transparent;
      padding-right: 30px;
      outline: none;
    }
    .search-wrap:hover .input:not(:focus) {
      border-color: color-mix(in srgb, var(--vscode-foreground) 16%, var(--vscode-panel-border));
    }
    .search-wrap.is-active .input,
    .search-wrap.has-value .input,
    .search-wrap .input:focus {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    .search-wrap.has-value .input:not(:focus) {
      border-color: var(--vscode-input-border, color-mix(in srgb, var(--vscode-foreground) 22%, var(--vscode-panel-border)));
    }
    .search-wrap.is-active .input,
    .search-wrap .input:focus {
      border-color: var(--dbadmin-input-focus);
    }
    .search-icon {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      width: 16px;
      height: 16px;
      color: var(--vscode-descriptionForeground);
      pointer-events: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .search-icon .codicon { font-size: 16px; line-height: 1; }
    .search-context-placeholder {
      position: absolute;
      inset: 1px 30px 1px 1px;
      padding: 0 8px;
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      pointer-events: none;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      border-radius: 5px;
    }
    .search-context-placeholder svg { width: 12px; height: 12px; flex: 0 0 auto; }
    .search-context-placeholder .codicon { font-size: 13px; line-height: 1; margin-right: 1px; }
    .search-context-placeholder .info-item { display: inline-flex; align-items: center; gap: 0; min-width: 0; }
    .search-context-placeholder .info-fixed { flex: 0 0 auto; white-space: nowrap; }
    .search-context-placeholder .info-conn { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .input { border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--vscode-foreground) 18%, var(--vscode-panel-border))); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 0 8px; height: 28px; box-sizing: border-box; overflow: hidden; background-clip: padding-box; }
    .btn-icon-fix { padding: 0px 0px 2px 0px !important; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; padding: 0 10px; height: 28px; cursor: pointer; box-sizing: border-box; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-button-border, transparent); }
    button:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset; }
    .toolbar > button.btn-icon,
    .toolbar > div > button.btn-icon,
    .toolbar .mode-select > button.btn-icon,
    .diagram-toolbar > button.btn-icon {
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-foreground);
    }
    .toolbar > button.btn-icon.secondary,
    .toolbar > div > button.btn-icon.secondary,
    .toolbar .mode-select > button.btn-icon.secondary,
    .diagram-toolbar > button.btn-icon.secondary {
      background: transparent;
      color: var(--vscode-foreground);
    }
    .toolbar > button.btn-icon.primary,
    .toolbar > div > button.btn-icon.primary,
    .diagram-toolbar > button.btn-icon.primary {
      background: transparent;
      border-color: transparent;
      color: var(--vscode-button-background);
    }
    .toolbar > button.btn-icon:hover:not(:disabled),
    .toolbar > div > button.btn-icon:hover:not(:disabled),
    .toolbar .mode-select > button.btn-icon:hover:not(:disabled),
    .diagram-toolbar > button.btn-icon:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      border-color: transparent;
      color: var(--vscode-foreground);
    }
    .toolbar > button.btn-icon.primary:hover:not(:disabled),
    .toolbar > div > button.btn-icon.primary:hover:not(:disabled),
    .diagram-toolbar > button.btn-icon.primary:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      border-color: transparent;
      color: var(--vscode-button-background);
    }
    .toolbar > button:not(.btn-icon),
    .toolbar > div > button:not(.btn-icon),
    .diagram-toolbar > button:not(.btn-icon) {
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-foreground) 3.5%, transparent);
      color: var(--vscode-foreground);
    }
    .toolbar > button.primary:not(.btn-icon),
    .toolbar > div > button.primary:not(.btn-icon),
    .diagram-toolbar > button.primary:not(.btn-icon) {
      border-color: color-mix(in srgb, var(--vscode-button-background) 40%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-button-background) 8%, transparent);
      color: var(--vscode-button-background);
    }
    .toolbar > button:not(.btn-icon):hover:not(:disabled),
    .toolbar > div > button:not(.btn-icon):hover:not(:disabled),
    .diagram-toolbar > button:not(.btn-icon):hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
      border-color: color-mix(in srgb, var(--vscode-foreground) 24%, var(--vscode-panel-border));
      color: var(--vscode-foreground);
    }
    .toolbar > button.primary:not(.btn-icon):hover:not(:disabled),
    .toolbar > div > button.primary:not(.btn-icon):hover:not(:disabled),
    .diagram-toolbar > button.primary:not(.btn-icon):hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-button-background) 14%, transparent);
      border-color: color-mix(in srgb, var(--vscode-button-background) 50%, var(--vscode-panel-border));
      color: var(--vscode-button-background);
    }
    .toolbar > button:focus-visible,
    .toolbar > div > button:focus-visible,
    .toolbar .mode-select > button:focus-visible,
    .diagram-toolbar > button:focus-visible {
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }
    #pageInfo {
      min-width: 60px;
      white-space: nowrap;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 28px;
    }
    #pageInfoBtn {
      min-width: 60px;
      justify-content: center;
      font-variant-numeric: tabular-nums;
      padding: 0 6px;
    }
    .pagination-menu {
      width: min(130px, calc(100vw - 24px));
      padding: 8px;
      flex-direction: column;
      gap: 10px;
      z-index: 62;
    }
    #paginationMenu.open { display: flex; }
    .pagination-menu-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
      text-align: center;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .pagination-menu .row {
      display: grid;
      grid-template-columns: 1fr;
      align-items: start;
      gap: 6px;
    }
    .pagination-menu .label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .pagination-menu .input {
      width: 100%;
    }
    .mode-select { position: relative; display: inline-flex; }
    .header-menu { z-index: 40; min-width: 180px; }
    .header-menu hr.menu-separator,
    .menu hr.menu-separator { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0; }
    .header-menu button:last-child,
    .mode-dropdown button:last-child,
    .menu > button:last-child,
    .menu-submenu > button:last-child { border-bottom: 0; }
    .header-menu .header-view-btn + .header-view-btn { margin-top: 4px; }
    .header-menu-query-result-only { display: none; }
    .header-menu button {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-menu .menu-item-check {
      display: inline-flex;
      width: 16px;
      min-width: 16px;
      height: 16px;
      justify-content: center;
      align-items: center;
      flex: 0 0 auto;
      font-size: 12px;
      line-height: 1;
      opacity: 0;
    }
    .header-menu .menu-item-check.is-checked {
      opacity: 1;
    }
    .header-menu .menu-item-check.is-checked::before {
      content: "✓";
    }
    .header-view-btn.active .menu-item-check {
      opacity: 1;
    }
    .header-view-btn.active .menu-item-check::before {
      content: "✓";
    }
    .diagram-view { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
    .diagram-toolbar { display: flex; align-items: center; gap: 6px; padding: 0px 4px 2px 4px; flex: 0 0 auto; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
    .diagram-zoom-group { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .diagram-zoom-group .input { width: 56px; }
    .diagram-toolbar-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-right: 4px; }
    .diagram-toolbar-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 2px; }
    .diagram-canvas { flex: 1 1 auto; overflow: hidden; position: relative; cursor: grab; background: var(--vscode-editor-background); }
    .diagram-canvas.panning { cursor: grabbing; }
    .diagram-canvas svg { display: block; width: 100%; height: 100%; overflow: visible; }
    /* Diagram ER: theme tokens only (no baked rgb) so colors track theme switches live */
    #diagramSvg {
      /* FK em destaque: verde do tema, depois “added” git, depois aviso (âmbar), último verde fixo */
      --diagram-fk-accent: var(
        --vscode-charts-green,
        var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-editorWarning-foreground, #73c991))
      );
    }
    #diagramSvg .diagram-fk-edge { fill: none; stroke: var(--vscode-textLink-foreground); stroke-width: 1.5; opacity: 0.85; }
    #diagramSvg .diagram-fk-edge.diagram-fk-edge--selected {
      stroke: var(--diagram-fk-accent);
      stroke-width: 3;
      opacity: 1;
    }
    #diagramSvg .diagram-fk-edge-dot { fill: var(--vscode-textLink-foreground); }
    #diagramSvg .diagram-fk-edge-dot.diagram-fk-edge-dot--selected { fill: var(--diagram-fk-accent); }
    #diagramSvg .diagram-fk-hit { fill: none; stroke: transparent; pointer-events: stroke; }
    #diagramSvg .diagram-card-bg.diagram-card-bg--selected {
      stroke: var(--vscode-focusBorder);
      stroke-width: 3;
    }
    #diagramSvg .diagram-col-highlight {
      fill: color-mix(in srgb, var(--diagram-fk-accent) 38%, transparent);
    }
    #diagramSvg .diagram-header-drag { fill: transparent; cursor: move; }
    #diagramSvg .diagram-arrow-head { fill: var(--vscode-textLink-foreground); }
    #diagramSvg .diagram-arrow-head--accent { fill: var(--diagram-fk-accent); }
    #diagramSvg { --diagram-table-line: color-mix(in srgb, var(--vscode-foreground) 28%, var(--vscode-panel-border)); }
    #diagramSvg .diagram-card-bg { fill: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, var(--vscode-panel-background, var(--vscode-editor-background)))); }
    #diagramSvg .diagram-card-bg.diagram-card-bg--main { stroke: var(--vscode-button-background); stroke-width: 2; }
    #diagramSvg .diagram-card-bg.diagram-card-bg--other { stroke: var(--diagram-table-line); stroke-width: 1; }
    #diagramSvg .diagram-card-header--main { fill: var(--vscode-button-background); }
    #diagramSvg .diagram-card-header--other { fill: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-button-secondaryBackground))); }
    #diagramSvg .diagram-header-divider--main { stroke: var(--vscode-button-background); stroke-width: 1; }
    #diagramSvg .diagram-header-divider--other { stroke: var(--diagram-table-line); stroke-width: 1; }
    #diagramSvg .diagram-title--main { fill: var(--vscode-button-foreground); }
    #diagramSvg .diagram-title--other { fill: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); }
    #diagramSvg .diagram-schema--main { fill: color-mix(in srgb, var(--vscode-button-foreground) 74%, transparent); }
    #diagramSvg .diagram-schema--other { fill: var(--vscode-descriptionForeground); }
    #diagramSvg .diagram-row-sep {
      stroke: var(--diagram-table-line);
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
      shape-rendering: crispEdges;
      opacity: 1;
    }
    #diagramSvg .diagram-icon--pk { fill: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, var(--vscode-foreground))); }
    #diagramSvg .diagram-icon--fk { fill: var(--vscode-textLink-foreground); }
    #diagramSvg .diagram-icon--spacer { fill: transparent; }
    #diagramSvg .diagram-col-name { fill: var(--vscode-foreground); }
    #diagramSvg .diagram-col-name--pk { fill: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, var(--vscode-foreground))); }
    #diagramSvg .diagram-col-type { fill: var(--vscode-descriptionForeground); }
    .diagram-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--vscode-descriptionForeground); }
    .diagram-export-modal {
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(400px, calc(100vw - 24px));
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border-radius: 8px;
      box-shadow: 0 0 16px rgba(0, 0, 0, 0.28);
      display: none;
      flex-direction: column;
      z-index: 71;
      overflow: hidden;
    }
    .diagram-export-modal.open { display: flex; }
    #diagramExportModalBackdrop { z-index: 70; background: rgba(0, 0, 0, 0.35); }
    .mode-dropdown { z-index: 20; min-width: 170px; }
    .columns-popup { width: 280px; max-height: 60vh; overflow: auto; z-index: 60; }
    #modeBackdrop { z-index: 19; }
    #headerMenuBackdrop { z-index: 39; }
    #menuBackdrop { z-index: 49; }
    #sortMenuBackdrop { z-index: 54; }
    #columnsBackdrop { z-index: 59; }
    #paginationMenuBackdrop {
      z-index: 61;
      pointer-events: auto;
      background: transparent;
    }
    .columns-popup-head { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 10px; }
    .columns-search { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 0 8px; height: 26px; overflow: hidden; background-clip: padding-box; }
    .columns-search:focus { border-color: var(--dbadmin-input-focus); outline: none; }
    .columns-list { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
    .columns-item { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; cursor: grab; user-select: none; }
    .columns-item.all-toggle { grid-template-columns: auto 1fr; cursor: default; }
    .columns-divider { height: 1px; background: var(--vscode-panel-border); margin: 2px 0 4px; border-radius: 1px; list-style: none; }
    .columns-item.no-reorder { cursor: default; }
    .columns-item.no-reorder .columns-item-handle { opacity: 0.35; }
    .columns-item:hover { background: var(--vscode-list-hoverBackground); }
    .columns-item.drag-over { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent); }
    .columns-item-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; }
    .columns-item-handle { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #errorMsg { display: none; color: var(--vscode-errorForeground); padding: 12px 10px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; flex: 1 1 auto; min-height: 0; overflow: auto; }
    .table-wrap { border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); overflow: auto; flex: 1 1 auto; min-height: 0; }
    .table-wrap:focus { outline: none; }
    table { width: 100%; border-collapse: collapse; }
    .table-cells-body { user-select: none; }
    th, td { border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 15%, transparent); padding: 2px 6px 1px 6px; vertical-align: top; }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 2;
      min-width: 170px;
      box-sizing: border-box;
      border-bottom: 0;
    }
    th::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 1px;
      background: var(--vscode-panel-border);
      pointer-events: none;
      z-index: 5;
    }
    th.fill-col,
    td.fill-col {
      width: auto;
      min-width: 0 !important;
      max-width: none !important;
      padding: 0 !important;
    }
    th.fill-col {
      background: var(--vscode-sideBar-background);
      z-index: 1;
    }
    td:not(.fill-col):has(+ td.fill-col) {
      position: relative;
    }
    td:not(.fill-col):has(+ td.fill-col)::after {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      width: 1px;
      height: 100%;
      background: var(--vscode-panel-border);
      pointer-events: none;
    }
    .th-title { display: flex; align-items: center; justify-content: space-between; gap: 0; padding: 0px 5px 0px 0px; cursor: grab; }
    .th-name { font-weight: 600; font-size: 12px; cursor: inherit; flex: 1 1 auto; min-width: 0; text-align: left; border-radius: 4px; padding-left: 5px; }
    th.col-drag-over { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .th-resizer { position: absolute; top: 0; right: 0; width: 8px; height: 100%; cursor: col-resize; user-select: none; border-radius: 2px; transition: background 120ms ease; }
    .th-resizer::before { content: ''; position: absolute; top: 2px; bottom: 2px; right: 0px; width: 1px; background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
    .th-name:hover:not(:active) { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, var(--vscode-foreground) 10%); }
    body.col-resizing, body.col-resizing * { cursor: col-resize !important; }
    .th-icons { cursor: pointer; user-select: none; border-radius: 4px; padding: 0 2px; display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
    .th-icons .codicon { font-size: 14px; line-height: 1; width: 14px; height: 14px; }
    .th-icons .sort-icon-pair {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      line-height: 1;
      gap: 0;
      transform: translateY(-2px);
    }
    .th-icons .sort-icon-pair .codicon {
      font-size: 11px;
      width: 12px;
      height: 7px;
      -webkit-text-stroke: 0.35px currentColor;
      paint-order: stroke fill;
    }
    .th-icons:hover { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, var(--vscode-foreground) 10%); color: var(--vscode-foreground); }
    .sort-menu { z-index: 55; min-width: 180px; }
    .sort-menu button {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sort-menu .menu-item-check {
      display: inline-flex;
      width: 16px;
      min-width: 16px;
      height: 16px;
      justify-content: center;
      align-items: center;
      flex: 0 0 auto;
      font-size: 12px;
      line-height: 1;
      opacity: 0;
    }
    .sort-menu .menu-item-check.is-checked {
      opacity: 1;
    }
    .sort-menu .menu-item-check.is-checked::before {
      content: "✓";
    }
    .th-filter-wrap { width: 100%; border-radius: 4px; overflow: hidden; }
    .th-filter { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); border-radius: 4px; padding: 4px; font-size: 11px; outline: none; overflow: hidden; background-clip: padding-box; }
    .th-filter:focus { border-color: var(--dbadmin-input-focus); background: var(--vscode-input-background); color: var(--vscode-input-foreground); outline: none; box-shadow: none; }
    .cell-input { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); border-radius: 4px; padding: 4px; outline: none; overflow: hidden; background-clip: padding-box; }
    .cell-input:focus { border-color: var(--dbadmin-input-focus); background: var(--vscode-input-background); }
    .cell-input.dirty { background: rgba(70, 130, 255, 0.18); border-color: rgba(70, 130, 255, 0.62); }
    .cell-input.cell-input-placeholder::placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      opacity: 0.95;
    }
    .json-cell { position: relative; }
    .cell-action-btn {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      min-height: 20px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease;
      z-index: 1;
    }
    .json-open-btn { right: 6px; }
    .json-cell.has-bool-toggle .json-open-btn { right: 6px; }
    .cell-bool-toggle-btn { right: 28px; }
    .cell-action-btn:hover:not(:disabled),
    .cell-action-btn:focus-visible {
      border-color: transparent;
      box-shadow: none;
      outline: none;
    }
    .json-cell:hover .cell-action-btn,
    .json-cell:focus-within .cell-action-btn { opacity: 1; pointer-events: auto; }
    .cell-action-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      border-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    }
    .cell-input.editing ~ .cell-action-btn {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .json-open-btn .codicon { font-size: 14px; line-height: 1; width: 14px; height: 14px; transform: translateX(1px); }
    .cell-bool-toggle-btn .bool-toggle-box {
      width: 12px;
      height: 12px;
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 55%, transparent);
      border-radius: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      background: transparent;
    }
    .cell-bool-toggle-btn .bool-toggle-box .codicon {
      font-size: 11px;
      line-height: 1;
      width: 11px;
      height: 11px;
      opacity: 0;
    }
    .cell-bool-toggle-btn.is-checked .bool-toggle-box {
      background: color-mix(in srgb, var(--vscode-foreground) 72%, transparent);
      border-color: color-mix(in srgb, var(--vscode-foreground) 72%, transparent);
      color: var(--vscode-editor-background, var(--vscode-sideBar-background, #fff));
    }
    .cell-bool-toggle-btn.is-checked .bool-toggle-box .codicon {
      opacity: 1;
      font-size: 11px;
      width: 11px;
      height: 11px;
      color: var(--vscode-editor-background, var(--vscode-sideBar-background, #fff));
    }
    .cell-bool-toggle-btn.is-checked:hover:not(:disabled) .bool-toggle-box {
      background: color-mix(in srgb, var(--vscode-foreground) 82%, transparent);
      border-color: color-mix(in srgb, var(--vscode-foreground) 82%, transparent);
      color: var(--vscode-editor-background, var(--vscode-sideBar-background, #fff));
    }
    tr.row-added td { background: rgba(46, 160, 67, 0.12); border-bottom-color: color-mix(in srgb, var(--vscode-foreground) 15%, rgba(46, 160, 67, 0.12)) !important; }
    tr.row-removed td { background: rgba(220, 53, 69, 0.16); border-bottom-color: color-mix(in srgb, var(--vscode-foreground) 15%, rgba(220, 53, 69, 0.16)) !important; }
    .json-modal-backdrop { z-index: 69; background: rgba(0, 0, 0, 0.35); }
    .json-modal {
      position: fixed;
      left: 50%;
      top: 40%;
      transform: translate(-50%, -40%);
      width: min(880px, calc(100vw - 24px));
      max-height: calc(100vh - 24px);
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 8px;
      box-shadow: 0 0 16px rgba(0, 0, 0, 0.28);
      display: none;
      flex-direction: column;
      z-index: 70;
      overflow: hidden;
    }
    @media (max-width: 1024px) {
      .json-modal {
        width: min(720px, calc(100vw - 24px));
      }
    }
    @media (max-width: 768px) {
      .json-modal {
        width: min(600px, calc(100vw - 24px));
        max-height: calc(100vh - 40px);
      }
    }
    @media (max-width: 480px) {
      .json-modal {
        width: calc(100vw - 16px);
        max-height: calc(100vh - 32px);
      }
    }
    .json-modal.open { display: flex; }
    .json-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, var(--vscode-sideBar-background));
    }
    .json-modal-title { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .json-modal-head-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .json-modal-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    .export-modal {
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(480px, calc(100vw - 24px));
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border-radius: 8px;
      box-shadow: 0 0 16px rgba(0, 0, 0, 0.28);
      display: none;
      flex-direction: column;
      z-index: 71;
      overflow: hidden;
    }
    .export-modal.open { display: flex; }
    #exportModalBackdrop { z-index: 70; background: rgba(0, 0, 0, 0.35); }
    .export-modal-head { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
    .export-modal-body { padding: 10px 12px; display: grid; gap: 12px; }
    .export-group-title { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .export-group { display: grid; gap: 6px; }
    .export-option { display: inline-flex; align-items: center; gap: 8px; }
    .export-option.disabled { opacity: 0.55; }
    .export-modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); }
    .json-modal-status {
      display: none;
    }
    ${codeEditorStyles}
    .menu { z-index: 50; min-width: 180px; }
    .menu > button,
    .menu .menu-submenu-wrap > button,
    .menu-submenu > button {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .menu .menu-item-icon {
      display: inline-flex;
      width: 16px;
      min-width: 16px;
      height: 16px;
      justify-content: center;
      align-items: center;
      flex: 0 0 auto;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
    }
    .menu .menu-item-icon .codicon {
      font-size: 14px;
      line-height: 1;
      width: 14px;
      height: 14px;
    }
    .menu .menu-item-label {
      flex: 1 1 auto;
      min-width: 0;
      text-align: left;
    }
    .menu-submenu-wrap > button { justify-content: flex-start; gap: 6px; }
    .menu-submenu-wrap > button .submenu-chevron { margin-left: auto; }
    .menu-submenu-wrap.submenu-open > button { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .submenu-chevron { width: 14px; height: 14px; color: var(--vscode-descriptionForeground); flex: 0 0 auto; }
    .btn-icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; font-size: 16px; line-height: 1; }
    .btn-icon svg { width: 16px; height: 16px; display: block; flex: 0 0 auto; }
    .btn-icon .codicon { font-size: 16px; line-height: 1; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
    .mode-dropdown .codicon { font-size: 16px; line-height: 1; width: 16px; height: 16px; flex: 0 0 auto; }
    button:disabled { opacity: 0.45; cursor: default; }
    .menu-submenu-wrap { position: relative; }
    .menu-submenu { position: absolute; top: -1px; left: calc(100% + 4px); display: none; min-width: 180px; max-height: 60vh; }
    .menu-submenu-wrap.submenu-left .menu-submenu { left: auto; right: calc(100% + 4px); }
    .menu-submenu-wrap.submenu-visible .menu-submenu { display: block; }
    input[type='number']::-webkit-outer-spin-button,
    input[type='number']::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    input[type='number'] {
      -moz-appearance: textfield;
      appearance: textfield;
    }
    .selection-col {
      width: 30px;
      min-width: 30px;
      max-width: 30px;
      padding: 2px 0 !important;
      position: sticky;
      left: 0;
      background: var(--vscode-sideBar-background);
    }
    th.selection-col { z-index: 4; }
    td.selection-col {
      z-index: 3;
      background: var(--vscode-sideBar-background) !important;
    }
    .selection-col::after {
      content: '';
      position: absolute;
      top: 0px;
      left: 0px;
      width: calc(100% - 1px);
      height: 100%;
      pointer-events: none;
      border-right: solid 1px var(--vscode-panel-border);
      border-bottom: solid 1px var(--vscode-panel-border);
      z-index: 6;
    }
    th.selection-col::after {
        content: "";
        width: calc(100% - 1px);
        border-right: solid 1px color-mix(in srgb, var(--vscode-panel-border) 50%, transparent);
        height: calc(100% - 1px);
        pointer-events: none;
        background: transparent;
        border-bottom: solid 1px var(--vscode-panel-border);
    }
    .selection-cell { cursor: pointer; }
    .selection-cell-index {
      display: block;
      width: 100%;
      text-align: center;
      top: 4px;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 85%, transparent);
      user-select: none;
      pointer-events: none;
      position: relative;
      z-index: 1;
    }
    .selection-cell.selected { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 82%, var(--vscode-sideBar-background)); }
    th.selection-col:hover::before,
    td.selection-cell:not(.selected):hover::before {
      content: '';
      position: absolute;
      inset: 2px 3px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, var(--vscode-foreground) 10%);
      pointer-events: none;
    }
    .cell-input:not(:focus):not(.editing) { background: transparent !important; border-color: transparent !important; cursor: pointer; pointer-events: none; }
    .cell-input.editing {
      pointer-events: auto;
      cursor: text;
      user-select: text;
      -webkit-user-select: text;
    }
    td.cell-selected { box-shadow: inset 0 0 0 1000px color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
    td.cell-selected-current-origin::before {
      content: "";
      position: absolute;
      inset: 0;
      border: 2px solid color-mix(in srgb, var(--vscode-focusBorder) 70%, var(--vscode-panel-border));
      top: 0px;
      bottom: -1px;
      right: 0px;
      pointer-events: none;
    }
    tr.row-marked-delete td { background: rgba(220, 53, 69, 0.16); border-bottom-color: color-mix(in srgb, var(--vscode-foreground) 15%, rgba(220, 53, 69, 0.16)) !important; }
    td:has(.cell-input.dirty) { background: rgba(70, 130, 255, 0.16); border-bottom-color: color-mix(in srgb, var(--vscode-foreground) 15%, rgba(70, 130, 255, 0.16)) !important; }
    .th-name:hover:not(:active) { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, var(--vscode-foreground) 10%); }
    @media (max-height: 500px) {
      .header { display: none; }
      .query-container { display: none; }
    }
    @media (max-width: 500px) {
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="loading-bar" id="loadingBar"></div>
    <div class="query-container" id="queryContainer" style="display:none;">
      <textarea id="query" class="query" rows="1" readonly tabindex="-1"></textarea>
    </div>

    <div class="toolbar">
      <div class="search-wrap grow" id="searchWrap">
        <input id="search" class="input" placeholder="${L('webview.table.searchAll', 'Pesquisar tudo')}" />
        <div id="searchContextPlaceholder" class="search-context-placeholder" aria-hidden="true"></div>
        <span class="search-icon" aria-hidden="true">
          <i class="codicon codicon-search"></i>
        </span>
      </div>
      <button id="clearFiltersBtn" class="secondary btn-icon" title="${L('webview.table.clearFilters', 'Limpar filtros')}" aria-label="${L('webview.table.clearFilters', 'Limpar filtros')}" style="display:none;"></button>
      <div class="mode-select" id="modeSelectWrap">
        <button id="modeBtn" class="secondary btn-icon" title="${L('webview.table.searchMode', 'Modo de busca')}"></button>
        <div class="mode-dropdown simple-menu overlay-surface overlay-scroll" id="modeDropdown">
          <button data-mode="local"><i class="codicon codicon-filter" aria-hidden="true"></i>${L('webview.table.localFilter', 'Filtro local')}</button>
          <button data-mode="query"><i class="codicon codicon-database" aria-hidden="true"></i>${L('webview.table.queryFilter', 'Filtro via query')}</button>
        </div>
      </div>
      <button id="columnsBtn" class="secondary btn-icon" title="${L('webview.table.selectColumns', 'Selecionar colunas')}" aria-label="${L('webview.table.selectColumns', 'Selecionar colunas')}">
        <i class="codicon codicon-eye" aria-hidden="true"></i>
      </button>
      <button id="reload" class="secondary btn-icon" title="${L('webview.table.reload', 'Recarregar')}" aria-label="${L('webview.table.reload', 'Recarregar')}">
        <i class="codicon codicon-refresh" aria-hidden="true"></i>
      </button>
      <button id="save" class="btn-icon primary" title="${L('webview.common.save', 'Salvar')}" aria-label="${L('webview.common.save', 'Salvar')}">
        <i class="codicon codicon-save" aria-hidden="true"></i>
      </button>
      <button id="newRow" class="secondary btn-icon" title="${L('webview.table.newRow', 'Nova linha')}" aria-label="${L('webview.table.newRow', 'Nova linha')}">
        <i class="codicon codicon-add" aria-hidden="true"></i>
      </button>
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="prevPage" class="secondary btn-icon" title="${L('webview.table.prevPage', 'Página anterior')}" aria-label="${L('webview.table.prevPage', 'Página anterior')}">
          <i class="codicon codicon-chevron-left" aria-hidden="true"></i>
        </button>
        <button id="pageInfoBtn" class="secondary" title="${L('webview.table.pagination', 'Paginação')}">
          <span id="pageInfo">1/1 (0)</span>
        </button>
        <button id="nextPage" class="secondary btn-icon" title="${L('webview.table.nextPage', 'Próxima página')}" aria-label="${L('webview.table.nextPage', 'Próxima página')}">
          <i class="codicon codicon-chevron-right" aria-hidden="true"></i>
        </button>
      </div>
      <button id="toolbarMenuBtn" class="secondary btn-icon" title="${L('webview.common.menu', 'Menu')}" aria-label="${L('webview.common.menu', 'Menu')}">
        <i class="codicon codicon-ellipsis" aria-hidden="true"></i>
      </button>
    </div>

    <div class="diagram-toolbar" style="display:none;">
      <button id="diagramExportBtn" class="secondary" title="${L('webview.table.exportDiagram', 'Exportar diagrama')}">${L('webview.common.export', 'Exportar')}</button>
      <button id="diagramResetLayoutBtn" class="secondary" title="${L('webview.table.resetPositions', 'Redefinir posição das tabelas')}">${L('webview.table.reset', 'Redefinir')}</button>
      <div class="diagram-zoom-group" title="Ctrl+rodar: zoom. Rodar: deslocar vertical. Shift+rodar: deslocar horizontal.">
        <label for="diagramZoomPct" class="diagram-toolbar-label">Zoom</label>
        <input type="number" id="diagramZoomPct" class="input" min="20" max="400" step="5" value="100" />
        <span class="diagram-toolbar-label" style="margin-right:0">%</span>
      </div>
      <span style="flex:1"></span>
      <button id="diagramMenuBtn" class="secondary btn-icon" title="${L('webview.common.menu', 'Menu')}" aria-label="${L('webview.common.menu', 'Menu')}">
        <i class="codicon codicon-ellipsis" aria-hidden="true"></i>
      </button>
    </div>

    <div id="errorMsg"></div>
    <div class="table-wrap" tabindex="-1">
      <table id="grid"></table>
    </div>
    <div id="diagramView" class="diagram-view" style="display:none;">
      <div id="diagramCanvas" class="diagram-canvas">
        <svg id="diagramSvg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="diagramArrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon class="diagram-arrow-head" data-diagram-themed="1" points="0 0, 8 3, 0 6" />
            </marker>
            <marker id="diagramArrowAccent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon class="diagram-arrow-head--accent" data-diagram-themed="1" points="0 0, 8 3, 0 6" />
            </marker>
          </defs>
        </svg>
        <div id="diagramLoading" class="diagram-loading" style="display:none;">${L('webview.table.loadingDiagram', 'Carregando diagrama…')}</div>
      </div>
    </div>
  </div>

  <div class="overlay-backdrop" id="columnsBackdrop"></div>
  <div class="columns-popup overlay-surface overlay-scroll" id="columnsPopup" role="dialog" aria-label="${L('webview.table.selectColumns', 'Selecionar colunas')}">
    <div class="columns-popup-head">
      <input id="columnsSearch" class="columns-search" placeholder="${L('webview.table.searchColumn', 'Buscar coluna')}" />
    </div>
    <ul class="columns-list" id="columnsList"></ul>
  </div>

  <div class="overlay-backdrop" id="modeBackdrop"></div>
  <div class="overlay-backdrop" id="headerMenuBackdrop"></div>
  <div class="overlay-backdrop" id="paginationMenuBackdrop"></div>
  <div id="headerMenu" class="header-menu simple-menu overlay-surface overlay-scroll">
    <button id="viewDataBtn" class="header-view-btn active" title="${L('webview.table.viewData', 'Ver dados da tabela')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.common.data', 'Dados')}</span>
    </button>
    <button id="viewDiagramBtn" class="header-view-btn" title="${L('webview.table.viewDiagram', 'Ver diagrama ER')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.diagram', 'Diagrama')}</span>
    </button>
    <hr class="menu-separator" />
    <button id="openSettings" title="${L('webview.table.settings', 'Configurações')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.settings', 'Configurações')}</span>
    </button>
    <button id="showInExplorer" class="header-menu-hide-in-result" title="${L('webview.table.showInExplorer', 'Mostrar no explorador')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.showInExplorer', 'Mostrar no explorador')}</span>
    </button>
    <button id="openNewTab" title="${L('webview.table.openNewTab', 'Abrir em nova aba')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.openNewTab', 'Abrir em nova aba')}</span>
    </button>
    <hr id="headerMenuDataSeparator" class="menu-separator" />
    <button id="showQueryModalBtn" title="${L('webview.table.showQuery', 'Mostrar query')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.showQuery', 'Mostrar query')}</span>
    </button>
    <button id="openConnectionManagerBtn" class="header-menu-hide-in-result" title="${L('webview.table.manageConnection', 'Gerenciar conexão')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.manageConnection', 'Gerenciar conexão')}</span>
    </button>
    <button id="toggleIntegratedTable" class="header-menu-query-result-only" title="${L('webview.table.integratedTable', 'Mostrar tabela integrada')}">
      <span id="toggleIntegratedTableCheck" class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.integratedTable', 'Mostrar tabela integrada')}</span>
    </button>
    <button id="openExport" class="header-menu-data-only" title="${L('webview.table.exportData', 'Exportar dados')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.common.export', 'Exportar')}</span>
    </button>
    <button id="resetLayout" class="header-menu-data-only" title="${L('webview.table.resetLayout', 'Restaurar layout da tabela')}">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>${L('webview.table.resetLayout', 'Restaurar layout da tabela')}</span>
    </button>
  </div>
  <div id="paginationMenu" class="pagination-menu overlay-surface overlay-scroll" role="dialog" aria-label="${L('webview.table.configurePagination', 'Configurar paginação')}">
    <div class="pagination-menu-info" id="paginationMenuInfo"></div>
    <div class="row">
    <label class="label" for="paginationPageInput">${L('webview.table.page', 'Página')}</label>
    <input id="paginationPageInput" class="input" type="number" step="1" />
    </div>
    <div class="row">
      <label class="label" for="paginationLimitInput">${L('webview.table.itemsPerPage', 'Itens por página')}</label>
      <input id="paginationLimitInput" class="input" type="number" min="1" max="500" step="1" />
    </div>
  </div>

  <div class="overlay-backdrop" id="menuBackdrop"></div>
  <div class="overlay-backdrop" id="sortMenuBackdrop"></div>
  <div class="menu simple-menu overlay-surface overlay-scroll" id="cellMenu">
    <button data-action="copy">
      <span class="menu-item-icon" aria-hidden="true"></span>
      <span class="menu-item-label">${L('webview.common.copy', 'Copiar')}</span>
    </button>
    <div class="menu-submenu-wrap">
      <button type="button">
        <span class="menu-item-icon" aria-hidden="true"></span>
        <span class="menu-item-label">${L('webview.table.copyAdvanced', 'Copiar avançado')}</span>
        <svg class="submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="menu-submenu simple-menu overlay-surface overlay-submenu">
        <button data-action="copyAdvancedCsv">
          <span class="menu-item-icon" aria-hidden="true"></span>
          <span class="menu-item-label">CSV</span>
        </button>
        <button data-action="copyAdvancedJson">
          <span class="menu-item-icon" aria-hidden="true"></span>
          <span class="menu-item-label">JSON</span>
        </button>
      </div>
    </div>
    <button data-action="paste">
      <span class="menu-item-icon" aria-hidden="true"></span>
      <span class="menu-item-label">${L('webview.common.paste', 'Colar')}</span>
    </button>
    <button data-action="pasteRaw">
      <span class="menu-item-icon" aria-hidden="true"></span>
      <span class="menu-item-label">Colar como texto</span>
    </button>
    <hr class="menu-separator" />
    <div class="menu-submenu-wrap">
      <button type="button">
        <span class="menu-item-icon" aria-hidden="true"><i class="codicon codicon-edit"></i></span>
        <span class="menu-item-label">Editar</span>
        <svg class="submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="menu-submenu simple-menu overlay-surface overlay-submenu">
        <button data-action="null">
          <span class="menu-item-icon" aria-hidden="true"></span>
          <span class="menu-item-label">Definir NULL</span>
        </button>
        <button data-action="empty">
          <span class="menu-item-icon" aria-hidden="true"></span>
          <span class="menu-item-label">Definir texto vazio</span>
        </button>
        <button data-action="default">
          <span class="menu-item-icon" aria-hidden="true"></span>
          <span class="menu-item-label">Definir DEFAULT</span>
        </button>
      </div>
    </div>
    <button data-action="openNativePreview">
      <span class="menu-item-icon" aria-hidden="true"><i class="codicon codicon-split-horizontal"></i></span>
      <span class="menu-item-label">Editar em tela dividida</span>
    </button>
    <button data-action="searchMentions" id="searchMentionsActionBtn" style="display:none;">
      <span class="menu-item-icon" aria-hidden="true"><i class="codicon codicon-search"></i></span>
      <span class="menu-item-label">Consultar menções</span>
    </button>
    <hr class="menu-separator" />
    <button data-action="duplicate">
      <span class="menu-item-icon" aria-hidden="true"><i class="codicon codicon-files"></i></span>
      <span class="menu-item-label">Duplicar linha</span>
    </button>
    <button data-action="new">
      <span class="menu-item-icon" aria-hidden="true"><i class="codicon codicon-add"></i></span>
      <span class="menu-item-label">Criar linha</span>
    </button>
    <hr class="menu-separator" />
    <button data-action="remove">
      <span class="menu-item-icon" aria-hidden="true"><i class="codicon codicon-trash"></i></span>
      <span class="menu-item-label">Remover linha</span>
    </button>
  </div>

  <div id="sortMenu" class="sort-menu simple-menu overlay-surface overlay-scroll">
    <button data-sort="asc" type="button">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>Ordenar crescente</span>
    </button>
    <button data-sort="desc" type="button">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>Ordenar decrescente</span>
    </button>
    <button data-sort="none" type="button">
      <span class="menu-item-check" aria-hidden="true"></span>
      <span>Sem ordenamento</span>
    </button>
  </div>


  <div class="overlay-backdrop json-modal-backdrop" id="queryModalBackdrop"></div>
  <div class="json-modal" id="queryModal" role="dialog" aria-label="Mostrar query">
    <div class="json-modal-head">
      <div class="json-modal-head-main">
        <span class="json-modal-title">Query</span>
      </div>
      <div class="json-modal-actions">
        <button id="queryModalCopy" class="secondary" title="${L('webview.common.copy', 'Copy')}">${L('webview.common.copy', 'Copy')}</button>
        <button id="queryModalClose" class="primary" title="Fechar">Fechar</button>
      </div>
    </div>
    ${queryCodeEditorMarkup}
  </div>

  <div class="overlay-backdrop" id="exportModalBackdrop"></div>
  <div class="export-modal" id="exportModal" role="dialog" aria-label="${L('webview.table.exportData', 'Exportar dados')}">
    <div class="export-modal-head">${L('webview.table.exportData', 'Exportar dados')}</div>
    <div class="export-modal-body">
      <div>
        <div class="export-group-title">Formato</div>
        <div class="export-group">
          <label class="export-option"><input type="radio" name="exportFormat" id="exportFormatJson" value="json" checked /><span>JSON</span></label>
          <label class="export-option"><input type="radio" name="exportFormat" id="exportFormatCsv" value="csv" /><span>CSV</span></label>
        </div>
      </div>
      <div>
        <div class="export-group-title">Dados</div>
        <div class="export-group">
          <label class="export-option"><input type="radio" name="exportDataScope" id="exportDataResult" value="result" checked /><span>Resultado</span></label>
          <label class="export-option"><input type="radio" name="exportDataScope" id="exportDataAll" value="all" /><span>Tudo (sem paginação)</span></label>
          <label class="export-option" id="exportSelectedOption"><input type="radio" name="exportDataScope" id="exportDataSelected" value="selected" /><span>${L('webview.table.selectedCells', 'Selected cells')}</span></label>
        </div>
      </div>
    </div>
    <div class="export-modal-actions">
      <button id="exportModalCancel" class="secondary">${L('webview.common.cancel', 'Cancelar')}</button>
      <button id="exportModalConfirm" class="primary">${L('webview.common.export', 'Exportar')}</button>
    </div>
  </div>

  <div class="overlay-backdrop" id="diagramExportModalBackdrop"></div>
  <div class="diagram-export-modal" id="diagramExportModal" role="dialog" aria-label="${L('webview.table.exportDiagram', 'Exportar diagrama')}">
    <div class="export-modal-head">${L('webview.table.exportDiagram', 'Exportar diagrama')}</div>
    <div class="export-modal-body">
      <div>
        <div class="export-group-title">${L('webview.backup.format', 'Formato')}</div>
        <div class="export-group">
          <label class="export-option"><input type="radio" name="diagramExportFormat" id="diagramExportFormatPng" value="png" checked /><span>PNG (imagem)</span></label>
          <label class="export-option"><input type="radio" name="diagramExportFormat" id="diagramExportFormatDrawio" value="drawio" /><span>Draw.io (.drawio / XML)</span></label>
        </div>
      </div>
      <div>
        <div class="export-group-title">Destino</div>
        <div class="export-group">
          <label class="export-option"><input type="radio" name="diagramExportTarget" id="diagramExportTargetFile" value="file" checked /><span>${L('webview.table.saveAsFile', 'Salvar como arquivo')}</span></label>
          <label class="export-option"><input type="radio" name="diagramExportTarget" id="diagramExportTargetClipboard" value="clipboard" /><span>${L('webview.table.copyToClipboard', 'Copy to clipboard')}</span></label>
        </div>
      </div>
    </div>
    <div class="export-modal-actions">
      <button id="diagramExportModalCancel" class="secondary">${L('webview.common.cancel', 'Cancelar')}</button>
      <button id="diagramExportModalConfirm" class="primary">${L('webview.common.export', 'Exportar')}</button>
    </div>
  </div>

  <div class="overlay-backdrop json-modal-backdrop" id="jsonModalBackdrop"></div>
  <div class="json-modal" id="jsonModal" role="dialog" aria-label="Conteúdo JSON">
    <div class="json-modal-head">
      <div class="json-modal-head-main">
        <span class="json-modal-title" id="jsonModalTitle">Conteúdo JSON</span>
      </div>
      <div class="json-modal-actions">
        <button id="jsonModalApply" class="primary" title="${L('webview.table.applyChanges', 'Aplicar alterações')}">${L('webview.common.apply', 'Aplicar')}</button>
        <button id="jsonModalOpenNative" class="secondary" title="Editar em tela dividida">Tela dividida</button>
        <button id="jsonModalClose" class="secondary">Fechar</button>
      </div>
    </div>
    ${codeEditorMarkup}
  </div>

  <script nonce="${nonce}">${codeEditorScript}</script>
  <script nonce="${nonce}" src="${tableAdvancedFilterScriptUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const queryContainer = document.getElementById('queryContainer');
    const queryEl = document.getElementById('query');
    const loadingBar = document.getElementById('loadingBar');
    const gridEl = document.getElementById('grid');
    const queryResizer = document.getElementById('queryResizer');
    const cellMenu = document.getElementById('cellMenu');
    const sortMenu = document.getElementById('sortMenu');
    const sortMenuBackdrop = document.getElementById('sortMenuBackdrop');
    const pageInfoEl = document.getElementById('pageInfo');
    const pageInfoBtn = document.getElementById('pageInfoBtn');
    const paginationMenuInfoEl = document.getElementById('paginationMenuInfo');
    const paginationMenu = document.getElementById('paginationMenu');
    const paginationMenuBackdrop = document.getElementById('paginationMenuBackdrop');
    const paginationLimitInput = document.getElementById('paginationLimitInput');
    const paginationPageInput = document.getElementById('paginationPageInput');
    const menuBackdrop = document.getElementById('menuBackdrop');
    const errorMsgEl = document.getElementById('errorMsg');
    const tableWrapEl = document.querySelector('.table-wrap');
    const advancedFilterApi = window.DBAdminAdvancedFilter || null;

    const rangeSelectionOverlay = document.createElement('div');
    rangeSelectionOverlay.className = 'range-selection-overlay';
    rangeSelectionOverlay.style.position = 'absolute';
    rangeSelectionOverlay.style.pointerEvents = 'none';
    rangeSelectionOverlay.style.display = 'none';
    rangeSelectionOverlay.style.border = '1px solid color-mix(in srgb, var(--vscode-focusBorder) 70%, var(--vscode-panel-border))';
    rangeSelectionOverlay.style.zIndex = '5';
    tableWrapEl.style.position = 'relative';
    tableWrapEl.appendChild(rangeSelectionOverlay);

    const searchInputEl = document.getElementById('search');
    const searchWrapEl = document.getElementById('searchWrap');
    const searchContextPlaceholderEl = document.getElementById('searchContextPlaceholder');
    const modeBtn = document.getElementById('modeBtn');
    const modeDropdown = document.getElementById('modeDropdown');
    const modeBackdrop = document.getElementById('modeBackdrop');
    const columnsBtn = document.getElementById('columnsBtn');
    const columnsPopup = document.getElementById('columnsPopup');
    const columnsBackdrop = document.getElementById('columnsBackdrop');
    const columnsList = document.getElementById('columnsList');
    const columnsSearch = document.getElementById('columnsSearch');
    const jsonModal = document.getElementById('jsonModal');
    const jsonModalBackdrop = document.getElementById('jsonModalBackdrop');
    const jsonModalTitle = document.getElementById('jsonModalTitle');
    const exportModal = document.getElementById('exportModal');
    const exportModalBackdrop = document.getElementById('exportModalBackdrop');
    const exportFormatJson = document.getElementById('exportFormatJson');
    const exportFormatCsv = document.getElementById('exportFormatCsv');
    const exportDataResult = document.getElementById('exportDataResult');
    const exportDataAll = document.getElementById('exportDataAll');
    const exportDataSelected = document.getElementById('exportDataSelected');
    const exportSelectedOption = document.getElementById('exportSelectedOption');
    const exportModalCancel = document.getElementById('exportModalCancel');
    const exportModalConfirm = document.getElementById('exportModalConfirm');
    const codeEditor = window.DbAdminCodeEditor.create({
      rootEl: document.getElementById('codeEditorRoot'),
      findWidgetEl: document.getElementById('codeEditorFindWidget'),
      lineNumbersEl: document.getElementById('codeEditorLineNumbers'),
      highlightEl: document.getElementById('codeEditorHighlight'),
      textareaEl: document.getElementById('codeEditorTextarea'),
      findInputEl: document.getElementById('codeEditorFindInput'),
      findResultEl: document.getElementById('codeEditorFindResult'),
      findPrevEl: document.getElementById('codeEditorFindPrev'),
      findNextEl: document.getElementById('codeEditorFindNext'),
      toggleReplaceEl: document.getElementById('codeEditorToggleReplace'),
      replaceRowEl: document.getElementById('codeEditorReplaceRow'),
      replaceInputEl: document.getElementById('codeEditorReplaceInput'),
      replaceOneEl: document.getElementById('codeEditorReplaceOne'),
      replaceAllEl: document.getElementById('codeEditorReplaceAll'),
      closeFindEl: document.getElementById('codeEditorCloseFind'),
      onChange: (value) => {
        currentJsonModalPayload.content = value;
      },
      onSaveShortcut: () => {
        applyJsonModalChanges(true);
      },
    });
    const jsonModalApply = document.getElementById('jsonModalApply');
    const jsonModalOpenNative = document.getElementById('jsonModalOpenNative');
    const jsonModalClose = document.getElementById('jsonModalClose');
    const headerMenu = document.getElementById('headerMenu');
    const headerMenuBackdrop = document.getElementById('headerMenuBackdrop');
    const toolbarMenuBtn = document.getElementById('toolbarMenuBtn');
    const openExportBtn = document.getElementById('openExport');
    const showQueryModalBtn = document.getElementById('showQueryModalBtn');
    const openConnectionManagerBtn = document.getElementById('openConnectionManagerBtn');
    const queryModal = document.getElementById('queryModal');
    const queryModalBackdrop = document.getElementById('queryModalBackdrop');
    const queryModalCopy = document.getElementById('queryModalCopy');
    const queryModalClose = document.getElementById('queryModalClose');
    const queryCodeEditor = window.DbAdminCodeEditor.create({
      rootEl: document.getElementById('queryCodeEditorRoot'),
      findWidgetEl: document.getElementById('queryCodeEditorFindWidget'),
      lineNumbersEl: document.getElementById('queryCodeEditorLineNumbers'),
      highlightEl: document.getElementById('queryCodeEditorHighlight'),
      textareaEl: document.getElementById('queryCodeEditorTextarea'),
      findInputEl: document.getElementById('queryCodeEditorFindInput'),
      findResultEl: document.getElementById('queryCodeEditorFindResult'),
      findPrevEl: document.getElementById('queryCodeEditorFindPrev'),
      findNextEl: document.getElementById('queryCodeEditorFindNext'),
      toggleReplaceEl: document.getElementById('queryCodeEditorToggleReplace'),
      replaceRowEl: document.getElementById('queryCodeEditorReplaceRow'),
      replaceInputEl: document.getElementById('queryCodeEditorReplaceInput'),
      replaceOneEl: document.getElementById('queryCodeEditorReplaceOne'),
      replaceAllEl: document.getElementById('queryCodeEditorReplaceAll'),
      closeFindEl: document.getElementById('queryCodeEditorCloseFind'),
      readOnly: true,
    });
    const resetLayoutBtn = document.getElementById('resetLayout');
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');
    const saveBtn = document.getElementById('save');
    const newRowBtn = document.getElementById('newRow');
    const openNativePreviewActionBtn = cellMenu.querySelector('button[data-action="openNativePreview"]');
    const searchMentionsActionBtn = cellMenu.querySelector('button[data-action="searchMentions"]');

    const ICON_FILTER = '<i class="codicon codicon-filter" aria-hidden="true"></i>';
    const ICON_QUERY_MODE = '<i class="codicon codicon-database" aria-hidden="true"></i>';
    const ICON_DB = '<i class="codicon codicon-database" aria-hidden="true"></i>';
    const ICON_SCHEMA = '<i class="codicon codicon-type-hierarchy-sub" aria-hidden="true"></i>';
    const ICON_CONNECTION = '<i class="codicon codicon-plug" aria-hidden="true"></i>';
    const ICON_SORT_NONE = '<span class="sort-icon-pair" aria-hidden="true"><i class="codicon codicon-chevron-up"></i><i class="codicon codicon-chevron-down"></i></span>';
    const ICON_SORT_ASC = '<i class="codicon codicon-chevron-up" aria-hidden="true"></i>';
    const ICON_SORT_DESC = '<i class="codicon codicon-chevron-down" aria-hidden="true"></i>';
    const ICON_ZOOM_IN = '<i class="codicon codicon-zoom-in" aria-hidden="true"></i>';
    const ICON_CLEAR_ALL = '<i class="codicon codicon-clear-all" aria-hidden="true"></i>';
    const ICON_GO_TO_FILE = '<i class="codicon codicon-go-to-file" aria-hidden="true"></i>';

    if (clearFiltersBtn) {
      clearFiltersBtn.innerHTML = ICON_CLEAR_ALL;
    }
    
    function updateModeIcon() {
      modeBtn.innerHTML = state.searchMode === 'query' ? ICON_QUERY_MODE : ICON_FILTER;
    }

    function showError(msg) {
      errorMsgEl.textContent = msg;
      errorMsgEl.style.display = 'block';
      tableWrapEl.style.display = 'none';
    }

    function hideError() {
      errorMsgEl.style.display = 'none';
      tableWrapEl.style.display = '';
    }

    const overlayControllers = [];
    const submenuCloseTimers = new WeakMap();

    class OverlaySurfaceController {
      constructor(options) {
        this.surfaceEl = options.surfaceEl;
        this.backdropEl = options.backdropEl;
        this.anchorEl = options.anchorEl || null;
        this.placement = options.placement || 'bottom-start';
        this.offset = options.offset ?? 4;
        this.onAfterOpen = options.onAfterOpen;
        this.onAfterClose = options.onAfterClose;
        this.lastOpenOptions = {};

        this.backdropEl.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        });

        this.backdropEl.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        });

        this.surfaceEl.addEventListener('click', (event) => {
          event.stopPropagation();
        });

        this.surfaceEl.addEventListener('mousedown', (event) => {
          event.stopPropagation();
        });

        overlayControllers.push(this);
      }

      isOpen() {
        return this.surfaceEl.classList.contains('open');
      }

      toggle(options = {}) {
        if (this.isOpen()) {
          this.close();
          return false;
        }

        this.open(options);
        return true;
      }

      open(options = {}) {
        closeAllOverlays(this);
        this.lastOpenOptions = options;
        this.surfaceEl.classList.add('open');
        this.backdropEl.style.display = 'block';
        this.position();
        if (typeof this.onAfterOpen === 'function') {
          this.onAfterOpen(options);
        }
      }

      close() {
        if (!this.isOpen()) {
          return;
        }

        this.surfaceEl.classList.remove('open');
        this.backdropEl.style.display = 'none';
        if (typeof this.onAfterClose === 'function') {
          this.onAfterClose();
        }
      }

      reposition() {
        if (this.isOpen()) {
          this.position();
        }
      }

      position() {
        const margin = 8;
        const width = this.surfaceEl.offsetWidth || 180;
        const height = this.surfaceEl.offsetHeight || 0;

        if (
          typeof this.lastOpenOptions.x === 'number' &&
          typeof this.lastOpenOptions.y === 'number'
        ) {
          const left = Math.min(
            Math.max(margin, this.lastOpenOptions.x),
            Math.max(margin, window.innerWidth - width - margin)
          );
          const top = Math.min(
            Math.max(margin, this.lastOpenOptions.y),
            Math.max(margin, window.innerHeight - height - margin)
          );
          this.surfaceEl.style.left = left + 'px';
          this.surfaceEl.style.top = top + 'px';
          return;
        }

        const anchorEl = this.lastOpenOptions.anchorEl || this.anchorEl;
        if (!anchorEl) {
          return;
        }

        const rect = anchorEl.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + this.offset;

        if (this.placement === 'bottom-end') {
          left = rect.right - width;
        }

        left = Math.min(
          Math.max(margin, left),
          Math.max(margin, window.innerWidth - width - margin)
        );
        top = Math.min(
          Math.max(margin, top),
          Math.max(margin, window.innerHeight - height - margin)
        );

        this.surfaceEl.style.left = left + 'px';
        this.surfaceEl.style.top = top + 'px';
      }
    }

    function closeAllOverlays(exceptOverlay) {
      overlayControllers.forEach((overlay) => {
        if (overlay !== exceptOverlay) {
          overlay.close();
        }
      });
    }

    const state = {
      searchText: '',
      searchMode: 'local',
      sortColumn: undefined,
      sortDirection: undefined,
      columnFilters: {},
      limit: ${defaultPageSize},
      page: 1,
    };

    let columns = [];
    let rows = [];
    let totalRows = 0;
    let editedRows = new Map();
    let insertedRows = [];
    let removedCtids = new Set();
    let columnOrder = [];
    let visibleColumns = new Set();
    let draggedColumnName = null;
    let columnWidthByName = new Map();
    let columnsSearchText = '';
    let activeCell = null;
    let queryResizeState = null;
    let columnResizeState = null;
    let pendingFocus = null;
    let layoutColumnOrderSnapshot = null;
    let isLoading = false;
    let dynamicDefaultColumnWidth = ${initialDynamicDefaultColumnWidth ? "true" : "false"};
    let readOnlyResultMode = false;
    let hideDiagramMode = false;
    let integratedTableMode = false;
    let currentDatabaseName = '';
    let currentSchemaName = '';
    let currentTableName = '';
    let currentConnectionName = '';
    let currentJsonModalPayload = {
      columnName: '',
      content: '',
      isJson: false,
      row: null,
      column: null,
      ctid: null,
      input: null,
    };
    
    // Selection state
    let selectedCells = new Map(); // rowKey -> Set of columnNames
    let rowKeyToRow = new Map(); // rowKey -> row reference
    let rowKeyToCtid = new Map(); // rowKey -> ctid|null
    let editingCellInput = null;
    let lastSelectedCell = null; // { rowKey, colName }
    let keyboardSelectionAnchor = null; // { rowIndex, colIndex }
    let keyboardSelectionAdditive = false;
    let keyboardSelectionBase = new Map(); // rowKey -> Set of columnNames
    let selectedCellCounts = new Map(); // rowKey -> Map(colName -> count)
    let currentRangeSelection = null; // { anchor: { rowIndex, colIndex }, focus: { rowIndex, colIndex } }
    let cellDragMode = 'replace'; // replace | add | remove
    let cellDragBaseCounts = new Map(); // rowKey -> Map(colName -> count)
    let suppressCellSelectionUntil = 0;
    let selectionSnapshotBeforeContextMenu = null;
    
    // Clipboard state for smart paste
    let clipboardData = []; // 2D array of values
    let clipboardRows = 0; // number of rows in clipboard
    let clipboardCols = 0; // number of columns in clipboard
    let clipboardColumnNames = []; // column names in clipboard (for structured paste)
    const MAX_CELL_HISTORY = 10;
    let cellUndoStack = [];
    let cellRedoStack = [];
    let pendingCellHistoryChanges = null;
    let isApplyingCellHistory = false;
    // DOM element maps for lightweight selection update (avoids full re-render)
    let trElements = new Map(); // rowKey -> tr element
    let selectionTdElements = new Map(); // rowKey -> selection-col td
    let inputElements = new Map(); // rowKey -> Map(colName -> input)
    let tdElements = new Map(); // rowKey -> Map(colName -> td)
    // Drag-to-select state
    let isDragging = false;
    let dragAnchor = null; // { rowIndex, colIndex }
    let isRowSelectionDragging = false;
    let rowSelectionDragPreserve = false;
    let rowSelectionDragAnchorIndex = null;
    let rowSelectionDragBaseSelection = new Map();
    let rowShiftSelectAnchorIndex = null; // âncora persistente para shift+click em linhas
    let colSelectionAnchorName = null; // colName string
    let displayedRowKeys = []; // rowKey[] in display order
    let displayedColNames = []; // colName[] in display order
    let nativePreviewSelectionSignature = '';
    const FOCUS_GUARD_MS = 420;
    const STICKY_FOCUS_MS = 900;
    const STICKY_FOCUS_INTERVAL_MS = 34;
    let focusGuardUntil = 0;
    let lastPointerTarget = null;
    let stickyFocusTarget = null;
    let stickyFocusUntil = 0;
    let stickyFocusTimer = null;

    function isFocusableElement(element) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      if (element.tabIndex >= 0) {
        return true;
      }

      const tag = element.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'A';
    }

    function shouldIgnoreTransientBlur() {
      return Date.now() <= focusGuardUntil;
    }

    function isSearchInputFocused() {
      return document.activeElement === searchInputEl;
    }

    function isTextInputFocusedOutsideGridEditing() {
      const active = document.activeElement;
      return isTextEditingElement(active) && active !== editingCellInput;
    }

    function focusGridSurface() {
      clearStickyFocus();
      if (isSearchInputFocused()) {
        searchInputEl.blur();
      }
      if (tableWrapEl instanceof HTMLElement) {
        tableWrapEl.focus({ preventScroll: true });
      }
    }

    function isTextEditingElement(element) {
      return (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement ||
        (element instanceof HTMLElement && element.isContentEditable)
      );
    }

    function shouldHandleGridSelectAllShortcut(event) {
      if (editingCellInput) {
        return false;
      }

      const active = document.activeElement;
      const activeInGrid = active instanceof Element && tableWrapEl.contains(active);
      const pointerInGrid = lastPointerTarget instanceof Element && tableWrapEl.contains(lastPointerTarget);
      const activeIsNeutral = !active || active === document.body || active === document.documentElement;

      if (isTextEditingElement(event.target) || isTextEditingElement(active)) {
        return false;
      }

      return activeInGrid || (activeIsNeutral && pointerInGrid);
    }

    function clearStickyFocus() {
      if (stickyFocusTimer) {
        clearTimeout(stickyFocusTimer);
        stickyFocusTimer = null;
      }
      stickyFocusTarget = null;
      stickyFocusUntil = 0;
    }

    function scheduleStickyFocusTick() {
      if (stickyFocusTimer) {
        clearTimeout(stickyFocusTimer);
      }
      stickyFocusTimer = setTimeout(() => {
        stickyFocusTimer = null;
        runStickyFocus();
      }, STICKY_FOCUS_INTERVAL_MS);
    }

    function beginStickyFocus(target) {
      if (!isFocusableElement(target)) {
        return;
      }

      stickyFocusTarget = target;
      stickyFocusUntil = Date.now() + STICKY_FOCUS_MS;
      scheduleStickyFocusTick();
    }

    function runStickyFocus() {
      if (!(stickyFocusTarget instanceof HTMLElement)) {
        clearStickyFocus();
        return;
      }

      if (Date.now() > stickyFocusUntil) {
        clearStickyFocus();
        return;
      }

      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        scheduleStickyFocusTick();
        return;
      }

      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        active !== stickyFocusTarget
      ) {
        clearStickyFocus();
        return;
      }

      if (!stickyFocusTarget.isConnected || !isFocusableElement(stickyFocusTarget)) {
        clearStickyFocus();
        return;
      }

      stickyFocusTarget.focus({ preventScroll: true });
      if (document.activeElement === stickyFocusTarget) {
        clearStickyFocus();
        return;
      }

      scheduleStickyFocusTick();
    }

    function restoreFocusAfterTransientBlur() {
      if (!shouldIgnoreTransientBlur()) {
        return;
      }

      const target = lastPointerTarget instanceof HTMLElement ? lastPointerTarget : stickyFocusTarget;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      beginStickyFocus(target);
    }

    document.addEventListener('pointerdown', (event) => {
      if (event.target instanceof HTMLElement) {
        lastPointerTarget = event.target;
        if (isFocusableElement(event.target)) {
          beginStickyFocus(event.target);
        } else {
          clearStickyFocus();
        }
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement) {
        lastPointerTarget = event.target;
        if (isFocusableElement(event.target)) {
          beginStickyFocus(event.target);
        } else {
          clearStickyFocus();
        }
      }
    }, true);

    window.addEventListener('focus', () => {
      focusGuardUntil = Date.now() + FOCUS_GUARD_MS;
      runStickyFocus();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        runStickyFocus();
      }
    });
    function serializeLayoutState() {
      return {
        columnOrder: [...columnOrder],
        visibleColumns: [...visibleColumns],
        columnWidths: Object.fromEntries(columnWidthByName.entries()),
      };
    }

    function notifyLayoutChanged() {
      vscode.postMessage({
        type: 'updateLayout',
        layout: serializeLayoutState(),
      });
    }

    function applyLayoutState(layout) {
      layoutColumnOrderSnapshot = null;

      if (!layout || typeof layout !== 'object') {
        return;
      }

      columnOrder = Array.isArray(layout.columnOrder) ? [...layout.columnOrder] : [];
      layoutColumnOrderSnapshot = new Set(columnOrder);
      visibleColumns = new Set(Array.isArray(layout.visibleColumns) ? layout.visibleColumns : []);
      columnWidthByName = new Map(
        Object.entries(layout.columnWidths || {}).filter(([, value]) =>
          typeof value === 'number' && Number.isFinite(value) && value > 0
        )
      );
    }

    function applyQueryVisibility() {
      // Sticky query only in query-result mode (read-only preview).
      if (queryContainer) {
        queryContainer.style.display = readOnlyResultMode ? '' : 'none';
      }
      if (queryEl) {
        queryEl.readOnly = true;
      }
    }

    function openQueryModal() {
      if (!queryModal || !queryCodeEditor) {
        return;
      }
      queryCodeEditor.setValue(String(queryEl && queryEl.value ? queryEl.value : ''));
      queryModal.classList.add('open');
      if (queryModalBackdrop) {
        queryModalBackdrop.style.display = 'block';
      }
      queryCodeEditor.closeFind();
      queryCodeEditor.focus();
      queryCodeEditor.setSelectionRange(0, 0);
      closeHeaderMenu();
    }

    function closeQueryModal() {
      if (queryModal) {
        queryModal.classList.remove('open');
      }
      if (queryModalBackdrop) {
        queryModalBackdrop.style.display = 'none';
      }
      queryCodeEditor?.closeFind();
    }

    function applyIntegratedTableCheck() {
      const check = document.getElementById('toggleIntegratedTableCheck');
      if (check) {
        check.classList.toggle('is-checked', integratedTableMode === true);
      }
    }

    function applyResultModeRestrictions() {
      if (saveBtn) {
        saveBtn.disabled = readOnlyResultMode || !hasChanges();
      }

      if (newRowBtn) {
        newRowBtn.style.display = readOnlyResultMode ? 'none' : '';
      }

      if (modeBtn) {
        modeBtn.style.display = readOnlyResultMode ? 'none' : '';
      }

      if (jsonModalApply) {
        jsonModalApply.disabled = readOnlyResultMode;
        jsonModalApply.style.display = readOnlyResultMode ? 'none' : '';
      }

      // Hide menu items that don't apply to query-result panels.
      const hideInResultEls = Array.from(document.querySelectorAll('.header-menu-hide-in-result'));
      hideInResultEls.forEach((el) => {
        if (el instanceof HTMLElement) {
          el.style.display = readOnlyResultMode ? 'none' : '';
        }
      });

      const queryResultOnlyEls = Array.from(document.querySelectorAll('.header-menu-query-result-only'));
      queryResultOnlyEls.forEach((el) => {
        if (el instanceof HTMLElement) {
          el.style.display = readOnlyResultMode ? 'flex' : 'none';
        }
      });

      applyIntegratedTableCheck();
      applyQueryVisibility();

      if (hideDiagramMode) {
        const viewDiagramBtn = document.getElementById('viewDiagramBtn');
        if (viewDiagramBtn) {
          viewDiagramBtn.style.display = 'none';
        }
      }
    }

    function syncSearchWrapState() {
      if (!searchWrapEl || !searchInputEl) {
        return;
      }
      const hasValue = String(searchInputEl.value || '').trim().length > 0;
      const isActive = document.activeElement === searchInputEl;
      searchWrapEl.classList.toggle('has-value', hasValue);
      searchWrapEl.classList.toggle('is-active', isActive);
    }

    function updateSearchContextPlaceholder() {
      if (!searchInputEl || !searchContextPlaceholderEl) {
        return;
      }

      const hasSearchText = String(searchInputEl.value || '').length > 0;
      const canShowContext = !hasSearchText;

      searchInputEl.placeholder = canShowContext ? '' : 'Pesquisar tudo';
      syncSearchWrapState();

      if (!canShowContext) {
        searchContextPlaceholderEl.style.display = 'none';
        searchContextPlaceholderEl.innerHTML = '';
        return;
      }

      const dbLabel = currentDatabaseName || 'Banco';
      const schemaLabel = currentSchemaName || 'Schema';
      const connectionLabel = currentConnectionName || 'Conexão';
      searchContextPlaceholderEl.innerHTML =
        '<span class="info-item info-fixed">' + ICON_SCHEMA + '<span>' + schemaLabel + '</span></span>' +
        '<span class="info-item info-fixed"><span style="margin: 4px 2px 0 0;">' + ICON_DB + '</span><span>' + dbLabel + '</span></span>' +
        '<span class="info-item info-conn"><span style="margin: 4px 0 0 0;">' + ICON_CONNECTION + '</span><span>' + connectionLabel + '</span></span>';
      searchContextPlaceholderEl.style.display = 'inline-flex';
    }

    function rememberSearchFocus() {
      const searchInput = document.getElementById('search');
      if (!searchInput) {
        return;
      }
      pendingFocus = {
        type: 'search',
        selectionStart: searchInput.selectionStart,
        selectionEnd: searchInput.selectionEnd,
      };
    }

    function rememberColumnFocus(columnName, element) {
      pendingFocus = {
        type: 'column',
        columnName,
        selectionStart: element.selectionStart,
        selectionEnd: element.selectionEnd,
      };
    }

    function restorePendingFocus() {
      if (!pendingFocus) {
        return;
      }

      const snapshot = pendingFocus;
      pendingFocus = null;

      if (snapshot.type === 'search') {
        const searchInput = document.getElementById('search');
        if (!searchInput) {
          return;
        }
        searchInput.focus();
        if (
          typeof snapshot.selectionStart === 'number' &&
          typeof snapshot.selectionEnd === 'number' &&
          typeof searchInput.setSelectionRange === 'function'
        ) {
          searchInput.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
        }
        return;
      }

      if (snapshot.type === 'column') {
        const filters = Array.from(document.querySelectorAll('.th-filter'));
        const target = filters.find((input) => input.getAttribute('data-col-name') === snapshot.columnName);
        if (!target) {
          return;
        }
        target.focus();
        if (
          typeof snapshot.selectionStart === 'number' &&
          typeof snapshot.selectionEnd === 'number' &&
          typeof target.setSelectionRange === 'function'
        ) {
          target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
        }
      }
    }

    function hasChanges() {
      if (readOnlyResultMode) {
        return false;
      }

      const hasInserted = insertedRows.some((row) => !row.__dbadmin_removed);
      return editedRows.size > 0 || hasInserted || removedCtids.size > 0;
    }

    function updateSaveButtonState() {
      saveBtn.disabled = readOnlyResultMode || !hasChanges();
    }

    function beginLoading() {
      if (isLoading) {
        return;
      }
      isLoading = true;
      loadingBar.classList.add('active');
    }

    function endLoading() {
      isLoading = false;
      loadingBar.classList.remove('active');
    }

    function getEffectiveCellValue(row, colName, ctid) {
      if (ctid && editedRows.has(ctid)) {
        const values = editedRows.get(ctid);
        if (Object.prototype.hasOwnProperty.call(values, colName)) {
          return values[colName];
        }
      }
      return row[colName];
    }

    function isJsonColumn(column) {
      const dataType = String(column?.dataType || '').toLowerCase();
      return dataType === 'json' || dataType === 'jsonb';
    }

    function isFkColumn(column) {
      return column?.isForeignKey === true;
    }

    function isPkColumn(column) {
      return column?.isPrimaryKey === true;
    }

    function isUniqueColumn(column) {
      return column?.isUnique === true;
    }

    function isBigIntType(column) {
      const dataType = String(column?.dataType || '').toLowerCase();
      return dataType === 'bigint' || dataType === 'int8';
    }

    function isBooleanType(column) {
      const dataType = String(column?.dataType || '').toLowerCase();
      return dataType === 'boolean' || dataType === 'bool';
    }

    function parseBooleanCellValue(value) {
      if (value === true) {
        return true;
      }
      if (value === false) {
        return false;
      }
      const text = String(value ?? '').trim().toLowerCase();
      if (text === 'true' || text === 't' || text === '1') {
        return true;
      }
      if (text === 'false' || text === 'f' || text === '0') {
        return false;
      }
      return false;
    }

    function syncBooleanToggleButton(button, value) {
      const isTrue = parseBooleanCellValue(value);
      button.classList.toggle('is-checked', isTrue);
      button.title = isTrue ? 'Alternar para false' : 'Alternar para true';
      button.setAttribute('aria-pressed', isTrue ? 'true' : 'false');
    }

    function isNumericColumn(column) {
      return advancedFilterApi ? Boolean(advancedFilterApi.isNumericColumn(column)) : false;
    }

    function isDateColumn(column) {
      return advancedFilterApi ? Boolean(advancedFilterApi.isDateColumn(column)) : false;
    }

    function buildAdvancedFilterMatcher(column, rawValue) {
      return advancedFilterApi
        ? advancedFilterApi.buildAdvancedFilterMatcher(column, rawValue)
        : null;
    }

    function getLongestVisibleCellLength(column, visibleRows) {
      let longestCellLength = 0;
      visibleRows.forEach((row) => {
        const ctid = row?.__dbadmin_ctid;
        const cellValue = toCellInputText(getEffectiveCellValue(row, column.name, ctid), column);
        const cellLength = String(cellValue || '').length;
        if (cellLength > longestCellLength) {
          longestCellLength = cellLength;
        }
      });
      return longestCellLength;
    }

    function shouldUseMinimumColumnWidth(column, longestCellLength) {
      const isPkOrFk = isPkColumn(column) || isFkColumn(column);
      return (isBigIntType(column) && isPkOrFk) || isBooleanType(column) || longestCellLength <= 15;
    }

    function measureTextWidth(text) {
      if (!measureTextWidth.canvas) {
        measureTextWidth.canvas = document.createElement('canvas');
      }

      const context = measureTextWidth.canvas.getContext('2d');
      if (!context) {
        return text.length * 7;
      }

      const computed = window.getComputedStyle(document.body);
      const fontSize = computed.fontSize || '12px';
      const fontFamily = computed.fontFamily || 'sans-serif';
      context.font = fontSize + ' ' + fontFamily;
      return context.measureText(String(text || '')).width;
    }

    function getMinimumColumnWidth(column, longestCellLength) {
      let headerWidth = (String(column?.name || '').length * 5) + 24 + 40;
      /** Ajuste fino */
      
      const cellsWidth = (longestCellLength * 8) + 25;
      return Math.max(headerWidth, cellsWidth);
    }

    function getDefaultColumnWidth(column, visibleRows) {
      const longestCellLength = getLongestVisibleCellLength(column, visibleRows);
      const useMinimumWidth = dynamicDefaultColumnWidth && shouldUseMinimumColumnWidth(column, longestCellLength);
      const resolvedWidth = useMinimumWidth ? getMinimumColumnWidth(column, longestCellLength) : 170;
      return resolvedWidth;
    }

    function isPreviewableColumn(column) {
      return !isFkColumn(column);
    }

    function openForeignKeyTarget(column, row, ctid) {
      if (!isFkColumn(column)) {
        return;
      }

      const targetSchemaName = String(column?.foreignKeyTargetSchema || '').trim();
      const targetTableName = String(column?.foreignKeyTargetTable || '').trim();
      const targetColumnName = String(column?.foreignKeyTargetColumn || '').trim();
      if (!targetSchemaName || !targetTableName || !targetColumnName) {
        return;
      }

      const sourceValue = toCellInputText(getEffectiveCellValue(row, column.name, ctid), column);
      vscode.postMessage({
        type: 'openForeignKeyTarget',
        sourceValue,
        targetSchemaName,
        targetTableName,
        targetColumnName,
      });
    }

    function formatJsonCompactText(value) {
      try {
        const jsonText = JSON.stringify(value, null, 2);
        let compact = jsonText.split(String.fromCharCode(10)).join(' ').trim();
        while (compact.includes('  ')) {
          compact = compact.split('  ').join(' ');
        }
        return compact;
      } catch {
        return String(value);
      }
    }

    function formatJsonPrettyText(value) {
      if (value === null || value === undefined) {
        return '';
      }

      if (typeof value === 'string') {
        try {
          return JSON.stringify(JSON.parse(value), null, 2);
        } catch {
          return value;
        }
      }

      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }



    function getRowKeyForCell(row, ctid) {
      if (ctid) {
        return String(ctid);
      }

      for (const [rowKey, candidate] of rowKeyToRow.entries()) {
        if (candidate === row) {
          return rowKey;
        }
      }

      return null;
    }

    function queueCellHistoryChange(change) {
      if (isApplyingCellHistory || !change || change.beforeValue === change.afterValue) {
        return;
      }

      if (!pendingCellHistoryChanges) {
        pendingCellHistoryChanges = [];
      }

      const existing = pendingCellHistoryChanges.find(
        (entry) => entry.rowKey === change.rowKey && entry.colName === change.colName
      );
      if (existing) {
        existing.afterValue = change.afterValue;
        return;
      }

      pendingCellHistoryChanges.push(change);
    }

    function flushPendingCellHistory() {
      if (isApplyingCellHistory || !pendingCellHistoryChanges || pendingCellHistoryChanges.length === 0) {
        pendingCellHistoryChanges = null;
        return;
      }

      const changes = pendingCellHistoryChanges.filter((change) => change.beforeValue !== change.afterValue);
      pendingCellHistoryChanges = null;
      if (changes.length === 0) {
        return;
      }

      cellUndoStack.push(changes);
      if (cellUndoStack.length > MAX_CELL_HISTORY) {
        cellUndoStack.shift();
      }
      cellRedoStack = [];
    }

    function applyCellHistoryOperation(changes, direction) {
      if (!Array.isArray(changes) || changes.length === 0) {
        return false;
      }

      isApplyingCellHistory = true;
      try {
        changes.forEach((change) => {
          const row = rowKeyToRow.get(change.rowKey);
          const col = columns.find((column) => column.name === change.colName);
          if (!row || !col) {
            return;
          }

          const nextValue = direction === 'undo' ? change.beforeValue : change.afterValue;
          const ctid = rowKeyToCtid.get(change.rowKey) || null;
          const inputMap = inputElements.get(change.rowKey);
          const input = inputMap ? inputMap.get(change.colName) : null;
          applyCellValue(row, col, ctid, nextValue, input || null, { recordHistory: false });
        });
      } finally {
        isApplyingCellHistory = false;
      }

      renderSelectionState();
      return true;
    }

    function undoCellChanges() {
      flushPendingCellHistory();
      const changes = cellUndoStack.pop();
      if (!changes) {
        return false;
      }

      if (applyCellHistoryOperation(changes, 'undo')) {
        cellRedoStack.push(changes);
        return true;
      }

      cellUndoStack.push(changes);
      return false;
    }

    function redoCellChanges() {
      const changes = cellRedoStack.pop();
      if (!changes) {
        return false;
      }

      if (applyCellHistoryOperation(changes, 'redo')) {
        cellUndoStack.push(changes);
        return true;
      }

      cellRedoStack.push(changes);
      return false;
    }

    function applyCellValue(row, column, ctid, nextValue, input, options) {
      const shouldRecordHistory = options?.recordHistory !== false;
      const nextInputValue = toCellInputText(nextValue, column);
      const baseCurrentText = toCellInputText(row[column.name], column);
      const rowKey = getRowKeyForCell(row, ctid);
      const beforeValue = toCellInputText(getEffectiveCellValue(row, column.name, ctid), column);

      if (input) {
        input.value = nextInputValue;
        updateCellInputPlaceholder(input, nextValue);
      }

      if (ctid) {
        if (nextInputValue === baseCurrentText) {
          if (editedRows.has(ctid)) {
            const values = editedRows.get(ctid);
            delete values[column.name];
            if (Object.keys(values).length === 0) {
              editedRows.delete(ctid);
            }
          }
          if (input) {
            input.classList.remove('dirty');
          }
        } else {
          if (!editedRows.has(ctid)) {
            editedRows.set(ctid, {});
          }
          editedRows.get(ctid)[column.name] = nextInputValue;
          if (input) {
            input.classList.add('dirty');
          }
        }
      } else {
        row[column.name] = nextInputValue;
      }

      if (shouldRecordHistory && rowKey) {
        queueCellHistoryChange({
          rowKey,
          colName: column.name,
          beforeValue,
          afterValue: nextInputValue,
        });
      }

      updateSaveButtonState();
    }

    function applyJsonModalChanges(closeAfterApply) {
      if (readOnlyResultMode) {
        return false;
      }

      const target = currentJsonModalPayload;
      if (!target.row || !target.column) {
        closeJsonModal();
        return true;
      }

      const rawContent = codeEditor.getValue() || '';
      if (!target.isJson) {
        currentJsonModalPayload.content = rawContent;
        applyCellValue(target.row, target.column, target.ctid, rawContent, target.input);
        if (closeAfterApply) {
          closeJsonModal();
        }
        return true;
      }

      try {
        const parsed = JSON.parse(rawContent);
        const formatted = JSON.stringify(parsed, null, 2);
        currentJsonModalPayload.content = formatted;
        codeEditor.setValue(formatted);
        applyCellValue(target.row, target.column, target.ctid, formatted, target.input);
        if (closeAfterApply) {
          closeJsonModal();
        }
        return true;
      } catch {
        currentJsonModalPayload.content = rawContent;
        applyCellValue(target.row, target.column, target.ctid, rawContent, target.input);
        if (closeAfterApply) {
          closeJsonModal();
        }
        return true;
      }
    }

    function toCellInputText(value, column) {
      if (value === null || value === undefined) {
        return '';
      }

      if (isJsonColumn(column)) {
        if (typeof value === 'string') {
          try {
            return formatJsonCompactText(JSON.parse(value));
          } catch {
            return value;
          }
        }

        return formatJsonCompactText(value);
      }

      return String(value);
    }

    function getCellPlaceholderText(value) {
      if (value === null || value === undefined) {
        return 'Nulo';
      }
      if (typeof value === 'string' && value.length === 0) {
        return 'Vazio';
      }
      return '';
    }

    function updateCellInputPlaceholder(input, value) {
      const placeholder = getCellPlaceholderText(value);
      if (placeholder) {
        input.placeholder = placeholder;
        input.classList.add('cell-input-placeholder');
      } else {
        input.placeholder = '';
        input.classList.remove('cell-input-placeholder');
      }
    }

    function isValidUnixTimestamp(value) {
      if (typeof value !== 'number' && typeof value !== 'string') {
        return false;
      }

      const num = typeof value === 'string' ? parseInt(value, 10) : value;
      if (isNaN(num) || !Number.isInteger(num)) {
        return false;
      }

      const str = String(num);
      // Valid unix timestamp: 10 digits (seconds) or 13 digits (milliseconds)
      // 10 digits: 1000000000 to 9999999999 (1970-01-01 to 2286-11-20)
      // 13 digits: 1000000000000 to 9999999999999 (1970-01-01 to 5138-11-16)
      if (str.length === 10 || str.length === 13) {
        return true;
      }

      return false;
    }

    function getUnixTimestampTooltip(value) {
      if (!isValidUnixTimestamp(value)) {
        return null;
      }

      const num = typeof value === 'string' ? parseInt(value, 10) : value;
      const isMilliseconds = String(num).length === 13;
      const timestamp = isMilliseconds ? num : num * 1000;

      try {
        const date = new Date(timestamp);
        return date.toLocaleString();
      } catch {
        return null;
      }
    }

    const headerMenuOverlay = new OverlaySurfaceController({
      surfaceEl: headerMenu,
      backdropEl: headerMenuBackdrop,
      anchorEl: null,
      placement: 'bottom-end',
    });

    const modeDropdownOverlay = new OverlaySurfaceController({
      surfaceEl: modeDropdown,
      backdropEl: modeBackdrop,
      anchorEl: modeBtn,
      placement: 'bottom-start',
    });

    const columnsPopupOverlay = new OverlaySurfaceController({
      surfaceEl: columnsPopup,
      backdropEl: columnsBackdrop,
      anchorEl: columnsBtn,
      placement: 'bottom-end',
      onAfterOpen: () => {
        columnsSearch.focus();
        columnsSearch.select();
      },
    });

    const cellMenuOverlay = new OverlaySurfaceController({
      surfaceEl: cellMenu,
      backdropEl: menuBackdrop,
      placement: 'point',
    });

    const sortMenuOverlay = new OverlaySurfaceController({
      surfaceEl: sortMenu,
      backdropEl: sortMenuBackdrop,
      placement: 'point',
    });

    let sortMenuColumnName = null;

    const paginationMenuOverlay = new OverlaySurfaceController({
      surfaceEl: paginationMenu,
      backdropEl: paginationMenuBackdrop,
      anchorEl: pageInfoBtn,
      placement: 'bottom-end',
      onAfterOpen: () => {
        renderPageInfo();
        paginationLimitInput.value = String(state.limit);
        paginationPageInput.value = String(state.page);
        paginationPageInput.focus();
        paginationPageInput.select();
      },
    });

    function closeSubmenusImmediately() {
      document.querySelectorAll('.menu-submenu-wrap').forEach((wrap) => {
        const timer = submenuCloseTimers.get(wrap);
        if (timer) {
          clearTimeout(timer);
          submenuCloseTimers.delete(wrap);
        }
        wrap.classList.remove('submenu-open');
        wrap.classList.remove('submenu-visible');
      });
    }

    function closeContextMenu() {
      closeSubmenusImmediately();
      cellMenuOverlay.close();
    }

    function closeSortMenu() {
      sortMenuColumnName = null;
      sortMenuOverlay.close();
    }

    function applyColumnSort(colName, direction) {
      if (!colName) {
        return;
      }
      if (direction === 'asc' || direction === 'desc') {
        state.sortColumn = colName;
        state.sortDirection = direction;
      } else {
        state.sortColumn = undefined;
        state.sortDirection = undefined;
      }
      persistCurrentState();
      reloadTableViewClearingSelection();
    }

    function showSortMenu(clientX, clientY, colName) {
      sortMenuColumnName = colName;
      const activeDirection =
        state.sortColumn === colName ? (state.sortDirection === 'desc' ? 'desc' : 'asc') : 'none';
      sortMenu.querySelectorAll('button[data-sort]').forEach((button) => {
        const check = button.querySelector('.menu-item-check');
        if (check) {
          check.classList.toggle('is-checked', button.getAttribute('data-sort') === activeDirection);
        }
      });
      closeContextMenu();
      sortMenuOverlay.open({ x: clientX, y: clientY });
    }

    function closeHeaderMenu() {
      headerMenuOverlay.close();
    }

    function closeModeDropdown() {
      modeDropdownOverlay.close();
    }

    function closeColumnsPopup() {
      columnsPopupOverlay.close();
    }

    function closePaginationMenu() {
      paginationMenuOverlay.close();
    }

    function openJsonModal(column, value, row, ctid, input) {
      const columnName = column.name;
      const isJson = isJsonColumn(column);
      jsonModalTitle.textContent = columnName;
      const formatted = isJson ? formatJsonPrettyText(value) : String(value ?? '');
      currentJsonModalPayload = {
        columnName,
        content: formatted,
        isJson,
        row,
        column,
        ctid,
        input,
      };
      codeEditor.setValue(formatted);
      jsonModal.classList.add('open');
      jsonModalBackdrop.style.display = 'block';
      codeEditor.closeFind();
      codeEditor.focus();
      codeEditor.setSelectionRange(0, 0);
    }

    function closeJsonModal() {
      jsonModal.classList.remove('open');
      jsonModalBackdrop.style.display = 'none';
      codeEditor.closeFind();
    }

    function getSelectedCellPreviewData() {
      if (!lastSelectedCell) {
        return null;
      }

      const column = columns.find((col) => col.name === lastSelectedCell.colName);
      if (!column) {
        return null;
      }

      const row = rowKeyToRow.get(lastSelectedCell.rowKey);
      if (!row) {
        return null;
      }

      const ctid = rowKeyToCtid.get(lastSelectedCell.rowKey) || null;
      const inputMap = inputElements.get(lastSelectedCell.rowKey);
      const input = inputMap ? inputMap.get(column.name) : null;
      const content = input
        ? String(input.value || '')
        : toCellInputText(getEffectiveCellValue(row, column.name, ctid), column);

      return {
        rowKey: lastSelectedCell.rowKey,
        ctid,
        column,
        row,
        input,
        content,
      };
    }

    function notifyNativeJsonPreviewFromSelection(openEditor) {
      const selected = getSelectedCellPreviewData();
      if (!selected) {
        return;
      }

      const signature = [selected.rowKey, selected.column.name, selected.content].join('|');
      if (!openEditor && signature === nativePreviewSelectionSignature) {
        return;
      }
      nativePreviewSelectionSignature = signature;

      vscode.postMessage({
        type: 'syncNativeJsonPreview',
        open: Boolean(openEditor),
        rowKey: selected.rowKey,
        ctid: selected.ctid,
        columnName: selected.column.name,
        isJson: isJsonColumn(selected.column),
        content: selected.content,
      });
    }

    function applyNativePreviewContent(message) {
      const columnName = String(message.columnName || '');
      if (!columnName) {
        return;
      }

      const column = columns.find((col) => col.name === columnName);
      if (!column) {
        return;
      }

      let rowKey = typeof message.rowKey === 'string' ? message.rowKey : '';
      if (!rowKey && message.ctid) {
        rowKeyToCtid.forEach((value, key) => {
          if (!rowKey && value === message.ctid) {
            rowKey = key;
          }
        });
      }
      if (!rowKey) {
        return;
      }

      const row = rowKeyToRow.get(rowKey);
      if (!row) {
        return;
      }

      const ctid = rowKeyToCtid.get(rowKey) || null;
      const inputMap = inputElements.get(rowKey);
      const input = inputMap ? inputMap.get(column.name) : null;
      const nextContent = String(message.content ?? '');
      applyCellValue(row, column, ctid, nextContent, input || null);
      if (input) {
        input.value = toCellInputText(nextContent, column);
        updateCellInputPlaceholder(input, nextContent);
      }
      updateSaveButtonState();
      renderSelectionState();
    }

    function syncColumnState() {
      const names = columns.map((col) => col.name);
      const namesSet = new Set(names);

      if (columnOrder.length === 0) {
        columnOrder = [...names];
      } else {
        columnOrder = [
          ...columnOrder.filter((name) => namesSet.has(name)),
          ...names.filter((name) => !columnOrder.includes(name)),
        ];
      }

      visibleColumns = new Set([...visibleColumns].filter((name) => namesSet.has(name)));
      columnWidthByName = new Map(
        Array.from(columnWidthByName.entries()).filter(([name]) => namesSet.has(name))
      );

      names.forEach((name) => {
        const isKnownByLayout = layoutColumnOrderSnapshot?.has(name) === true;
        if (!visibleColumns.has(name) && !isKnownByLayout) {
          visibleColumns.add(name);
        }
      });
    }

    function resetColumnLayoutToDefault() {
      const names = columns.map((col) => col.name);
      columnOrder = [...names];
      visibleColumns = new Set(names);
      columnWidthByName = new Map();
      layoutColumnOrderSnapshot = null;
      notifyLayoutChanged();
      if (columnsPopup.classList.contains('open')) {
        renderColumnsPopupList();
      }
      render();
    }

    function getDisplayColumns() {
      const byName = new Map(columns.map((col) => [col.name, col]));
      return columnOrder
        .filter((name) => visibleColumns.has(name))
        .map((name) => byName.get(name))
        .filter((col) => Boolean(col));
    }

    function reorderColumnNames(sourceName, targetName) {
      if (!sourceName || !targetName || sourceName === targetName) {
        return;
      }

      const sourceIndex = columnOrder.indexOf(sourceName);
      const targetIndex = columnOrder.indexOf(targetName);
      if (sourceIndex < 0 || targetIndex < 0) {
        return;
      }

      const next = [...columnOrder];
      next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, sourceName);
      columnOrder = next;
      notifyLayoutChanged();
    }

    function renderColumnsPopupList() {
      columnsList.innerHTML = '';

      const allItem = document.createElement('li');
      allItem.className = 'columns-item all-toggle';

      const allCheckbox = document.createElement('input');
      allCheckbox.type = 'checkbox';
      allCheckbox.checked = visibleColumns.size === columnOrder.length;
      allCheckbox.indeterminate = visibleColumns.size > 0 && visibleColumns.size < columnOrder.length;
      allCheckbox.addEventListener('change', () => {
        if (allCheckbox.checked) {
          visibleColumns = new Set(columnOrder);
        } else {
          visibleColumns = new Set();
        }
        notifyLayoutChanged();
        renderColumnsPopupList();
        render();
      });

      const allLabel = document.createElement('span');
      allLabel.className = 'columns-item-name';
      allLabel.textContent = t('webview.table.all', 'Todos');
      allLabel.style.cursor = 'pointer';
      allLabel.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        allCheckbox.checked = !allCheckbox.checked;
        allCheckbox.dispatchEvent(new Event('change'));
      });

      allItem.appendChild(allCheckbox);
      allItem.appendChild(allLabel);
      columnsList.appendChild(allItem);

      const dividerItem = document.createElement('li');
      dividerItem.className = 'columns-divider';
      dividerItem.setAttribute('aria-hidden', 'true');
      columnsList.appendChild(dividerItem);

      const filterText = columnsSearchText.trim().toLowerCase();
      const filteredNames = filterText
        ? columnOrder.filter((name) => name.toLowerCase().includes(filterText))
        : columnOrder;
      const allowPopupReorder = filterText.length === 0;

      filteredNames.forEach((name) => {
        const item = document.createElement('li');
        item.className = 'columns-item';
        if (!allowPopupReorder) {
          item.classList.add('no-reorder');
        }
        item.draggable = allowPopupReorder;
        item.setAttribute('data-column-name', name);

        if (!allowPopupReorder) {
          item.addEventListener('dragstart', (event) => {
            event.preventDefault();
          });
        }

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = visibleColumns.has(name);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            visibleColumns.add(name);
          } else {
            visibleColumns.delete(name);
          }

          notifyLayoutChanged();
          renderColumnsPopupList();
          render();
        });

        const label = document.createElement('span');
        label.className = 'columns-item-name';
        label.textContent = name;
        label.style.cursor = 'pointer';
        label.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        });

        const handle = document.createElement('span');
        handle.className = 'columns-item-handle';
        handle.textContent = '⋮⋮';

        if (allowPopupReorder) {
          item.addEventListener('dragstart', () => {
            draggedColumnName = name;
          });

          item.addEventListener('dragover', (event) => {
            event.preventDefault();
            item.classList.add('drag-over');
          });

          item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
          });

          item.addEventListener('drop', (event) => {
            event.preventDefault();
            item.classList.remove('drag-over');
            reorderColumnNames(draggedColumnName, name);
            renderColumnsPopupList();
            render();
          });

          item.addEventListener('dragend', () => {
            draggedColumnName = null;
            columnsList.querySelectorAll('.columns-item').forEach((node) => node.classList.remove('drag-over'));
          });
        }

        item.appendChild(checkbox);
        item.appendChild(label);
        item.appendChild(handle);
        columnsList.appendChild(item);
      });
    }

    function showContextMenu(clientX, clientY) {
      if (openNativePreviewActionBtn) {
        openNativePreviewActionBtn.style.display = activeCell ? '' : 'none';
      }
      if (searchMentionsActionBtn) {
        searchMentionsActionBtn.style.display = canSearchMentionsForActiveCell() ? '' : 'none';
      }
      closeSortMenu();
      cellMenuOverlay.open({ x: clientX, y: clientY });
    }

    function resolveMentionTargetForColumn(column) {
      if (!column) {
        return null;
      }

      if (isFkColumn(column)) {
        const targetSchemaName = String(column.foreignKeyTargetSchema || '').trim();
        const targetTableName = String(column.foreignKeyTargetTable || '').trim();
        const targetColumnName = String(column.foreignKeyTargetColumn || '').trim();
        if (!targetSchemaName || !targetTableName || !targetColumnName) {
          return null;
        }
        return { targetSchemaName, targetTableName, targetColumnName };
      }

      if (isPkColumn(column) || isUniqueColumn(column)) {
        const targetSchemaName = String(currentSchemaName || '').trim();
        const targetTableName = String(currentTableName || '').trim();
        const targetColumnName = String(column.name || '').trim();
        if (!targetSchemaName || !targetTableName || !targetColumnName) {
          return null;
        }
        return { targetSchemaName, targetTableName, targetColumnName };
      }

      return null;
    }

    function canSearchMentionsForActiveCell() {
      if (!activeCell || readOnlyResultMode) {
        return false;
      }
      const col = columns.find((column) => column.name === activeCell.colName);
      if (!resolveMentionTargetForColumn(col)) {
        return false;
      }
      const value = getEffectiveCellValue(activeCell.row, activeCell.colName, activeCell.ctid);
      return value !== null && value !== undefined && String(value).trim() !== '';
    }

    function syncControls() {
      searchInputEl.value = state.searchText;
      updateModeIcon();
      updateSearchContextPlaceholder();
      syncClearFiltersButton();
      renderPageInfo();
      updateSaveButtonState();
    }

    function hasActiveFilters() {
      const hasSearch = String(state.searchText || '').trim().length > 0;
      const hasColumnFilters = Object.values(state.columnFilters || {}).some(
        (value) => String(value || '').trim().length > 0
      );
      return hasSearch || hasColumnFilters;
    }

    function syncClearFiltersButton() {
      if (!clearFiltersBtn) {
        return;
      }

      const active = hasActiveFilters();
      clearFiltersBtn.style.display = active ? '' : 'none';
      clearFiltersBtn.disabled = !active;
    }

    function currentState() {
      return {
        searchText: document.getElementById('search').value || '',
        searchMode: state.searchMode,
        sortColumn: state.sortColumn,
        sortDirection: state.sortDirection,
        columnFilters: state.columnFilters,
        limit: Math.max(1, Math.trunc(Number(state.limit || ${defaultPageSize}))),
        page: state.page,
      };
    }

    function persistCurrentState() {
      vscode.postMessage({
        type: 'updateState',
        state: currentState(),
      });
    }

    function closeExportModal() {
      exportModal.classList.remove('open');
      exportModalBackdrop.classList.remove('open');
    }

    function updateExportSelectedOptionState() {
      const hasSelection = getSelectedCellsCount() > 0;
      exportDataSelected.disabled = !hasSelection;
      exportSelectedOption.classList.toggle('disabled', !hasSelection);
      if (!hasSelection && exportDataSelected.checked) {
        exportDataResult.checked = true;
      }
    }

    function openExportModal() {
      updateExportSelectedOptionState();
      exportFormatJson.checked = true;
      exportDataResult.checked = true;
      exportModal.classList.add('open');
      exportModalBackdrop.classList.add('open');
    }

    function getResultExportPayload() {
      const displayColumns = getDisplayColumns();
      const visibleRows = applyLocalFilter(rows);
      const columnNames = displayColumns.map((col) => col.name);

      const exportRows = visibleRows.map((row) => {
        const ctid = row.__dbadmin_ctid || null;
        const out = {};
        displayColumns.forEach((col) => {
          out[col.name] = getEffectiveCellValue(row, col.name, ctid);
        });
        return out;
      });

      return { columns: columnNames, rows: exportRows };
    }

    function getSelectedCellsExportPayload() {
      const displayColumns = getDisplayColumns();
      const selectedColumnsSet = new Set();
      displayedRowKeys.forEach((rowKey) => {
        const cellSet = selectedCells.get(rowKey);
        if (!cellSet || cellSet.size === 0) {
          return;
        }
        cellSet.forEach((colName) => selectedColumnsSet.add(colName));
      });

      const columnNames = displayColumns
        .map((col) => col.name)
        .filter((name) => selectedColumnsSet.has(name));

      const exportRows = [];
      displayedRowKeys.forEach((rowKey) => {
        const cellSet = selectedCells.get(rowKey);
        const row = rowKeyToRow.get(rowKey);
        if (!row || !cellSet || cellSet.size === 0) {
          return;
        }

        const ctid = rowKeyToCtid.get(rowKey) || null;
        const out = {};
        columnNames.forEach((colName) => {
          out[colName] = cellSet.has(colName)
            ? getEffectiveCellValue(row, colName, ctid)
            : '';
        });
        exportRows.push(out);
      });

      return { columns: columnNames, rows: exportRows };
    }

    function renderPageInfo() {
      const pageSize = Math.max(1, Number(state.limit || ${defaultPageSize}));
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      if (state.page > totalPages) {
        state.page = totalPages;
      }
      pageInfoEl.textContent = state.page + '/' + totalPages + ' (' + totalRows + ')';
      if (paginationMenuInfoEl) {
        paginationMenuInfoEl.textContent = tf('webview.table.pageInfo', { page: state.page, total: totalPages, rows: totalRows }, 'Página ' + state.page + ' de ' + totalPages + '   •   Total: ' + totalRows);
      }
      if (pageInfoBtn) {
        pageInfoBtn.setAttribute(
          'title',
          'Paginação - Página ' + state.page + ' de ' + totalPages,
        );
      }
      document.getElementById('prevPage').disabled = state.page <= 1;
      document.getElementById('nextPage').disabled = state.page >= totalPages;
    }

    function sanitizePageSizeInput(rawValue) {
      const parsed = Math.trunc(Number(rawValue));
      if (!Number.isFinite(parsed) || parsed < 1) {
        return null;
      }
      return Math.max(1, Math.min(500, parsed));
    }

    function normalizeRequestedPage(rawPageValue, totalPages) {
      const parsed = Math.trunc(Number(rawPageValue));
      if (!Number.isFinite(parsed)) {
        return null;
      }
      if (parsed === -1) {
        return totalPages;
      }
      if (parsed < 1) {
        return null;
      }
      return parsed > totalPages ? totalPages : parsed;
    }

    function applyPaginationMenuValues() {
      const nextLimit = sanitizePageSizeInput(paginationLimitInput.value);
      if (nextLimit === null) {
        paginationLimitInput.value = String(state.limit);
        return false;
      }

      const limitChanged = nextLimit !== state.limit;
      const totalPagesAfterLimit = Math.max(1, Math.ceil(totalRows / nextLimit));
      const requestedPage = normalizeRequestedPage(paginationPageInput.value, totalPagesAfterLimit);
      if (requestedPage === null) {
        paginationPageInput.value = String(state.page);
        return false;
      }

      const pageChanged = requestedPage !== state.page;
      if (!limitChanged && !pageChanged) {
        return true;
      }

      state.limit = nextLimit;
      state.page = requestedPage;
      persistCurrentState();
      reloadTableViewClearingSelection();
      return true;
    }

    function enableCellEditing(input) {
      if (editingCellInput) {
        editingCellInput.classList.remove('editing');
      }
      editingCellInput = input;
      input.classList.add('editing');
      input.setAttribute('data-edit-initial-value', input.value);
      input.setSelectionRange(0, input.value.length);
      input.focus();
    }

    function disableCellEditing(input) {
      if (editingCellInput === input) {
        editingCellInput = null;
      }
      if (typeof input.setSelectionRange === 'function') {
        try {
          input.setSelectionRange(0, 0);
        } catch {
          // Ignore selection reset failures.
        }
      }
      input.classList.remove('editing');
      input.readOnly = true;
      if (document.activeElement === input) {
        input.blur();
      }
      const selection = window.getSelection ? window.getSelection() : null;
      if (selection && typeof selection.removeAllRanges === 'function') {
        selection.removeAllRanges();
      }
    }

    function selectRow(rowKey, displayColumns, preserveExisting) {
      keyboardSelectionAnchor = null;
      keyboardSelectionAdditive = false;
      keyboardSelectionBase = new Map();
      if (!preserveExisting) {
        selectedCells.clear();
      }

      const selectableColumns = getRowSelectableColumnNames(rowKey);
      const selectedColumnNames = selectableColumns.length > 0
        ? selectableColumns
        : displayColumns.map((col) => col.name);

      selectedCells.set(rowKey, new Set(selectedColumnNames));
      setSingleRowRangeSelection(rowKey, selectedColumnNames);
      syncSelectionCountsFromSelectedCells();
      if (selectedColumnNames.length > 0) {
        lastSelectedCell = { rowKey, colName: selectedColumnNames[0] };
      }
    }

    function getRowSelectableColumnNames(rowKey) {
      const tdMap = tdElements.get(rowKey);
      if (!tdMap || tdMap.size === 0) {
        return [...displayedColNames];
      }

      return displayedColNames.filter((colName) => tdMap.has(colName));
    }

    function setSingleRowRangeSelection(rowKey, selectedColumnNames) {
      const rowIndex = displayedRowKeys.indexOf(rowKey);
      if (rowIndex < 0 || selectedColumnNames.length === 0) {
        currentRangeSelection = null;
        return;
      }

      const firstColIndex = displayedColNames.indexOf(selectedColumnNames[0]);
      const lastColIndex = displayedColNames.indexOf(
        selectedColumnNames[selectedColumnNames.length - 1]
      );

      if (firstColIndex < 0 || lastColIndex < 0) {
        currentRangeSelection = null;
        return;
      }

      currentRangeSelection = {
        anchor: { rowIndex, colIndex: firstColIndex },
        focus: { rowIndex, colIndex: lastColIndex },
      };
    }

    function selectAllDisplayedCells() {
      keyboardSelectionAnchor = displayedRowKeys.length > 0 && displayedColNames.length > 0
        ? { rowIndex: 0, colIndex: 0 }
        : null;
      keyboardSelectionAdditive = false;
      keyboardSelectionBase = new Map();
      selectedCells.clear();

      displayedRowKeys.forEach((rowKey) => {
        selectedCells.set(rowKey, new Set(displayedColNames));
      });

      if (displayedRowKeys.length > 0 && displayedColNames.length > 0) {
        currentRangeSelection = {
          anchor: { rowIndex: 0, colIndex: 0 },
          focus: {
            rowIndex: displayedRowKeys.length - 1,
            colIndex: displayedColNames.length - 1,
          },
        };
        lastSelectedCell = { rowKey: displayedRowKeys[0], colName: displayedColNames[0] };
      } else {
        currentRangeSelection = null;
        lastSelectedCell = null;
      }

      syncSelectionCountsFromSelectedCells();
      renderSelectionState();
    }

    function cloneSelectionMap(source) {
      const clone = new Map();
      source.forEach((set, rowKey) => {
        clone.set(rowKey, new Set(set));
      });
      return clone;
    }

    function snapshotCellSelection() {
      return {
        selectedCells: cloneSelectionMap(selectedCells),
        selectedCellCounts: cloneSelectionCounts(selectedCellCounts),
        lastSelectedCell: lastSelectedCell
          ? { rowKey: lastSelectedCell.rowKey, colName: lastSelectedCell.colName }
          : null,
        currentRangeSelection: currentRangeSelection
          ? {
              anchor: { ...currentRangeSelection.anchor },
              focus: { ...currentRangeSelection.focus },
            }
          : null,
      };
    }

    function restoreCellSelectionSnapshot(snapshot) {
      if (!snapshot) {
        return;
      }
      selectedCells = cloneSelectionMap(snapshot.selectedCells);
      selectedCellCounts = cloneSelectionCounts(snapshot.selectedCellCounts);
      lastSelectedCell = snapshot.lastSelectedCell
        ? { rowKey: snapshot.lastSelectedCell.rowKey, colName: snapshot.lastSelectedCell.colName }
        : null;
      currentRangeSelection = snapshot.currentRangeSelection
        ? {
            anchor: { ...snapshot.currentRangeSelection.anchor },
            focus: { ...snapshot.currentRangeSelection.focus },
          }
        : null;
      renderSelectionState();
    }

    function beginContextMenuGesture() {
      selectionSnapshotBeforeContextMenu = snapshotCellSelection();
      suppressCellSelectionUntil = Date.now() + 400;
      isDragging = false;
      dragAnchor = null;
      cellDragMode = 'replace';
      cellDragBaseCounts = new Map();
    }

    function finishContextMenuGesture() {
      selectionSnapshotBeforeContextMenu = null;
    }

    function selectCellForContextMenuIfNeeded(rowKey, colName, rowIndex, colIndex) {
      const currentCellSet = selectedCells.get(rowKey);
      if (currentCellSet && currentCellSet.has(colName)) {
        return;
      }

      selectedCells.clear();
      selectedCells.set(rowKey, new Set([colName]));
      syncSelectionCountsFromSelectedCells();
      lastSelectedCell = { rowKey, colName };
      currentRangeSelection = {
        anchor: { rowIndex, colIndex },
        focus: { rowIndex, colIndex },
      };
      keyboardSelectionAnchor = { rowIndex, colIndex };
      keyboardSelectionAdditive = false;
      keyboardSelectionBase = new Map();
      cellDragMode = 'replace';
      cellDragBaseCounts = new Map();
      dragAnchor = null;
      isDragging = false;
      renderSelectionState();
    }

    function cloneSelectionCounts(source) {
      const clone = new Map();
      source.forEach((colMap, rowKey) => {
        const nextColMap = new Map();
        colMap.forEach((count, colName) => {
          if (count > 0) {
            nextColMap.set(colName, count);
          }
        });
        if (nextColMap.size > 0) {
          clone.set(rowKey, nextColMap);
        }
      });
      return clone;
    }

    function selectionCountsFromSelectionMap(source) {
      const counts = new Map();
      source.forEach((colSet, rowKey) => {
        const colMap = new Map();
        colSet.forEach((colName) => {
          colMap.set(colName, 1);
        });
        if (colMap.size > 0) {
          counts.set(rowKey, colMap);
        }
      });
      return counts;
    }

    function selectionMapFromCounts(source) {
      const nextSelection = new Map();
      source.forEach((colMap, rowKey) => {
        const colSet = new Set();
        colMap.forEach((count, colName) => {
          if (count > 0) {
            colSet.add(colName);
          }
        });
        if (colSet.size > 0) {
          nextSelection.set(rowKey, colSet);
        }
      });
      return nextSelection;
    }

    function syncSelectionCountsFromSelectedCells() {
      selectedCellCounts = selectionCountsFromSelectionMap(selectedCells);
    }

    function clearSelectionState(options) {
      selectedCells.clear();
      selectedCellCounts = new Map();
      currentRangeSelection = null;
      keyboardSelectionAnchor = null;
      keyboardSelectionAdditive = false;
      keyboardSelectionBase = new Map();
      cellDragMode = 'replace';
      cellDragBaseCounts = new Map();
      dragAnchor = null;
      isDragging = false;
      lastSelectedCell = null;
      nativePreviewSelectionSignature = '';
      rangeSelectionOverlay.style.display = 'none';

      if (!options || options.render !== false) {
        renderSelectionState();
      }
    }

    function clearSelectionForViewChange() {
      clearSelectionState({ render: false });
    }

    function rerenderTableViewClearingSelection() {
      clearSelectionForViewChange();
      render();
    }

    function reloadTableViewClearingSelection(options) {
      clearSelectionForViewChange();
      beginLoading();
      vscode.postMessage({
        type: 'reload',
        state: currentState(),
        clearSelectionAndPreview: Boolean(options && options.clearSelectionAndPreview),
      });
    }

    function applyRangeToCounts(baseCounts, minR, maxR, minC, maxC, delta) {
      const nextCounts = cloneSelectionCounts(baseCounts);
      for (let r = minR; r <= maxR; r++) {
        const rowKey = displayedRowKeys[r];
        if (!rowKey) {
          continue;
        }

        let colMap = nextCounts.get(rowKey);
        if (!colMap) {
          colMap = new Map();
          nextCounts.set(rowKey, colMap);
        }

        for (let c = minC; c <= maxC; c++) {
          const colName = displayedColNames[c];
          if (!colName) {
            continue;
          }
          const prev = colMap.get(colName) || 0;
          const next = Math.max(0, prev + delta);
          if (next > 0) {
            colMap.set(colName, next);
          } else {
            colMap.delete(colName);
          }
        }

        if (colMap.size === 0) {
          nextCounts.delete(rowKey);
        }
      }
      return nextCounts;
    }

    function applyCellDragRange(currentRowIndex, currentColIndex) {
      if (!dragAnchor) {
        return;
      }

      const minR = Math.min(dragAnchor.rowIndex, currentRowIndex);
      const maxR = Math.max(dragAnchor.rowIndex, currentRowIndex);
      const minC = Math.min(dragAnchor.colIndex, currentColIndex);
      const maxC = Math.max(dragAnchor.colIndex, currentColIndex);

      if (cellDragMode === 'replace') {
        selectedCells.clear();
        for (let r = minR; r <= maxR; r++) {
          const rk = displayedRowKeys[r];
          if (!rk) {
            continue;
          }
          const colSet = new Set();
          for (let c = minC; c <= maxC; c++) {
            const cn = displayedColNames[c];
            if (cn) {
              colSet.add(cn);
            }
          }
          if (colSet.size > 0) {
            selectedCells.set(rk, colSet);
          }
        }
        syncSelectionCountsFromSelectedCells();
      } else {
        const delta = cellDragMode === 'add' ? 1 : -1;
        selectedCellCounts = applyRangeToCounts(cellDragBaseCounts, minR, maxR, minC, maxC, delta);
        selectedCells = selectionMapFromCounts(selectedCellCounts);
      }

      currentRangeSelection = {
        anchor: { rowIndex: dragAnchor.rowIndex, colIndex: dragAnchor.colIndex },
        focus: { rowIndex: currentRowIndex, colIndex: currentColIndex },
      };

      const focusRowKey = displayedRowKeys[currentRowIndex];
      const focusColName = displayedColNames[currentColIndex];
      if (focusRowKey && focusColName) {
        lastSelectedCell = { rowKey: focusRowKey, colName: focusColName };
      }

      renderSelectionState();
    }

    function applyRowSelectionDragRange(currentRowIndex, displayColumns) {
      keyboardSelectionAnchor = null;
      keyboardSelectionAdditive = false;
      keyboardSelectionBase = new Map();
      if (rowSelectionDragAnchorIndex === null) {
        currentRangeSelection = null;
        return;
      }
      selectedCells = cloneSelectionMap(rowSelectionDragBaseSelection);
      const minR = Math.min(rowSelectionDragAnchorIndex, currentRowIndex);
      const maxR = Math.max(rowSelectionDragAnchorIndex, currentRowIndex);
      for (let r = minR; r <= maxR; r++) {
        const rk = displayedRowKeys[r];
        if (!rk) {
          continue;
        }
        selectedCells.set(rk, new Set(getRowSelectableColumnNames(rk)));
      }
      if (displayColumns.length > 0) {
        const lastRowKey = displayedRowKeys[currentRowIndex];
        if (lastRowKey) {
          const selectableColumns = getRowSelectableColumnNames(lastRowKey);
          if (selectableColumns.length > 0) {
            lastSelectedCell = { rowKey: lastRowKey, colName: selectableColumns[0] };
          }
        }
      }
      currentRangeSelection = {
        anchor: { rowIndex: rowSelectionDragAnchorIndex, colIndex: 0 },
        focus: { rowIndex: currentRowIndex, colIndex: Math.max(0, displayedColNames.length - 1) },
      };
      syncSelectionCountsFromSelectedCells();
      renderSelectionState();
    }

    function discardInsertedRow(row) {
      if (!row || !row.__dbadmin_inserted) {
        return false;
      }
      const beforeInserted = insertedRows.length;
      const beforeRows = rows.length;
      insertedRows = insertedRows.filter((candidate) => candidate !== row);
      rows = rows.filter((candidate) => candidate !== row);
      return insertedRows.length !== beforeInserted || rows.length !== beforeRows;
    }

    function markSelectedRowsForDelete() {
      let discardedInserted = false;
      selectedCells.forEach((_cols, rowKey) => {
        const ctid = rowKeyToCtid.get(rowKey);
        if (ctid) {
          removedCtids.add(ctid);
          return;
        }
        const row = rowKeyToRow.get(rowKey);
        if (discardInsertedRow(row)) {
          discardedInserted = true;
        }
      });
      if (discardedInserted) {
        clearSelectionState({ render: false });
        if (activeCell && (!activeCell.ctid) && activeCell.row && activeCell.row.__dbadmin_inserted) {
          const stillPresent = rows.includes(activeCell.row);
          if (!stillPresent) {
            activeCell = null;
          }
        }
      }
      updateSaveButtonState();
    }

    function renderSelectionState() {
      const range = currentRangeSelection;
      const minR = range ? Math.min(range.anchor.rowIndex, range.focus.rowIndex) : -1;
      const maxR = range ? Math.max(range.anchor.rowIndex, range.focus.rowIndex) : -1;
      const minC = range ? Math.min(range.anchor.colIndex, range.focus.colIndex) : -1;
      const maxC = range ? Math.max(range.anchor.colIndex, range.focus.colIndex) : -1;
      const originRowKey = range ? displayedRowKeys[range.anchor.rowIndex] : null;
      const originColName = range ? displayedColNames[range.anchor.colIndex] : null;

      trElements.forEach((_tr, rowKey) => {
        const selTd = selectionTdElements.get(rowKey);
        const cellSet = selectedCells.get(rowKey);
        const tdMap = tdElements.get(rowKey);
        // Selection column: highlight only when entire row is selected
        const totalCols = tdMap ? tdMap.size : 0;
        const isFullRowSelected = Boolean(cellSet && totalCols > 0 && cellSet.size === totalCols);
        if (selTd) {
          selTd.classList.toggle('selected', isFullRowSelected);
        }
        if (tdMap) {
          const isSingleCellFocus = !range && lastSelectedCell && lastSelectedCell.rowKey === rowKey;
          tdMap.forEach((td, colName) => {
            td.classList.toggle('cell-selected', Boolean(cellSet && cellSet.has(colName)));
            const isOrigin = range
              ? (rowKey === originRowKey && colName === originColName)
              : Boolean(isSingleCellFocus && lastSelectedCell.colName === colName && cellSet && cellSet.has(colName));
            td.classList.toggle('cell-selected-current-origin', isOrigin);
          });
        }
      });

      // Update range selection overlay bounding box
      if (range && minR >= 0 && maxR >= 0 && minC >= 0 && maxC >= 0) {
        let topTd = null;
        let bottomTd = null;
        let leftTd = null;
        let rightTd = null;

        for (let r = minR; r <= maxR; r++) {
          const rowKey = displayedRowKeys[r];
          if (!rowKey) {
            continue;
          }
          const tdMap = tdElements.get(rowKey);
          if (!tdMap) {
            continue;
          }

          for (let c = minC; c <= maxC; c++) {
            const colName = displayedColNames[c];
            if (!colName) {
              continue;
            }
            const td = tdMap.get(colName);
            if (!td) {
              continue;
            }

            if (!topTd || r === minR) {
              topTd = td;
            }
            if (!bottomTd || r === maxR) {
              bottomTd = td;
            }
            if (!leftTd || c === minC) {
              leftTd = td;
            }
            if (!rightTd || c === maxC) {
              rightTd = td;
            }
          }
        }

        if (topTd && bottomTd && leftTd && rightTd) {
          const wrapRect = tableWrapEl.getBoundingClientRect();
          const topRect = topTd.getBoundingClientRect();
          const bottomRect = bottomTd.getBoundingClientRect();
          const leftRect = leftTd.getBoundingClientRect();
          const rightRect = rightTd.getBoundingClientRect();

          /** Esses números -2, -1 são ajustes finos */
          const overlayTop = topRect.top - wrapRect.top + tableWrapEl.scrollTop - 1;
          const stickySelectionWidth =
            (gridEl.querySelector('th.selection-col')?.getBoundingClientRect().width ?? 30);
          const minOverlayLeftPx = wrapRect.left + stickySelectionWidth;
          const clampedOverlayLeftPx = Math.max(leftRect.left, minOverlayLeftPx);
          const overlayLeft = clampedOverlayLeftPx - wrapRect.left + tableWrapEl.scrollLeft;
          const overlayWidth = (rightRect.right - clampedOverlayLeftPx) - 2;
          const overlayHeight = (bottomRect.bottom - topRect.top) - 2;

          if (overlayWidth > 0) {
            rangeSelectionOverlay.style.top = overlayTop + 'px';
            rangeSelectionOverlay.style.left = overlayLeft + 'px';
            rangeSelectionOverlay.style.width = overlayWidth + 'px';
            rangeSelectionOverlay.style.height = overlayHeight + 'px';
            rangeSelectionOverlay.style.display = 'block';
          } else {
            rangeSelectionOverlay.style.display = 'none';
          }
        } else {
          rangeSelectionOverlay.style.display = 'none';
        }
      } else {
        rangeSelectionOverlay.style.display = 'none';
      }

      updateExportSelectedOptionState();
      notifyNativeJsonPreviewFromSelection(false);
    }

    function ensureCellSelectionVisible(rowKey, colName) {
      const tdMap = tdElements.get(rowKey);
      const td = tdMap ? tdMap.get(colName) : null;
      if (!td) {
        return;
      }

      const tdRect = td.getBoundingClientRect();
      const wrapRect = tableWrapEl.getBoundingClientRect();

      const thead = tableWrapEl.querySelector('thead');
      const headerHeight = thead ? thead.getBoundingClientRect().height : 0;

      const visibleTop = wrapRect.top + headerHeight;
      const visibleBottom = wrapRect.bottom;

      // Esses 15px são ajuste fino, 1px é a borda.
      if (tdRect.top < visibleTop) {
        tableWrapEl.scrollTop -= (visibleTop - tdRect.top) + 1;
      } else if (tdRect.bottom > visibleBottom - 16) {
        tableWrapEl.scrollTop += (tdRect.bottom - visibleBottom) + 16;
      }

      if (tdRect.left < wrapRect.left + 30) {
        const isFirstCell = colName === displayedColNames[0];
        if (isFirstCell) {
          tableWrapEl.scrollLeft = 0;
        } else {
          tableWrapEl.scrollLeft -= (wrapRect.left - tdRect.left) + 30;
        }
      } else if (tdRect.right > wrapRect.right - (15)) {
        tableWrapEl.scrollLeft += (tdRect.right - wrapRect.right) + 15;
      }
    }

    function getCellPosition(cellRef) {
      if (!cellRef) {
        return null;
      }
      const rowIndex = displayedRowKeys.indexOf(cellRef.rowKey);
      const colIndex = displayedColNames.indexOf(cellRef.colName);
      if (rowIndex < 0 || colIndex < 0) {
        return null;
      }
      return { rowIndex, colIndex };
    }

    function getSelectionAnchorPosition() {
      if (
        keyboardSelectionAnchor &&
        keyboardSelectionAnchor.rowIndex >= 0 &&
        keyboardSelectionAnchor.colIndex >= 0 &&
        keyboardSelectionAnchor.rowIndex < displayedRowKeys.length &&
        keyboardSelectionAnchor.colIndex < displayedColNames.length
      ) {
        return keyboardSelectionAnchor;
      }

      const fallback = getCellPosition(lastSelectedCell);
      if (!fallback) {
        return null;
      }

      return { rowIndex: fallback.rowIndex, colIndex: fallback.colIndex };
    }

    function selectSingleCellAt(rowIndex, colIndex, enterEditMode) {
      if (rowIndex < 0 || colIndex < 0 || rowIndex >= displayedRowKeys.length || colIndex >= displayedColNames.length) {
        return;
      }

      const rowKey = displayedRowKeys[rowIndex];
      const colName = displayedColNames[colIndex];
      keyboardSelectionAnchor = { rowIndex, colIndex };
      keyboardSelectionAdditive = false;
      keyboardSelectionBase = new Map();
      currentRangeSelection = null;
      selectedCells.clear();
      selectedCells.set(rowKey, new Set([colName]));
      syncSelectionCountsFromSelectedCells();
      lastSelectedCell = { rowKey, colName };
      renderSelectionState();
      ensureCellSelectionVisible(rowKey, colName);

      if (!enterEditMode) {
        return;
      }

      const inputMap = inputElements.get(rowKey);
      const nextInput = inputMap ? inputMap.get(colName) : null;
      if (!nextInput) {
        return;
      }
      nextInput.readOnly = false;
      enableCellEditing(nextInput);
    }

    function moveSelectionBy(deltaRow, deltaCol) {
      const pos = getCellPosition(lastSelectedCell);
      if (!pos) {
        if (displayedRowKeys.length > 0 && displayedColNames.length > 0) {
          selectSingleCellAt(0, 0, false);
        }
        return;
      }

      const nextRow = Math.min(Math.max(pos.rowIndex + deltaRow, 0), displayedRowKeys.length - 1);
      const nextCol = Math.min(Math.max(pos.colIndex + deltaCol, 0), displayedColNames.length - 1);
      selectSingleCellAt(nextRow, nextCol, false);
    }

    function moveSelectionTo(rowIndex, colIndex) {
      if (displayedRowKeys.length === 0 || displayedColNames.length === 0) {
        return;
      }

      const boundedRow = Math.min(Math.max(rowIndex, 0), displayedRowKeys.length - 1);
      const boundedCol = Math.min(Math.max(colIndex, 0), displayedColNames.length - 1);
      selectSingleCellAt(boundedRow, boundedCol, false);
    }

    function getViewportNavigationStep() {
      const wrapRect = tableWrapEl.getBoundingClientRect();

      let visibleRows = 0;
      displayedRowKeys.forEach((rowKey) => {
        const tr = trElements.get(rowKey);
        if (!tr) {
          return;
        }
        const rect = tr.getBoundingClientRect();
        if (rect.top >= wrapRect.top && rect.bottom <= wrapRect.bottom) {
          visibleRows += 1;
        }
      });

      let visibleCols = 0;
      displayedColNames.forEach((colName) => {
        const th = gridEl.querySelector('th[data-column-name="' + colName + '"]');
        if (!th) {
          return;
        }
        const rect = th.getBoundingClientRect();
        if (rect.left >= wrapRect.left && rect.right <= wrapRect.right) {
          visibleCols += 1;
        }
      });

      return {
        rows: Math.max(1, visibleRows),
        cols: Math.max(1, visibleCols),
      };
    }

    function applyKeyboardRangeSelection(anchor, focus) {
      const minR = Math.min(anchor.rowIndex, focus.rowIndex);
      const maxR = Math.max(anchor.rowIndex, focus.rowIndex);
      const minC = Math.min(anchor.colIndex, focus.colIndex);
      const maxC = Math.max(anchor.colIndex, focus.colIndex);

      if (keyboardSelectionAdditive) {
        selectedCells = cloneSelectionMap(keyboardSelectionBase);
      } else {
        selectedCells.clear();
      }
      for (let r = minR; r <= maxR; r++) {
        const rowKey = displayedRowKeys[r];
        if (!rowKey) {
          continue;
        }
        const cellSet = keyboardSelectionAdditive
          ? new Set(selectedCells.get(rowKey) || [])
          : new Set();
        for (let c = minC; c <= maxC; c++) {
          const colName = displayedColNames[c];
          if (colName) {
            cellSet.add(colName);
          }
        }
        selectedCells.set(rowKey, cellSet);
      }

      syncSelectionCountsFromSelectedCells();
      currentRangeSelection = {
        anchor: { rowIndex: anchor.rowIndex, colIndex: anchor.colIndex },
        focus: { rowIndex: focus.rowIndex, colIndex: focus.colIndex },
      };

      const focusRowKey = displayedRowKeys[focus.rowIndex];
      const focusColName = displayedColNames[focus.colIndex];
      if (focusRowKey && focusColName) {
        lastSelectedCell = { rowKey: focusRowKey, colName: focusColName };
        ensureCellSelectionVisible(focusRowKey, focusColName);
      }

      renderSelectionState();
    }

    function extendSelectionBy(deltaRow, deltaCol) {
      if (displayedRowKeys.length === 0 || displayedColNames.length === 0) {
        return;
      }

      let pos = getCellPosition(lastSelectedCell);
      if (!pos) {
        selectSingleCellAt(0, 0, false);
        pos = { rowIndex: 0, colIndex: 0 };
      }

      if (!keyboardSelectionAnchor) {
        keyboardSelectionAnchor = { rowIndex: pos.rowIndex, colIndex: pos.colIndex };
      }

      const next = {
        rowIndex: Math.min(Math.max(pos.rowIndex + deltaRow, 0), displayedRowKeys.length - 1),
        colIndex: Math.min(Math.max(pos.colIndex + deltaCol, 0), displayedColNames.length - 1),
      };

      applyKeyboardRangeSelection(keyboardSelectionAnchor, next);
    }

    function extendSelectionTo(rowIndex, colIndex) {
      if (displayedRowKeys.length === 0 || displayedColNames.length === 0) {
        return;
      }

      let pos = getCellPosition(lastSelectedCell);
      if (!pos) {
        selectSingleCellAt(0, 0, false);
        pos = { rowIndex: 0, colIndex: 0 };
      }

      if (!keyboardSelectionAnchor) {
        keyboardSelectionAnchor = { rowIndex: pos.rowIndex, colIndex: pos.colIndex };
      }

      const next = {
        rowIndex: Math.min(Math.max(rowIndex, 0), displayedRowKeys.length - 1),
        colIndex: Math.min(Math.max(colIndex, 0), displayedColNames.length - 1),
      };

      applyKeyboardRangeSelection(keyboardSelectionAnchor, next);
    }

    function moveEditCellByTab(backward) {
      const pos = getCellPosition(lastSelectedCell);
      if (!pos) {
        return;
      }

      let nextRow = pos.rowIndex;
      let nextCol = pos.colIndex + (backward ? -1 : 1);
      if (nextCol >= displayedColNames.length) {
        nextCol = 0;
        nextRow += 1;
      } else if (nextCol < 0) {
        nextCol = displayedColNames.length - 1;
        nextRow -= 1;
      }

      nextRow = Math.min(Math.max(nextRow, 0), displayedRowKeys.length - 1);
      nextCol = Math.min(Math.max(nextCol, 0), displayedColNames.length - 1);
      selectSingleCellAt(nextRow, nextCol, true);
    }

    function getSelectedCellsCount() {
      let count = 0;
      selectedCells.forEach((cellSet) => {
        count += cellSet.size;
      });
      return count;
    }

    function enterEditFromCurrentSelection() {
      if (!lastSelectedCell || getSelectedCellsCount() !== 1) {
        return false;
      }

      const pos = getCellPosition(lastSelectedCell);
      if (!pos) {
        return false;
      }

      selectSingleCellAt(pos.rowIndex, pos.colIndex, true);
      return true;
    }

    function getSelectedCellsText() {
      const TAB = String.fromCharCode(9);
      const NEWLINE = String.fromCharCode(10);
      let selectedCount = 0;
      const lines = [];

      displayedRowKeys.forEach((rowKey) => {
        const row = rowKeyToRow.get(rowKey);
        const cellSet = selectedCells.get(rowKey);
        if (!row || !cellSet || cellSet.size === 0) {
          return;
        }

        const values = [];
        displayedColNames.forEach((colName) => {
          if (!cellSet.has(colName)) {
            return;
          }
          const col = columns.find((column) => column.name === colName);
          values.push(col ? toCellInputText(getEffectiveCellValue(row, col.name, row.__dbadmin_ctid), col) : '');
          selectedCount += 1;
        });

        lines.push(values.join(TAB));
      });

      return selectedCount > 1 ? lines.join(NEWLINE) : '';
    }

    function extractSelectedCellsData() {
      // Returns 2D array of selected cell values with layout info
      const data = [];
      const colNamesList = [];
      let rowCount = 0;

      displayedRowKeys.forEach((rowKey) => {
        const row = rowKeyToRow.get(rowKey);
        const cellSet = selectedCells.get(rowKey);
        if (!row || !cellSet || cellSet.size === 0) {
          return;
        }

        const rowData = [];
        displayedColNames.forEach((colName) => {
          if (!cellSet.has(colName)) {
            return;
          }
          const col = columns.find((column) => column.name === colName);
          const value = col ? getEffectiveCellValue(row, col.name, row.__dbadmin_ctid) : '';
          rowData.push(value);
          
          if (rowCount === 0) {
            colNamesList.push(colName);
          }
        });

        if (rowData.length > 0) {
          data.push(rowData);
          rowCount += 1;
        }
      });

      return { data, colNames: colNamesList, rows: rowCount, cols: colNamesList.length };
    }

    function getFocusedCellFallbackText() {
      if (activeCell) {
        const activeCol = columns.find((c) => c.name === activeCell.colName);
        if (activeCol) {
          return toCellInputText(
            getEffectiveCellValue(activeCell.row, activeCol.name, activeCell.ctid),
            activeCol
          );
        }
      }

      if (!lastSelectedCell) {
        return '';
      }

      const row = rowKeyToRow.get(lastSelectedCell.rowKey);
      const col = columns.find((c) => c.name === lastSelectedCell.colName);
      if (!row || !col) {
        return '';
      }

      return toCellInputText(getEffectiveCellValue(row, col.name, row.__dbadmin_ctid), col);
    }

    function copyDefaultSelectionToClipboard() {
      let value = '';
      if (editingCellInput) {
        value = editingCellInput.value;
        // If editing a cell, just copy its value
        clipboardData = [];
        clipboardRows = 0;
        clipboardCols = 0;
        clipboardColumnNames = [];
      } else {
        value = getSelectedCellsText();
        // Extract structured data for smart paste
        if (value) {
          const extracted = extractSelectedCellsData();
          clipboardData = extracted.data;
          clipboardRows = extracted.rows;
          clipboardCols = extracted.cols;
          clipboardColumnNames = extracted.colNames;
        } else {
          const fallbackValue = getFocusedCellFallbackText();
          value = fallbackValue;
          // Single cell fallback
          clipboardData = [[fallbackValue]];
          clipboardRows = 1;
          clipboardCols = 1;
          clipboardColumnNames = lastSelectedCell ? [lastSelectedCell.colName] : [];
        }
      }

      navigator.clipboard.writeText(value || '').catch(() => {});
    }

    function copyAdvancedToClipboard(format) {
      let payload = getSelectedCellsExportPayload();

      if (!payload.rows.length) {
        const fallbackValue = getFocusedCellFallbackText();
        payload = {
          columns: ['value'],
          rows: [{ value: fallbackValue }],
        };
      }

      vscode.postMessage({
        type: 'copyAdvancedClipboard',
        format,
        columns: payload.columns,
        rows: payload.rows,
      });
    }

    function pasteIntoEditingOrSelectedCell(value) {
      if (editingCellInput) {
        editingCellInput.value = value;
        editingCellInput.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      if (!lastSelectedCell) {
        return false;
      }

      const row = rowKeyToRow.get(lastSelectedCell.rowKey);
      const col = columns.find((c) => c.name === lastSelectedCell.colName);
      if (!row || !col) {
        return false;
      }

      const ctid = rowKeyToCtid.get(lastSelectedCell.rowKey) || null;
      const inputMap = inputElements.get(lastSelectedCell.rowKey);
      const input = inputMap ? inputMap.get(col.name) : null;
      applyCellValue(row, col, ctid, value, input || null);
      flushPendingCellHistory();
      renderSelectionState();
      return true;
    }

    function pasteIntoSelectedCells(isRaw) {
      // Smart paste: if raw mode or no clipboard data, paste as text
      if (isRaw || clipboardData.length === 0) {
        // Raw paste into single focused cell
        navigator.clipboard.readText().then((text) => {
          pasteIntoEditingOrSelectedCell(text);
        }).catch(() => {});
        return true;
      }

      // Smart paste logic
      const selectedRows = Array.from(selectedCells.keys());
      if (selectedRows.length === 0) {
        return false;
      }

      // Get first selected row and first selected column position for anchor
      const firstRowKey = selectedRows[0];
      const firstColSet = selectedCells.get(firstRowKey);
      const colNames = Array.from(firstColSet).sort((a, b) => 
        displayedColNames.indexOf(a) - displayedColNames.indexOf(b)
      );
      
      if (colNames.length === 0) {
        return false;
      }

      const firstColName = colNames[0];
      const firstColIndex = displayedColNames.indexOf(firstColName);
      const firstRowIndex = displayedRowKeys.indexOf(firstRowKey);

      if (firstColIndex === -1 || firstRowIndex === -1) {
        return false;
      }

      // Determine paste behavior
      const totalSelectedCells = Array.from(selectedCells.values())
        .reduce((sum, set) => sum + set.size, 0);

      const isSingleCellCopied = clipboardRows === 1 && clipboardCols === 1;
      const isMultipleCellsCopied = clipboardRows > 1 || clipboardCols > 1;

      let pastedCount = 0;

      if (isSingleCellCopied) {
        // Paste same value to all selected cells
        const singleValue = clipboardData[0][0];
        selectedCells.forEach((colSet, rowKey) => {
          const row = rowKeyToRow.get(rowKey);
          if (!row) return;

          colSet.forEach((colName) => {
            const col = columns.find((c) => c.name === colName);
            if (!col) return;

            const ctid = rowKeyToCtid.get(rowKey) || null;
            const inputMap = inputElements.get(rowKey);
            const input = inputMap ? inputMap.get(colName) : null;
            applyCellValue(row, col, ctid, singleValue, input || null);
            pastedCount += 1;
          });
        });
      } else if (isMultipleCellsCopied && totalSelectedCells >= clipboardRows * clipboardCols) {
        // Distribute clipboard data across selection (like Excel)
        // This works when pasting a rectangular selection into another rectangular area
        const selectedRowsArray = Array.from(selectedCells.entries());
        let pasteRowIndex = 0;

        for (const [rowKey, colSet] of selectedRowsArray) {
          if (pasteRowIndex >= clipboardRows) break;

          const row = rowKeyToRow.get(rowKey);
          if (!row) continue;

          const sortedCols = Array.from(colSet).sort((a, b) =>
            displayedColNames.indexOf(a) - displayedColNames.indexOf(b)
          );

          const clipboardRowData = clipboardData[pasteRowIndex];
          let pasteColIndex = 0;

          for (const colName of sortedCols) {
            if (pasteColIndex >= clipboardCols) break;

            const col = columns.find((c) => c.name === colName);
            if (!col) continue;

            const value = clipboardRowData[pasteColIndex];
            const ctid = rowKeyToCtid.get(rowKey) || null;
            const inputMap = inputElements.get(rowKey);
            const input = inputMap ? inputMap.get(colName) : null;
            applyCellValue(row, col, ctid, value, input || null);
            pastedCount += 1;
            pasteColIndex += 1;
          }

          pasteRowIndex += 1;
        }
      } else {
        // Fallback: tile the clipboard data if selection is larger
        const clipboard2DArray = clipboardData;
        let currentRowIndex = firstRowIndex;
        let rowsProcessed = 0;

        for (const [rowKey, colSet] of Array.from(selectedCells.entries())) {
          const rowPos = displayedRowKeys.indexOf(rowKey);
          const clipboardRowIndex = (rowPos - firstRowIndex) % clipboardRows;
          const row = rowKeyToRow.get(rowKey);
          if (!row) continue;

          const sortedCols = Array.from(colSet).sort((a, b) =>
            displayedColNames.indexOf(a) - displayedColNames.indexOf(b)
          );

          const clipboardRowData = clipboard2DArray[clipboardRowIndex] || [];
          let colIndex = 0;

          for (const colName of sortedCols) {
            const colPos = displayedColNames.indexOf(colName);
            const clipboardColIndex = (colPos - firstColIndex) % clipboardCols;
            const value = clipboardRowData[clipboardColIndex];

            const col = columns.find((c) => c.name === colName);
            if (col && typeof value !== 'undefined') {
              const ctid = rowKeyToCtid.get(rowKey) || null;
              const inputMap = inputElements.get(rowKey);
              const input = inputMap ? inputMap.get(colName) : null;
              applyCellValue(row, col, ctid, value, input || null);
              pastedCount += 1;
            }
            colIndex += 1;
          }
          rowsProcessed += 1;
        }
      }

      if (pastedCount > 0) {
        flushPendingCellHistory();
        renderSelectionState();
        return true;
      }

      return false;
    }

    function render() {
      const displayColumns = getDisplayColumns();
      const visibleRows = applyLocalFilter(rows);

      if (displayColumns.length === 0) {
        rowKeyToRow.clear();
        rowKeyToCtid.clear();
        trElements.clear();
        selectionTdElements.clear();
        inputElements.clear();
        tdElements.clear();
        displayedRowKeys = [];
        displayedColNames = [];
        gridEl.innerHTML = '';
        rangeSelectionOverlay.style.display = 'none';
        return;
      }

      const head = document.createElement('thead');
      const headRow = document.createElement('tr');

      // Empty selection column header
      const selectTh = document.createElement('th');
      selectTh.className = 'selection-col';
      selectTh.textContent = '';
      selectTh.style.cursor = 'pointer';
      selectTh.addEventListener('click', () => {
        selectAllDisplayedCells();
      });
      headRow.appendChild(selectTh);

      displayColumns.forEach((col) => {
        const th = document.createElement('th');
        th.setAttribute('data-column-name', col.name);
        const savedWidth = columnWidthByName.get(col.name);
        if (typeof savedWidth === 'number' && Number.isFinite(savedWidth) && savedWidth > 0) {
          th.style.width = savedWidth + 'px';
          th.style.minWidth = savedWidth + 'px';
          th.style.maxWidth = savedWidth + 'px';
        } else {
          const defaultWidth = getDefaultColumnWidth(col, visibleRows);
          th.style.width = defaultWidth + 'px';
          th.style.minWidth = defaultWidth + 'px';
          th.style.maxWidth = defaultWidth + 'px';
        }

        const title = document.createElement('div');
        title.className = 'th-title';
        title.draggable = true;

        const left = document.createElement('span');
        left.className = 'th-name';
        left.textContent = col.name;

        // Click on column header (without drag) selects entire column
        left.addEventListener('click', (event) => {
          if (draggedColumnName) {
            return;
          }
          event.stopPropagation();

          const displayedRows = applyLocalFilter(rows);
          const currentIdx = displayedColNames.indexOf(col.name);

          // Ctrl+click: alternar (toggle) coluna
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
            colSelectionAnchorName = col.name;
            currentRangeSelection = null;
            const isFullySelected = displayedRows.every((row, ri) => {
              const rk = row.__dbadmin_ctid || ('new:' + ri);
              return selectedCells.has(rk) && selectedCells.get(rk).has(col.name);
            });
            if (isFullySelected) {
              displayedRows.forEach((row, ri) => {
                const rk = row.__dbadmin_ctid || ('new:' + ri);
                if (selectedCells.has(rk)) {
                  selectedCells.get(rk).delete(col.name);
                  if (selectedCells.get(rk).size === 0) {
                    selectedCells.delete(rk);
                  }
                }
              });
            } else {
              displayedRows.forEach((row, ri) => {
                const rk = row.__dbadmin_ctid || ('new:' + ri);
                if (!selectedCells.has(rk)) {
                  selectedCells.set(rk, new Set());
                }
                selectedCells.get(rk).add(col.name);
                lastSelectedCell = { rowKey: rk, colName: col.name };
              });
            }
            syncSelectionCountsFromSelectedCells();
            renderSelectionState();
            return;
          }

          // Shift+click: estender range de colunas
          if (event.shiftKey && colSelectionAnchorName !== null) {
            const anchorIdx = displayedColNames.indexOf(colSelectionAnchorName);
            if (anchorIdx !== -1 && currentIdx !== -1) {
              const minC = Math.min(anchorIdx, currentIdx);
              const maxC = Math.max(anchorIdx, currentIdx);
              selectedCells.clear();
              displayedRows.forEach((row, ri) => {
                const rk = row.__dbadmin_ctid || ('new:' + ri);
                const colSet = new Set();
                for (let c = minC; c <= maxC; c++) {
                  colSet.add(displayedColNames[c]);
                }
                selectedCells.set(rk, colSet);
                lastSelectedCell = { rowKey: rk, colName: col.name };
              });
              currentRangeSelection = {
                anchor: { rowIndex: 0, colIndex: anchorIdx },
                focus: { rowIndex: Math.max(0, displayedRowKeys.length - 1), colIndex: currentIdx },
              };
              syncSelectionCountsFromSelectedCells();
              renderSelectionState();
              return;
            }
          }

          // Clique normal: selecionar coluna inteira
          colSelectionAnchorName = col.name;
          selectedCells.clear();
          displayedRows.forEach((row, ri) => {
            const rk = row.__dbadmin_ctid || ('new:' + ri);
            if (!selectedCells.has(rk)) {
              selectedCells.set(rk, new Set());
            }
            selectedCells.get(rk).add(col.name);
            lastSelectedCell = { rowKey: rk, colName: col.name };
          });
          currentRangeSelection = currentIdx !== -1 ? {
            anchor: { rowIndex: 0, colIndex: currentIdx },
            focus: { rowIndex: Math.max(0, displayedRowKeys.length - 1), colIndex: currentIdx },
          } : null;
          syncSelectionCountsFromSelectedCells();
          renderSelectionState();
        });

        title.addEventListener('dragstart', (event) => {
          draggedColumnName = col.name;
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', col.name);
          }
        });
        title.addEventListener('dragend', () => {
          draggedColumnName = null;
          gridEl.querySelectorAll('th.col-drag-over').forEach((node) => node.classList.remove('col-drag-over'));
        });

        th.addEventListener('dragover', (event) => {
          if (!draggedColumnName || draggedColumnName === col.name) {
            return;
          }
          event.preventDefault();
          th.classList.add('col-drag-over');
        });

        th.addEventListener('dragleave', () => {
          th.classList.remove('col-drag-over');
        });

        th.addEventListener('drop', (event) => {
          if (!draggedColumnName || draggedColumnName === col.name) {
            return;
          }
          event.preventDefault();
          th.classList.remove('col-drag-over');
          reorderColumnNames(draggedColumnName, col.name);
          if (columnsPopup.classList.contains('open')) {
            renderColumnsPopupList();
          }
          render();
        });

        const right = document.createElement('span');
        right.className = 'th-icons';
        right.title = 'Ordenar';
        right.innerHTML = state.sortColumn === col.name
          ? (state.sortDirection === 'desc' ? ICON_SORT_DESC : ICON_SORT_ASC)
          : ICON_SORT_NONE;
        right.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (state.sortColumn !== col.name) {
            state.sortColumn = col.name;
            state.sortDirection = 'asc';
          } else if (state.sortDirection === 'asc') {
            state.sortDirection = 'desc';
          } else {
            state.sortColumn = undefined;
            state.sortDirection = undefined;
          }
          persistCurrentState();
          reloadTableViewClearingSelection();
        });
        right.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          showSortMenu(event.clientX, event.clientY, col.name);
        });

        title.appendChild(left);
        title.appendChild(right);

        const filterInput = document.createElement('input');
        filterInput.className = 'th-filter';
        filterInput.setAttribute('data-col-name', col.name);
        filterInput.placeholder = col.dataType;
        filterInput.value = state.columnFilters[col.name] || '';
        filterInput.addEventListener('input', () => {
          const value = filterInput.value;
          if (value.length > 0) {
            state.columnFilters[col.name] = value;
          } else {
            delete state.columnFilters[col.name];
          }
          syncClearFiltersButton();
          persistCurrentState();

          if (state.searchMode === 'local') {
            rememberColumnFocus(col.name, filterInput);
            rerenderTableViewClearingSelection();
            restorePendingFocus();
          }
        });
        filterInput.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') {
            return;
          }
          const value = filterInput.value;
          if (value.length > 0) {
            state.columnFilters[col.name] = value;
          } else {
            delete state.columnFilters[col.name];
          }
          syncClearFiltersButton();
          state.page = 1;
          persistCurrentState();
          rememberColumnFocus(col.name, filterInput);

          if (state.searchMode === 'query') {
            reloadTableViewClearingSelection();
          } else {
            rerenderTableViewClearingSelection();
            restorePendingFocus();
          }
        });

        const filterWrap = document.createElement('div');
        filterWrap.className = 'th-filter-wrap';
        filterWrap.appendChild(filterInput);

        th.appendChild(title);
        th.appendChild(filterWrap);

        const resizer = document.createElement('div');
        resizer.className = 'th-resizer';
        resizer.title = 'Redimensionar coluna';
        resizer.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const startWidth = th.getBoundingClientRect().width;
          columnResizeState = {
            columnName: col.name,
            startX: event.clientX,
            startWidth,
            th,
          };
          draggedColumnName = null;
          document.body.classList.add('col-resizing');
        });
        resizer.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const defaultWidth = getDefaultColumnWidth(col, visibleRows);
          columnResizeState = null;
          document.body.classList.remove('col-resizing');
          columnWidthByName.delete(col.name);
          th.style.width = defaultWidth + 'px';
          th.style.minWidth = defaultWidth + 'px';
          th.style.maxWidth = defaultWidth + 'px';
          renderSelectionState();
          notifyLayoutChanged();
        });

        th.appendChild(resizer);
        headRow.appendChild(th);
      });

      // Coluna de preenchimento para manter o visual do header no espaco vazio.
      const fillTh = document.createElement('th');
      fillTh.className = 'fill-col';
      fillTh.setAttribute('aria-hidden', 'true');
      headRow.appendChild(fillTh);

      head.appendChild(headRow);

      const body = document.createElement('tbody');
      body.classList.add('table-cells-body');
      rowKeyToRow.clear();
      rowKeyToCtid.clear();
      trElements.clear();
      selectionTdElements.clear();
      inputElements.clear();
      tdElements.clear();
      displayedRowKeys = [];
      displayedColNames = displayColumns.map((c) => c.name);

      visibleRows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        const ctid = row.__dbadmin_ctid;
        const rowKey = ctid || ('new:' + rowIndex);
        rowKeyToRow.set(rowKey, row);
        rowKeyToCtid.set(rowKey, ctid || null);
        trElements.set(rowKey, tr);
        inputElements.set(rowKey, new Map());
        tdElements.set(rowKey, new Map());
        displayedRowKeys.push(rowKey);
        const isRemoved = ctid ? removedCtids.has(ctid) : Boolean(row.__dbadmin_removed);
        const isInserted = !ctid && Boolean(row.__dbadmin_inserted);
        const rowSelection = selectedCells.get(rowKey);
        const isRowSelected = Boolean(rowSelection && rowSelection.size > 0);

        if (isRemoved) {
          tr.classList.add('row-removed');
        } else if (isInserted) {
          tr.classList.add('row-added');
        }
        if (isRemoved) {
          tr.classList.add('row-marked-delete');
        }

        // Empty selection column cell: click/drag selects full row(s)
        const selectTd = document.createElement('td');
        selectTd.className = 'selection-col selection-cell';
        if (isRowSelected) {
          selectTd.classList.add('selected');
        }
        const rowNumberEl = document.createElement('span');
        rowNumberEl.className = 'selection-cell-index';
        rowNumberEl.textContent = String(((Math.max(1, Number(state.page || 1)) - 1) * Math.max(1, Number(state.limit || ${defaultPageSize}))) + rowIndex + 1);
        selectTd.appendChild(rowNumberEl);
        selectionTdElements.set(rowKey, selectTd);
        selectTd.addEventListener('mousedown', (event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          focusGridSurface();
          isRowSelectionDragging = true;
          rowSelectionDragPreserve = event.ctrlKey || event.metaKey;
          const rowSelectableColumns = getRowSelectableColumnNames(rowKey);
          if (event.shiftKey && rowShiftSelectAnchorIndex !== null) {
            // Estende range da âncora persistente até este row
            rowSelectionDragAnchorIndex = rowShiftSelectAnchorIndex;
            rowSelectionDragBaseSelection = new Map();
            applyRowSelectionDragRange(rowIndex, displayColumns);
          } else {
            rowShiftSelectAnchorIndex = rowIndex;
            rowSelectionDragAnchorIndex = rowIndex;
            rowSelectionDragBaseSelection = rowSelectionDragPreserve ? cloneSelectionMap(selectedCells) : new Map();
            if (rowSelectionDragPreserve) {
              selectedCells.set(rowKey, new Set(rowSelectableColumns));
              setSingleRowRangeSelection(rowKey, rowSelectableColumns);
              syncSelectionCountsFromSelectedCells();
              if (rowSelectableColumns.length > 0) {
                lastSelectedCell = { rowKey, colName: rowSelectableColumns[0] };
              }
              renderSelectionState();
            } else {
              selectRow(rowKey, displayColumns, false);
              renderSelectionState();
            }
          }
        });
        selectTd.addEventListener('mouseenter', () => {
          if (!isRowSelectionDragging) {
            return;
          }
          applyRowSelectionDragRange(rowIndex, displayColumns);
        });
        tr.appendChild(selectTd);

        displayColumns.forEach((col, colIndex) => {
          const td = document.createElement('td');
          const input = document.createElement('input');
          input.className = 'cell-input';
          input.readOnly = true;
          input.tabIndex = -1;
          input.setAttribute('data-row-key', rowKey);
          input.setAttribute('data-col-name', col.name);
          inputElements.get(rowKey).set(col.name, input);
          tdElements.get(rowKey).set(col.name, td);

          const baseCurrent = row[col.name];
          const baseCurrentText = toCellInputText(baseCurrent, col);
          const effectiveCurrent = getEffectiveCellValue(row, col.name, ctid);
          input.value = toCellInputText(effectiveCurrent, col);
          updateCellInputPlaceholder(input, effectiveCurrent);

          if (isPreviewableColumn(col) || isFkColumn(col)) {
            td.classList.add('json-cell');
          }

          if (ctid && editedRows.has(ctid) && Object.prototype.hasOwnProperty.call(editedRows.get(ctid), col.name)) {
            input.classList.add('dirty');
          }
          if (rowSelection && rowSelection.has(col.name)) {
            td.classList.add('cell-selected');
          }

          input.addEventListener('input', () => {
            if (ctid) {
              if (input.value === baseCurrentText) {
                if (editedRows.has(ctid)) {
                  const values = editedRows.get(ctid);
                  delete values[col.name];
                  if (Object.keys(values).length === 0) {
                    editedRows.delete(ctid);
                  }
                }
                input.classList.remove('dirty');
              } else {
                if (!editedRows.has(ctid)) {
                  editedRows.set(ctid, {});
                }
                editedRows.get(ctid)[col.name] = input.value;
                input.classList.add('dirty');
              }
            } else {
              row[col.name] = input.value;
            }
            updateCellInputPlaceholder(input, input.value);
            updateSaveButtonState();
          });

          // Mousedown selects immediately (no delay)
          td.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
              beginContextMenuGesture();
              event.preventDefault();
              event.stopPropagation();
            }
          });

          td.addEventListener('mousedown', (event) => {
            // Right/middle click must not change cell selection (context menu uses button 2).
            if (event.button !== 0 || Date.now() < suppressCellSelectionUntil) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (event.detail >= 2) {
              // Let dblclick handle it; don't interfere
              return;
            }
            event.stopPropagation();
            isDragging = true;
            focusGridSurface();

            const anchorPosition = getSelectionAnchorPosition();
            if (event.shiftKey && anchorPosition) {
              isDragging = false;
              dragAnchor = null;
              keyboardSelectionAnchor = {
                rowIndex: anchorPosition.rowIndex,
                colIndex: anchorPosition.colIndex,
              };
              applyKeyboardRangeSelection(keyboardSelectionAnchor, { rowIndex, colIndex });
              return;
            }

            dragAnchor = { rowIndex, colIndex };
            const currentCellSet = selectedCells.get(rowKey);
            const isAlreadySelected = Boolean(currentCellSet && currentCellSet.has(col.name));

            if (event.ctrlKey || event.metaKey) {
              const baseCounts = selectedCellCounts.size > 0
                ? selectedCellCounts
                : selectionCountsFromSelectionMap(selectedCells);
              cellDragMode = isAlreadySelected ? 'remove' : 'add';
              cellDragBaseCounts = cloneSelectionCounts(baseCounts);
              keyboardSelectionAdditive = cellDragMode === 'add';
              if (keyboardSelectionAdditive) {
                keyboardSelectionBase = cloneSelectionMap(selectedCells);
              }
            } else {
              cellDragMode = 'replace';
              cellDragBaseCounts = new Map();
              keyboardSelectionAdditive = false;
              keyboardSelectionBase = new Map();
            }

            keyboardSelectionAnchor = { rowIndex, colIndex };
            applyCellDragRange(rowIndex, colIndex);

            if (keyboardSelectionAdditive) {
              keyboardSelectionBase = cloneSelectionMap(selectedCells);
            }
          });

          td.addEventListener('mouseenter', () => {
            if (!isDragging || !dragAnchor || Date.now() < suppressCellSelectionUntil) {
              return;
            }
            applyCellDragRange(rowIndex, colIndex);
          });

          // Double click: clear selection and enter edit mode
          td.addEventListener('dblclick', (event) => {
            if (event.target.closest('.cell-action-btn')) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            event.stopPropagation();
            if (editingCellInput === input && input.classList.contains('editing')) {
              return;
            }
            selectedCells.clear();
            lastSelectedCell = { rowKey, colName: col.name };
            renderSelectionState();
            input.readOnly = false;
            enableCellEditing(input);
          });

          input.addEventListener('keydown', (event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              disableCellEditing(input);
              moveEditCellByTab(event.shiftKey);
              return;
            }
            if (event.key === 'Escape' || event.key === 'Enter') {
              event.preventDefault();
              disableCellEditing(input);
              renderSelectionState();
            }
          });

          input.addEventListener('blur', () => {
            if (input === editingCellInput) {
              const initialValue = input.getAttribute('data-edit-initial-value');
              if (initialValue !== null && initialValue !== input.value) {
                const inputRowKey = input.getAttribute('data-row-key');
                const inputColName = input.getAttribute('data-col-name');
                if (inputRowKey && inputColName) {
                  queueCellHistoryChange({
                    rowKey: inputRowKey,
                    colName: inputColName,
                    beforeValue: initialValue,
                    afterValue: input.value,
                  });
                  flushPendingCellHistory();
                }
              }
              disableCellEditing(input);
            }
          });

          input.addEventListener('mousedown', (event) => {
            if (event.button !== 0 || Date.now() < suppressCellSelectionUntil) {
              beginContextMenuGesture();
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (input.classList.contains('editing')) {
              // Keep text-selection interactions inside the input without triggering td drag-selection.
              event.stopPropagation();
            }
          });

          input.addEventListener('click', (event) => {
            if (!input.classList.contains('editing')) {
              event.preventDefault();
              event.stopPropagation();
            }
          });

          input.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            activeCell = { input, colName: col.name, ctid, row };
            finishContextMenuGesture();
            selectCellForContextMenuIfNeeded(rowKey, col.name, rowIndex, colIndex);
            showContextMenu(event.clientX, event.clientY);
          });

          td.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            activeCell = { input, colName: col.name, ctid, row };
            finishContextMenuGesture();
            selectCellForContextMenuIfNeeded(rowKey, col.name, rowIndex, colIndex);
            showContextMenu(event.clientX, event.clientY);
          });

          td.addEventListener('mouseenter', () => {
            if (!isNumericColumn(col)) {
              td.title = '';
              return;
            }
            const cellValue = getEffectiveCellValue(row, col.name, ctid);
            const tooltip = getUnixTimestampTooltip(cellValue);
            if (tooltip) {
              td.title = tooltip;
            } else {
              td.title = '';
            }
          });

          td.appendChild(input);

          if (isBooleanType(col) && !readOnlyResultMode) {
            td.classList.add('has-bool-toggle');
            const boolToggleBtn = document.createElement('button');
            boolToggleBtn.type = 'button';
            boolToggleBtn.className = 'cell-bool-toggle-btn cell-action-btn';
            boolToggleBtn.setAttribute('aria-label', 'Alternar valor booleano');
            boolToggleBtn.innerHTML = '<span class="bool-toggle-box"><i class="codicon codicon-check" aria-hidden="true"></i></span>';
            syncBooleanToggleButton(boolToggleBtn, effectiveCurrent);
            boolToggleBtn.addEventListener('mousedown', (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            boolToggleBtn.addEventListener('dblclick', (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            boolToggleBtn.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              const currentValue = getEffectiveCellValue(row, col.name, ctid);
              const nextValue = !parseBooleanCellValue(currentValue);
              applyCellValue(row, col, ctid, nextValue, input);
              syncBooleanToggleButton(boolToggleBtn, nextValue);
            });
            td.appendChild(boolToggleBtn);
          }

          if (isFkColumn(col)) {
            const openFkBtn = document.createElement('button');
            openFkBtn.type = 'button';
            openFkBtn.className = 'json-open-btn cell-action-btn';
            openFkBtn.title = 'Abrir tabela relacionada';
            openFkBtn.setAttribute('aria-label', 'Abrir tabela relacionada');
            openFkBtn.innerHTML = ICON_GO_TO_FILE;
            openFkBtn.addEventListener('mousedown', (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            openFkBtn.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              openForeignKeyTarget(col, row, ctid);
            });
            td.appendChild(openFkBtn);
          } else if (isPreviewableColumn(col)) {
            const openJsonBtn = document.createElement('button');
            openJsonBtn.type = 'button';
            openJsonBtn.className = 'json-open-btn cell-action-btn';
            openJsonBtn.title = 'Abrir conteúdo';
            openJsonBtn.setAttribute('aria-label', 'Abrir conteúdo');
            openJsonBtn.innerHTML = ICON_ZOOM_IN;
            openJsonBtn.addEventListener('mousedown', (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            openJsonBtn.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              openJsonModal(col, getEffectiveCellValue(row, col.name, ctid), row, ctid, input);
            });
            td.appendChild(openJsonBtn);
          }

          tr.appendChild(td);
        });

        const fillTd = document.createElement('td');
        fillTd.className = 'fill-col';
        fillTd.setAttribute('aria-hidden', 'true');
        tr.appendChild(fillTd);

        body.appendChild(tr);
      });

      gridEl.innerHTML = '';
      gridEl.appendChild(head);
      gridEl.appendChild(body);
    }

    function applyLocalFilter(rawRows) {
      if (state.searchMode !== 'local') {
        return rawRows;
      }

      const textSuperRaw = String(state.searchText || '');
      const textRaw = String(state.searchText || '').trim();
      const text = textRaw.toLowerCase();
      const columnsByName = new Map(columns.map((col) => [col.name, col]));
      const parseNullFilterToken = (value) => {
        if (value === 'NULL') {
          return 'null';
        }
        if (value === 'NOT NULL') {
          return 'not-null';
        }
        return null;
      };
      const matchesNullFilter = (value, nullFilter) => {
        const isNull = value === null || value === undefined;
        return nullFilter === 'null' ? isNull : !isNull;
      };

      const globalNullFilter = parseNullFilterToken(textSuperRaw);
      const globalAdvancedMatchers =
        textRaw.length > 0
          ? columns
              .map((col) => ({
                column: col,
                matcher: buildAdvancedFilterMatcher(col, textRaw),
              }))
              .filter((entry) => Boolean(entry.matcher))
          : [];

      const columnFilters = Object.entries(state.columnFilters)
        .map(([columnName, value]) => {
          const rawValue = String(value || '').trim();
          const column = columnsByName.get(columnName);
          return {
            columnName,
            rawValue,
            lowerValue: rawValue.toLowerCase(),
            nullFilter: parseNullFilterToken(rawValue),
            advancedMatcher: column ? buildAdvancedFilterMatcher(column, rawValue) : null,
          };
        })
        .filter((entry) => entry.rawValue.length > 0);

      return rawRows.filter((row) => {
        const ctid = row.__dbadmin_ctid || null;
        const matchesGlobal =
          text.length === 0
            ? true
            : globalNullFilter
              ? columns.some((col) =>
                  matchesNullFilter(getEffectiveCellValue(row, col.name, ctid), globalNullFilter)
                )
              : globalAdvancedMatchers.length > 0
                ? globalAdvancedMatchers.some((entry) =>
                    entry.matcher(getEffectiveCellValue(row, entry.column.name, ctid))
                  )
              : columns.some((col) =>
                  toCellInputText(getEffectiveCellValue(row, col.name, ctid), col)
                    .toLowerCase()
                    .includes(text)
                );

        if (!matchesGlobal) {
          return false;
        }

        if (columnFilters.length === 0) {
          return true;
        }

        return columnFilters.every(({ columnName, lowerValue, nullFilter, advancedMatcher }) => {
          const col = columnsByName.get(columnName);
          const cellValue = getEffectiveCellValue(row, columnName, ctid);

          if (nullFilter) {
            return matchesNullFilter(cellValue, nullFilter);
          }

          if (advancedMatcher) {
            return advancedMatcher(cellValue);
          }

          const cellText = col
            ? toCellInputText(cellValue, col)
            : String(cellValue ?? '');
          return cellText.toLowerCase().includes(lowerValue);
        });
      });
    }

    function save() {
      if (readOnlyResultMode) {
        return;
      }

      if (!hasChanges()) {
        return;
      }

      const updates = [];
      editedRows.forEach((values, ctid) => {
        if (!removedCtids.has(ctid)) {
          updates.push({ ctid, values });
        }
      });

      const inserts = insertedRows
        .filter((row) => !row.__dbadmin_removed)
        .map((row) => {
          const clone = { ...row };
          delete clone.__dbadmin_inserted;
          delete clone.__dbadmin_removed;
          return clone;
        });

      vscode.postMessage({
        type: 'save',
        state: currentState(),
        payload: { updates, inserts, deletes: Array.from(removedCtids) },
      });
      beginLoading();
    }

    searchInputEl.addEventListener('input', (event) => {
      state.searchText = event.target.value;
      updateSearchContextPlaceholder();
      syncClearFiltersButton();
      persistCurrentState();
      if (state.searchMode === 'local') {
        rerenderTableViewClearingSelection();
      }
    });

    searchInputEl.addEventListener('focus', () => {
      syncSearchWrapState();
    });

    searchInputEl.addEventListener('blur', () => {
      syncSearchWrapState();
    });

    searchInputEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }

      state.searchText = event.target.value;
      syncClearFiltersButton();
      persistCurrentState();
      if (state.searchMode === 'query') {
        rememberSearchFocus();
        state.page = 1;
        persistCurrentState();
        reloadTableViewClearingSelection();
      } else {
        rerenderTableViewClearingSelection();
      }
    });

    // Prevent duplicate paste in global search when grid selection should receive Ctrl+V.
    searchInputEl.addEventListener('paste', (event) => {
      if (currentView !== 'data') {
        return;
      }

      if (!isSearchInputFocused()) {
        return;
      }

      if (!(editingCellInput || lastSelectedCell)) {
        return;
      }

      const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
      if (!pasteIntoEditingOrSelectedCell(text)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    });

    modeDropdown.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (readOnlyResultMode) {
          closeModeDropdown();
          return;
        }
        state.searchMode = btn.getAttribute('data-mode');
        closeModeDropdown();
        updateModeIcon();
        syncClearFiltersButton();
        state.page = 1;
        persistCurrentState();
        if (state.searchMode === 'query') {
          reloadTableViewClearingSelection();
        } else {
          rerenderTableViewClearingSelection();
        }
      });
    });

    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modeDropdownOverlay.toggle({ anchorEl: modeBtn });
    });

    columnsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      columnsSearch.value = columnsSearchText;
      renderColumnsPopupList();
      columnsPopupOverlay.toggle({ anchorEl: columnsBtn });
    });

    columnsSearch.addEventListener('input', () => {
      columnsSearchText = columnsSearch.value || '';
      renderColumnsPopupList();
      columnsPopupOverlay.reposition();
    });

    clearFiltersBtn?.addEventListener('click', () => {
      state.searchText = '';
      state.columnFilters = {};
      state.page = 1;

      const searchInput = document.getElementById('search');
      if (searchInput) {
        searchInput.value = '';
      }
      updateSearchContextPlaceholder();
      persistCurrentState();

      if (state.searchMode === 'query') {
        reloadTableViewClearingSelection();
      } else {
        rerenderTableViewClearingSelection();
      }

      syncClearFiltersButton();
    });

    window.addEventListener('resize', () => {
      updateSearchContextPlaceholder();
      overlayControllers.forEach((overlay) => overlay.reposition());
      renderSelectionState();
    });

    tableWrapEl.addEventListener('scroll', () => {
      if (currentRangeSelection) {
        renderSelectionState();
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      const selectionOverlayResizeObserver = new ResizeObserver(() => {
        renderSelectionState();
      });
      selectionOverlayResizeObserver.observe(document.documentElement);
      selectionOverlayResizeObserver.observe(tableWrapEl);
    }

    jsonModalClose.addEventListener('click', () => {
      closeJsonModal();
    });

    jsonModalApply.addEventListener('click', () => {
      applyJsonModalChanges(true);
    });

    jsonModalOpenNative.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openJsonInNativeEditor',
        columnName: currentJsonModalPayload.columnName,
        isJson: true,
        content: codeEditor.getValue(),
        ctid: currentJsonModalPayload.ctid,
      });
      closeJsonModal();
    });

    jsonModalBackdrop.addEventListener('click', () => {
      closeJsonModal();
    });

    exportModalCancel.addEventListener('click', () => {
      closeExportModal();
    });

    exportModalConfirm.addEventListener('click', () => {
      const format = exportFormatCsv.checked ? 'csv' : 'json';
      const dataScope = exportDataAll.checked
        ? 'all'
        : (exportDataSelected.checked ? 'selected' : 'result');

      let payload = { columns: [], rows: [] };
      if (dataScope === 'result') {
        payload = getResultExportPayload();
      } else if (dataScope === 'selected') {
        payload = getSelectedCellsExportPayload();
      }

      vscode.postMessage({
        type: 'exportData',
        format,
        dataScope,
        state: currentState(),
        columns: payload.columns,
        rows: payload.rows,
      });

      closeExportModal();
      closeHeaderMenu();
    });

    exportModalBackdrop.addEventListener('click', () => {
      closeExportModal();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
        return;
      }

      if (jsonModal.classList.contains('open')) {
        closeJsonModal();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (queryModal && queryModal.classList.contains('open')) {
        closeQueryModal();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (exportModal.classList.contains('open')) {
        closeExportModal();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const closedAny = overlayControllers.some((overlay) => overlay.isOpen());
      closeAllOverlays();

      if (closedAny) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    document.addEventListener('mousedown', (event) => {
      const openedAny = overlayControllers.some((overlay) => overlay.isOpen());
      if (!openedAny) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('.overlay-surface')) {
        return;
      }

      if (target.closest('.table-wrap')) {
        return;
      }

      closeAllOverlays();
    });


    toolbarMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      headerMenuOverlay.toggle({ anchorEl: toolbarMenuBtn });
    });

    document.getElementById('reload').addEventListener('click', () => {
      reloadTableViewClearingSelection({ clearSelectionAndPreview: true });
    });

    document.getElementById('save').addEventListener('click', () => save());

    document.getElementById('newRow').addEventListener('click', () => {
      const row = { __dbadmin_inserted: true, __dbadmin_removed: false };
      columns.forEach((column) => {
        row[column.name] = '';
      });
      insertedRows.push(row);
      rows = [...rows, row];
      render();
      updateSaveButtonState();
    });

    document.getElementById('prevPage').addEventListener('click', () => {
      if (state.page <= 1) {
        return;
      }
      state.page -= 1;
      persistCurrentState();
      reloadTableViewClearingSelection();
    });

    document.getElementById('nextPage').addEventListener('click', () => {
      const pageSize = Math.max(1, Number(state.limit || ${defaultPageSize}));
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      if (state.page >= totalPages) {
        return;
      }
      state.page += 1;
      persistCurrentState();
      reloadTableViewClearingSelection();
    });

    pageInfoBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      paginationMenuOverlay.toggle({ anchorEl: pageInfoBtn });
    });

    paginationLimitInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (applyPaginationMenuValues()) {
          closePaginationMenu();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closePaginationMenu();
      }
    });

    paginationPageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (applyPaginationMenuValues()) {
          closePaginationMenu();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closePaginationMenu();
      }
    });

    paginationLimitInput.addEventListener('change', () => {
      const parsed = sanitizePageSizeInput(paginationLimitInput.value);
      if (parsed !== null) {
        paginationLimitInput.value = String(parsed);
      }
    });

    paginationPageInput.addEventListener('change', () => {
      const pageSize = sanitizePageSizeInput(paginationLimitInput.value) ?? state.limit;
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      const normalized = normalizeRequestedPage(paginationPageInput.value, totalPages);
      if (normalized !== null) {
        paginationPageInput.value = String(normalized);
      }
    });

    document.getElementById('openNewTab').addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'openInNewTab' });
    });

    document.getElementById('openSettings').addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'openSettings' });
    });

    openExportBtn.addEventListener('click', () => {
      closeHeaderMenu();
      openExportModal();
    });

    document.getElementById('showInExplorer').addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'showInExplorer' });
    });

    showQueryModalBtn?.addEventListener('click', () => {
      openQueryModal();
    });

    openConnectionManagerBtn?.addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'openConnectionManager' });
    });

    queryModalClose?.addEventListener('click', () => {
      closeQueryModal();
    });

    queryModalBackdrop?.addEventListener('click', () => {
      closeQueryModal();
    });

    queryModalCopy?.addEventListener('click', async () => {
      const value = String(queryCodeEditor?.getValue() || '');
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const textarea = document.getElementById('queryCodeEditorTextarea');
        if (textarea instanceof HTMLTextAreaElement) {
          textarea.select();
          document.execCommand('copy');
        }
      }
    });

    const toggleIntegratedTableBtn = document.getElementById('toggleIntegratedTable');
    if (toggleIntegratedTableBtn) {
      toggleIntegratedTableBtn.addEventListener('click', () => {
        integratedTableMode = !integratedTableMode;
        applyIntegratedTableCheck();
        vscode.postMessage({ type: 'toggleIntegratedTable' });
      });
    }

    resetLayoutBtn.addEventListener('click', () => {
      closeHeaderMenu();
      resetColumnLayoutToDefault();
    });

    queryEl?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      if (readOnlyResultMode) {
        reloadTableViewClearingSelection();
        return;
      }
      state.searchMode = 'query';
      updateModeIcon();
      state.page = 1;
      persistCurrentState();
      reloadTableViewClearingSelection();
    });

    queryResizer?.addEventListener('mousedown', (event) => {
      event.preventDefault();
      queryResizeState = {
        startY: event.clientY,
        startHeight: queryEl.offsetHeight,
      };
    });

    const endDrag = () => {
      queryResizeState = null;
    };

    window.addEventListener('mousemove', (event) => {
      if (columnResizeState) {
        const nextWidth = Math.max(
          80,
          Math.round(columnResizeState.startWidth + (event.clientX - columnResizeState.startX))
        );
        columnWidthByName.set(columnResizeState.columnName, nextWidth);
        columnResizeState.th.style.width = nextWidth + 'px';
        columnResizeState.th.style.minWidth = nextWidth + 'px';
        columnResizeState.th.style.maxWidth = nextWidth + 'px';
        renderSelectionState();
        return;
      }

      if (!queryResizeState) {
        return;
      }

      const nextHeight = Math.max(28, queryResizeState.startHeight + (event.clientY - queryResizeState.startY));
      if (queryEl) {
        queryEl.style.height = nextHeight + 'px';
      }
    });

    const endColumnResize = () => {
      const hadResize = Boolean(columnResizeState);
      columnResizeState = null;
      document.body.classList.remove('col-resizing');
      if (hadResize) {
        notifyLayoutChanged();
      }
    };

    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', () => {
      if (shouldIgnoreTransientBlur()) {
        restoreFocusAfterTransientBlur();
        return;
      }
      endDrag();
    });
    window.addEventListener('mouseleave', endDrag);
    window.addEventListener('mouseup', () => {
      isDragging = false;
      dragAnchor = null;
      cellDragMode = 'replace';
      cellDragBaseCounts = new Map();
      isRowSelectionDragging = false;
      rowSelectionDragPreserve = false;
      rowSelectionDragAnchorIndex = null;
      rowSelectionDragBaseSelection = new Map();
    });
    window.addEventListener('blur', () => {
      if (shouldIgnoreTransientBlur()) {
        restoreFocusAfterTransientBlur();
        return;
      }
      closeAllOverlays();
    });
    window.addEventListener('mouseup', endColumnResize);
    window.addEventListener('blur', () => {
      if (shouldIgnoreTransientBlur()) {
        restoreFocusAfterTransientBlur();
        return;
      }
      endColumnResize();
    });
    window.addEventListener('mouseleave', endColumnResize);
    document.addEventListener('visibilitychange', endDrag);
    document.addEventListener('pointerleave', endDrag);
    document.addEventListener('visibilitychange', endColumnResize);
    document.addEventListener('pointerleave', endColumnResize);

    // Disable native browser context menu in the webview to keep custom UX flow.
    document.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    // Keyboard handlers for data grid interactions only.
    document.addEventListener('keydown', (event) => {
      if (currentView !== 'data') {
        return;
      }

      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      const key = String(event.key || '').toLowerCase();
      const textInputFocusedOutsideGridEditing = isTextInputFocusedOutsideGridEditing();

      if (isCtrlOrMeta && !event.altKey && !event.shiftKey && key === 's') {
        event.preventDefault();
        save();
        return;
      }

      if (isCtrlOrMeta && !event.altKey && !event.shiftKey && key === 'a') {
        if (shouldHandleGridSelectAllShortcut(event)) {
          event.preventDefault();
          event.stopPropagation();
          const selection = window.getSelection ? window.getSelection() : null;
          if (selection && typeof selection.removeAllRanges === 'function') {
            selection.removeAllRanges();
          }
          selectAllDisplayedCells();
        }
        return;
      }

      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: prevent browser native undo/redo from leaking into
      // the search input when a grid cell is selected but not actively being edited.
      // Handled before the input-target early return for the same reason as Ctrl+C/V.
      if (isCtrlOrMeta && !event.altKey && (key === 'z' || key === 'y')) {
        if (textInputFocusedOutsideGridEditing) {
          return;
        }

        if (lastSelectedCell && !editingCellInput) {
          event.preventDefault();
          const handled = key === 'y' || event.shiftKey
            ? redoCellChanges()
            : undoCellChanges();
          if (!handled) {
            event.stopPropagation();
          }
          return;
        }
      }

      // Ctrl+C: copy active editing value or last selected cell value.
      // Handle before input-target early return so grid shortcuts still work
      // after selecting a cell, even if another input kept focus.
      if (isCtrlOrMeta && !event.altKey && !event.shiftKey && key === 'c') {
        if (textInputFocusedOutsideGridEditing) {
          return;
        }

        if (editingCellInput || lastSelectedCell) {
          copyDefaultSelectionToClipboard();
          event.preventDefault();
          return;
        }
      }

      // Ctrl+Shift+V: paste raw text into current editing cell or last selected cell.
      if (isCtrlOrMeta && event.shiftKey && !event.altKey && key === 'v') {
        if (textInputFocusedOutsideGridEditing) {
          return;
        }

        // When a cell input is actively editing, let native paste run to avoid duplicate insertion.
        if (editingCellInput) {
          return;
        }

        if (!lastSelectedCell) {
          return;
        }

        event.preventDefault();
        pasteIntoSelectedCells(true); // true = raw mode
        return;
      }

      // Ctrl+V: smart paste into selected cells or current editing cell.
      // Handle before input-target early return for consistent grid behavior.
      if (isCtrlOrMeta && !event.altKey && !event.shiftKey && key === 'v') {
        if (textInputFocusedOutsideGridEditing) {
          return;
        }

        // When a cell input is actively editing, let native paste run to avoid duplicate insertion.
        if (editingCellInput) {
          return;
        }

        if (!(lastSelectedCell || selectedCells.size > 0)) {
          return;
        }

        event.preventDefault();
        
        // If only one cell is selected, use raw paste.
        if (selectedCells.size === 1 && lastSelectedCell) {
          navigator.clipboard.readText().then((value) => {
            pasteIntoEditingOrSelectedCell(value);
          }).catch(() => {});
        } else {
          // Try smart paste first, fall back to clipboard if no structured data
          if (clipboardData.length === 0) {
            navigator.clipboard.readText().then((value) => {
              pasteIntoEditingOrSelectedCell(value);
            }).catch(() => {});
          } else {
            pasteIntoSelectedCells(false); // false = smart mode
          }
        }
        return;
      }

      const target = event.target;
      if (
        !editingCellInput &&
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
      ) {
        return;
      }

      if (
        !editingCellInput &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        if (enterEditFromCurrentSelection()) {
          event.preventDefault();
        }
        return;
      }

      if (!editingCellInput && (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight'
      )) {
        const pos = getCellPosition(lastSelectedCell) || { rowIndex: 0, colIndex: 0 };

        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          let targetRow = pos.rowIndex;
          let targetCol = pos.colIndex;
          if (event.key === 'ArrowUp') {
            targetRow = 0;
          } else if (event.key === 'ArrowDown') {
            targetRow = displayedRowKeys.length - 1;
          } else if (event.key === 'ArrowLeft') {
            targetCol = 0;
          } else if (event.key === 'ArrowRight') {
            targetCol = displayedColNames.length - 1;
          }

          if (event.shiftKey) {
            extendSelectionTo(targetRow, targetCol);
          } else {
            moveSelectionTo(targetRow, targetCol);
          }
          event.preventDefault();
          return;
        }

        if (event.shiftKey) {
          if (event.key === 'ArrowUp') {
            extendSelectionBy(-1, 0);
          } else if (event.key === 'ArrowDown') {
            extendSelectionBy(1, 0);
          } else if (event.key === 'ArrowLeft') {
            extendSelectionBy(0, -1);
          } else if (event.key === 'ArrowRight') {
            extendSelectionBy(0, 1);
          }
        } else {
          if (event.key === 'ArrowUp') {
            moveSelectionBy(-1, 0);
          } else if (event.key === 'ArrowDown') {
            moveSelectionBy(1, 0);
          } else if (event.key === 'ArrowLeft') {
            moveSelectionBy(0, -1);
          } else if (event.key === 'ArrowRight') {
            moveSelectionBy(0, 1);
          }
        }
        event.preventDefault();
        return;
      }

      if (!editingCellInput && (
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End'
      )) {
        const pos = getCellPosition(lastSelectedCell) || { rowIndex: 0, colIndex: 0 };
        const step = getViewportNavigationStep();
        let targetRow = pos.rowIndex;
        let targetCol = pos.colIndex;

        if (event.key === 'PageUp') {
          targetRow = pos.rowIndex - step.rows;
        } else if (event.key === 'PageDown') {
          targetRow = pos.rowIndex + step.rows;
        } else if (event.key === 'Home') {
          targetCol = pos.colIndex - step.cols;
        } else if (event.key === 'End') {
          targetCol = pos.colIndex + step.cols;
        }

        if (event.shiftKey) {
          extendSelectionTo(targetRow, targetCol);
        } else {
          moveSelectionTo(targetRow, targetCol);
        }

        event.preventDefault();
        return;
      }

      // DEL: mark rows corresponding to selected cells for deletion
      if (event.key === 'Delete' && !editingCellInput) {
        markSelectedRowsForDelete();
        render();
        event.preventDefault();
        return;
      }

      // Space: open preview popup for the selected cell
      if (event.key === ' ' && !editingCellInput && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        if (lastSelectedCell) {
          const spaceRow = rowKeyToRow.get(lastSelectedCell.rowKey);
          const spaceCol = columns.find((c) => c.name === lastSelectedCell.colName);
          if (spaceRow && spaceCol) {
            const spaceCtid = rowKeyToCtid.get(lastSelectedCell.rowKey) || null;
            if (isFkColumn(spaceCol)) {
              openForeignKeyTarget(spaceCol, spaceRow, spaceCtid);
              event.preventDefault();
            } else if (isPreviewableColumn(spaceCol)) {
              const spaceInputMap = inputElements.get(lastSelectedCell.rowKey);
              const spaceInput = spaceInputMap ? spaceInputMap.get(spaceCol.name) : null;
              openJsonModal(spaceCol, getEffectiveCellValue(spaceRow, spaceCol.name, spaceCtid), spaceRow, spaceCtid, spaceInput);
              event.preventDefault();
            }
          }
        }
        return;
      }

      // Ctrl+Enter: open split-screen native editor for the selected cell
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.shiftKey && !event.altKey && !editingCellInput) {
        if (lastSelectedCell) {
          const nativeRow = rowKeyToRow.get(lastSelectedCell.rowKey);
          const nativeCol = columns.find((c) => c.name === lastSelectedCell.colName);
          if (nativeRow && nativeCol) {
            const nativeCtid = rowKeyToCtid.get(lastSelectedCell.rowKey) || null;
            vscode.postMessage({
              type: 'openJsonInNativeEditor',
              content: toCellInputText(getEffectiveCellValue(nativeRow, nativeCol.name, nativeCtid), nativeCol),
              columnName: nativeCol.name,
              isJson: isJsonColumn(nativeCol),
              ctid: nativeCtid,
              rowKey: lastSelectedCell.rowKey,
              preserveFocus: true,
            });
            event.preventDefault();
          }
        }
        return;
      }

    });

    document.querySelectorAll('.menu-submenu-wrap').forEach((wrap) => {
      const clearCloseTimer = () => {
        const timer = submenuCloseTimers.get(wrap);
        if (timer) {
          clearTimeout(timer);
          submenuCloseTimers.delete(wrap);
        }
      };

      const closeOtherSubmenusImmediately = () => {
        document.querySelectorAll('.menu-submenu-wrap').forEach((candidate) => {
          if (candidate === wrap) {
            return;
          }

          const timer = submenuCloseTimers.get(candidate);
          if (timer) {
            clearTimeout(timer);
            submenuCloseTimers.delete(candidate);
          }

          candidate.classList.remove('submenu-open');
          candidate.classList.remove('submenu-visible');
        });
      };

      const openSubmenu = () => {
        clearCloseTimer();
        closeOtherSubmenusImmediately();
        const rect = wrap.getBoundingClientRect();
        const spaceRight = window.innerWidth - rect.right;
        if (spaceRight < 188) {
          wrap.classList.add('submenu-left');
        } else {
          wrap.classList.remove('submenu-left');
        }
        wrap.classList.add('submenu-visible');
        wrap.classList.add('submenu-open');
      };

      const scheduleSubmenuClose = () => {
        wrap.classList.remove('submenu-open');

        clearCloseTimer();
        const timer = setTimeout(() => {
          wrap.classList.remove('submenu-visible');
          submenuCloseTimers.delete(wrap);
        }, 500);
        submenuCloseTimers.set(wrap, timer);
      };

      const closeSubmenuImmediately = () => {
        clearCloseTimer();
        wrap.classList.remove('submenu-open');
        wrap.classList.remove('submenu-visible');
      };

      wrap.addEventListener('mouseenter', openSubmenu);
      wrap.addEventListener('mouseleave', scheduleSubmenuClose);
      wrap.addEventListener('focusin', openSubmenu);
      wrap.addEventListener('focusout', (event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && wrap.contains(nextTarget)) {
          return;
        }
        closeSubmenuImmediately();
      });
    });

    sortMenu.querySelectorAll('button[data-sort]').forEach((button) => {
      button.addEventListener('click', () => {
        const direction = button.getAttribute('data-sort');
        const colName = sortMenuColumnName;
        closeSortMenu();
        if (!colName) {
          return;
        }
        applyColumnSort(colName, direction === 'none' ? null : direction);
      });
    });

    cellMenu.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!activeCell) {
          return;
        }

        const action = button.getAttribute('data-action');
        let value = '';
        if (action === 'null') {
          value = '';
          if (activeCell.ctid) {
            if (!editedRows.has(activeCell.ctid)) {
              editedRows.set(activeCell.ctid, {});
            }
            editedRows.get(activeCell.ctid)[activeCell.colName] = null;
          } else {
            activeCell.row[activeCell.colName] = null;
          }
        } else if (action === 'empty') {
          value = '';
          if (activeCell.ctid) {
            if (!editedRows.has(activeCell.ctid)) {
              editedRows.set(activeCell.ctid, {});
            }
            editedRows.get(activeCell.ctid)[activeCell.colName] = '';
          } else {
            activeCell.row[activeCell.colName] = '';
          }
        } else {
          if (action === 'copy') {
            copyDefaultSelectionToClipboard();
          }

          if (action === 'paste') {
            pasteIntoSelectedCells(false); // false = smart mode
          }

          if (action === 'pasteRaw') {
            pasteIntoSelectedCells(true); // true = raw mode
          }

          if (action === 'copyAdvancedCsv') {
            copyAdvancedToClipboard('csv');
          }

          if (action === 'copyAdvancedJson') {
            copyAdvancedToClipboard('json');
          }

          if (action === 'default') {
            value = '';
            if (activeCell.ctid) {
              if (!editedRows.has(activeCell.ctid)) {
                editedRows.set(activeCell.ctid, {});
              }
              editedRows.get(activeCell.ctid)[activeCell.colName] = '__DBADMIN_DEFAULT__';
            } else {
              activeCell.row[activeCell.colName] = '__DBADMIN_DEFAULT__';
            }
          }

          if (action === 'duplicate') {
            const clone = { __dbadmin_inserted: true, __dbadmin_removed: false };
            columns.forEach((column) => {
              clone[column.name] = getEffectiveCellValue(
                activeCell.row,
                column.name,
                activeCell.ctid
              ) ?? '';
            });
            insertedRows.push(clone);
            rows = [...rows, clone];
            render();
          }

          if (action === 'openNativePreview') {
            const col = columns.find((column) => column.name === activeCell.colName);
            if (col) {
              const rowKey = activeCell.ctid || displayedRowKeys.find((key) => rowKeyToRow.get(key) === activeCell.row) || null;
              vscode.postMessage({
                type: 'openJsonInNativeEditor',
                content: toCellInputText(getEffectiveCellValue(activeCell.row, col.name, activeCell.ctid), col),
                columnName: col.name,
                isJson: isJsonColumn(col),
                ctid: activeCell.ctid || null,
                rowKey,
              });
            }
          }

          if (action === 'searchMentions') {
            const col = columns.find((column) => column.name === activeCell.colName);
            const target = resolveMentionTargetForColumn(col);
            if (target) {
              const sourceValue = toCellInputText(
                getEffectiveCellValue(activeCell.row, activeCell.colName, activeCell.ctid),
                col,
              );
              vscode.postMessage({
                type: 'searchForeignKeyMentions',
                sourceValue,
                targetSchemaName: target.targetSchemaName,
                targetTableName: target.targetTableName,
                targetColumnName: target.targetColumnName,
              });
            }
          }

          if (action === 'remove') {
            if (activeCell.ctid) {
              if (removedCtids.has(activeCell.ctid)) {
                removedCtids.delete(activeCell.ctid);
              } else {
                removedCtids.add(activeCell.ctid);
              }
            } else if (activeCell.row && activeCell.row.__dbadmin_inserted) {
              discardInsertedRow(activeCell.row);
              clearSelectionState({ render: false });
              activeCell = null;
            } else if (activeCell.row) {
              activeCell.row.__dbadmin_removed = !activeCell.row.__dbadmin_removed;
            }
            render();
          }

          if (action === 'new') {
            const row = { __dbadmin_inserted: true, __dbadmin_removed: false };
            columns.forEach((column) => {
              row[column.name] = '';
            });
            insertedRows.push(row);
            rows = [...rows, row];
            render();
          }
        }

        if (action === 'null' || action === 'empty' || action === 'default') {
          activeCell.input.value = value;
          updateCellInputPlaceholder(
            activeCell.input,
            action === 'null' ? null : value,
          );
        }
        updateSaveButtonState();
        closeContextMenu();
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'data') {
        endLoading();
        currentConnectionName = String(message.connectionName || '');
        currentDatabaseName = String(message.databaseName || '');
        currentSchemaName = String(message.schemaName || '');
        currentTableName = String(message.tableName || '');
        if (queryEl) {
          queryEl.value = message.result.query;
        }
        columns = message.result.columns || [];
        applyLayoutState(message.layout);
        syncColumnState();
        rows = message.result.rows || [];
        totalRows = Number(message.result.totalRows || 0);
        state.searchText = message.state.searchText || '';
        state.searchMode = message.state.searchMode || 'local';
        state.sortColumn = message.state.sortColumn;
        state.sortDirection = message.state.sortDirection;
        state.columnFilters = message.state.columnFilters || {};
        state.limit = message.state.limit || ${defaultPageSize};
        state.page = message.state.page || 1;
        dynamicDefaultColumnWidth = message.dynamicDefaultColumnWidth !== false;
        readOnlyResultMode = message.readOnlyResultMode === true;
        hideDiagramMode = message.hideDiagramMode === true;
        integratedTableMode = message.integratedTableMode === true;
        editedRows = new Map();
        cellUndoStack = [];
        cellRedoStack = [];
        pendingCellHistoryChanges = null;
        insertedRows = [];
        removedCtids = new Set();
        clearSelectionForViewChange();
        syncControls();
        applyResultModeRestrictions();
        render();
        hideError();
        restorePendingFocus();
      }

      if (message.type === 'status') {
        if (message.kind === 'error') {
          endLoading();
          showError(message.message);
        }
      }

      if (message.type === 'integratedTableMode') {
        integratedTableMode = message.integratedTableMode === true;
        applyIntegratedTableCheck();
      }

      if (message.type === 'nativeJsonPreviewContentChanged') {
        applyNativePreviewContent(message);
      }

      if (message.type === 'restoreGridFocus') {
        tableWrapEl?.focus({ preventScroll: true });
      }

      if (message.type === 'diagramData') {
        diagramLoading = false;
        document.getElementById('diagramLoading').style.display = 'none';
        diagramData = message.data;
        diagramLayout = null;
        diagramSelectedFkIndex = null;
        const mainT = message.data.tables.find((t) => t.isMain);
        diagramSelectedKey = mainT ? mainT.schemaName + '.' + mainT.tableName : null;
        renderDiagram();
      }
    });

    // ─── Diagram view ──────────────────────────────────────────────────────────

    const diagramViewEl = document.getElementById('diagramView');
    const tableWrapDataEl = document.querySelector('.table-wrap');
    const viewDataBtnEl = document.getElementById('viewDataBtn');
    const viewDiagramBtnEl = document.getElementById('viewDiagramBtn');
    const diagramCanvasEl = document.getElementById('diagramCanvas');
    const diagramSvgEl = document.getElementById('diagramSvg');
    const diagramLoadingEl = document.getElementById('diagramLoading');
    const mainToolbarEl = document.querySelector('.toolbar');
    const diagramToolbarEl = document.querySelector('.diagram-toolbar');
    const diagramZoomPctEl = document.getElementById('diagramZoomPct');
    const headerMenuDataSeparatorEl = document.getElementById('headerMenuDataSeparator');
    const headerMenuDataOnlyEls = Array.from(document.querySelectorAll('.header-menu-data-only'));

    let currentView = 'data';
    let diagramData = null;
    let diagramLayout = null;
    let diagramLoading = false;
    let diagramSelectedKey = null;
    let diagramSelectedFkIndex = null;
    let diagramSuppressCardClick = false;
    // SVG pan state
    let diagramPanX = 0;
    let diagramPanY = 0;
    let diagramScale = 1;
    let diagramIsPanning = false;
    let diagramPanStartX = 0;
    let diagramPanStartY = 0;

    const CARD_WIDTH = 220;
    const CARD_HEADER_H = 30;
    const CARD_ROW_H = 24;
    const CARD_GAP_X = 80;
    const CARD_GAP_Y = 30;

    function diagramWheelPanDelta(e) {
      if (e.deltaMode === 1) return e.deltaY * 16;
      if (e.deltaMode === 2) return e.deltaY * 400;
      return e.deltaY;
    }

    function diagramBuildRootTransformString() {
      return 'translate(' + diagramPanX + ',' + diagramPanY + ') scale(' + diagramScale + ')';
    }

    function diagramSyncZoomControls() {
      if (!diagramZoomPctEl) return;
      if (document.activeElement === diagramZoomPctEl) return;
      diagramZoomPctEl.value = String(Math.round(diagramScale * 100));
    }

    function diagramApplyRootTransform() {
      const root = document.getElementById('diagramRoot');
      if (root) {
        root.setAttribute('transform', diagramBuildRootTransformString());
      }
      diagramSyncZoomControls();
    }

    function diagramZoomSetScaleAtPoint(newScale, px, py) {
      const clamped = Math.max(0.2, Math.min(4, newScale));
      const factor = clamped / diagramScale;
      diagramPanX = px - (px - diagramPanX) * factor;
      diagramPanY = py - (py - diagramPanY) * factor;
      diagramScale = clamped;
      diagramApplyRootTransform();
    }

    function diagramZoomSetScaleCentered(newScale) {
      const rect = diagramCanvasEl.getBoundingClientRect();
      diagramZoomSetScaleAtPoint(newScale, rect.width / 2, rect.height / 2);
    }

    function diagramZoomPctCommit() {
      if (!diagramZoomPctEl) return;
      let pct = parseInt(diagramZoomPctEl.value, 10);
      if (!Number.isFinite(pct)) pct = Math.round(diagramScale * 100);
      pct = Math.max(20, Math.min(400, pct));
      diagramZoomPctEl.value = String(pct);
      diagramZoomSetScaleCentered(pct / 100);
    }

    if (diagramZoomPctEl) {
      diagramZoomPctEl.addEventListener('change', diagramZoomPctCommit);
      diagramZoomPctEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          diagramZoomPctCommit();
          diagramZoomPctEl.blur();
        }
      });
    }

    function switchView(view) {
      if (hideDiagramMode && view !== 'data') {
        view = 'data';
      }

      currentView = view;
      const isData = view === 'data';
      tableWrapDataEl.style.display = isData ? '' : 'none';
      document.getElementById('errorMsg').style.display = isData ? '' : 'none';
      diagramViewEl.style.display = isData ? 'none' : '';
      mainToolbarEl.style.display = isData ? '' : 'none';
      diagramToolbarEl.style.display = isData ? 'none' : '';
      viewDataBtnEl.classList.toggle('active', isData);
      viewDiagramBtnEl.classList.toggle('active', !isData);
      viewDiagramBtnEl.style.display = hideDiagramMode ? 'none' : '';
      if (headerMenuDataSeparatorEl) {
        headerMenuDataSeparatorEl.style.display = isData ? '' : 'none';
      }
      headerMenuDataOnlyEls.forEach((el) => {
        if (el instanceof HTMLElement) {
          const hideInResult = el.classList.contains('header-menu-hide-in-result');
          el.style.display =
            isData && !(readOnlyResultMode && hideInResult) ? '' : 'none';
        }
      });
      if (!isData && !diagramData && !diagramLoading) {
        diagramLoading = true;
        diagramLoadingEl.style.display = '';
        vscode.postMessage({ type: 'loadDiagram', mainColumns: columns });
      }
    }

    viewDataBtnEl.addEventListener('click', () => {
      headerMenuOverlay.close();
      switchView('data');
    });
    viewDiagramBtnEl.addEventListener('click', () => {
      headerMenuOverlay.close();
      switchView('diagram');
    });

    document.getElementById('diagramResetLayoutBtn').addEventListener('click', () => {
      diagramLayout = null;
      diagramPanX = 0;
      diagramPanY = 0;
      diagramScale = 1;
      if (diagramData) {
        renderDiagram();
      }
    });

    const diagramExportModal = document.getElementById('diagramExportModal');
    const diagramExportModalBackdrop = document.getElementById('diagramExportModalBackdrop');

    function openDiagramExportModal() {
      diagramExportModal.classList.add('open');
      diagramExportModalBackdrop.classList.add('open');
    }
    function closeDiagramExportModal() {
      diagramExportModal.classList.remove('open');
      diagramExportModalBackdrop.classList.remove('open');
    }

    document.getElementById('diagramExportBtn').addEventListener('click', () => {
      openDiagramExportModal();
    });
    document.getElementById('diagramExportModalCancel').addEventListener('click', closeDiagramExportModal);
    diagramExportModalBackdrop.addEventListener('click', closeDiagramExportModal);
    document.getElementById('diagramExportModalConfirm').addEventListener('click', () => {
      const format = document.querySelector('input[name="diagramExportFormat"]:checked').value;
      const target = document.querySelector('input[name="diagramExportTarget"]:checked').value;
      closeDiagramExportModal();
      if (format === 'png') {
        exportDiagramPng(target);
      } else {
        exportDiagramDrawio(target);
      }
    });

    document.getElementById('diagramMenuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      headerMenuOverlay.toggle({ anchorEl: document.getElementById('diagramMenuBtn') });
    });

    function tableCardHeight(colCount) {
      return CARD_HEADER_H + colCount * CARD_ROW_H + 4;
    }

    function computeInitialLayout(data) {
      const positions = {};
      const mainTable = data.tables.find((t) => t.isMain);
      if (!mainTable) return positions;

      // Classify tables
      const outgoing = new Set();
      const incoming = new Set();
      for (const fk of data.foreignKeys) {
        const fromKey = fk.fromSchema + '.' + fk.fromTable;
        const toKey = fk.toSchema + '.' + fk.toTable;
        const mainKey = mainTable.schemaName + '.' + mainTable.tableName;
        if (fromKey === mainKey) outgoing.add(toKey);
        else if (toKey === mainKey) incoming.add(fromKey);
      }

      // Place main table in center
      const mainH = tableCardHeight(mainTable.columns.length);
      const canvasW = diagramCanvasEl.clientWidth || 800;
      const canvasH = diagramCanvasEl.clientHeight || 600;
      let cx = Math.max(60, canvasW / 2 - CARD_WIDTH / 2);
      const mainKey = mainTable.schemaName + '.' + mainTable.tableName;
      positions[mainKey] = { x: cx, y: Math.max(40, canvasH / 2 - mainH / 2) };

      const placeGroup = (keys, xOffset) => {
        const arr = [...keys];
        const totalH = arr.reduce((sum, k) => {
          const t = data.tables.find((t2) => t2.schemaName + '.' + t2.tableName === k);
          return sum + (t ? tableCardHeight(t.columns.length) : 150) + CARD_GAP_Y;
        }, 0);
        let y = positions[mainKey].y + mainH / 2 - totalH / 2;
        for (const k of arr) {
          const t = data.tables.find((t2) => t2.schemaName + '.' + t2.tableName === k);
          const h = t ? tableCardHeight(t.columns.length) : 150;
          positions[k] = { x: positions[mainKey].x + xOffset, y };
          y += h + CARD_GAP_Y;
        }
      };

      placeGroup(outgoing, CARD_WIDTH + CARD_GAP_X);
      placeGroup(incoming, -(CARD_WIDTH + CARD_GAP_X));

      // Place any remaining related tables below
      let fallbackY = positions[mainKey].y + mainH + CARD_GAP_Y;
      for (const t of data.tables) {
        const k = t.schemaName + '.' + t.tableName;
        if (!positions[k]) {
          positions[k] = { x: positions[mainKey].x, y: fallbackY };
          fallbackY += tableCardHeight(t.columns.length) + CARD_GAP_Y;
        }
      }

      return positions;
    }

    /** Inline computed fill/stroke for PNG (data URL SVG has no access to host theme variables). */
    function diagramInlineComputedSvgStyles(sourceSvg, cloneSvg) {
      const themed = '[data-diagram-themed]';
      const srcNodes = sourceSvg.querySelectorAll(themed);
      const dstNodes = cloneSvg.querySelectorAll(themed);
      const n = Math.min(srcNodes.length, dstNodes.length);
      for (let i = 0; i < n; i++) {
        const src = srcNodes[i];
        const dst = dstNodes[i];
        const cs = getComputedStyle(src);
        const fill = cs.fill;
        const stroke = cs.stroke;
        if (fill && fill !== 'none' && fill !== 'rgba(0, 0, 0, 0)') dst.setAttribute('fill', fill);
        else dst.removeAttribute('fill');
        if (stroke && stroke !== 'none' && stroke !== 'rgba(0, 0, 0, 0)') {
          dst.setAttribute('stroke', stroke);
          const sw = cs.strokeWidth;
          if (sw && sw !== '0px') dst.setAttribute('stroke-width', sw);
          const op = cs.opacity;
          if (op && op !== '1') dst.setAttribute('opacity', op);
        } else dst.removeAttribute('stroke');
        dst.removeAttribute('data-diagram-themed');
      }
    }

    function renderDiagram() {
      if (!diagramData) return;

      if (!diagramLayout) {
        diagramLayout = computeInitialLayout(diagramData);
      }

      // Clear SVG (keep defs)
      const defs = diagramSvgEl.querySelector('defs');
      while (diagramSvgEl.firstChild) {
        diagramSvgEl.removeChild(diagramSvgEl.firstChild);
      }
      if (defs) diagramSvgEl.appendChild(defs);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('id', 'diagramRoot');
      g.setAttribute('transform', diagramBuildRootTransformString());
      diagramSvgEl.appendChild(g);

      // Draw FK lines (behind cards)
      const linesG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.appendChild(linesG);

      const fkGeoms = [];
      diagramData.foreignKeys.forEach((fk, fkIdx) => {
        const fromKey = fk.fromSchema + '.' + fk.fromTable;
        const toKey = fk.toSchema + '.' + fk.toTable;
        const fromPos = diagramLayout[fromKey];
        const toPos = diagramLayout[toKey];
        if (!fromPos || !toPos) return;

        const fromTable = diagramData.tables.find((t) => t.schemaName + '.' + t.tableName === fromKey);
        const toTable = diagramData.tables.find((t) => t.schemaName + '.' + t.tableName === toKey);
        if (!fromTable || !toTable) return;

        const fromColIdx = fromTable.columns.findIndex((c) => c.name === fk.fromColumn);
        const toColIdx = toTable.columns.findIndex((c) => c.name === fk.toColumn);
        const fromY = fromPos.y + CARD_HEADER_H + (fromColIdx >= 0 ? fromColIdx * CARD_ROW_H + CARD_ROW_H / 2 : CARD_HEADER_H / 2);
        const toY = toPos.y + CARD_HEADER_H + (toColIdx >= 0 ? toColIdx * CARD_ROW_H + CARD_ROW_H / 2 : CARD_HEADER_H / 2);

        const fromRight = fromPos.x + CARD_WIDTH;
        const toRight = toPos.x + CARD_WIDTH;
        let x1, x2, cx1, cx2;
        if (fromPos.x > toPos.x + CARD_WIDTH) {
          x1 = fromPos.x; cx1 = fromPos.x - 60;
          x2 = toRight; cx2 = toRight + 60;
        } else if (toPos.x > fromRight) {
          x1 = fromRight; cx1 = fromRight + 60;
          x2 = toPos.x; cx2 = toPos.x - 60;
        } else {
          x1 = fromPos.x; cx1 = fromPos.x - 60;
          x2 = toPos.x; cx2 = toPos.x - 60;
        }

        const pathD = 'M ' + x1 + ' ' + fromY + ' C ' + cx1 + ' ' + fromY + ', ' + cx2 + ' ' + toY + ', ' + x2 + ' ' + toY;
        fkGeoms.push({ fkIdx, pathD, x1, fromY });
      });

      fkGeoms.forEach((geo) => {
        const edgeSelected = diagramSelectedFkIndex === geo.fkIdx;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'diagram-fk-edge' + (edgeSelected ? ' diagram-fk-edge--selected' : ''));
        path.setAttribute('data-diagram-themed', '1');
        path.setAttribute('d', geo.pathD);
        path.setAttribute('marker-end', edgeSelected ? 'url(#diagramArrowAccent)' : 'url(#diagramArrow)');
        linesG.appendChild(path);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'diagram-fk-edge-dot' + (edgeSelected ? ' diagram-fk-edge-dot--selected' : ''));
        dot.setAttribute('data-diagram-themed', '1');
        dot.setAttribute('cx', String(geo.x1));
        dot.setAttribute('cy', String(geo.fromY));
        dot.setAttribute('r', '3');
        linesG.appendChild(dot);
      });

      const hitsG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.appendChild(hitsG);
      fkGeoms.forEach((geo) => {
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('class', 'diagram-fk-hit');
        hit.setAttribute('d', geo.pathD);
        hit.setAttribute('stroke-width', '14');
        hit.setAttribute('vector-effect', 'non-scaling-stroke');
        hit.setAttribute('fill', 'none');
        hit.style.cursor = 'pointer';
        hit.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          diagramSelectedFkIndex = geo.fkIdx;
          renderDiagram();
        });
        hitsG.appendChild(hit);
      });

      const selFk = diagramSelectedFkIndex !== null ? diagramData.foreignKeys[diagramSelectedFkIndex] : null;

      // Draw table cards
      for (const table of diagramData.tables) {
        const key = table.schemaName + '.' + table.tableName;
        const pos = diagramLayout[key] || { x: 40, y: 40 };
        const cardH = tableCardHeight(table.columns.length);

        const cardG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        cardG.setAttribute('class', 'diagram-card');
        cardG.setAttribute('data-key', key);
        cardG.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ')');
        g.appendChild(cardG);

        // Card background
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute(
          'class',
          'diagram-card-bg ' +
            (table.isMain ? 'diagram-card-bg--main' : 'diagram-card-bg--other') +
            (diagramSelectedKey === key ? ' diagram-card-bg--selected' : '')
        );
        bg.setAttribute('data-diagram-themed', '1');
        bg.setAttribute('width', String(CARD_WIDTH));
        bg.setAttribute('height', String(cardH));
        bg.setAttribute('rx', '6');
        cardG.appendChild(bg);

        // Header background
        const header = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        header.setAttribute('class', table.isMain ? 'diagram-card-header--main' : 'diagram-card-header--other');
        header.setAttribute('data-diagram-themed', '1');
        header.setAttribute('width', String(CARD_WIDTH));
        header.setAttribute('height', String(CARD_HEADER_H));
        header.setAttribute('rx', '6');
        cardG.appendChild(header);

        // Fix rounded corners only at top
        const headerFix = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        headerFix.setAttribute('class', table.isMain ? 'diagram-card-header--main' : 'diagram-card-header--other');
        headerFix.setAttribute('data-diagram-themed', '1');
        headerFix.setAttribute('y', String(CARD_HEADER_H / 2));
        headerFix.setAttribute('width', String(CARD_WIDTH));
        headerFix.setAttribute('height', String(CARD_HEADER_H / 2));
        cardG.appendChild(headerFix);

        // Table name
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        title.setAttribute('class', table.isMain ? 'diagram-title--main' : 'diagram-title--other');
        title.setAttribute('data-diagram-themed', '1');
        title.setAttribute('x', '10');
        title.setAttribute('y', String(CARD_HEADER_H / 2 + 5));
        title.setAttribute('font-size', '12');
        title.setAttribute('font-weight', 'bold');
        title.setAttribute('font-family', 'var(--vscode-font-family, sans-serif)');
        title.textContent = table.tableName;
        cardG.appendChild(title);

        // Schema name (small)
        if (table.schemaName !== 'public') {
          const schema = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          schema.setAttribute('class', table.isMain ? 'diagram-schema--main' : 'diagram-schema--other');
          schema.setAttribute('data-diagram-themed', '1');
          schema.setAttribute('x', String(CARD_WIDTH - 8));
          schema.setAttribute('y', String(CARD_HEADER_H / 2 + 5));
          schema.setAttribute('font-size', '10');
          schema.setAttribute('text-anchor', 'end');
          schema.setAttribute('font-family', 'var(--vscode-font-family, sans-serif)');
          schema.textContent = table.schemaName;
          cardG.appendChild(schema);
        }

        const headerDrag = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        headerDrag.setAttribute('class', 'diagram-header-drag');
        headerDrag.setAttribute('x', '0');
        headerDrag.setAttribute('y', '0');
        headerDrag.setAttribute('width', String(CARD_WIDTH));
        headerDrag.setAttribute('height', String(CARD_HEADER_H));
        headerDrag.setAttribute('rx', '6');
        cardG.appendChild(headerDrag);

        // Divider
        const divider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        divider.setAttribute('class', table.isMain ? 'diagram-header-divider--main' : 'diagram-header-divider--other');
        divider.setAttribute('data-diagram-themed', '1');
        divider.setAttribute('x1', '0');
        divider.setAttribute('y1', String(CARD_HEADER_H));
        divider.setAttribute('x2', String(CARD_WIDTH));
        divider.setAttribute('y2', String(CARD_HEADER_H));
        cardG.appendChild(divider);

        // Columns
        table.columns.forEach((col, i) => {
          const rowY = CARD_HEADER_H + i * CARD_ROW_H;
          const rowG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          rowG.setAttribute('transform', 'translate(0,' + rowY + ')');

          let rowFkHighlight = false;
          if (selFk) {
            if (
              (table.schemaName === selFk.fromSchema &&
                table.tableName === selFk.fromTable &&
                col.name === selFk.fromColumn) ||
              (table.schemaName === selFk.toSchema && table.tableName === selFk.toTable && col.name === selFk.toColumn)
            ) {
              rowFkHighlight = true;
            }
          }
          if (rowFkHighlight) {
            const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            hl.setAttribute('class', 'diagram-col-highlight');
            hl.setAttribute('x', '0');
            hl.setAttribute('y', '0');
            hl.setAttribute('width', String(CARD_WIDTH));
            hl.setAttribute('height', String(CARD_ROW_H));
            rowG.appendChild(hl);
          }

          // Row separator
          if (i > 0) {
            const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            sep.setAttribute('class', 'diagram-row-sep');
            sep.setAttribute('data-diagram-themed', '1');
            sep.setAttribute('x1', '0');
            sep.setAttribute('y1', '0');
            sep.setAttribute('x2', String(CARD_WIDTH));
            sep.setAttribute('y2', '0');
            rowG.appendChild(sep);
          }

          // Icon
          let iconText = '  ';
          if (col.isPrimaryKey) iconText = 'PK';
          else if (col.isForeignKey) iconText = 'FK';
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          icon.setAttribute(
            'class',
            col.isPrimaryKey ? 'diagram-icon--pk' : col.isForeignKey ? 'diagram-icon--fk' : 'diagram-icon--spacer'
          );
          icon.setAttribute('data-diagram-themed', '1');
          icon.setAttribute('x', '6');
          icon.setAttribute('y', String(CARD_ROW_H / 2 + 4));
          icon.setAttribute('font-size', '9');
          icon.setAttribute('font-weight', 'bold');
          icon.setAttribute('font-family', 'var(--vscode-font-family, sans-serif)');
          icon.textContent = iconText;
          rowG.appendChild(icon);

          // Column name
          const colName = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          colName.setAttribute('class', col.isPrimaryKey ? 'diagram-col-name diagram-col-name--pk' : 'diagram-col-name');
          colName.setAttribute('data-diagram-themed', '1');
          colName.setAttribute('x', '32');
          colName.setAttribute('y', String(CARD_ROW_H / 2 + 4));
          colName.setAttribute('font-size', '11');
          colName.setAttribute('font-family', 'var(--vscode-font-family, sans-serif)');
          // Truncate long names
          const maxNameW = 100;
          let nameText = col.name;
          colName.textContent = nameText;
          rowG.appendChild(colName);

          // Data type (right aligned)
          const colType = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          colType.setAttribute('class', 'diagram-col-type');
          colType.setAttribute('data-diagram-themed', '1');
          colType.setAttribute('x', String(CARD_WIDTH - 6));
          colType.setAttribute('y', String(CARD_ROW_H / 2 + 4));
          colType.setAttribute('font-size', '10');
          colType.setAttribute('text-anchor', 'end');
          colType.setAttribute('font-family', 'var(--vscode-font-family, sans-serif)');
          // Shorten common types
          let typeText = col.dataType;
          if (typeText === 'character varying') typeText = 'varchar';
          else if (typeText === 'timestamp without time zone') typeText = 'timestamp';
          else if (typeText === 'timestamp with time zone') typeText = 'timestamptz';
          else if (typeText === 'double precision') typeText = 'float8';
          colType.textContent = typeText;
          rowG.appendChild(colType);

          cardG.appendChild(rowG);
        });

        let dragOffX = 0, dragOffY = 0, isDragging = false, dragMoved = false, dragStartSX = 0, dragStartSY = 0;
        headerDrag.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          isDragging = true;
          dragMoved = false;
          dragStartSX = e.clientX;
          dragStartSY = e.clientY;
          const rect = diagramSvgEl.getBoundingClientRect();
          dragOffX = (e.clientX - rect.left) / diagramScale - diagramPanX / diagramScale - pos.x;
          dragOffY = (e.clientY - rect.top) / diagramScale - diagramPanY / diagramScale - pos.y;

          const onMove = (me) => {
            if (!isDragging) return;
            if (Math.hypot(me.clientX - dragStartSX, me.clientY - dragStartSY) > 4) {
              dragMoved = true;
            }
            const r = diagramSvgEl.getBoundingClientRect();
            const nx = (me.clientX - r.left) / diagramScale - diagramPanX / diagramScale - dragOffX;
            const ny = (me.clientY - r.top) / diagramScale - diagramPanY / diagramScale - dragOffY;
            diagramLayout[key] = { x: nx, y: ny };
            pos.x = nx; pos.y = ny;
            renderDiagram();
          };
          const onUp = () => {
            if (dragMoved) {
              diagramSuppressCardClick = true;
            }
            isDragging = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });

        headerDrag.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (!table.isMain) {
            vscode.postMessage({
              type: 'openDiagramTableInNewTab',
              schemaName: table.schemaName,
              tableName: table.tableName,
            });
          }
        });

        cardG.addEventListener('click', (e) => {
          if (diagramSuppressCardClick) {
            diagramSuppressCardClick = false;
            return;
          }
          diagramSelectedKey = key;
          diagramSelectedFkIndex = null;
          renderDiagram();
        });
      }

      diagramSyncZoomControls();
    }

    // Pan diagram canvas
    diagramCanvasEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.diagram-fk-hit')) return;
      if (e.target.closest('.diagram-card')) return;
      if (diagramSelectedFkIndex !== null) {
        diagramSelectedFkIndex = null;
        renderDiagram();
      }
      diagramIsPanning = true;
      diagramPanStartX = e.clientX - diagramPanX;
      diagramPanStartY = e.clientY - diagramPanY;
      diagramCanvasEl.classList.add('panning');
    });
    window.addEventListener('mousemove', (e) => {
      if (!diagramIsPanning) return;
      diagramPanX = e.clientX - diagramPanStartX;
      diagramPanY = e.clientY - diagramPanStartY;
      diagramApplyRootTransform();
    });
    window.addEventListener('mouseup', () => {
      if (diagramIsPanning) {
        diagramIsPanning = false;
        diagramCanvasEl.classList.remove('panning');
      }
    });

    // Diagram canvas: Ctrl+wheel = zoom; wheel = pan vertical; Shift+wheel = pan horizontal
    diagramCanvasEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = diagramCanvasEl.getBoundingClientRect();
      const zoomMod = e.ctrlKey || e.metaKey;
      if (zoomMod) {
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        diagramZoomSetScaleAtPoint(diagramScale * factor, mx, my);
        return;
      }
      const d = diagramWheelPanDelta(e);
      if (e.shiftKey) {
        diagramPanX -= d;
      } else {
        diagramPanY -= d;
      }
      diagramApplyRootTransform();
    }, { passive: false });

    function exportDiagramPng(target) {
      if (!diagramData) return;
      // Snapshot the current layout to get bounds
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const t of diagramData.tables) {
        const k = t.schemaName + '.' + t.tableName;
        const p = diagramLayout && diagramLayout[k];
        if (!p) continue;
        const h = tableCardHeight(t.columns.length);
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + CARD_WIDTH);
        maxY = Math.max(maxY, p.y + h);
      }
      const pad = 40;
      const W = (maxX - minX) + pad * 2;
      const H = (maxY - minY) + pad * 2;

      // Serialize SVG with a fresh transform centering the diagram
      const svgClone = diagramSvgEl.cloneNode(true);
      svgClone.querySelectorAll('.diagram-fk-hit').forEach((n) => n.remove());
      const rootG = svgClone.getElementById('diagramRoot');
      if (rootG) {
        rootG.setAttribute('transform', 'translate(' + (pad - minX) + ',' + (pad - minY) + ')');
      }
      svgClone.setAttribute('width', String(W));
      svgClone.setAttribute('height', String(H));
      svgClone.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      // Apply background (resolved so PNG matches canvas outside the diagram)
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('width', String(W));
      bgRect.setAttribute('height', String(H));
      bgRect.setAttribute(
        'fill',
        getComputedStyle(document.body).backgroundColor || '#1e1e1e'
      );
      svgClone.insertBefore(bgRect, svgClone.firstChild);
      diagramInlineComputedSvgStyles(diagramSvgEl, svgClone);

      const svgData = new XMLSerializer().serializeToString(svgClone);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = W * 2;
        canvas.height = H * 2;
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        if (target === 'file') {
          canvas.toBlob((blob) => {
            const reader = new FileReader();
            reader.onload = () => {
              vscode.postMessage({
                type: 'exportDiagram',
                format: 'png',
                target: 'file',
                data: reader.result,
                tableName: diagramData.tables.find((t) => t.isMain)?.tableName || 'diagram',
              });
            };
            reader.readAsDataURL(blob);
          }, 'image/png');
        } else {
          canvas.toBlob(async (blob) => {
            try {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            } catch {
              // Fallback: export as file
              const reader = new FileReader();
              reader.onload = () => {
                vscode.postMessage({
                  type: 'exportDiagram',
                  format: 'png',
                  target: 'file',
                  data: reader.result,
                  tableName: diagramData.tables.find((t) => t.isMain)?.tableName || 'diagram',
                });
              };
              reader.readAsDataURL(blob);
            }
          }, 'image/png');
        }
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
    }

    function buildDrawioXml() {
      if (!diagramData || !diagramLayout) return '';
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      let cells = '';
      let edgeCells = '';
      let idCounter = 10;
      const cellIds = {};

      for (const table of diagramData.tables) {
        const key = table.schemaName + '.' + table.tableName;
        const pos = diagramLayout[key] || { x: 0, y: 0 };
        const h = tableCardHeight(table.columns.length);
        const tId = 't_' + (idCounter++);
        cellIds[key] = { tableId: tId, colIds: {} };

        const headerStyle = table.isMain
          ? 'shape=table;startSize=30;container=1;collapsible=0;childLayout=tableLayout;fixedRows=1;rowLines=0;fontStyle=1;align=center;resizeLast=1;fontSize=12;fillColor=#094771;strokeColor=#4db6f4;fontColor=#ffffff;'
          : 'shape=table;startSize=30;container=1;collapsible=0;childLayout=tableLayout;fixedRows=1;rowLines=0;fontStyle=1;align=center;resizeLast=1;fontSize=12;fillColor=#3c3c3c;strokeColor=#555555;fontColor=#cccccc;';
        cells += '<mxCell id="' + tId + '" value="' + esc(table.tableName) + '" style="' + headerStyle + '" vertex="1" parent="1"><mxGeometry x="' + Math.round(pos.x) + '" y="' + Math.round(pos.y) + '" width="' + CARD_WIDTH + '" height="' + h + '" as="geometry"/></mxCell>';

        table.columns.forEach((col, i) => {
          const cId = 'c_' + (idCounter++);
          cellIds[key].colIds[col.name] = cId;
          let prefix = '';
          if (col.isPrimaryKey) prefix = 'PK  ';
          else if (col.isForeignKey) prefix = 'FK  ';
          let typeText = col.dataType;
          if (typeText === 'character varying') typeText = 'varchar';
          else if (typeText === 'timestamp without time zone') typeText = 'timestamp';
          else if (typeText === 'timestamp with time zone') typeText = 'timestamptz';
          else if (typeText === 'double precision') typeText = 'float8';
          const label = prefix + col.name + '  ' + typeText;
          // horizontal=1: draw.io uses horizontal=0 for vertical label text (see style reference).
          const rowStyle =
            'shape=tableRow;horizontal=1;startSize=0;swimlaneHead=0;swimlaneBody=0;fillColor=none;collapsible=0;dropTarget=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;fontSize=11;align=left;verticalAlign=middle;spacingLeft=6;spacingRight=6;top=0;left=0;right=0;bottom=1;';
          cells += '<mxCell id="' + cId + '" value="' + esc(label) + '" style="' + rowStyle + '" vertex="1" parent="' + tId + '"><mxGeometry x="0" y="' + (CARD_HEADER_H + i * CARD_ROW_H) + '" width="' + CARD_WIDTH + '" height="' + CARD_ROW_H + '" as="geometry"/></mxCell>';
        });
      }

      for (const fk of diagramData.foreignKeys) {
        const fromKey = fk.fromSchema + '.' + fk.fromTable;
        const toKey = fk.toSchema + '.' + fk.toTable;
        const fromInfo = cellIds[fromKey];
        const toInfo = cellIds[toKey];
        if (!fromInfo || !toInfo) continue;
        const srcId = fromInfo.colIds[fk.fromColumn];
        const tgtId = toInfo.colIds[fk.toColumn];
        if (!srcId || !tgtId) continue;
        const eId = 'e_' + (idCounter++);
        edgeCells += '<mxCell id="' + eId + '" style="edgeStyle=entityRelationEdgeStyle;endArrow=ERzeroToOne;startArrow=ERmandOne;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;" edge="1" source="' + srcId + '" target="' + tgtId + '" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>';
      }

      return '<?xml version="1.0" encoding="UTF-8"?><mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' + cells + edgeCells + '</root></mxGraphModel></diagram></mxfile>';
    }

    function exportDiagramDrawio(target) {
      if (!diagramData) return;
      if (!diagramLayout) {
        diagramLayout = computeInitialLayout(diagramData);
      }
      const xml = buildDrawioXml();
      if (target === 'clipboard') {
        vscode.postMessage({ type: 'exportDiagram', format: 'drawio', target: 'clipboard', data: xml, tableName: diagramData.tables.find((t) => t.isMain)?.tableName || 'diagram' });
      } else {
        vscode.postMessage({ type: 'exportDiagram', format: 'drawio', target: 'file', data: xml, tableName: diagramData.tables.find((t) => t.isMain)?.tableName || 'diagram' });
      }
    }

    // ─── End diagram view ───────────────────────────────────────────────────────

    updateModeIcon();
    applyQueryVisibility();
    updateSaveButtonState();
    beginLoading();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
