import * as vscode from "vscode";
import { PostgresConnection } from "./models";
import { SqlQueryResult } from "./postgresService";

export interface QueryResultViewModel {
  connection: PostgresConnection;
  databaseName: string;
  schemaName?: string;
  sql: string;
  result: SqlQueryResult;
  source: "sqlRunner" | "sqlBook";
  title?: string;
  onRefresh?: () => Promise<SqlQueryResult>;
}

interface QueryResultWebviewPayload {
  title: string;
  subtitle: string;
  source: string;
  sql: string;
  rowCount: number;
  command: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export class QueryResultPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private currentModel: QueryResultViewModel | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async show(model: QueryResultViewModel): Promise<void> {
    this.currentModel = model;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "dbadmin.queryResult",
        this.getPanelTitle(model),
        {
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.Beside,
        },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      this.panel.webview.html = this.getHtml(this.panel.webview);

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      this.panel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
        if (!this.currentModel || !this.panel) {
          return;
        }

        if (message.type === "ready") {
          await this.postHydrate(this.currentModel);
          return;
        }

        if (message.type === "refresh") {
          if (!this.currentModel.onRefresh) {
            void vscode.window.showInformationMessage("Sem contexto para reexecutar esta consulta.");
            return;
          }

          try {
            const refreshed = await this.currentModel.onRefresh();
            this.currentModel = { ...this.currentModel, result: refreshed };
            await this.postHydrate(this.currentModel);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Erro ao atualizar resultado.";
            void this.panel.webview.postMessage({
              type: "notify",
              level: "error",
              message: errorMessage,
            });
          }
        }
      });
    } else {
      this.panel.title = this.getPanelTitle(model);
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      await this.postHydrate(model);
    }
  }

  private async postHydrate(model: QueryResultViewModel): Promise<void> {
    if (!this.panel) {
      return;
    }

    const payload = this.toWebviewPayload(model);
    await this.panel.webview.postMessage({
      type: "hydrate",
      payload,
    });
  }

  private toWebviewPayload(model: QueryResultViewModel): QueryResultWebviewPayload {
    const effective = this.getEffectiveResult(model.result);
    const rowCount = Number.isFinite(effective.rowCount)
      ? Number(effective.rowCount)
      : effective.rows.length;

    return {
      title: model.title || "Resultado da consulta",
      subtitle: `${model.connection.nickname} • ${model.databaseName}${model.schemaName ? ` • ${model.schemaName}` : ""}`,
      source: model.source === "sqlBook" ? "SQL Book" : "SQL Runner",
      sql: model.sql,
      rowCount,
      command: effective.command || "",
      columns: effective.columns,
      rows: effective.rows,
    };
  }

  private getEffectiveResult(result: SqlQueryResult): SqlQueryResult {
    if (Array.isArray(result.results) && result.results.length > 0) {
      const last = result.results[result.results.length - 1];
      return {
        columns: last.columns,
        rows: last.rows,
        rowCount: last.rowCount,
        command: last.command,
        results: result.results,
      };
    }

    return result;
  }

  private getPanelTitle(model: QueryResultViewModel): string {
    return model.title || "Resultado SQL";
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Resultado SQL</title>
  <style>
    :root {
      color-scheme: light dark;
      --control-height: 28px;
      --control-radius: 6px;
    }
    html, body {
      height: 100%;
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
    body {
      margin: 0;
      padding: 10px;
      box-sizing: border-box;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    .shell {
      height: 100%;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--vscode-editorWidget-background);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      flex-wrap: wrap;
    }
    .title-wrap {
      min-width: 220px;
      flex: 1 1 280px;
    }
    .title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
    }
    .subtitle {
      margin: 2px 0 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.2;
    }
    .search {
      min-width: 220px;
      flex: 2 1 320px;
      height: var(--control-height);
      border-radius: var(--control-radius);
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 0 10px;
      box-sizing: border-box;
      outline: none;
      overflow: hidden;
      background-clip: padding-box;
    }
    .search:focus {
      border-color: var(--dbadmin-input-focus);
    }
    button {
      height: var(--control-height);
      border-radius: var(--control-radius);
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 0 10px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover {
      border-color: var(--vscode-focusBorder);
    }
    .meta {
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    .sql-preview {
      margin-left: auto;
      max-width: 45%;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .grid-wrap {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    table {
      border-collapse: collapse;
      width: max-content;
      min-width: 100%;
      table-layout: fixed;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      border-right: 1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent);
      padding: 4px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-sideBar-background);
      user-select: none;
    }
    th .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
    }
    th .sort {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 10px;
      text-align: right;
    }
    th .filter-wrap {
      margin-top: 4px;
      width: 100%;
      border-radius: 4px;
      overflow: hidden;
    }
    th .filter {
      width: 100%;
      height: 22px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 0 6px;
      box-sizing: border-box;
      font-size: 11px;
      outline: none;
      overflow: hidden;
      background-clip: padding-box;
    }
    th .filter:focus {
      border-color: var(--dbadmin-input-focus);
      outline: none;
      box-shadow: none;
    }
    td {
      max-width: 460px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    tr:hover td {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent);
    }
    .empty {
      padding: 20px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .notify {
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      display: none;
    }
    .notify.error {
      display: block;
      color: var(--vscode-errorForeground);
      background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent);
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <div class="title-wrap">
        <h1 id="title" class="title">Resultado da consulta</h1>
        <p id="subtitle" class="subtitle"></p>
      </div>
      <input id="search" class="search" placeholder="Buscar nos resultados" />
      <button id="reset">Resetar layout</button>
      <button id="refresh" class="primary">Reexecutar</button>
    </div>
    <div id="notify" class="notify"></div>
    <div class="meta">
      <span id="source"></span>
      <span id="command"></span>
      <span id="count"></span>
      <span id="sql" class="sql-preview"></span>
    </div>
    <div id="gridWrap" class="grid-wrap">
      <div id="empty" class="empty">Execute uma consulta para ver resultados.</div>
      <table id="grid" style="display:none"></table>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const titleEl = document.getElementById('title');
    const subtitleEl = document.getElementById('subtitle');
    const sourceEl = document.getElementById('source');
    const commandEl = document.getElementById('command');
    const countEl = document.getElementById('count');
    const sqlEl = document.getElementById('sql');
    const searchEl = document.getElementById('search');
    const resetBtn = document.getElementById('reset');
    const refreshBtn = document.getElementById('refresh');
    const gridEl = document.getElementById('grid');
    const emptyEl = document.getElementById('empty');
    const notifyEl = document.getElementById('notify');

    const state = {
      payload: null,
      searchText: '',
      sortColumn: undefined,
      sortDirection: undefined,
      columnFilters: {},
    };

    function esc(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function getFilteredRows(payload) {
      const searchValue = state.searchText.trim().toLowerCase();

      return payload.rows.filter((row) => {
        for (const colName of payload.columns) {
          const filterValue = String(state.columnFilters[colName] || '').trim().toLowerCase();
          if (filterValue) {
            const cellValue = String(row[colName] ?? '').toLowerCase();
            if (!cellValue.includes(filterValue)) {
              return false;
            }
          }
        }

        if (!searchValue) {
          return true;
        }

        return payload.columns.some((colName) => {
          const cellValue = String(row[colName] ?? '').toLowerCase();
          return cellValue.includes(searchValue);
        });
      });
    }

    function getSortedRows(rows) {
      if (!state.sortColumn || !state.sortDirection) {
        return rows;
      }

      const col = state.sortColumn;
      const dir = state.sortDirection === 'asc' ? 1 : -1;
      const copy = [...rows];
      copy.sort((a, b) => {
        const va = a[col];
        const vb = b[col];

        const na = Number(va);
        const nb = Number(vb);
        const bothNumeric = Number.isFinite(na) && Number.isFinite(nb);

        if (bothNumeric) {
          if (na === nb) {
            return 0;
          }
          return na > nb ? dir : -dir;
        }

        const sa = String(va ?? '');
        const sb = String(vb ?? '');
        const cmp = sa.localeCompare(sb, 'pt-BR', { numeric: true, sensitivity: 'base' });
        return cmp * dir;
      });

      return copy;
    }

    function setNotify(message, isError) {
      if (!message) {
        notifyEl.textContent = '';
        notifyEl.className = 'notify';
        return;
      }

      notifyEl.textContent = message;
      notifyEl.className = isError ? 'notify error' : 'notify';
    }

    function render() {
      const payload = state.payload;
      if (!payload) {
        gridEl.style.display = 'none';
        emptyEl.style.display = 'block';
        emptyEl.textContent = 'Execute uma consulta para ver resultados.';
        return;
      }

      const filtered = getFilteredRows(payload);
      const rows = getSortedRows(filtered);

      countEl.textContent = String(rows.length) + ' linha(s) exibida(s) de ' + String(payload.rowCount);

      if (payload.columns.length === 0) {
        gridEl.style.display = 'none';
        emptyEl.style.display = 'block';
        emptyEl.textContent = payload.command
          ? String(payload.command) + ' executado sem conjunto de resultados.'
          : 'Consulta sem colunas para renderizar.';
        return;
      }

      const headSort = (colName) => {
        if (state.sortColumn !== colName) {
          return '';
        }
        return state.sortDirection === 'asc' ? '↑' : state.sortDirection === 'desc' ? '↓' : '';
      };

      const head = payload.columns.map((colName) => {
        const currentFilter = esc(state.columnFilters[colName] || '');
        return '<th data-col="' + esc(colName) + '">' +
          '<div class="head" data-sort-col="' + esc(colName) + '">' +
            '<span>' + esc(colName) + '</span>' +
            '<span class="sort">' + headSort(colName) + '</span>' +
          '</div>' +
          '<div class="filter-wrap"><input class="filter" data-filter-col="' + esc(colName) + '" value="' + currentFilter + '" placeholder="Filtro" /></div>' +
        '</th>';
      }).join('');

      const body = rows.map((row) => {
        const tds = payload.columns.map((colName) => {
          const raw = row[colName];
          const text = raw === null || typeof raw === 'undefined' ? 'null' : String(raw);
          return '<td title="' + esc(text) + '">' + esc(text) + '</td>';
        }).join('');
        return '<tr>' + tds + '</tr>';
      }).join('');

      gridEl.innerHTML = '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>';
      gridEl.style.display = 'table';
      emptyEl.style.display = rows.length === 0 ? 'block' : 'none';
      if (rows.length === 0) {
        emptyEl.textContent = 'Nenhuma linha atende aos filtros atuais.';
      }

      gridEl.querySelectorAll('[data-sort-col]').forEach((node) => {
        node.addEventListener('click', () => {
          const colName = node.getAttribute('data-sort-col');
          if (!colName) {
            return;
          }

          if (state.sortColumn !== colName) {
            state.sortColumn = colName;
            state.sortDirection = 'asc';
          } else if (state.sortDirection === 'asc') {
            state.sortDirection = 'desc';
          } else {
            state.sortColumn = undefined;
            state.sortDirection = undefined;
          }

          render();
        });
      });

      gridEl.querySelectorAll('[data-filter-col]').forEach((node) => {
        node.addEventListener('input', () => {
          const colName = node.getAttribute('data-filter-col');
          if (!colName) {
            return;
          }
          state.columnFilters[colName] = node.value || '';
          render();
        });
      });
    }

    function applyPayload(payload) {
      state.payload = payload;
      state.searchText = '';
      state.sortColumn = undefined;
      state.sortDirection = undefined;
      state.columnFilters = {};

      titleEl.textContent = payload.title || 'Resultado da consulta';
      subtitleEl.textContent = payload.subtitle || '';
      sourceEl.textContent = payload.source || '';
      commandEl.textContent = payload.command ? 'Comando: ' + String(payload.command) : '';
      countEl.textContent = String(payload.rowCount) + ' linha(s)';
      sqlEl.textContent = payload.sql || '';
      sqlEl.title = payload.sql || '';
      searchEl.value = '';
      setNotify('', false);

      render();
    }

    searchEl.addEventListener('input', () => {
      state.searchText = searchEl.value || '';
      render();
    });

    resetBtn.addEventListener('click', () => {
      state.searchText = '';
      state.sortColumn = undefined;
      state.sortDirection = undefined;
      state.columnFilters = {};
      searchEl.value = '';
      render();
    });

    refreshBtn.addEventListener('click', () => {
      setNotify('', false);
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || !message.type) {
        return;
      }

      if (message.type === 'hydrate') {
        applyPayload(message.payload);
        return;
      }

      if (message.type === 'notify') {
        setNotify(message.message || '', message.level === 'error');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
