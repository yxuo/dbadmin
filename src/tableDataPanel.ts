import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DbObjectNodeRef } from './models';
import { PostgresService, TableSavePayload, TableSortDirection } from './postgresService';
import { ConnectionStore } from './connectionStore';
import {
  buildCodeEditorMarkup,
  buildCodeEditorScript,
  buildCodeEditorStyles,
} from './webview/codeEditor';

interface OpenTableInput {
  node: DbObjectNodeRef;
  newTab: boolean;
  restoringOnStartup?: boolean;
  layout?: TableLayoutState;
  initialState?: TableState;
}

interface TableState {
  searchText: string;
  searchMode: 'local' | 'query';
  sortColumn?: string;
  sortDirection?: TableSortDirection;
  columnFilters: Record<string, string>;
  limit: number;
  page: number;
}

interface TableLayoutState {
  columnOrder: string[];
  visibleColumns: string[];
  columnWidths: Record<string, number>;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'reload'; state: TableState; clearSelectionAndPreview?: boolean }
  | { type: 'updateState'; state: TableState }
  | { type: 'save'; state: TableState; payload: TableSavePayload }
  | {
      type: 'exportData';
      format: 'json' | 'csv';
      dataScope: 'result' | 'all' | 'selected';
      state: TableState;
      columns: string[];
      rows: Array<Record<string, unknown>>;
    }
  | {
      type: 'copyAdvancedClipboard';
      format: 'json' | 'csv';
      columns: string[];
      rows: Array<Record<string, unknown>>;
    }
  | { type: 'openInNewTab' }
  | { type: 'openSettings' }
  | { type: 'showInExplorer' }
  | {
      type: 'openJsonInNativeEditor';
      content: string;
      columnName: string;
      isJson?: boolean;
      ctid?: string | null;
      rowKey?: string | null;
      preserveFocus?: boolean;
    }
  | {
      type: 'syncNativeJsonPreview';
      content: string;
      columnName: string;
      isJson?: boolean;
      ctid?: string | null;
      rowKey?: string | null;
      open?: boolean;
    }
  | {
      type: 'openForeignKeyTarget';
      sourceValue: string;
      targetSchemaName: string;
      targetTableName: string;
      targetColumnName: string;
    }
  | { type: 'toggleQueryVisibility' }
  | { type: 'toggleHeaderVisibility' }
  | { type: 'updateLayout'; layout: TableLayoutState };

interface NativeJsonPreviewState {
  document: vscode.TextDocument;
  tmpFilePath: string;
  tmpFilePrefix: string;
  isJson: boolean;
  ctid: string | null;
  rowKey: string | null;
  columnName: string;
  viewColumn?: vscode.ViewColumn;
}

const GLOBAL_REUSED_KEY = '__global__';
const SHOW_QUERY_SETTING = 'dbadmin.showQueryEditor';
const HIDE_TAB_HEADER_SETTING = 'dbadmin.hideTabHeader';
const PERSIST_LAYOUT_SETTING = 'dbadmin.persistColumnLayout';
const DEFAULT_PAGE_SIZE_SETTING = 'dbadmin.defaultPageSize';
const DYNAMIC_DEFAULT_COLUMN_WIDTH_SETTING = 'dbadmin.dynamicDefaultColumnWidth';

export class TableDataPanelManager {
  private readonly reusedPanels = new Map<string, vscode.WebviewPanel>();
  private readonly panelNodes = new Map<vscode.WebviewPanel, DbObjectNodeRef>();
  private readonly panelIsNewTab = new Map<vscode.WebviewPanel, boolean>();
  private readonly panelLayouts = new Map<vscode.WebviewPanel, TableLayoutState>();
  private readonly panelStates = new Map<vscode.WebviewPanel, TableState>();
  private readonly panelPreviewTabIds = new Map<vscode.WebviewPanel, string>();
  private readonly panelNativePreview = new Map<vscode.WebviewPanel, NativeJsonPreviewState>();
  private readonly nativePreviewDocumentToPanel = new Map<string, vscode.WebviewPanel>();
  private readonly nativePreviewSaveDisposable: vscode.Disposable;
  private readonly nativePreviewCloseDisposable: vscode.Disposable;
  private previewTabIdSequence = 1;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postgresService: PostgresService
  ) {
    this.cleanupStaleNativePreviewTempFiles();
    this.nativePreviewSaveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
      this.handleNativePreviewDocumentSave(document);
    });
    this.nativePreviewCloseDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
      this.handleNativePreviewDocumentClose(document);
    });
  }

  public async openTable(input: OpenTableInput): Promise<void> {
    const key = input.newTab ? this.panelKey(input.node, true) : GLOBAL_REUSED_KEY;
    const shouldPersistOutsideRestore = this.getPersistLayoutOutsideRestore();
    const initialLayout =
      input.layout ??
      (shouldPersistOutsideRestore ? this.readStoredLayout(input.node) : undefined);

    const initialState = input.initialState ?? this.defaultState();

    if (!input.newTab) {
      const reused = this.reusedPanels.get(key);
      if (reused) {
        this.panelNodes.set(reused, input.node);
        this.panelStates.set(reused, this.cloneTableState(initialState));
        if (initialLayout) {
          this.panelLayouts.set(reused, initialLayout);
        } else {
          this.panelLayouts.delete(reused);
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
      'dbadmin.tableData',
      `${input.node.objectName}`,
      {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    panel.webview.html = this.buildHtml(
      panel.webview,
      this.getShowQueryEditor(),
      this.getHideTabHeader()
    );
    this.panelNodes.set(panel, input.node);
    this.panelIsNewTab.set(panel, input.newTab);
    this.panelStates.set(panel, this.cloneTableState(initialState));
    if (initialLayout) {
      this.panelLayouts.set(panel, initialLayout);
    } else {
      this.panelLayouts.delete(panel);
    }

    if (!input.newTab) {
      panel.iconPath = vscode.Uri.file(
        this.context.asAbsolutePath('resources/icons/table-global.svg')
      );
      this.reusedPanels.set(key, panel);
    } else {
      panel.iconPath = {
        light: vscode.Uri.file(this.context.asAbsolutePath('resources/icons/light/table.svg')),
        dark: vscode.Uri.file(this.context.asAbsolutePath('resources/icons/dark/table.svg')),
      };
    }

    this.saveOpenTabs();

    const disposable = panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      const currentNode = this.panelNodes.get(panel) ?? input.node;

      if (message.type === 'ready') {
        panel.webview.postMessage({
          type: 'queryVisibility',
          showQueryEditor: this.getShowQueryEditor(),
        });
        panel.webview.postMessage({
          type: 'headerVisibility',
          hideTabHeader: this.getHideTabHeader(),
        });
        await this.refreshPanel(panel, currentNode, initialState, {
          retryTimeout: input.restoringOnStartup === true,
        });
        return;
      }

      if (message.type === 'reload') {
        this.panelStates.set(panel, this.cloneTableState(message.state));
        this.saveOpenTabs();
        if (message.clearSelectionAndPreview === true) {
          await this.clearNativePreviewContent(panel);
        }
        await this.refreshPanel(panel, currentNode, message.state);
        return;
      }

      if (message.type === 'updateState') {
        this.panelStates.set(panel, this.cloneTableState(message.state));
        this.saveOpenTabs();
        return;
      }

      if (message.type === 'save') {
        try {
          this.panelStates.set(panel, this.cloneTableState(message.state));
          this.saveOpenTabs();
          await this.postgresService.saveTableData(
            currentNode.connection,
            currentNode.databaseName,
            currentNode.schemaName,
            currentNode.objectName,
            message.payload
          );

          panel.webview.postMessage({
            type: 'status',
            kind: 'ok',
            message: 'Alteracoes salvas com sucesso.',
          });

          await this.refreshPanel(panel, currentNode, message.state);
        } catch (error) {
          panel.webview.postMessage({
            type: 'status',
            kind: 'error',
            message: this.errorMessage(error),
          });
        }
        return;
      }

      if (message.type === 'exportData') {
        try {
          await this.exportTableData(panel, currentNode, message);
        } catch (error) {
          panel.webview.postMessage({
            type: 'status',
            kind: 'error',
            message: this.errorMessage(error),
          });
        }
        return;
      }

      if (message.type === 'copyAdvancedClipboard') {
        try {
          const content = this.buildExportContent(message.format, message.columns, message.rows);
          await vscode.env.clipboard.writeText(content);
          panel.webview.postMessage({
            type: 'status',
            kind: 'ok',
            message: 'Conteudo copiado para a area de transferencia.',
          });
        } catch (error) {
          panel.webview.postMessage({
            type: 'status',
            kind: 'error',
            message: this.errorMessage(error),
          });
        }
        return;
      }

      if (message.type === 'openInNewTab') {
        await this.openTable({ node: currentNode, newTab: true });
        return;
      }

      if (message.type === 'openSettings') {
        await vscode.commands.executeCommand('dbadmin.openSettings');
        return;
      }

      if (message.type === 'showInExplorer') {
        await vscode.commands.executeCommand('dbadmin.showInExplorer', currentNode);
        return;
      }

      if (message.type === 'openJsonInNativeEditor') {
        await this.openOrSyncNativePreview(panel, message, true);
        return;
      }

      if (message.type === 'syncNativeJsonPreview') {
        await this.openOrSyncNativePreview(panel, message, false);
        return;
      }

      if (message.type === 'openForeignKeyTarget') {
        const targetSchemaName = String(message.targetSchemaName || '').trim();
        const targetTableName = String(message.targetTableName || '').trim();
        const targetColumnName = String(message.targetColumnName || '').trim();

        if (!targetSchemaName || !targetTableName || !targetColumnName) {
          panel.webview.postMessage({
            type: 'status',
            kind: 'error',
            message: 'Metadados da chave estrangeira incompletos para abrir a tabela relacionada.',
          });
          return;
        }

        const initialTargetState = this.defaultState();
        initialTargetState.searchMode = 'query';
        const sourceValue = String(message.sourceValue ?? '').trim();
        if (sourceValue.length > 0) {
          initialTargetState.columnFilters[targetColumnName] = sourceValue;
        }

        await this.openTable({
          node: {
            type: 'dbObject',
            connection: currentNode.connection,
            databaseName: currentNode.databaseName,
            schemaName: targetSchemaName,
            kind: 'table',
            objectName: targetTableName,
          },
          newTab: true,
          initialState: initialTargetState,
        });
        return;
      }

      if (message.type === 'toggleQueryVisibility') {
        const current = this.getShowQueryEditor();
        await vscode.workspace.getConfiguration().update(
          SHOW_QUERY_SETTING,
          !current,
          vscode.ConfigurationTarget.Global
        );
        this.notifyQueryVisibilityChanged();
        return;
      }

      if (message.type === 'toggleHeaderVisibility') {
        const current = this.getHideTabHeader();
        await vscode.workspace.getConfiguration().update(
          HIDE_TAB_HEADER_SETTING,
          !current,
          vscode.ConfigurationTarget.Global
        );
        this.notifyHeaderVisibilityChanged();
        return;
      }

      if (message.type === 'updateLayout') {
        this.panelLayouts.set(panel, message.layout);
        if (this.getPersistLayoutOutsideRestore()) {
          await this.persistLayout(currentNode, message.layout);
        }
        this.saveOpenTabs();
      }
    });

    panel.onDidDispose(() => {
      disposable.dispose();
      void this.closeAndClearNativePreviewState(panel);
      this.panelNodes.delete(panel);
      this.panelIsNewTab.delete(panel);
      this.panelLayouts.delete(panel);
      this.panelStates.delete(panel);
      this.panelPreviewTabIds.delete(panel);
      if (!input.newTab) {
        this.reusedPanels.delete(key);
      }
      this.saveOpenTabs();
    });
  }

  private async refreshPanel(
    panel: vscode.WebviewPanel,
    node: DbObjectNodeRef,
    state: TableState,
    options?: { retryTimeout?: boolean }
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
          }
        );

        panel.webview.postMessage({
          type: 'data',
          title: `${node.databaseName} / ${node.schemaName}.${node.objectName}`,
          connectionName:
            node.connection.nickname?.trim() ||
            node.connection.database?.trim() ||
            node.connection.host,
          databaseName: node.databaseName,
          schemaName: node.schemaName,
          result,
          state,
          showQueryEditor: this.getShowQueryEditor(),
          dynamicDefaultColumnWidth: this.getDynamicDefaultColumnWidth(),
          layout: this.panelLayouts.get(panel),
        });
        return;
      } catch (error) {
        lastError = error;

        const shouldRetry = options?.retryTimeout && this.isTimeoutError(error) && attempt < maxAttempts;
        if (shouldRetry) {
          await this.wait(350);
          continue;
        }

        break;
      }
    }

    panel.webview.postMessage({
      type: 'status',
      kind: 'error',
      message: this.errorMessage(lastError),
    });
  }

  private async exportTableData(
    panel: vscode.WebviewPanel,
    node: DbObjectNodeRef,
    message: Extract<WebviewMessage, { type: 'exportData' }>
  ): Promise<void> {
    let columns = Array.isArray(message.columns) ? [...message.columns] : [];
    let rows = Array.isArray(message.rows) ? [...message.rows] : [];

    if (message.dataScope === 'all') {
      const allResult = await this.fetchAllRowsForExport(node, message.state);
      columns = allResult.columns;
      rows = allResult.rows;
    }

    const format = message.format === 'csv' ? 'csv' : 'json';
    const content = this.buildExportContent(format, columns, rows);
    const language = format === 'csv' ? 'csv' : 'json';
    const document = await vscode.workspace.openTextDocument({ language, content });

    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: panel.viewColumn ?? vscode.ViewColumn.Active,
    });

    panel.webview.postMessage({
      type: 'status',
      kind: 'ok',
      message: 'Exportacao aberta em nova aba.',
    });
  }

  private async fetchAllRowsForExport(
    node: DbObjectNodeRef,
    state: TableState
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];
    let totalRows = 0;
    let page = 1;
    const limit = 500;

    while (true) {
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
          limit,
          page,
        }
      );

      if (page === 1) {
        columns = result.columns.map((column) => column.name);
        totalRows = Number(result.totalRows || 0);
      }

      rows.push(...result.rows);

      if (result.rows.length === 0 || rows.length >= totalRows) {
        break;
      }

      page += 1;
    }

    return { columns, rows };
  }

  private buildExportContent(
    format: 'json' | 'csv',
    columns: string[],
    rows: Array<Record<string, unknown>>
  ): string {
    const normalizedColumns = columns.filter((columnName) => Boolean(columnName));

    const pickRowValues = (row: Record<string, unknown>): Record<string, unknown> => {
      if (normalizedColumns.length === 0) {
        return { ...row };
      }

      const picked: Record<string, unknown> = {};
      normalizedColumns.forEach((columnName) => {
        picked[columnName] = row[columnName];
      });
      return picked;
    };

    if (format === 'json') {
      return JSON.stringify(rows.map((row) => pickRowValues(row)), null, 2);
    }

    const escapeCsv = (value: unknown): string => {
      if (value === null || value === undefined) {
        return '';
      }

      const text =
        typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
      if (!/[",\n\r]/.test(text)) {
        return text;
      }

      return `"${text.replace(/"/g, '""')}"`;
    };

    const header = normalizedColumns.map((columnName) => escapeCsv(columnName)).join(',');
    const lines = rows.map((row) => {
      const source = pickRowValues(row);
      return normalizedColumns.map((columnName) => escapeCsv(source[columnName])).join(',');
    });

    return [header, ...lines].join('\n');
  }

  private isTimeoutError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('etimedout')
    );
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private panelKey(_node: DbObjectNodeRef, _newTab: boolean): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  private defaultState(): TableState {
    return {
      searchText: '',
      searchMode: 'local',
      sortColumn: undefined,
      sortDirection: undefined,
      columnFilters: {},
      limit: this.getDefaultPageSize(),
      page: 1,
    };
  }

  private cloneTableState(state: TableState): TableState {
    return {
      searchText: String(state.searchText || ''),
      searchMode: state.searchMode === 'query' ? 'query' : 'local',
      sortColumn: state.sortColumn,
      sortDirection: state.sortDirection,
      columnFilters: { ...(state.columnFilters || {}) },
      limit: Number.isFinite(Number(state.limit)) ? Math.max(1, Math.trunc(Number(state.limit))) : this.getDefaultPageSize(),
      page: Number.isFinite(Number(state.page)) ? Math.max(1, Math.trunc(Number(state.page))) : 1,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erro inesperado';
  }

  private layoutStorageKey(node: DbObjectNodeRef): string {
    return [
      'dbadmin.tableLayout',
      node.connection.id,
      node.databaseName,
      node.schemaName,
      node.objectName,
    ].join(':');
  }

  private readStoredLayout(node: DbObjectNodeRef): TableLayoutState | undefined {
    return this.context.globalState.get<TableLayoutState>(this.layoutStorageKey(node));
  }

  private async persistLayout(node: DbObjectNodeRef, layout: TableLayoutState): Promise<void> {
    await this.context.globalState.update(this.layoutStorageKey(node), layout);
  }

  private getShowQueryEditor(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(SHOW_QUERY_SETTING, true);
  }

  private getHideTabHeader(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(HIDE_TAB_HEADER_SETTING, false);
  }

  private getPersistLayoutOutsideRestore(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(PERSIST_LAYOUT_SETTING, false);
  }

  private getDefaultPageSize(): number {
    const configured = vscode.workspace.getConfiguration().get<number>(DEFAULT_PAGE_SIZE_SETTING, 50);
    const numeric = Number(configured);
    if (!Number.isFinite(numeric)) {
      return 50;
    }
    return Math.max(1, Math.min(500, Math.trunc(numeric)));
  }

  private getDynamicDefaultColumnWidth(): boolean {
    return vscode.workspace
      .getConfiguration()
      .get<boolean>(DYNAMIC_DEFAULT_COLUMN_WIDTH_SETTING, true);
  }

  public notifyQueryVisibilityChanged(): void {
    const showQueryEditor = this.getShowQueryEditor();
    this.panelNodes.forEach((_node, panel) => {
      panel.webview.postMessage({
        type: 'queryVisibility',
        showQueryEditor,
      });
    });
  }

  public notifyHeaderVisibilityChanged(): void {
    const hideTabHeader = this.getHideTabHeader();
    this.panelNodes.forEach((_node, panel) => {
      panel.webview.postMessage({
        type: 'headerVisibility',
        hideTabHeader,
      });
    });
  }

  private async updateNativePreviewContent(
    state: NativeJsonPreviewState,
    content: string,
    options?: { preserveFocus?: boolean }
  ): Promise<void> {
    const formatted = state.isJson ? this.tryFormatJson(String(content ?? '')) : String(content ?? '');
    if (state.document.getText() === formatted) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      state.document.positionAt(0),
      state.document.positionAt(state.document.getText().length)
    );
    edit.replace(state.document.uri, fullRange, formatted);
    await vscode.workspace.applyEdit(edit);
  }

  private async clearNativePreviewContent(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.panelNativePreview.get(panel);
    if (!state) {
      return;
    }
    await this.updateNativePreviewContent(state, '', { preserveFocus: true });
    state.ctid = null;
    state.rowKey = null;
  }

  private sanitizeFileNamePart(value: string): string {
    const sanitized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return sanitized || 'na';
  }

  private getOrCreatePanelPreviewTabId(panel: vscode.WebviewPanel): string {
    const existing = this.panelPreviewTabIds.get(panel);
    if (existing) {
      return existing;
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    this.previewTabIdSequence += 1;
    this.panelPreviewTabIds.set(panel, id);
    return id;
  }

  private getNativePreviewFilePrefix(panel: vscode.WebviewPanel): string {
    const node = this.panelNodes.get(panel);
    const tablePart = this.sanitizeFileNamePart(node?.objectName ?? 'tabela');
    const tabId = this.sanitizeFileNamePart(this.getOrCreatePanelPreviewTabId(panel));
    return `${tablePart}_dbadmin_${tabId}`;
  }

  private cleanupNativePreviewTempFilesByPrefix(prefix: string, keepPath?: string): void {
    try {
      const tmpDir = os.tmpdir();
      const keep = keepPath ? path.normalize(keepPath).toLowerCase() : null;
      const entries = fs.readdirSync(tmpDir);
      for (const entry of entries) {
        const isTarget =
          entry.startsWith(prefix) && (entry.endsWith('.json') || entry.endsWith('.txt'));
        if (!isTarget) {
          continue;
        }
        const fullPath = path.join(tmpDir, entry);
        const normalized = path.normalize(fullPath).toLowerCase();
        if (keep && normalized === keep) {
          continue;
        }
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Ignore inaccessible files during prefix cleanup.
        }
      }
    } catch {
      // Ignore cleanup issues.
    }
  }

  private async createNativePreviewTempDocument(
    panel: vscode.WebviewPanel,
    content: string,
    isJson: boolean
  ): Promise<{ document: vscode.TextDocument; tmpFilePath: string; tmpFilePrefix: string }> {
    const formattedContent = isJson ? this.tryFormatJson(String(content ?? '')) : String(content ?? '');
    const extension = isJson ? 'json' : 'txt';
    const tmpFilePrefix = this.getNativePreviewFilePrefix(panel);
    const tmpFilePath = path.join(os.tmpdir(), `${tmpFilePrefix}.${extension}`);
    fs.writeFileSync(tmpFilePath, formattedContent, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpFilePath));
    return { document, tmpFilePath, tmpFilePrefix };
  }

  private isNativePreviewTempPath(fsPath: string): boolean {
    const name = path.basename(fsPath).toLowerCase();
    const isLegacy =
      name.startsWith('dbmanager_preview_') && (name.endsWith('.json') || name.endsWith('.txt'));
    const isNamedByPrefix =
      (name.includes('_dbmanaget_preview_') || name.includes('_db_manager_') || name.includes('_dbadmin_')) &&
      (name.endsWith('.json') || name.endsWith('.txt'));
    return isLegacy || isNamedByPrefix;
  }

  private async closeDocumentTabByUri(uri: vscode.Uri): Promise<void> {
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((candidate) => {
        const input = candidate.input;
        return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
      });

    if (tab) {
      await vscode.window.tabGroups.close(tab, true);
      return;
    }

    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === uri.toString()
    );
    if (!editor) {
      return;
    }

    await vscode.window.showTextDocument(editor.document, {
      preview: false,
      preserveFocus: true,
      viewColumn: editor.viewColumn,
    });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }

  private scrollNativePreviewToTop(document: vscode.TextDocument): void {
    const top = new vscode.Position(0, 0);
    const topRange = new vscode.Range(top, top);
    vscode.window.visibleTextEditors.forEach((editor) => {
      if (editor.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      editor.selection = new vscode.Selection(top, top);
      editor.revealRange(topRange, vscode.TextEditorRevealType.AtTop);
    });
  }

  private isDocumentActiveInEditor(document: vscode.TextDocument): boolean {
    return vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString();
  }

  private getVisibleEditorForDocument(document: vscode.TextDocument): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === document.uri.toString()
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
    forceOpen: boolean
  ): Promise<void> {
    const isJson = payload.isJson !== false;
    let state = this.panelNativePreview.get(panel);
    let switchedTypeWithNewEditor = false;

    if (!state && !forceOpen && payload.open !== true) {
      return;
    }

    if (!state) {
      const { document, tmpFilePath, tmpFilePrefix } = await this.createNativePreviewTempDocument(
        panel,
        payload.content,
        isJson
      );
      this.cleanupNativePreviewTempFilesByPrefix(tmpFilePrefix, tmpFilePath);

      try {
        await vscode.commands.executeCommand('workbench.action.splitEditorDown');
      } catch {
        // Fallback: open beside if split command is unavailable.
      }

      const shownEditor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: payload.preserveFocus === true,
        viewColumn: vscode.ViewColumn.Active,
      });

      state = {
        document,
        tmpFilePath,
        tmpFilePrefix,
        isJson,
        ctid: payload.ctid ?? null,
        rowKey: payload.rowKey ?? null,
        columnName: payload.columnName,
        viewColumn: shownEditor.viewColumn,
      };
      this.panelNativePreview.set(panel, state);
      this.nativePreviewDocumentToPanel.set(document.uri.toString(), panel);

      if (payload.preserveFocus) {
        panel.reveal(panel.viewColumn, false);
        panel.webview.postMessage({ type: 'restoreGridFocus' });
      }
      return;
    }

    if (state.isJson !== isJson) {
      const previousDocumentUri = state.document.uri.toString();
      const previousDocumentFileUri = state.document.uri;
      const previousTempFilePath = state.tmpFilePath;
      const previousEditor = vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.toString() === previousDocumentUri
      );
      const nextViewColumn = previousEditor?.viewColumn ?? vscode.ViewColumn.Active;

      const { document, tmpFilePath, tmpFilePrefix } = await this.createNativePreviewTempDocument(
        panel,
        payload.content,
        isJson
      );

      this.nativePreviewDocumentToPanel.delete(previousDocumentUri);
      this.nativePreviewDocumentToPanel.set(document.uri.toString(), panel);

      state.document = document;
      state.tmpFilePath = tmpFilePath;
      state.tmpFilePrefix = tmpFilePrefix;
      state.isJson = isJson;

      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn: nextViewColumn,
      });

      await this.closeDocumentTabByUri(previousDocumentFileUri);

      try {
        fs.unlinkSync(previousTempFilePath);
      } catch {
        // Previous temp file may already be removed.
      }
      this.cleanupNativePreviewTempFilesByPrefix(tmpFilePrefix, tmpFilePath);

      switchedTypeWithNewEditor = true;
    }

    state.isJson = isJson;
    state.ctid = payload.ctid ?? null;
    state.rowKey = payload.rowKey ?? null;
    state.columnName = payload.columnName;
    await this.updateNativePreviewContent(state, payload.content, {
      preserveFocus: !forceOpen,
    });

    if (!forceOpen && !this.isDocumentActiveInEditor(state.document)) {
      this.scrollNativePreviewToTop(state.document);
    }

    if (!forceOpen && switchedTypeWithNewEditor) {
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
    }

    if (forceOpen && !switchedTypeWithNewEditor) {
      const existingVisibleEditor = this.getVisibleEditorForDocument(state.document);
      if (!existingVisibleEditor) {
        try {
          await vscode.commands.executeCommand('workbench.action.splitEditorDown');
        } catch {
          // Fallback: keep current group when split command is unavailable.
        }
      }

      const targetViewColumn = existingVisibleEditor?.viewColumn ?? vscode.ViewColumn.Active;

      const shownEditor = await vscode.window.showTextDocument(state.document, {
        preview: false,
        preserveFocus: payload.preserveFocus === true,
        viewColumn: targetViewColumn,
      });
      state.viewColumn = shownEditor.viewColumn;

      if (payload.preserveFocus) {
        panel.reveal(panel.viewColumn, false);
        panel.webview.postMessage({ type: 'restoreGridFocus' });
      }
    }
  }

  private handleNativePreviewDocumentSave(document: vscode.TextDocument): void {
    const panel = this.nativePreviewDocumentToPanel.get(document.uri.toString());
    if (!panel) {
      return;
    }

    const state = this.panelNativePreview.get(panel);
    if (!state || state.document.uri.toString() !== document.uri.toString()) {
      this.nativePreviewDocumentToPanel.delete(document.uri.toString());
      return;
    }

    panel.webview.postMessage({
      type: 'nativeJsonPreviewContentChanged',
      content: document.getText(),
      ctid: state.ctid,
      rowKey: state.rowKey,
      columnName: state.columnName,
    });
  }

  private handleNativePreviewDocumentClose(document: vscode.TextDocument): void {
    if (this.isNativePreviewTempPath(document.uri.fsPath)) {
      try {
        fs.unlinkSync(document.uri.fsPath);
      } catch {
        // Temp preview file may already be removed.
      }
    }

    const panel = this.nativePreviewDocumentToPanel.get(document.uri.toString());
    if (!panel) {
      return;
    }
    this.clearNativePreviewState(panel);
  }

  private async closeAndClearNativePreviewState(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.panelNativePreview.get(panel);
    if (!state) {
      return;
    }

    try {
      await this.closeDocumentTabByUri(state.document.uri);
    } catch {
      // Best effort: still clear state if closing the editor tab fails.
    }

    this.clearNativePreviewState(panel);
  }

  private clearNativePreviewState(panel: vscode.WebviewPanel): void {
    const state = this.panelNativePreview.get(panel);
    if (!state) {
      return;
    }
    this.nativePreviewDocumentToPanel.delete(state.document.uri.toString());
    this.panelNativePreview.delete(panel);
    try {
      fs.unlinkSync(state.tmpFilePath);
    } catch {
      // Temp file may already be gone or locked.
    }
    this.cleanupNativePreviewTempFilesByPrefix(state.tmpFilePrefix);
  }

  private cleanupStaleNativePreviewTempFiles(): void {
    try {
      const tmpDir = os.tmpdir();
      const openDocs = new Set(
        vscode.workspace.textDocuments.map((doc) => path.normalize(doc.uri.fsPath).toLowerCase())
      );
      const entries = fs.readdirSync(tmpDir);
      for (const entry of entries) {
        const isLegacy = entry.startsWith('dbmanager_preview_');
        const isNamedByPrefix =
          entry.includes('_dbmanaget_preview_') ||
          entry.includes('_db_manager_') ||
          entry.includes('_dbadmin_');
        if (!isLegacy && !isNamedByPrefix) {
          continue;
        }
        if (!entry.endsWith('.json') && !entry.endsWith('.txt')) {
          continue;
        }
        const fullPath = path.join(tmpDir, entry);
        const normalized = path.normalize(fullPath).toLowerCase();
        if (openDocs.has(normalized)) {
          continue;
        }
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Ignore inaccessible files in temp cleanup.
        }
      }
    } catch {
      // Ignore temp cleanup issues.
    }
  }

  private tryFormatJson(content: string): string {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }

  private saveOpenTabs(): void {
    const openTabs = Array.from(this.panelNodes.entries())
      .map(([panel, node]) => {
        if (!node || !node.connection) {
          return null;
        }

        return {
          connectionId: node.connection.id,
          databaseName: node.databaseName,
          schemaName: node.schemaName,
          objectName: node.objectName,
          newTab: this.panelIsNewTab.get(panel) ?? false,
          layout: this.panelLayouts.get(panel),
          state: this.cloneTableState(this.panelStates.get(panel) ?? this.defaultState()),
        };
      })
      .filter((tab): tab is {
        connectionId: string;
        databaseName: string;
        schemaName: string;
        objectName: string;
        newTab: boolean;
        layout: TableLayoutState | undefined;
        state: TableState;
      } => tab !== null);

    this.context.globalState.update('dbadmin.openTabs', openTabs);
  }

  public async restoreOpenTabs(store: ConnectionStore): Promise<void> {
    try {
      const openTabs = this.context.globalState.get('dbadmin.openTabs', []) as Array<{
        connectionId: string;
        databaseName: string;
        schemaName: string;
        objectName: string;
        newTab: boolean;
        layout?: TableLayoutState;
        state?: TableState;
      }>;

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
            type: 'dbObject',
            kind: 'table',
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
            initialState: this.cloneTableState(tab.state ?? this.defaultState()),
          });
        } catch (error) {
          console.error(`Falha ao restaurar aba ${tab.objectName}:`, error);
        }
      }
    } catch (error) {
      console.error('Falha ao restaurar abas abertas:', error);
    }
  }

  private buildHtml(
    webview: vscode.Webview,
    initialShowQueryEditor: boolean = true,
    initialHideTabHeader: boolean = false
  ): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    const defaultPageSize = this.getDefaultPageSize();
    const codeEditorStyles = buildCodeEditorStyles();
    const codeEditorMarkup = buildCodeEditorMarkup();
    const codeEditorScript = buildCodeEditorScript();
    const codiconsCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    const initialDynamicDefaultColumnWidth = this.getDynamicDefaultColumnWidth();

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconsCssUri}" rel="stylesheet" />
  <style>
    html, body { height: 100%; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; overflow: hidden; }
    .shell { height: 100vh; min-height: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; margin-top: 2px; position: relative; }
    .loading-bar { position: fixed; top: 0; left: 0; right: 0; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; transition: opacity 120ms ease; z-index: 90; }
    .loading-bar.active { opacity: 1; }
    .loading-bar::before { content: ''; position: absolute; top: 0; left: 0; height: 100%; width: 21%; background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); animation: dbadmin-loading 2s ease-in-out infinite; }
    @keyframes dbadmin-loading {
      0% { left: -21%; }
      100% { left: 100%; }
    }
    .header { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 0px 4px; }
    .title { font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .title svg { width: 14px; height: 14px; margin-top: 4px; }
    .title .info-item { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
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
    .query:focus { border-color: var(--vscode-focusBorder); }
    .query { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent) transparent; }
    .query::-webkit-scrollbar { width: 8px; height: 8px; }
    .query::-webkit-scrollbar-button { display: none; }
    .query::-webkit-scrollbar-track { background: transparent; }
    .query::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
    .query::-webkit-scrollbar-corner { background: transparent; }
    .query-resizer { position: absolute; right: 5px; bottom: 4px; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; cursor: ns-resize; user-select: none; }
    .query-resizer svg { width: 14px; height: 14px; pointer-events: none; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 4px; flex: 0 0 auto; }
    #toolbarMenuBtn { display: none; margin-left: auto; }
    body.header-hidden .header { display: none; }
    body.header-hidden #toolbarMenuBtn { display: inline-flex; }
    .grow { flex: 1 1 150px; min-width: 150px; }
    .search-wrap { position: relative; }
    .search-wrap .input { width: 100%; }
    .search-context-placeholder {
      position: absolute;
      inset: 0;
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
    }
    .search-context-placeholder svg { width: 12px; height: 12px; flex: 0 0 auto; }
    .search-context-placeholder .info-item { display: inline-flex; align-items: center; gap: 0; min-width: 0; }
    .search-context-placeholder .info-fixed { flex: 0 0 auto; white-space: nowrap; }
    .search-context-placeholder .info-conn { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .input { border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 0 8px; height: 28px; box-sizing: border-box; }
    .btn-icon-fix { padding: 0px 0px 2px 0px !important; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; padding: 0 10px; height: 28px; cursor: pointer; box-sizing: border-box; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-button-border, transparent); }
    button:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset; }
    #pageInfo { white-space: nowrap; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 28px; }
    .mode-select { position: relative; display: inline-flex; }
    .header-menu { z-index: 40; min-width: 180px; }
    .header-menu button:last-child,
    .mode-dropdown button:last-child,
    .menu > button:last-child,
    .menu-submenu > button:last-child { border-bottom: 0; }
    .mode-dropdown { z-index: 20; min-width: 170px; }
    .columns-popup { width: 280px; max-height: 60vh; overflow: auto; z-index: 60; }
    #modeBackdrop { z-index: 19; }
    #headerMenuBackdrop { z-index: 39; }
    #menuBackdrop { z-index: 49; }
    #columnsBackdrop { z-index: 59; }
    .columns-popup-head { position: sticky; top: 0; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 10px; }
    .columns-search { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 0 8px; height: 26px; }
    .columns-search:focus { border-color: var(--vscode-focusBorder); outline: none; }
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
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 2px 6px; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 2; min-width: 170px; box-sizing: border-box; }
    .th-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0px 5px 0px 0px; cursor: grab; }
    .th-name { font-weight: 600; font-size: 12px; cursor: inherit; flex: 1 1 auto; min-width: 0; text-align: left; border-radius: 4px; padding-left: 5px; }
    th.col-drag-over { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .th-resizer { position: absolute; top: 0; right: 0; width: 8px; height: 100%; cursor: col-resize; user-select: none; border-radius: 2px; transition: background 120ms ease; }
    .th-resizer::before { content: ''; position: absolute; top: 2px; bottom: 2px; right: 0px; width: 1px; background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
    .th-name:hover:not(:active) { background: var(--vscode-list-hoverBackground); }
    body.col-resizing, body.col-resizing * { cursor: col-resize !important; }
    .th-icons { cursor: pointer; user-select: none; border-radius: 4px; }
    .th-icons-char { padding: 0px 6px; }
    .th-icons-svg { padding: 0px 2px; }
    .th-icons:hover { background: var(--vscode-list-hoverBackground); }
    .th-filter { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); border-radius: 4px; padding: 4px; font-size: 11px; }
    .th-filter:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .cell-input { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); border-radius: 4px; padding: 4px; }
    .cell-input:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
    .cell-input.dirty { background: rgba(70, 130, 255, 0.18); border-color: rgba(70, 130, 255, 0.62); }
    .json-cell { position: relative; }
    .json-open-btn {
      position: absolute;
      right: 6px;
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
      z-index: 5;
    }
    .cell-action-btn:hover:not(:disabled),
    .cell-action-btn:focus-visible {
      border-color: transparent;
      box-shadow: none;
      outline: none;
    }
    .json-cell:hover .json-open-btn,
    .json-cell:focus-within .json-open-btn { opacity: 1; pointer-events: auto; }
    .json-open-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      border-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    }
    .cell-input.editing + .json-open-btn {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .json-open-btn svg { width: 12px; height: 12px; }
    .json-open-btn svg path { stroke-width: 1.45; }
    tr.row-added td { background: rgba(46, 160, 67, 0.12); }
    tr.row-removed td { background: rgba(220, 53, 69, 0.16); }
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
    .menu-submenu-wrap > button { justify-content: space-between; gap: 12px; }
    .menu-submenu-wrap.submenu-open > button { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .submenu-chevron { width: 14px; height: 14px; color: var(--vscode-descriptionForeground); flex: 0 0 auto; }
    .btn-icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }
    .btn-icon svg { width: 14px; height: 14px; }
    .btn-icon .codicon { font-size: 14px; }
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
    .selection-col { width: 24px; min-width: 24px; max-width: 24px; padding: 2px 0 !important; }
    td.selection-col { position: relative; }
    .selection-cell { cursor: pointer; }
    .selection-cell-index {
      display: block;
      width: 100%;
      text-align: center;
      font-size: 10px;
      line-height: 1.2;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 85%, transparent);
      user-select: none;
      pointer-events: none;
      position: relative;
      z-index: 1;
    }
    .selection-cell.selected { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 50%, transparent); }
    th.selection-col:hover::before,
    td.selection-cell:not(.selected):hover::before {
      content: '';
      position: absolute;
      inset: 2px 3px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      pointer-events: none;
    }
    .cell-input:not(:focus):not(.editing) { background: transparent !important; border-color: transparent !important; cursor: pointer; pointer-events: none; }
    .cell-input.editing { pointer-events: auto; }
    td.cell-selected { box-shadow: inset 0 0 0 1000px color-mix(in srgb, var(--vscode-foreground) 20%, transparent); }
   td.cell-selected-current-origin::before {
        content: "";
        position: absolute;
        inset: 0;
        border: 2px solid var(--vscode-focusBorder);
        top: -1px;
        bottom: -1px;
        right: -1px;
    }
    tr.row-marked-delete td { background: rgba(220, 53, 69, 0.16); }
    td:has(.cell-input.dirty) { background: rgba(70, 130, 255, 0.16); }
    .th-name:hover:not(:active) { background: var(--vscode-list-hoverBackground); }
    @media (max-height: 500px) {
      .header { display: none; }
      .query-container { display: none; }
      body.header-hidden #toolbarMenuBtn { display: none; }
    }
    @media (max-width: 500px) {
      body.header-hidden #toolbarMenuBtn { display: none; }
    }
  </style>
</head>
<body class="${initialHideTabHeader ? "header-hidden" : ""}">
  <div class="shell">
    <div class="loading-bar" id="loadingBar"></div>
    <div class="header">
      <div class="title" id="title">Tabela</div>
      <div class="header-menu-wrap">
        <button id="headerMenuBtn" class="secondary btn-icon btn-icon-fix" title="Menu">☰</button>
      </div>
    </div>

    <div class="query-container">
      <textarea id="query" class="query" rows="1"></textarea>
      <div id="queryResizer" class="query-resizer" title="Redimensionar query" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M6 12.5h4M8 9.5h4M10 6.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>

    <div class="toolbar">
      <div class="search-wrap grow">
        <input id="search" class="input" placeholder="Pesquisar tudo" />
        <div id="searchContextPlaceholder" class="search-context-placeholder" aria-hidden="true"></div>
      </div>
      <button id="clearFiltersBtn" class="secondary btn-icon" title="Limpar filtros" aria-label="Limpar filtros" style="display:none;"></button>
      <div class="mode-select" id="modeSelectWrap">
        <button id="modeBtn" class="secondary btn-icon" title="Modo de busca"></button>
        <div class="mode-dropdown simple-menu overlay-surface overlay-scroll" id="modeDropdown">
          <button data-mode="local"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12l-4.5 5.5V13h-3V8.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>Filtro local</button>
          <button data-mode="query"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4.5" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4.5v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" stroke="currentColor" stroke-width="1.3"/></svg>Filtro via query</button>
        </div>
      </div>
      <input id="limit" class="input" type="number" min="1" max="500" value="${defaultPageSize}" style="width:60px" />
      <button id="columnsBtn" class="secondary btn-icon" title="Selecionar colunas" aria-label="Selecionar colunas">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M1.8 8c1.3-2.2 3.6-3.6 6.2-3.6S12.9 5.8 14.2 8c-1.3 2.2-3.6 3.6-6.2 3.6S3.1 10.2 1.8 8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1"/>
        </svg>
      </button>
      <button id="reload" class="secondary btn-icon" title="Recarregar">↻</button>
      <button id="save" class="btn-icon primary" title="Salvar" aria-label="Salvar">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 2.5h8.5L13.5 4.5v9H3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M5 2.5h5v3H5z" stroke="currentColor" stroke-width="1.2"/>
          <path d="M5 9.5h6v4H5z" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
      <button id="newRow" class="secondary btn-icon btn-icon-fix" title="Nova linha">＋</button>
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="prevPage" class="secondary btn-icon btn-icon-fix" title="Página anterior">←</button>
        <span id="pageInfo"></span>
        <button id="nextPage" class="secondary btn-icon btn-icon-fix" title="Próxima página">→</button>
      </div>
      <button id="toolbarMenuBtn" class="secondary btn-icon btn-icon-fix" title="Menu">☰</button>
    </div>

    <div id="errorMsg"></div>
    <div class="table-wrap" tabindex="-1">
      <table id="grid"></table>
    </div>
  </div>

  <div class="overlay-backdrop" id="columnsBackdrop"></div>
  <div class="columns-popup overlay-surface overlay-scroll" id="columnsPopup" role="dialog" aria-label="Selecionar colunas">
    <div class="columns-popup-head">
      <input id="columnsSearch" class="columns-search" placeholder="Buscar coluna" />
    </div>
    <ul class="columns-list" id="columnsList"></ul>
  </div>

  <div class="overlay-backdrop" id="modeBackdrop"></div>
  <div class="overlay-backdrop" id="headerMenuBackdrop"></div>
  <div id="headerMenu" class="header-menu simple-menu overlay-surface overlay-scroll">
    <button id="openSettings" title="Configurações">
      <span>Configurações</span>
    </button>
    <button id="showInExplorer" title="Mostrar no explorador">
      <span>Mostrar no explorador</span>
    </button>
    <button id="toggleHeaderVisibility" title="Mostrar/Ocultar cabeçalho">
      <span id="toggleHeaderVisibilityLabel">Ocultar cabeçalho</span>
    </button>
    <button id="toggleQueryVisibility" title="Mostrar query">
      <span id="toggleQueryVisibilityLabel">Ocultar query</span>
    </button>
    <button id="openExport" title="Exportar dados">
      <span>Exportar</span>
    </button>
    <button id="resetLayout" title="Restaurar layout da tabela">
      <span>Restaurar layout</span>
    </button>
    <button id="openNewTab" title="Abrir em nova aba">
      <span>Abrir em nova aba</span>
    </button>
  </div>

  <div class="overlay-backdrop" id="menuBackdrop"></div>
  <div class="menu simple-menu overlay-surface overlay-scroll" id="cellMenu">
    <button data-action="copy"><span>Copiar</span></button>
    <div class="menu-submenu-wrap">
      <button type="button"><span>Copiar avancado</span><svg class="submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="menu-submenu simple-menu overlay-surface overlay-submenu">
        <button data-action="copyAdvancedCsv">CSV</button>
        <button data-action="copyAdvancedJson">JSON</button>
      </div>
    </div>
    <div class="menu-submenu-wrap">
      <button type="button"><span>✎ Editar</span><svg class="submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="menu-submenu simple-menu overlay-surface overlay-submenu">
        <button data-action="null">Definir NULL</button>
        <button data-action="empty">Definir texto vazio</button>
        <button data-action="default">Definir DEFAULT</button>
      </div>
    </div>
    <button data-action="duplicate"><span>⧉ Duplicar linha</span></button>
    <button data-action="openNativePreview">
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M3.00024 1H14.0002L15.0002 2V7.30005C14.6855 7.14615 14.3477 7.04476 14.0002 7V2H9.00024V12.88L7.88025 14H3.00024L2.00024 13V2L3.00024 1ZM3.00024 13H8.00024V2H3.00024V13ZM13.3789 8.00202C12.96 8.01773 12.5515 8.13726 12.1902 8.34992H12.1602C11.8707 8.52448 11.6195 8.75571 11.4216 9.02973C11.2237 9.30375 11.0833 9.61487 11.0085 9.94453C10.9338 10.2742 10.9264 10.6156 10.9868 10.9482C11.0473 11.2808 11.1743 11.5977 11.3602 11.88L9.00024 14.2299L9.71021 14.9399L12.0602 12.5799C12.3853 12.8004 12.7597 12.9378 13.1503 12.9799C13.5352 13.0271 13.9257 12.9825 14.2902 12.8499C14.6689 12.7225 15.0117 12.5065 15.2902 12.2199C15.5602 11.9374 15.7591 11.5946 15.8702 11.2199C15.9783 10.8465 16.0021 10.4537 15.9402 10.0699C15.8707 9.68581 15.7133 9.32307 15.4802 9.00996C15.2473 8.6929 14.9422 8.43582 14.5902 8.25996C14.214 8.07495 13.7978 7.98631 13.3789 8.00202ZM13.6199 11.9943C13.2749 12.0285 12.9288 11.9422 12.6403 11.7499C12.3918 11.5822 12.1972 11.3459 12.0802 11.0699C11.9692 10.7974 11.9414 10.4982 12.0002 10.2099C12.0567 9.91792 12.1993 9.64957 12.4095 9.43928C12.6198 9.22898 12.8882 9.08644 13.1802 9.02998C13.4685 8.97115 13.7677 8.99894 14.0402 9.10993C14.3162 9.2269 14.5525 9.42149 14.7202 9.66999C14.9124 9.95851 14.9988 10.3046 14.9646 10.6496C14.9304 10.9946 14.7777 11.3172 14.5326 11.5623C14.2874 11.8075 13.9649 11.9601 13.6199 11.9943Z" fill="currentColor"/>
        </svg>
        <span>Editar em tela dividida</span>
      </span>
    </button>
    <button data-action="remove">
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 4.5h9l-.7 9h-7.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M2.5 4.5h11M6 4.5v-2h4v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        <span>Remover linha</span>
      </span>
    </button>
    <button data-action="new"><span>＋ Criar linha</span></button>
  </div>

  <div class="overlay-backdrop" id="exportModalBackdrop"></div>
  <div class="export-modal" id="exportModal" role="dialog" aria-label="Exportar dados">
    <div class="export-modal-head">Exportar dados</div>
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
          <label class="export-option"><input type="radio" name="exportDataScope" id="exportDataAll" value="all" /><span>Tudo (sem paginacao)</span></label>
          <label class="export-option" id="exportSelectedOption"><input type="radio" name="exportDataScope" id="exportDataSelected" value="selected" /><span>Celulas selecionadas</span></label>
        </div>
      </div>
    </div>
    <div class="export-modal-actions">
      <button id="exportModalCancel" class="secondary">Cancelar</button>
      <button id="exportModalConfirm" class="primary">Exportar</button>
    </div>
  </div>

  <div class="overlay-backdrop json-modal-backdrop" id="jsonModalBackdrop"></div>
  <div class="json-modal" id="jsonModal" role="dialog" aria-label="Conteúdo JSON">
    <div class="json-modal-head">
      <div class="json-modal-head-main">
        <span class="json-modal-title" id="jsonModalTitle">Conteúdo JSON</span>
      </div>
      <div class="json-modal-actions">
        <button id="jsonModalApply" class="primary" title="Aplicar alteracoes">Aplicar</button>
        <button id="jsonModalOpenNative" class="secondary" title="Editar em tela dividida">Tela dividida</button>
        <button id="jsonModalClose" class="secondary">Fechar</button>
      </div>
    </div>
    ${codeEditorMarkup}
  </div>

  <script nonce="${nonce}">${codeEditorScript}</script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const queryContainer = document.querySelector('.query-container');
    const queryEl = document.getElementById('query');
    const loadingBar = document.getElementById('loadingBar');
    const titleEl = document.getElementById('title');
    const gridEl = document.getElementById('grid');
    const queryResizer = document.getElementById('queryResizer');
    const cellMenu = document.getElementById('cellMenu');
    const pageInfoEl = document.getElementById('pageInfo');
    const menuBackdrop = document.getElementById('menuBackdrop');
    const errorMsgEl = document.getElementById('errorMsg');
    const tableWrapEl = document.querySelector('.table-wrap');

    const rangeSelectionOverlay = document.createElement('div');
    rangeSelectionOverlay.style.position = 'absolute';
    rangeSelectionOverlay.style.pointerEvents = 'none';
    rangeSelectionOverlay.style.display = 'none';
    rangeSelectionOverlay.style.border = '1px solid var(--vscode-focusBorder)';
    rangeSelectionOverlay.style.borderRadius = '1px';
    rangeSelectionOverlay.style.zIndex = '10';
    tableWrapEl.style.position = 'relative';
    tableWrapEl.appendChild(rangeSelectionOverlay);

    const searchInputEl = document.getElementById('search');
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
    const headerMenuBtn = document.getElementById('headerMenuBtn');
    const headerMenu = document.getElementById('headerMenu');
    const headerMenuBackdrop = document.getElementById('headerMenuBackdrop');
    const toolbarMenuBtn = document.getElementById('toolbarMenuBtn');
    const openExportBtn = document.getElementById('openExport');
    const toggleQueryVisibilityBtn = document.getElementById('toggleQueryVisibility');
    const toggleQueryVisibilityLabel = document.getElementById('toggleQueryVisibilityLabel');
    const toggleHeaderVisibilityBtn = document.getElementById('toggleHeaderVisibility');
    const toggleHeaderVisibilityLabel = document.getElementById('toggleHeaderVisibilityLabel');
    const resetLayoutBtn = document.getElementById('resetLayout');
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');
    const saveBtn = document.getElementById('save');
    const openNativePreviewActionBtn = cellMenu.querySelector('button[data-action="openNativePreview"]');

    const SVG_LOCAL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12l-4.5 5.5V13h-3V8.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    const SVG_QUERY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4.5" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4.5v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" stroke="currentColor" stroke-width="1.3"/></svg>';
    const SVG_DB = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4v7.5C2.5 12.88 4.96 14 8 14s5.5-1.12 5.5-2.5V4" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 7.5c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5" stroke="currentColor" stroke-width="1.3"/></svg>';
    const SVG_SCHEMA = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3h12v3H2zM2 8h12v5H2z" stroke="currentColor" stroke-width="1.2"/></svg>';
    const SVG_CONNECTION = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M10.723 4H10V1.5C10 1.224 9.776 1 9.5 1C9.224 1 9 1.224 9 1.5V4H7V1.5C7 1.224 6.776 1 6.5 1C6.224 1 6 1.224 6 1.5V4H5.277C4.573 4 4 4.573 4 5.278V8C4 10.036 5.529 11.722 7.5 11.969V14.5C7.5 14.776 7.724 15 8 15C8.276 15 8.5 14.776 8.5 14.5V11.969C10.471 11.722 12 10.037 12 8V5.278C12 4.573 11.427 4 10.723 4ZM11 8C11 9.654 9.654 11 8 11C6.346 11 5 9.654 5 8V5.278C5 5.125 5.124 5 5.277 5H10.722C10.875 5 10.999 5.125 10.999 5.278V8H11Z"/></svg>';
    const SVG_SORT_NONE = '<svg width="16" height="16" viewBox="0 -3 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m8 15 4 4 4-4m0-6-4-4-4 4"/></svg>';
    const SVG_EXTERNAL_LINK = '<svg viewBox="0 0 1 1" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M8 8l5.5-5.5M7 3.5h-2A1.5 1.5 0 0 0 3.5 5v6A1.5 1.5 0 0 0 5 12.5h6a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const SVG_ZOOM_IN = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.0278 6.14861C12.1234 7.56649 11.6685 8.96661 10.7577 10.0575L15.0177 14.3176L14.3178 15.0275L10.0578 10.7575C8.96686 11.6682 7.56674 12.1231 6.14885 12.0275C4.73097 11.9319 3.40461 11.2931 2.44585 10.2442C1.48709 9.19523 0.969739 7.81691 1.00164 6.39617C1.03353 4.97542 1.61212 3.62162 2.61699 2.61675C3.62187 1.61188 4.97566 1.03329 6.39641 1.00139C7.81716 0.969494 9.19548 1.48684 10.2444 2.44561C11.2934 3.40437 11.9321 4.73072 12.0278 6.14861ZM6.57781 11.0375C7.77066 11.0354 8.91402 10.5608 9.75774 9.71758L9.71782 9.7376C10.145 9.32074 10.4851 8.82316 10.7186 8.27385C10.952 7.72455 11.0741 7.13437 11.0778 6.53752C11.0778 5.64751 10.8139 4.77755 10.3194 4.03752C9.82492 3.2975 9.12212 2.72065 8.29985 2.38005C7.47759 2.03946 6.57279 1.95032 5.69988 2.12395C4.82696 2.29758 4.02514 2.72618 3.3958 3.35552C2.76646 3.98485 2.33787 4.78668 2.16423 5.6596C1.9906 6.53251 2.07974 7.4373 2.42034 8.25957C2.76093 9.08184 3.33766 9.78464 4.07769 10.2791C4.81771 10.7736 5.68779 11.0375 6.57781 11.0375ZM9.01773 7.0376V6.0376H7.01773V4.0376H6.01773V6.0376H4.01773V7.0376H6.01773V9.0376H7.01773V7.0376H9.01773Z" fill="currentColor"/></svg>';
    const SVG_CLEAR_ALL = '<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.5004 12.0004C13.7762 12.0006 14.0004 12.2245 14.0004 12.5004C14.0002 12.7761 13.7761 13.0002 13.5004 13.0004H2.50037C2.22449 13.0004 2.00056 12.7762 2.00037 12.5004C2.00037 12.2244 2.22437 12.0004 2.50037 12.0004H13.5004Z"/><path d="M13.5004 9.00037C13.7762 9.00056 14.0004 9.22449 14.0004 9.50037C14.0002 9.77608 13.7761 10.0002 13.5004 10.0004H2.50037C2.22449 10.0004 2.00056 9.7762 2.00037 9.50037C2.00037 9.22437 2.22437 9.00037 2.50037 9.00037H13.5004Z"/><path d="M13.5004 6.00037C13.7762 6.00056 14.0004 6.22449 14.0004 6.50037C14.0002 6.77608 13.7761 7.00017 13.5004 7.00037H7.50037C7.22449 7.00037 7.00056 6.7762 7.00037 6.50037C7.00037 6.22437 7.22437 6.00037 7.50037 6.00037H13.5004Z"/><path d="M5.50037 0.999023C5.63295 0.999115 5.76009 1.05179 5.85388 1.14551C5.94777 1.23939 6.00037 1.36722 6.00037 1.5C6.00027 1.63265 5.94769 1.75971 5.85388 1.85352L3.7074 4L5.85388 6.14551C5.94777 6.23939 6.00037 6.36722 6.00037 6.5C6.00027 6.63265 5.94769 6.75971 5.85388 6.85352C5.76008 6.94732 5.63302 6.99991 5.50037 7C5.36759 7 5.23976 6.9474 5.14587 6.85352L3.00037 4.70703L0.853882 6.85352C0.760077 6.94732 0.633017 6.99991 0.500366 7C0.36759 7 0.239761 6.9474 0.145874 6.85352C0.0521583 6.75972 -0.000519052 6.63258 -0.000610352 6.5C-0.000610354 6.36722 0.0519875 6.23939 0.145874 6.14551L2.29333 4L0.145874 1.85352C0.0521583 1.75972 -0.000519119 1.63258 -0.000610352 1.5C-0.000610351 1.36722 0.0519874 1.23939 0.145874 1.14551C0.239761 1.05162 0.36759 0.999023 0.500366 0.999023C0.63295 0.999115 0.76009 1.05179 0.853882 1.14551L3.00037 3.29297L5.14587 1.14551C5.23976 1.05162 5.36759 0.999023 5.50037 0.999023Z"/><path d="M13.5004 3.00037C13.7762 3.00056 14.0004 3.22449 14.0004 3.50037C14.0002 3.77608 13.7761 4.00017 13.5004 4.00037H7.50037C7.22449 4.00037 7.00056 3.7762 7.00037 3.50037C7.00037 3.22437 7.22437 3.00037 7.50037 3.00037H13.5004Z"/></svg>';
    const SVG_GO_TO_FILE = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.58594 1.00098C8.98394 1.00098 9.36646 1.15943 9.64746 1.44043L12.5605 4.35352C12.8415 4.63552 13.001 5.01704 13.001 5.41504V13.001C13.001 14.106 12.106 15.001 11.001 15.001H5.00098C3.89599 15.001 3.00098 14.106 3.00098 13.001V6.00098H4.00098V13.001C4.00098 13.553 4.44899 14.001 5.00098 14.001H11.001C11.553 14.001 12.001 13.553 12.001 13.001V6.00098H9.50098C8.67299 6.00096 8.00098 5.32897 8.00098 4.50098V2.00098C7.99198 1.97699 7.98265 1.9527 7.97266 1.92871C7.89674 1.74704 7.78717 1.5812 7.64746 1.44238L7.20605 1.00098H8.58594ZM9 4.5C9 4.776 9.224 5 9.5 5H11.793L9 2.20703V4.5Z"/><path d="M4.5 0C4.63299 0 4.75952 0.0534683 4.85352 0.147461L6.85352 2.14746C6.90042 2.19336 6.93789 2.24775 6.96289 2.30859C6.98789 2.36959 7.00097 2.43498 7.00098 2.50098C7.00098 2.56698 6.98789 2.63236 6.96289 2.69336C6.93789 2.75323 6.90043 2.80956 6.85352 2.85547L4.85352 4.85547C4.75956 4.94917 4.63278 5.00195 4.5 5.00195C4.36722 5.00195 4.24044 4.94917 4.14648 4.85547C4.05248 4.76147 3.99902 4.63398 3.99902 4.50098C3.99903 4.36799 4.05249 4.24146 4.14648 4.14746L5.29297 3.00098H2.5C2.10201 3.00098 1.72045 3.15944 1.43945 3.44043C1.15846 3.72242 1.00001 4.10298 1 4.50098V5.50098C1 5.63398 0.947516 5.76147 0.853516 5.85547C0.759563 5.94817 0.632774 6.00098 0.5 6.00098C0.367225 6.00098 0.240437 5.94917 0.146484 5.85547C0.0534844 5.76147 0 5.63398 0 5.50098V4.50098C6.17892e-06 3.83799 0.263427 3.20239 0.732422 2.7334C1.20142 2.26441 1.83701 2.00098 2.5 2.00098H5.29297L4.14648 0.855469C4.05248 0.761469 3.99902 0.633977 3.99902 0.500977C3.99903 0.367985 4.05249 0.241455 4.14648 0.147461C4.24048 0.0534683 4.36701 0 4.5 0Z"/></svg>';

    if (clearFiltersBtn) {
      clearFiltersBtn.innerHTML = SVG_CLEAR_ALL;
    }
    
    function updateModeIcon() {
      modeBtn.innerHTML = state.searchMode === 'query' ? SVG_QUERY : SVG_LOCAL;
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

        this.backdropEl.addEventListener('click', (event) => {
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
    let showQueryEditor = ${initialShowQueryEditor ? "true" : "false"};
    let hideTabHeader = ${initialHideTabHeader ? "true" : "false"};
    let dynamicDefaultColumnWidth = ${initialDynamicDefaultColumnWidth ? "true" : "false"};
    let currentDatabaseName = '';
    let currentSchemaName = '';
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
        beginStickyFocus(event.target);
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement) {
        lastPointerTarget = event.target;
        beginStickyFocus(event.target);
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
      if (!queryContainer) {
        return;
      }

      queryContainer.style.display = showQueryEditor ? '' : 'none';
      toggleQueryVisibilityLabel.textContent = showQueryEditor ? 'Ocultar query' : 'Mostrar query';
    }

    function applyHeaderVisibility() {
      document.body.classList.toggle('header-hidden', hideTabHeader);
      toggleHeaderVisibilityLabel.textContent = hideTabHeader ? 'Mostrar cabeçalho' : 'Ocultar cabeçalho';
      updateSearchContextPlaceholder();
    }

    function updateSearchContextPlaceholder() {
      if (!searchInputEl || !searchContextPlaceholderEl) {
        return;
      }

      const hasSearchText = String(searchInputEl.value || '').length > 0;
      const isCompactHeight = window.innerHeight <= 500;
      const canShowContext = hideTabHeader && !hasSearchText && !isCompactHeight;

      searchInputEl.placeholder = canShowContext ? '' : 'Pesquisar tudo';

      if (!canShowContext) {
        searchContextPlaceholderEl.style.display = 'none';
        searchContextPlaceholderEl.innerHTML = '';
        return;
      }

      const dbLabel = currentDatabaseName || 'Banco';
      const schemaLabel = currentSchemaName || 'Schema';
      const connectionLabel = currentConnectionName || 'Conexão';
      searchContextPlaceholderEl.innerHTML =
        '<span class="info-item info-fixed"><span style="margin: 4px 2px 0 0;">' + SVG_DB + '</span><span>' + dbLabel + '</span></span>' +
        '<span class="info-item info-fixed"><span style="margin: 4px 2px 0 0;">' + SVG_SCHEMA + '</span><span>' + schemaLabel + '</span></span>' +
        '<span class="info-item info-conn">' + SVG_CONNECTION + '<span>' + connectionLabel + '</span></span>';
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
      const hasInserted = insertedRows.some((row) => !row.__dbadmin_removed);
      return editedRows.size > 0 || hasInserted || removedCtids.size > 0;
    }

    function updateSaveButtonState() {
      saveBtn.disabled = !hasChanges();
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

    function isBigIntType(column) {
      const dataType = String(column?.dataType || '').toLowerCase();
      return dataType === 'bigint' || dataType === 'int8';
    }

    function isBooleanType(column) {
      const dataType = String(column?.dataType || '').toLowerCase();
      return dataType === 'boolean' || dataType === 'bool';
    }

    function isNumericColumn(column) {
      const dataType = String(column?.dataType || '').toLowerCase();
      const numericTypes = [
        'smallint', 'int2',
        'integer', 'int', 'int4',
        'bigint', 'int8',
        'decimal', 'numeric',
        'real', 'float4',
        'double precision', 'float8',
        'money',
        'serial', 'serial4',
        'serial8', 'bigserial',
      ];
      return numericTypes.includes(dataType);
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



    function applyCellValue(row, column, ctid, nextValue, input) {
      const nextInputValue = toCellInputText(nextValue, column);
      const baseCurrentText = toCellInputText(row[column.name], column);

      if (input) {
        input.value = nextInputValue;
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

      updateSaveButtonState();
    }

    function applyJsonModalChanges(closeAfterApply) {
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
      anchorEl: headerMenuBtn,
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

    function closeHeaderMenu() {
      headerMenuOverlay.close();
    }

    function closeModeDropdown() {
      modeDropdownOverlay.close();
    }

    function closeColumnsPopup() {
      columnsPopupOverlay.close();
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
      allLabel.textContent = 'Todos';
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
      cellMenuOverlay.open({ x: clientX, y: clientY });
    }

    function syncControls() {
      searchInputEl.value = state.searchText;
      document.getElementById('limit').value = String(state.limit);
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
        limit: Number(document.getElementById('limit').value || ${defaultPageSize}),
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
      document.getElementById('prevPage').disabled = state.page <= 1;
      document.getElementById('nextPage').disabled = state.page >= totalPages;
    }

    function enableCellEditing(input) {
      if (editingCellInput) {
        editingCellInput.classList.remove('editing');
      }
      editingCellInput = input;
      input.classList.add('editing');
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
      currentRangeSelection = null;
      if (!preserveExisting) {
        selectedCells.clear();
      }
      selectedCells.set(rowKey, new Set(displayColumns.map((col) => col.name)));
      syncSelectionCountsFromSelectedCells();
      if (displayColumns.length > 0) {
        lastSelectedCell = { rowKey, colName: displayColumns[0].name };
      }
    }

    function cloneSelectionMap(source) {
      const clone = new Map();
      source.forEach((set, rowKey) => {
        clone.set(rowKey, new Set(set));
      });
      return clone;
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
      currentRangeSelection = null;
      if (rowSelectionDragAnchorIndex === null) {
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
        selectedCells.set(rk, new Set(displayColumns.map((col) => col.name)));
      }
      if (displayColumns.length > 0) {
        const lastRowKey = displayedRowKeys[currentRowIndex];
        if (lastRowKey) {
          lastSelectedCell = { rowKey: lastRowKey, colName: displayColumns[0].name };
        }
      }
      syncSelectionCountsFromSelectedCells();
      renderSelectionState();
    }

    function markSelectedRowsForDelete() {
      selectedCells.forEach((_cols, rowKey) => {
        const ctid = rowKeyToCtid.get(rowKey);
        if (ctid) {
          removedCtids.add(ctid);
        }
      });
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
          tdMap.forEach((td, colName) => {
            td.classList.toggle('cell-selected', Boolean(cellSet && cellSet.has(colName)));
            td.classList.toggle('cell-selected-current-origin', Boolean(range && rowKey === originRowKey && colName === originColName));
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
          const overlayTop = topRect.top - wrapRect.top + tableWrapEl.scrollTop - 2;
          const overlayLeft = leftRect.left - wrapRect.left + tableWrapEl.scrollLeft;
          const overlayWidth = (rightRect.right - leftRect.left) - 1;
          const overlayHeight = (bottomRect.bottom - topRect.top) - 1;

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

      if (tdRect.left < wrapRect.left) {
        const isFirstCell = colName === displayedColNames[0];
        if (isFirstCell) {
          tableWrapEl.scrollLeft = 0;
        } else {
          tableWrapEl.scrollLeft -= (wrapRect.left - tdRect.left);
        }
      } else if (tdRect.right > wrapRect.right - 15) {
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
      } else {
        value = getSelectedCellsText();
      }

      if (!value) {
        value = getFocusedCellFallbackText();
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
        currentRangeSelection = null;
        selectedCells.clear();
        visibleRows.forEach((row, rowIndex) => {
          const rk = row.__dbadmin_ctid || ('new:' + rowIndex);
          selectedCells.set(rk, new Set(displayColumns.map((c) => c.name)));
        });
        syncSelectionCountsFromSelectedCells();
        renderSelectionState();
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
        } else if (!dynamicDefaultColumnWidth || shouldUseMinimumColumnWidth(col, getLongestVisibleCellLength(col, visibleRows))) {
          const minWidth = getDefaultColumnWidth(col, visibleRows);
          th.style.width = minWidth + 'px';
          th.style.minWidth = minWidth + 'px';
          th.style.maxWidth = minWidth + 'px';
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
          currentRangeSelection = null;

          const displayedRows = applyLocalFilter(rows);
          selectedCells.clear();
          displayedRows.forEach((row, rowIndex) => {
            const rowKey = row.__dbadmin_ctid || ('new:' + rowIndex);
            if (!selectedCells.has(rowKey)) {
              selectedCells.set(rowKey, new Set());
            }
            selectedCells.get(rowKey).add(col.name);
            lastSelectedCell = { rowKey, colName: col.name };
          });
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
        right.classList.add(state.sortColumn === col.name ? 'th-icons-char' : 'th-icons-svg');
        right.innerHTML = state.sortColumn === col.name
          ? (state.sortDirection === 'desc' ? '↓' : '↑')
          : SVG_SORT_NONE;
        right.addEventListener('click', () => {
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

        th.appendChild(title);
        th.appendChild(filterInput);

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
          notifyLayoutChanged();
        });

        th.appendChild(resizer);
        headRow.appendChild(th);
      });

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
          isRowSelectionDragging = true;
          rowSelectionDragPreserve = event.ctrlKey || event.metaKey;
          rowSelectionDragAnchorIndex = rowIndex;
          rowSelectionDragBaseSelection = rowSelectionDragPreserve ? cloneSelectionMap(selectedCells) : new Map();
          applyRowSelectionDragRange(rowIndex, displayColumns);
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
          inputElements.get(rowKey).set(col.name, input);
          tdElements.get(rowKey).set(col.name, td);

          const baseCurrent = row[col.name];
          const baseCurrentText = toCellInputText(baseCurrent, col);
          const effectiveCurrent = getEffectiveCellValue(row, col.name, ctid);
          input.value = toCellInputText(effectiveCurrent, col);

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
            updateSaveButtonState();
          });

          // Mousedown selects immediately (no delay)
          td.addEventListener('mousedown', (event) => {
            if (event.button !== 0) {
              return;
            }
            if (event.detail >= 2) {
              // Let dblclick handle it; don't interfere
              return;
            }
            event.stopPropagation();
            isDragging = true;

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
            if (!isDragging || !dragAnchor) {
              return;
            }
            applyCellDragRange(rowIndex, colIndex);
          });

          // Double click: clear selection and enter edit mode
          td.addEventListener('dblclick', (event) => {
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
              disableCellEditing(input);
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
            activeCell = { input, colName: col.name, ctid, row };
            showContextMenu(event.clientX, event.clientY);
          });

          td.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            activeCell = { input, colName: col.name, ctid, row };
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

          if (isFkColumn(col)) {
            const openFkBtn = document.createElement('button');
            openFkBtn.type = 'button';
            openFkBtn.className = 'json-open-btn cell-action-btn';
            openFkBtn.title = 'Abrir tabela relacionada';
            openFkBtn.setAttribute('aria-label', 'Abrir tabela relacionada');
            openFkBtn.innerHTML = SVG_GO_TO_FILE;
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
            openJsonBtn.innerHTML = SVG_ZOOM_IN;
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
      console.log({textSuperRaw})
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
      const columnFilters = Object.entries(state.columnFilters)
        .map(([columnName, value]) => {
          const rawValue = String(value || '').trim();
          return {
            columnName,
            rawValue,
            lowerValue: rawValue.toLowerCase(),
            nullFilter: parseNullFilterToken(rawValue),
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

        return columnFilters.every(({ columnName, lowerValue, nullFilter }) => {
          const col = columnsByName.get(columnName);
          const cellValue = getEffectiveCellValue(row, columnName, ctid);

          if (nullFilter) {
            return matchesNullFilter(cellValue, nullFilter);
          }

          const cellText = col
            ? toCellInputText(cellValue, col)
            : String(cellValue ?? '');
          return cellText.toLowerCase().includes(lowerValue);
        });
      });
    }

    function save() {
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

    modeDropdown.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
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
    });

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

    headerMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      headerMenuOverlay.toggle({ anchorEl: headerMenuBtn });
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

    document.getElementById('limit').addEventListener('change', () => {
      state.page = 1;
      persistCurrentState();
      reloadTableViewClearingSelection();
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

    toggleQueryVisibilityBtn.addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'toggleQueryVisibility' });
    });

    toggleHeaderVisibilityBtn.addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'toggleHeaderVisibility' });
    });

    resetLayoutBtn.addEventListener('click', () => {
      closeHeaderMenu();
      resetColumnLayoutToDefault();
    });

    queryEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      state.searchMode = 'query';
      updateModeIcon();
      state.page = 1;
      persistCurrentState();
      reloadTableViewClearingSelection();
    });

    queryResizer.addEventListener('mousedown', (event) => {
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
        return;
      }

      if (!queryResizeState) {
        return;
      }

      const nextHeight = Math.max(28, queryResizeState.startHeight + (event.clientY - queryResizeState.startY));
      queryEl.style.height = nextHeight + 'px';
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

    // Keyboard handlers for copy/paste/delete
    document.addEventListener('keydown', (event) => {
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

      // Ctrl+C: copy active editing value or last selected cell value
      if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
        copyDefaultSelectionToClipboard();
        event.preventDefault();
        return;
      }

      // Ctrl+V: paste into current editing cell or last selected cell
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
        event.preventDefault();
        navigator.clipboard.readText().then((value) => {
          if (editingCellInput) {
            editingCellInput.value = value;
            editingCellInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }

          if (!lastSelectedCell) {
            return;
          }

          const row = rowKeyToRow.get(lastSelectedCell.rowKey);
          const col = columns.find((c) => c.name === lastSelectedCell.colName);
          if (!row || !col) {
            return;
          }

          const ctid = rowKeyToCtid.get(lastSelectedCell.rowKey) || null;
          const inputMap = inputElements.get(lastSelectedCell.rowKey);
          const input = inputMap ? inputMap.get(col.name) : null;
          applyCellValue(row, col, ctid, value, input || null);
          renderSelectionState();
        }).catch(() => {});
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

          if (action === 'remove') {
            if (activeCell.ctid) {
              if (removedCtids.has(activeCell.ctid)) {
                removedCtids.delete(activeCell.ctid);
              } else {
                removedCtids.add(activeCell.ctid);
              }
            } else {
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
        titleEl.innerHTML =
          '<span class="info-item info-fixed"><span style="margin-right: 4px;">' + SVG_DB + '</span><span>' + currentDatabaseName + '</span></span>' +
          '<span class="info-item info-fixed"><span style="margin-right: 4px;">' + SVG_SCHEMA + '</span><span>' + currentSchemaName + '</span></span>' +
          '<span class="info-item info-conn">' + SVG_CONNECTION + '<span>' + (currentConnectionName || 'Conexão') + '</span></span>';
        queryEl.value = message.result.query;
        showQueryEditor = message.showQueryEditor !== false;
        applyQueryVisibility();
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
        editedRows = new Map();
        insertedRows = [];
        removedCtids = new Set();
        clearSelectionForViewChange();
        syncControls();
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

      if (message.type === 'queryVisibility') {
        showQueryEditor = message.showQueryEditor !== false;
        applyQueryVisibility();
      }

      if (message.type === 'headerVisibility') {
        hideTabHeader = message.hideTabHeader === true;
        applyHeaderVisibility();
      }

      if (message.type === 'nativeJsonPreviewContentChanged') {
        applyNativePreviewContent(message);
      }

      if (message.type === 'restoreGridFocus') {
        tableWrapEl?.focus({ preventScroll: true });
      }
    });

    updateModeIcon();
    applyQueryVisibility();
    applyHeaderVisibility();
    updateSaveButtonState();
    beginLoading();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
