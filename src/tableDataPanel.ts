import * as vscode from 'vscode';
import { DbObjectNodeRef } from './models';
import { PostgresService, TableSavePayload, TableSortDirection } from './postgresService';
import { ConnectionStore } from './connectionStore';

interface OpenTableInput {
  node: DbObjectNodeRef;
  newTab: boolean;
  restoringOnStartup?: boolean;
  layout?: TableLayoutState;
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
  | { type: 'reload'; state: TableState }
  | { type: 'save'; state: TableState; payload: TableSavePayload }
  | { type: 'openInNewTab' }
  | { type: 'openSettings' }
  | { type: 'showInExplorer' }
  | { type: 'toggleQueryVisibility' }
  | { type: 'toggleHeaderVisibility' }
  | { type: 'updateLayout'; layout: TableLayoutState };

const GLOBAL_REUSED_KEY = '__global__';
const SHOW_QUERY_SETTING = 'dbadmin.showQueryEditor';
const HIDE_TAB_HEADER_SETTING = 'dbadmin.hideTabHeader';
const PERSIST_LAYOUT_SETTING = 'dbadmin.persistColumnLayout';
const DEFAULT_PAGE_SIZE_SETTING = 'dbadmin.defaultPageSize';

export class TableDataPanelManager {
  private readonly reusedPanels = new Map<string, vscode.WebviewPanel>();
  private readonly panelNodes = new Map<vscode.WebviewPanel, DbObjectNodeRef>();
  private readonly panelIsNewTab = new Map<vscode.WebviewPanel, boolean>();
  private readonly panelLayouts = new Map<vscode.WebviewPanel, TableLayoutState>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postgresService: PostgresService
  ) {}

  public async openTable(input: OpenTableInput): Promise<void> {
    const key = input.newTab ? this.panelKey(input.node, true) : GLOBAL_REUSED_KEY;
    const shouldPersistOutsideRestore = this.getPersistLayoutOutsideRestore();
    const initialLayout =
      input.layout ??
      (shouldPersistOutsideRestore ? this.readStoredLayout(input.node) : undefined);

    if (!input.newTab) {
      const reused = this.reusedPanels.get(key);
      if (reused) {
        this.panelNodes.set(reused, input.node);
        if (initialLayout) {
          this.panelLayouts.set(reused, initialLayout);
        } else {
          this.panelLayouts.delete(reused);
        }
        reused.title = `${input.node.objectName}`;
        reused.reveal(vscode.ViewColumn.Active, false);
        await this.refreshPanel(reused, input.node, this.defaultState(), {
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
      panel.iconPath = new vscode.ThemeIcon('table');
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
        await this.refreshPanel(panel, currentNode, this.defaultState(), {
          retryTimeout: input.restoringOnStartup === true,
        });
        return;
      }

      if (message.type === 'reload') {
        await this.refreshPanel(panel, currentNode, message.state);
        return;
      }

      if (message.type === 'save') {
        try {
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
      this.panelNodes.delete(panel);
      this.panelIsNewTab.delete(panel);
      this.panelLayouts.delete(panel);
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
          databaseName: node.databaseName,
          schemaName: node.schemaName,
          result,
          state,
          showQueryEditor: this.getShowQueryEditor(),
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
        };
      })
      .filter((tab): tab is {
        connectionId: string;
        databaseName: string;
        schemaName: string;
        objectName: string;
        newTab: boolean;
        layout: TableLayoutState | undefined;
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
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const defaultPageSize = this.getDefaultPageSize();

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
    .title svg { width: 14px; height: 14px; }
    .header-menu-wrap { position: relative; }
    .overlay-backdrop { position: fixed; inset: 0; display: none; }
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
    .input { border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 0 8px; height: 28px; box-sizing: border-box; }
    .btn-icon-fix { padding: 0px 0px 2px 0px !important; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; padding: 0 10px; height: 28px; cursor: pointer; box-sizing: border-box; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
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
    .columns-item { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; border: 1px solid transparent; border-radius: 6px; padding: 6px; cursor: grab; user-select: none; }
    .columns-item.all-toggle { grid-template-columns: auto 1fr; cursor: default; border-bottom: 1px solid var(--vscode-panel-border); border-radius: 0; padding-bottom: 8px; margin-bottom: 2px; }
    .columns-item.no-reorder { cursor: default; }
    .columns-item.no-reorder .columns-item-handle { opacity: 0.35; }
    .columns-item:hover { background: var(--vscode-list-hoverBackground); }
    .columns-item.drag-over { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent); }
    .columns-item-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; }
    .columns-item-handle { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #errorMsg { display: none; color: var(--vscode-errorForeground); padding: 12px 10px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; flex: 1 1 auto; min-height: 0; overflow: auto; }
    .table-wrap { border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); overflow: auto; flex: 1 1 auto; min-height: 0; }
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
    .cell-input.dirty { background: rgba(70, 130, 255, 0.14); border-color: rgba(70, 130, 255, 0.5); }
    tr.row-added td { background: rgba(46, 160, 67, 0.12); }
    tr.row-removed td { background: rgba(220, 53, 69, 0.16); }
    .menu { z-index: 50; min-width: 180px; }
    .menu-submenu-wrap > button { justify-content: space-between; gap: 12px; }
    .menu-submenu-wrap.submenu-open > button { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .submenu-chevron { width: 14px; height: 14px; color: var(--vscode-descriptionForeground); flex: 0 0 auto; }
    .btn-icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }
    .btn-icon svg { width: 14px; height: 14px; }
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
    .selection-col { width: 24px; min-width: 24px; max-width: 24px; padding: 2px 0 !important; position: relative; }
    .selection-cell { cursor: pointer; }
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
    tr.row-marked-delete td { background: rgba(220, 53, 69, 0.16); }
    td:has(.cell-input.dirty) { background: color-mix(in srgb, var(--vscode-inputValidation-infoBackground, #007acc) 35%, transparent); }
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
<body class="${initialHideTabHeader ? 'header-hidden' : ''}">
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
      <input id="search" class="input grow" placeholder="Pesquisar tudo" />
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
      <button id="save" class="btn-icon" title="Salvar" aria-label="Salvar">
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
    <div class="table-wrap">
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
    <button id="toggleQueryVisibility" title="Mostrar query">
      <span id="toggleQueryVisibilityLabel">Ocultar query</span>
    </button>
    <button id="toggleHeaderVisibility" title="Mostrar/Ocultar cabeçalho">
      <span id="toggleHeaderVisibilityLabel">Ocultar cabeçalho</span>
    </button>
    <button id="resetLayout" title="Restaurar layout da tabela">
      <span>Restaurar layout</span>
    </button>
    <button id="openNewTab" title="Abrir em nova aba">
      <span>Abrir em nova guia</span>
    </button>
  </div>

  <div class="overlay-backdrop" id="menuBackdrop"></div>
  <div class="menu simple-menu overlay-surface overlay-scroll" id="cellMenu">
    <div class="menu-submenu-wrap">
      <button type="button"><span>✎ Editar</span><svg class="submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="menu-submenu simple-menu overlay-surface overlay-submenu">
        <button data-action="null">Definir NULL</button>
        <button data-action="empty">Definir texto vazio</button>
        <button data-action="default">Definir DEFAULT</button>
      </div>
    </div>
    <button data-action="duplicate"><span>⧉ Duplicar linha</span></button>
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
    const modeBtn = document.getElementById('modeBtn');
    const modeDropdown = document.getElementById('modeDropdown');
    const modeBackdrop = document.getElementById('modeBackdrop');
    const columnsBtn = document.getElementById('columnsBtn');
    const columnsPopup = document.getElementById('columnsPopup');
    const columnsBackdrop = document.getElementById('columnsBackdrop');
    const columnsList = document.getElementById('columnsList');
    const columnsSearch = document.getElementById('columnsSearch');
    const headerMenuBtn = document.getElementById('headerMenuBtn');
    const headerMenu = document.getElementById('headerMenu');
    const headerMenuBackdrop = document.getElementById('headerMenuBackdrop');
    const toolbarMenuBtn = document.getElementById('toolbarMenuBtn');
    const toggleQueryVisibilityBtn = document.getElementById('toggleQueryVisibility');
    const toggleQueryVisibilityLabel = document.getElementById('toggleQueryVisibilityLabel');
    const toggleHeaderVisibilityBtn = document.getElementById('toggleHeaderVisibility');
    const toggleHeaderVisibilityLabel = document.getElementById('toggleHeaderVisibilityLabel');
    const resetLayoutBtn = document.getElementById('resetLayout');
    const saveBtn = document.getElementById('save');

    const SVG_LOCAL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12l-4.5 5.5V13h-3V8.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    const SVG_QUERY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4.5" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4.5v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" stroke="currentColor" stroke-width="1.3"/></svg>';
    const SVG_DB = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4v7.5C2.5 12.88 4.96 14 8 14s5.5-1.12 5.5-2.5V4" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 7.5c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5" stroke="currentColor" stroke-width="1.3"/></svg>';
    const SVG_SCHEMA = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12v3H2zM2 8h12v5H2z" stroke="currentColor" stroke-width="1.2"/></svg>';
    const SVG_SORT_NONE = '<svg width="14" height="14" viewBox="0 -3 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m8 15 4 4 4-4m0-6-4-4-4 4"/></svg>';

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
    
    // Selection state
    let selectedCells = new Map(); // rowKey -> Set of columnNames
    let rowKeyToRow = new Map(); // rowKey -> row reference
    let rowKeyToCtid = new Map(); // rowKey -> ctid|null
    let editingCellInput = null;
    let lastSelectedCell = null; // { rowKey, colName }
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
      cellMenuOverlay.open({ x: clientX, y: clientY });
    }

    function syncControls() {
      document.getElementById('search').value = state.searchText;
      document.getElementById('limit').value = String(state.limit);
      updateModeIcon();
      renderPageInfo();
      updateSaveButtonState();
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
      if (!preserveExisting) {
        selectedCells.clear();
      }
      selectedCells.set(rowKey, new Set(displayColumns.map((col) => col.name)));
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

    function applyRowSelectionDragRange(currentRowIndex, displayColumns) {
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
          });
        }
      });
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

    function selectSingleCellAt(rowIndex, colIndex, enterEditMode) {
      if (rowIndex < 0 || colIndex < 0 || rowIndex >= displayedRowKeys.length || colIndex >= displayedColNames.length) {
        return;
      }

      const rowKey = displayedRowKeys[rowIndex];
      const colName = displayedColNames[colIndex];
      selectedCells.clear();
      selectedCells.set(rowKey, new Set([colName]));
      lastSelectedCell = { rowKey, colName };
      renderSelectionState();

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

    function render() {
      const displayColumns = getDisplayColumns();
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');

      // Empty selection column header
      const selectTh = document.createElement('th');
      selectTh.className = 'selection-col';
      selectTh.textContent = '';
      selectTh.style.cursor = 'pointer';
      selectTh.addEventListener('click', () => {
        const displayedRows = applyLocalFilter(rows);
        selectedCells.clear();
        displayedRows.forEach((row, rowIndex) => {
          const rk = row.__dbadmin_ctid || ('new:' + rowIndex);
          selectedCells.set(rk, new Set(displayColumns.map((c) => c.name)));
        });
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
          selectedCells.clear();
          displayedRows.forEach((row, rowIndex) => {
            const rowKey = row.__dbadmin_ctid || ('new:' + rowIndex);
            if (!selectedCells.has(rowKey)) {
              selectedCells.set(rowKey, new Set());
            }
            selectedCells.get(rowKey).add(col.name);
            lastSelectedCell = { rowKey, colName: col.name };
          });
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
          beginLoading();
          vscode.postMessage({ type: 'reload', state: currentState() });
        });

        title.appendChild(left);
        title.appendChild(right);

        const filterInput = document.createElement('input');
        filterInput.className = 'th-filter';
        filterInput.setAttribute('data-col-name', col.name);
        filterInput.placeholder = col.dataType;
        filterInput.value = state.columnFilters[col.name] || '';
        filterInput.addEventListener('input', () => {
          const value = filterInput.value.trim();
          if (value) {
            state.columnFilters[col.name] = value;
          } else {
            delete state.columnFilters[col.name];
          }

          if (state.searchMode === 'local') {
            rememberColumnFocus(col.name, filterInput);
            render();
            restorePendingFocus();
          }
        });
        filterInput.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') {
            return;
          }
          const value = filterInput.value.trim();
          if (value) {
            state.columnFilters[col.name] = value;
          } else {
            delete state.columnFilters[col.name];
          }
          state.page = 1;
          rememberColumnFocus(col.name, filterInput);

          if (state.searchMode === 'query') {
            beginLoading();
            vscode.postMessage({ type: 'reload', state: currentState() });
          } else {
            render();
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

        th.appendChild(resizer);
        headRow.appendChild(th);
      });

      head.appendChild(headRow);

      const body = document.createElement('tbody');
      body.classList.add('table-cells-body');
      const displayedRows = applyLocalFilter(rows);
      rowKeyToRow.clear();
      rowKeyToCtid.clear();
      trElements.clear();
      selectionTdElements.clear();
      inputElements.clear();
      tdElements.clear();
      displayedRowKeys = [];
      displayedColNames = displayColumns.map((c) => c.name);

      displayedRows.forEach((row, rowIndex) => {
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
            dragAnchor = { rowIndex, colIndex };
            if (!selectedCells.has(rowKey)) {
              selectedCells.set(rowKey, new Set());
            }
            const cellSet = selectedCells.get(rowKey);

            if (event.ctrlKey || event.metaKey) {
              if (cellSet.has(col.name)) {
                cellSet.delete(col.name);
              } else {
                cellSet.add(col.name);
              }
            } else {
              selectedCells.clear();
              selectedCells.set(rowKey, new Set([col.name]));
            }

            if ((event.ctrlKey || event.metaKey) && cellSet.size === 0) {
              selectedCells.delete(rowKey);
            }

            lastSelectedCell = { rowKey, colName: col.name };
            renderSelectionState();
          });

          td.addEventListener('mouseenter', () => {
            if (!isDragging || !dragAnchor) {
              return;
            }
            // Expand selection rectangle from anchor to current cell
            const minR = Math.min(dragAnchor.rowIndex, rowIndex);
            const maxR = Math.max(dragAnchor.rowIndex, rowIndex);
            const minC = Math.min(dragAnchor.colIndex, colIndex);
            const maxC = Math.max(dragAnchor.colIndex, colIndex);
            selectedCells.clear();
            for (let r = minR; r <= maxR; r++) {
              const rk = displayedRowKeys[r];
              if (!rk) { continue; }
              const colSet = new Set();
              for (let c = minC; c <= maxC; c++) {
                const cn = displayedColNames[c];
                if (cn) { colSet.add(cn); }
              }
              selectedCells.set(rk, colSet);
            }
            lastSelectedCell = { rowKey, colName: col.name };
            renderSelectionState();
          });

          // Double click: clear selection and enter edit mode
          td.addEventListener('dblclick', (event) => {
            event.stopPropagation();
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
              render();
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

          td.appendChild(input);
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

      const text = state.searchText.trim().toLowerCase();
      const columnsByName = new Map(columns.map((col) => [col.name, col]));
      const columnFilters = Object.entries(state.columnFilters)
        .map(([columnName, value]) => [columnName, String(value || '').trim().toLowerCase()])
        .filter(([, value]) => value.length > 0);

      return rawRows.filter((row) => {
        const matchesGlobal =
          text.length === 0 ||
          columns.some((col) =>
            toCellInputText(row[col.name], col).toLowerCase().includes(text)
          );

        if (!matchesGlobal) {
          return false;
        }

        if (columnFilters.length === 0) {
          return true;
        }

        return columnFilters.every(([columnName, filterValue]) => {
          const col = columnsByName.get(columnName);
          const cellText = col
            ? toCellInputText(row[columnName], col)
            : String(row[columnName] ?? '');
          return cellText.toLowerCase().includes(filterValue);
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

    document.getElementById('search').addEventListener('input', (event) => {
      state.searchText = event.target.value;
      if (state.searchMode === 'local') {
        render();
      }
    });

    document.getElementById('search').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }

      state.searchText = event.target.value;
      if (state.searchMode === 'query') {
        rememberSearchFocus();
        state.page = 1;
        beginLoading();
        vscode.postMessage({ type: 'reload', state: currentState() });
      } else {
        render();
      }
    });

    modeDropdown.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.searchMode = btn.getAttribute('data-mode');
        closeModeDropdown();
        updateModeIcon();
        state.page = 1;
        if (state.searchMode === 'query') {
          beginLoading();
          vscode.postMessage({ type: 'reload', state: currentState() });
        } else {
          render();
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

    window.addEventListener('resize', () => {
      overlayControllers.forEach((overlay) => overlay.reposition());
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
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
      beginLoading();
      vscode.postMessage({ type: 'reload', state: currentState() });
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
      beginLoading();
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    document.getElementById('nextPage').addEventListener('click', () => {
      const pageSize = Math.max(1, Number(state.limit || ${defaultPageSize}));
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      if (state.page >= totalPages) {
        return;
      }
      state.page += 1;
      beginLoading();
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    document.getElementById('limit').addEventListener('change', () => {
      state.page = 1;
      beginLoading();
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    document.getElementById('openNewTab').addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'openInNewTab' });
    });

    document.getElementById('openSettings').addEventListener('click', () => {
      closeHeaderMenu();
      vscode.postMessage({ type: 'openSettings' });
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
      beginLoading();
      vscode.postMessage({ type: 'reload', state: currentState() });
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
    window.addEventListener('blur', endDrag);
    window.addEventListener('mouseleave', endDrag);
    window.addEventListener('mouseup', () => {
      isDragging = false;
      dragAnchor = null;
      isRowSelectionDragging = false;
      rowSelectionDragPreserve = false;
      rowSelectionDragAnchorIndex = null;
      rowSelectionDragBaseSelection = new Map();
    });
    window.addEventListener('blur', () => closeAllOverlays());
    window.addEventListener('mouseup', endColumnResize);
    window.addEventListener('blur', endColumnResize);
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
        if (event.key === 'ArrowUp') {
          moveSelectionBy(-1, 0);
        } else if (event.key === 'ArrowDown') {
          moveSelectionBy(1, 0);
        } else if (event.key === 'ArrowLeft') {
          moveSelectionBy(0, -1);
        } else if (event.key === 'ArrowRight') {
          moveSelectionBy(0, 1);
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

      // Ctrl+C: copy active editing value or last selected cell value
      if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
        let value = '';
        if (editingCellInput) {
          value = editingCellInput.value;
        } else {
          value = getSelectedCellsText();
        }
        if (!value && lastSelectedCell) {
          const row = rowKeyToRow.get(lastSelectedCell.rowKey);
          const col = columns.find((c) => c.name === lastSelectedCell.colName);
          if (row && col) {
            value = toCellInputText(getEffectiveCellValue(row, col.name, row.__dbadmin_ctid), col);
          }
        }
        navigator.clipboard.writeText(value).catch(() => {});
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

          const ctid = row.__dbadmin_ctid;
          const baseCurrentText = toCellInputText(row[col.name], col);
          if (ctid) {
            if (value === baseCurrentText) {
              if (editedRows.has(ctid)) {
                const values = editedRows.get(ctid);
                delete values[col.name];
                if (Object.keys(values).length === 0) {
                  editedRows.delete(ctid);
                }
              }
            } else {
              if (!editedRows.has(ctid)) {
                editedRows.set(ctid, {});
              }
              editedRows.get(ctid)[col.name] = value;
            }
          } else {
            row[col.name] = value;
          }

          updateSaveButtonState();
          render();
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

      const openSubmenu = () => {
        clearCloseTimer();
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
        titleEl.innerHTML = SVG_DB + '<span>' + (message.databaseName || '') + '</span>' + SVG_SCHEMA + '<span>' + (message.schemaName || '') + '</span>';
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
        editedRows = new Map();
        insertedRows = [];
        removedCtids = new Set();
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
