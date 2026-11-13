import * as vscode from "vscode";
import { ConnectionStore } from "./connectionStore";
import { DatabaseService } from "./engines/databaseService";
import { DatabaseTreeProvider } from "./databaseTreeProvider";
import { TableDataPanelManager } from "./tableDataPanel";
import {
  getOpenSqliteInExplorerEnabled,
  openDatabaseFile,
  setOpenSqliteInExplorerEnabled,
} from "./fileAdmin";
import { isSqliteConnection } from "./models";
import { sqliteDatabaseName } from "./connectionIdentity";
import { SQLITE_SCHEMA } from "./engines/types";
import { t } from "./i18n";
import { log, logError, revealOutput } from "./output";
import { EphemeralConnectionLifecycle } from "./ephemeralConnectionLifecycle";

export class SqliteCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly databaseService: DatabaseService,
    private readonly treeProvider: DatabaseTreeProvider,
    private readonly tablePanels: TableDataPanelManager,
    private readonly ephemeralLifecycle: EphemeralConnectionLifecycle,
  ) {}

  public async openCustomDocument(
    uri: vscode.Uri,
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => undefined };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.renderHtml(document.uri, t("Loading..."));
    log(`Opening SQLite editor: ${document.uri.fsPath}`);

    const disposable = webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "persist") {
        try {
          const connection = await this.store.findSqliteByFilePath(document.uri.fsPath);
          if (connection && isSqliteConnection(connection) && connection.ephemeral) {
            await this.store.persistEphemeralSqlite(connection.id);
            this.treeProvider.refresh();
            this.ephemeralLifecycle.scheduleReconcile();
            void vscode.window.showInformationMessage(t("Connection created successfully."));
          }
          await this.pushEditorState(document.uri, webviewPanel);
        } catch (error) {
          logError("Failed to persist SQLite connection", error);
        }
        return;
      }
      if (message?.type === "setOpenInExplorer") {
        try {
          await setOpenSqliteInExplorerEnabled(Boolean(message.value));
          await this.pushEditorState(document.uri, webviewPanel);
        } catch (error) {
          logError("Failed to update SQLite explorer setting", error);
        }
        return;
      }
      if (message?.type === "openTable") {
        try {
          const connection = await this.store.findSqliteByFilePath(document.uri.fsPath);
          if (!connection || !isSqliteConnection(connection)) {
            return;
          }
          await this.tablePanels.openTable({
            node: {
              type: "dbObject",
              connection,
              databaseName: sqliteDatabaseName(connection),
              schemaName: SQLITE_SCHEMA,
              kind: "table",
              objectName: String(message.tableName || ""),
            },
            newTab: Boolean(message.newTab),
          });
        } catch (error) {
          logError("Failed to open SQLite table from editor", error);
        }
      }
    });
    const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dbadmin.openSqliteInExplorer")) {
        void this.pushEditorState(document.uri, webviewPanel);
      }
    });
    webviewPanel.onDidDispose(() => {
      disposable.dispose();
      onConfigChange.dispose();
      this.ephemeralLifecycle.scheduleReconcile();
    });

    void this.hydrateEditor(document.uri, webviewPanel);
  }

  private async hydrateEditor(
    uri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    try {
      await openDatabaseFile(uri, {
        store: this.store,
        treeProvider: this.treeProvider,
        tablePanels: this.tablePanels,
        persistConnection: false,
      });
      const connection = await this.store.findSqliteByFilePath(uri.fsPath);
      if (!connection || !isSqliteConnection(connection)) {
        throw new Error(t("SQLite connection was not created."));
      }
      const tables = await this.databaseService.listTables(
        connection,
        sqliteDatabaseName(connection),
        SQLITE_SCHEMA,
      );
      log(`SQLite editor ready: ${uri.fsPath} (${tables.length} tables)`);
      webviewPanel.webview.postMessage({ type: "tables", tables });
      await this.pushEditorState(uri, webviewPanel);
      this.ephemeralLifecycle.scheduleReconcile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Failed to open SQLite file: ${uri.fsPath}`, error);
      revealOutput();
      webviewPanel.webview.postMessage({
        type: "error",
        message,
      });
    }
  }

  private async pushEditorState(
    uri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const connection = await this.store.findSqliteByFilePath(uri.fsPath);
    const ephemeral = Boolean(
      connection && isSqliteConnection(connection) && connection.ephemeral,
    );
    webviewPanel.webview.postMessage({
      type: "editorState",
      ephemeral,
      openInExplorer: getOpenSqliteInExplorerEnabled(),
    });
  }

  private renderHtml(uri: vscode.Uri, loadingLabel: string): string {
    const fileName = uri.fsPath.split(/[/\\]/).pop() || uri.fsPath;
    const labels = {
      intro: t("This SQLite database is open in DBAdmin. Use the explorer or pick a table below."),
      save: t("Save connection"),
      empty: t("Empty SQLite database."),
      openInExplorer: t("Open in explorer when opening a file"),
    };
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h1 { font-size: 16px; }
    button {
      margin-right: 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 4px 12px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .hidden { display: none !important; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0; }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
    }
    .tables { margin-top: 16px; display: flex; flex-direction: column; gap: 6px; }
    .table {
      cursor: pointer;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
    }
    .table:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
    }
    .error { color: var(--vscode-errorForeground); }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h1>${escapeHtml(fileName)}</h1>
  <p>${escapeHtml(labels.intro)}</p>
  <div class="toolbar">
    <button id="persist">${escapeHtml(labels.save)}</button>
    <label class="check">
      <input id="openInExplorer" type="checkbox" />
      <span>${escapeHtml(labels.openInExplorer)}</span>
    </label>
  </div>
  <div id="status" class="muted">${escapeHtml(loadingLabel)}</div>
  <div id="tables" class="tables"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const labels = ${JSON.stringify(labels)};
    document.getElementById('persist').addEventListener('click', () => {
      vscode.postMessage({ type: 'persist' });
    });
    document.getElementById('openInExplorer').addEventListener('change', (event) => {
      vscode.postMessage({ type: 'setOpenInExplorer', value: event.target.checked });
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      const status = document.getElementById('status');
      if (message.type === 'editorState') {
        document.getElementById('persist').classList.toggle('hidden', !message.ephemeral);
        document.getElementById('openInExplorer').checked = Boolean(message.openInExplorer);
        return;
      }
      if (message.type === 'tables') {
        const root = document.getElementById('tables');
        root.innerHTML = '';
        const tables = message.tables || [];
        status.textContent = tables.length ? '' : labels.empty;
        status.className = 'muted';
        tables.forEach((name) => {
          const el = document.createElement('div');
          el.className = 'table';
          el.textContent = name;
          el.addEventListener('click', () => vscode.postMessage({ type: 'openTable', tableName: name }));
          root.appendChild(el);
        });
      }
      if (message.type === 'error') {
        status.textContent = message.message || '';
        status.className = 'error';
      }
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
