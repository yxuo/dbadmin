import * as vscode from 'vscode';
import { DbObjectNodeRef } from './models';
import { PostgresService, TableSavePayload, TableSortDirection } from './postgresService';
import { ConnectionStore } from './connectionStore';

interface OpenTableInput {
  node: DbObjectNodeRef;
  newTab: boolean;
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

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'reload'; state: TableState }
  | { type: 'save'; state: TableState; payload: TableSavePayload }
  | { type: 'openInNewTab' };

const GLOBAL_REUSED_KEY = '__global__';

export class TableDataPanelManager {
  private readonly reusedPanels = new Map<string, vscode.WebviewPanel>();
  private readonly panelNodes = new Map<vscode.WebviewPanel, DbObjectNodeRef>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postgresService: PostgresService
  ) {}

  public async openTable(input: OpenTableInput): Promise<void> {
    const key = input.newTab ? this.panelKey(input.node, true) : GLOBAL_REUSED_KEY;

    if (!input.newTab) {
      const reused = this.reusedPanels.get(key);
      if (reused) {
        this.panelNodes.set(reused, input.node);
        reused.title = `${input.node.schemaName}.${input.node.objectName}`;
        reused.reveal(vscode.ViewColumn.Active, false);
        await this.refreshPanel(reused, input.node, this.defaultState());
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      'dbadmin.tableData',
      `${input.node.schemaName}.${input.node.objectName}`,
      {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    panel.webview.html = this.buildHtml(panel.webview);
    this.panelNodes.set(panel, input.node);

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
        await this.refreshPanel(panel, currentNode, this.defaultState());
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
      }
    });

    panel.onDidDispose(() => {
      disposable.dispose();
      this.panelNodes.delete(panel);
      if (!input.newTab) {
        this.reusedPanels.delete(key);
      }
      this.saveOpenTabs();
    });
  }

  private async refreshPanel(
    panel: vscode.WebviewPanel,
    node: DbObjectNodeRef,
    state: TableState
  ): Promise<void> {
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
      });
    } catch (error) {
      panel.webview.postMessage({
        type: 'status',
        kind: 'error',
        message: this.errorMessage(error),
      });
    }
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
      limit: 200,
      page: 1,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erro inesperado';
  }

  private saveOpenTabs(): void {
    const openTabs = Array.from(this.reusedPanels.entries()).map(([, panel]) => {
      const node = this.panelNodes.get(panel);
      if (!node || !node.connection) {
        return null;
      }
      return {
        connectionId: node.connection.id,
        databaseName: node.databaseName,
        schemaName: node.schemaName,
        objectName: node.objectName,
        newTab: false,
      };
    }).filter((tab) => tab !== null);

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
          });
        } catch (error) {
          console.error(`Falha ao restaurar aba ${tab.objectName}:`, error);
        }
      }
    } catch (error) {
      console.error('Falha ao restaurar abas abertas:', error);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { height: 100%; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; overflow: hidden; }
    .shell { height: 100vh; min-height: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
    .header { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 0px 4px; }
    .title { font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .title svg { width: 14px; height: 14px; }
    .header-menu-wrap { position: relative; }
    .header-menu { position: absolute; top: calc(100% + 4px); right: 0; display: none; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); border-radius: 6px; z-index: 40; min-width: 180px; }
    .header-menu.open { display: block; }
    .header-menu button { width: 100%; border: 0; border-radius: 6px; text-align: left; background: transparent; color: var(--vscode-foreground); display: flex; align-items: center; gap: 8px; padding: 0 10px; }
    .header-menu button:hover { background: var(--vscode-list-hoverBackground); }
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
    .grow { flex: 1 1 150px; min-width: 150px; }
    .input { border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 0 8px; height: 28px; box-sizing: border-box; }
    #headerMenuBtn { padding: 0px 0px 2px 0px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; padding: 0 10px; height: 28px; cursor: pointer; box-sizing: border-box; transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
    button:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset; }
    #pageInfo { white-space: nowrap; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 28px; }
    .mode-select { position: relative; display: inline-flex; }
    .mode-dropdown { position: absolute; top: calc(100% + 4px); left: 0; display: none; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); border-radius: 6px; z-index: 20; min-width: 170px; }
    .mode-dropdown.open { display: block; }
    .mode-dropdown button { width: 100%; border: 0; border-bottom: 1px solid var(--vscode-panel-border); border-radius: 0; text-align: left; background: transparent; color: var(--vscode-foreground); display: flex; align-items: center; gap: 8px; padding: 0 10px; }
    .mode-dropdown button:last-child { border-bottom: 0; }
    .mode-dropdown button:hover { background: var(--vscode-list-hoverBackground); }
    #errorMsg { display: none; color: var(--vscode-errorForeground); padding: 12px 10px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; flex: 1 1 auto; min-height: 0; overflow: auto; }
    .table-wrap { border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); overflow: auto; flex: 1 1 auto; min-height: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 2px 6px; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 2; min-width: 170px; }
    .th-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0px 5px; }
    .th-name { font-weight: 600; font-size: 12px; }
    .th-icons { cursor: pointer; user-select: none; }
    .th-filter { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); border-radius: 4px; padding: 4px; font-size: 11px; }
    .th-filter:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .cell-input { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); border-radius: 4px; padding: 4px; }
    .cell-input:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
    .cell-input.dirty { background: rgba(70, 130, 255, 0.14); border-color: rgba(70, 130, 255, 0.5); }
    tr.row-added td { background: rgba(46, 160, 67, 0.12); }
    tr.row-removed td { background: rgba(220, 53, 69, 0.16); }
    .menu { position: fixed; display: none; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); border-radius: 6px; z-index: 50; min-width: 180px; }
    .menu button { width: 100%; border: 0; border-bottom: 1px solid var(--vscode-panel-border); border-radius: 0; text-align: left; background: transparent; color: var(--vscode-foreground); white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .menu button:hover { background: var(--vscode-list-hoverBackground); }
    .menu button:last-child { border-bottom: 0; }
    .menu-backdrop { position: fixed; inset: 0; z-index: 49; display: none; }
    .btn-icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }
    .btn-icon svg { width: 14px; height: 14px; }
    button:disabled { opacity: 0.45; cursor: default; }
    button:disabled:hover { background: var(--vscode-button-background); border-color: var(--vscode-button-border, transparent); }
    .menu-submenu-wrap { position: relative; }
    .menu-submenu { position: absolute; top: -1px; left: calc(100% - 2px); display: none; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); border-radius: 6px; min-width: 180px; }
    .menu-submenu-wrap.submenu-left .menu-submenu { left: auto; right: calc(100% - 2px); }
    .menu-submenu-wrap:hover .menu-submenu { display: block; }
    input[type='number']::-webkit-outer-spin-button,
    input[type='number']::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    input[type='number'] {
      -moz-appearance: textfield;
      appearance: textfield;
    }
    @media (max-height: 500px) {
      .header { display: none; }
      .query-container { display: none; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <div class="title" id="title">Tabela</div>
      <div class="header-menu-wrap">
        <button id="headerMenuBtn" class="secondary btn-icon" title="Menu">☰</button>
        <div id="headerMenu" class="header-menu">
          <button id="openNewTab" title="Abrir em nova guia">
            <span>⧉</span>
            <span>Abrir em nova guia</span>
          </button>
        </div>
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
        <div class="mode-dropdown" id="modeDropdown">
          <button data-mode="local"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12l-4.5 5.5V13h-3V8.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>Filtro local</button>
          <button data-mode="query"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4.5" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4.5v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" stroke="currentColor" stroke-width="1.3"/></svg>Filtro via query</button>
        </div>
      </div>
      <input id="limit" class="input" type="number" min="1" max="500" value="200" style="width:60px" />
      <button id="reload" class="secondary btn-icon" title="Recarregar">↻</button>
      <button id="save" class="btn-icon" title="Salvar" aria-label="Salvar">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 2.5h8.5L13.5 4.5v9H3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M5 2.5h5v3H5z" stroke="currentColor" stroke-width="1.2"/>
          <path d="M5 9.5h6v4H5z" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
      <button id="newRow" class="secondary btn-icon" title="Nova linha">＋</button>
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="prevPage" class="secondary btn-icon" title="Página anterior">←</button>
        <span id="pageInfo"></span>
        <button id="nextPage" class="secondary btn-icon" title="Próxima página">→</button>
      </div>
    </div>

    <div id="errorMsg"></div>
    <div class="table-wrap">
      <table id="grid"></table>
    </div>
  </div>

  <div class="menu-backdrop" id="menuBackdrop"></div>
  <div class="menu" id="cellMenu">
    <div class="menu-submenu-wrap">
      <button type="button"><span>✎ Editar</span><span>›</span></button>
      <div class="menu-submenu">
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
    const queryEl = document.getElementById('query');
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
    const headerMenuBtn = document.getElementById('headerMenuBtn');
    const headerMenu = document.getElementById('headerMenu');
    const saveBtn = document.getElementById('save');

    const SVG_LOCAL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12l-4.5 5.5V13h-3V8.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    const SVG_QUERY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4.5" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4.5v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" stroke="currentColor" stroke-width="1.3"/></svg>';
    const SVG_DB = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4v7.5C2.5 12.88 4.96 14 8 14s5.5-1.12 5.5-2.5V4" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 7.5c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5" stroke="currentColor" stroke-width="1.3"/></svg>';
    const SVG_SCHEMA = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12v3H2zM2 8h12v5H2z" stroke="currentColor" stroke-width="1.2"/></svg>';

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

    const state = {
      searchText: '',
      searchMode: 'local',
      sortColumn: undefined,
      sortDirection: undefined,
      columnFilters: {},
      limit: 200,
      page: 1,
    };

    let columns = [];
    let rows = [];
    let totalRows = 0;
    let editedRows = new Map();
    let insertedRows = [];
    let removedCtids = new Set();
    let activeCell = null;
    let queryResizeState = null;

    function hasChanges() {
      const hasInserted = insertedRows.some((row) => !row.__dbadmin_removed);
      return editedRows.size > 0 || hasInserted || removedCtids.size > 0;
    }

    function updateSaveButtonState() {
      saveBtn.disabled = !hasChanges();
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

    function closeContextMenu() {
      cellMenu.style.display = 'none';
      menuBackdrop.style.display = 'none';
    }

    function showContextMenu(clientX, clientY) {
      const margin = 4;
      cellMenu.style.display = 'block';
      menuBackdrop.style.display = 'block';
      const menuWidth = cellMenu.offsetWidth;
      const menuHeight = cellMenu.offsetHeight;

      const x = Math.min(
        Math.max(margin, clientX),
        Math.max(margin, window.innerWidth - menuWidth - margin)
      );
      const y = Math.min(
        Math.max(margin, clientY),
        Math.max(margin, window.innerHeight - menuHeight - margin)
      );

      cellMenu.style.left = x + 'px';
      cellMenu.style.top = y + 'px';
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
        limit: Number(document.getElementById('limit').value || 200),
        page: state.page,
      };
    }

    function renderPageInfo() {
      const pageSize = Math.max(1, Number(state.limit || 200));
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      if (state.page > totalPages) {
        state.page = totalPages;
      }
      pageInfoEl.textContent = state.page + '/' + totalPages + ' (' + totalRows + ')';
      document.getElementById('prevPage').disabled = state.page <= 1;
      document.getElementById('nextPage').disabled = state.page >= totalPages;
    }

    function render() {
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');

      columns.forEach((col) => {
        const th = document.createElement('th');
        const title = document.createElement('div');
        title.className = 'th-title';

        const left = document.createElement('span');
        left.className = 'th-name';
        left.textContent = col.name;

        const right = document.createElement('span');
        right.className = 'th-icons';
        right.innerHTML = state.sortColumn === col.name
          ? (state.sortDirection === 'desc' ? '↓' : '↑')
          : '↕';
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
          vscode.postMessage({ type: 'reload', state: currentState() });
        });

        title.appendChild(left);
        title.appendChild(right);

        const filterInput = document.createElement('input');
        filterInput.className = 'th-filter';
        filterInput.placeholder = col.dataType;
        filterInput.value = state.columnFilters[col.name] || '';
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
          vscode.postMessage({ type: 'reload', state: currentState() });
        });

        th.appendChild(title);
        th.appendChild(filterInput);
        headRow.appendChild(th);
      });

      head.appendChild(headRow);

      const body = document.createElement('tbody');
      const displayedRows = applyLocalFilter(rows);

      displayedRows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        const ctid = row.__dbadmin_ctid;
        const isRemoved = ctid ? removedCtids.has(ctid) : Boolean(row.__dbadmin_removed);
        const isInserted = !ctid && Boolean(row.__dbadmin_inserted);

        if (isRemoved) {
          tr.classList.add('row-removed');
        } else if (isInserted) {
          tr.classList.add('row-added');
        }

        columns.forEach((col) => {
          const td = document.createElement('td');
          const input = document.createElement('input');
          input.className = 'cell-input';

          const baseCurrent = row[col.name];
          const baseCurrentText = baseCurrent === null || baseCurrent === undefined ? '' : String(baseCurrent);
          const effectiveCurrent = getEffectiveCellValue(row, col.name, ctid);
          input.value = effectiveCurrent === null || effectiveCurrent === undefined ? '' : String(effectiveCurrent);

          if (ctid && editedRows.has(ctid) && Object.prototype.hasOwnProperty.call(editedRows.get(ctid), col.name)) {
            input.classList.add('dirty');
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
      if (state.searchMode !== 'local' || !state.searchText.trim()) {
        return rawRows;
      }

      const text = state.searchText.toLowerCase();
      return rawRows.filter((row) => columns.some((col) => String(row[col.name] ?? '').toLowerCase().includes(text)));
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
        state.page = 1;
        vscode.postMessage({ type: 'reload', state: currentState() });
      } else {
        render();
      }
    });

    modeDropdown.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.searchMode = btn.getAttribute('data-mode');
        modeDropdown.classList.remove('open');
        updateModeIcon();
        state.page = 1;
        if (state.searchMode === 'query') {
          vscode.postMessage({ type: 'reload', state: currentState() });
        } else {
          render();
        }
      });
    });

    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modeDropdown.classList.toggle('open');
    });

    document.addEventListener('click', () => {
      modeDropdown.classList.remove('open');
      headerMenu.classList.remove('open');
    });

    headerMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      headerMenu.classList.toggle('open');
    });

    document.getElementById('reload').addEventListener('click', () => {
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
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    document.getElementById('nextPage').addEventListener('click', () => {
      const pageSize = Math.max(1, Number(state.limit || 200));
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      if (state.page >= totalPages) {
        return;
      }
      state.page += 1;
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    document.getElementById('limit').addEventListener('change', () => {
      state.page = 1;
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    document.getElementById('openNewTab').addEventListener('click', () => {
      headerMenu.classList.remove('open');
      vscode.postMessage({ type: 'openInNewTab' });
    });

    queryEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      state.searchMode = 'query';
      updateModeIcon();
      state.page = 1;
      vscode.postMessage({ type: 'reload', state: currentState() });
    });

    menuBackdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
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
      if (!queryResizeState) {
        return;
      }

      const nextHeight = Math.max(28, queryResizeState.startHeight + (event.clientY - queryResizeState.startY));
      queryEl.style.height = nextHeight + 'px';
    });

    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    window.addEventListener('mouseleave', endDrag);
    document.addEventListener('visibilitychange', endDrag);
    document.addEventListener('pointerleave', endDrag);

    // Disable native browser context menu in the webview to keep custom UX flow.
    document.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    document.querySelectorAll('.menu-submenu-wrap').forEach((wrap) => {
      wrap.addEventListener('mouseenter', () => {
        const rect = wrap.getBoundingClientRect();
        const spaceRight = window.innerWidth - rect.right;
        if (spaceRight < 188) {
          wrap.classList.add('submenu-left');
        } else {
          wrap.classList.remove('submenu-left');
        }
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
        titleEl.innerHTML = SVG_DB + '<span>' + (message.databaseName || '') + '</span>' + SVG_SCHEMA + '<span>' + (message.schemaName || '') + '</span>';
        queryEl.value = message.result.query;
        columns = message.result.columns || [];
        rows = message.result.rows || [];
        totalRows = Number(message.result.totalRows || 0);
        state.searchText = message.state.searchText || '';
        state.searchMode = message.state.searchMode || 'local';
        state.sortColumn = message.state.sortColumn;
        state.sortDirection = message.state.sortDirection;
        state.columnFilters = message.state.columnFilters || {};
        state.limit = message.state.limit || 200;
        state.page = message.state.page || 1;
        editedRows = new Map();
        insertedRows = [];
        removedCtids = new Set();
        syncControls();
        render();
        hideError();
      }

      if (message.type === 'status') {
        if (message.kind === 'error') {
          showError(message.message);
        }
      }
    });

    updateModeIcon();
    updateSaveButtonState();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
