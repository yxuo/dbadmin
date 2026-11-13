import * as vscode from "vscode";
import { getBcp47Locale, t } from "./i18n";
import { loadLocaleDict, webviewI18nBootstrap } from "./i18n/webviewLocale";
import { SchemaNodeRef } from "./models";
import { requirePostgresConnection } from "./connectionIdentity";
import {
  RestoreOptions,
  runRestoreByMode,
  truncateInsertTablesFromScript,
  clearSchema,
} from "./backupRestoreService";

type RestoreWebviewMessage =
  | { type: "ready" }
  | { type: "execute"; options: RestoreOptions }
  | { type: "browse" }
  | { type: "clearTables"; filename: string }
  | { type: "clearSchema" }
  | { type: "rememberFilename"; provider: "dbadmin" | "pgadmin"; path: string }
  | { type: "abort" }
  | { type: "cancel" };

const RESTORE_LAST_FILENAMES_KEY = "dbadmin.restore.lastFilenames";

export class RestorePanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onRestoreCompleted?: () => Promise<void>,
  ) {}

  public show(context: vscode.ExtensionContext, node: SchemaNodeRef): void {
    const key = `${node.connection.id}:${node.databaseName}:${node.schemaName}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.webview.html = buildRestoreHtml(existing.webview, node, this.context.extensionPath);
      existing.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "dbadmin.restore",
      `Restaurar — ${node.schemaName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.iconPath = new vscode.ThemeIcon("cloud-upload");
    panel.webview.html = buildRestoreHtml(panel.webview, node, this.context.extensionPath);
    this.panels.set(key, panel);

    let running = false;
    let abortController: AbortController | undefined;
    const lastFilenames = this.context.workspaceState.get<{
      dbadmin?: string;
      pgadmin?: string;
    }>(RESTORE_LAST_FILENAMES_KEY, {});

    const disposition = panel.webview.onDidReceiveMessage(
      async (message: RestoreWebviewMessage) => {
        if (message.type === "ready") {
          panel.webview.postMessage({
            type: "restoreLastFilenames",
            dbadmin: lastFilenames.dbadmin ?? "",
            pgadmin: lastFilenames.pgadmin ?? "",
          });
          return;
        }

        if (message.type === "rememberFilename") {
          const nextPath = String(message.path ?? "").trim();
          const currentPath =
            message.provider === "dbadmin"
              ? lastFilenames.dbadmin
              : lastFilenames.pgadmin;
          if (currentPath === nextPath) {
            return;
          }

          if (message.provider === "dbadmin") {
            lastFilenames.dbadmin = nextPath;
          } else {
            lastFilenames.pgadmin = nextPath;
          }

          await this.context.workspaceState.update(
            RESTORE_LAST_FILENAMES_KEY,
            lastFilenames,
          );
          return;
        }

        if (message.type === "browse") {
          const uris = await vscode.window.showOpenDialog({
            title: t("Select backup file"),
            canSelectMany: false,
            filters: {
              [t("PostgreSQL backup")]: ["backup", "dump", "tar", "sql"],
              [t("All files")]: ["*"],
            },
          });
          if (uris && uris[0]) {
            panel.webview.postMessage({
              type: "browseResult",
              path: uris[0].fsPath,
            });
          }
          return;
        }

        if (message.type === "execute") {
          if (running) {
            return;
          }
          running = true;
          abortController = new AbortController();
          panel.webview.postMessage({ type: "started" });

          try {
            await runRestoreByMode(
              requirePostgresConnection(node.connection),
              node.databaseName,
              node.schemaName,
              message.options,
              (line) => panel.webview.postMessage({ type: "line", text: line }),
              abortController.signal,
            );
            if (this.onRestoreCompleted) {
              await this.onRestoreCompleted();
            }
            panel.webview.postMessage({ type: "done", success: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({
              type: "done",
              success: false,
              error: msg,
            });
          } finally {
            running = false;
            abortController = undefined;
          }
          return;
        }

        if (message.type === "clearTables") {
          if (running) {
            return;
          }
          if (!message.filename?.trim()) {
            panel.webview.postMessage({
              type: "done",
              success: false,
              error: t("Enter the SQL file before clearing tables."),
            });
            return;
          }
          running = true;
          panel.webview.postMessage({ type: "started" });

          try {
            await truncateInsertTablesFromScript(
              requirePostgresConnection(node.connection),
              node.databaseName,
              node.schemaName,
              message.filename,
              (line) => panel.webview.postMessage({ type: "line", text: line }),
            );
            panel.webview.postMessage({
              type: "done",
              success: true,
              label: t("Tables cleared successfully."),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({
              type: "done",
              success: false,
              error: msg,
            });
          } finally {
            running = false;
            abortController = undefined;
          }
          return;
        }

        if (message.type === "clearSchema") {
          if (running) {
            return;
          }
          running = true;
          panel.webview.postMessage({ type: "started" });

          try {
            await clearSchema(
              requirePostgresConnection(node.connection),
              node.databaseName,
              node.schemaName,
              (line) => panel.webview.postMessage({ type: "line", text: line }),
            );
            panel.webview.postMessage({
              type: "done",
              success: true,
              label: t("Schema cleared successfully."),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({
              type: "done",
              success: false,
              error: msg,
            });
          } finally {
            running = false;
            abortController = undefined;
          }
          return;
        }

        if (message.type === "abort") {
          if (!running || !abortController) {
            return;
          }

          panel.webview.postMessage({
            type: "line",
            text: t("[DbAdmin] Abort requested. Stopping restore..."),
          });
          abortController.abort();
          return;
        }

        if (message.type === "cancel") {
          panel.dispose();
        }
      },
    );

    panel.onDidDispose(() => {
      if (running && abortController) {
        abortController.abort();
      }
      this.panels.delete(key);
      disposition.dispose();
    });
  }
}

function buildRestoreHtml(
  webview: vscode.Webview,
  node: SchemaNodeRef,
  extensionPath: string,
): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const title = `${node.schemaName} @ ${node.databaseName}`;
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
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
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
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .header {
      padding: 10px 16px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      position: relative;
      z-index: 2;
    }
    .header h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    .provider-tabs { display: flex; gap: 0; margin-bottom: 10px; }
    .tabs { display: flex; gap: 0; margin-bottom: 8px; }
    .tab {
      padding: 6px 14px;
      cursor: pointer;
      border: none;
      border-radius: 0;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: inherit;
      font-size: 13px;
      border-bottom: 2px solid transparent;
      opacity: 0.7;
    }
    .tab.active {
      border-bottom: 2px solid var(--vscode-focusBorder);
      opacity: 1;
      font-weight: 600;
    }
    .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .content {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 16px;
      position: relative;
      z-index: 0;
    }
    .provider-pane { display: none; }
    .provider-pane.active { display: block; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .field { margin-bottom: 12px; }
    .field label { display: block; margin-bottom: 4px; font-weight: 500; }
    .field input[type=text], .field input[type=number], .field select {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 4px 8px;
      height: 28px;
      font-family: inherit;
      font-size: inherit;
      overflow: hidden;
      background-clip: padding-box;
    }
    .field.row { display: flex; gap: 8px; align-items: flex-end; }
    .field.row > :first-child { flex: 1; }
    .check-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .check-row label { margin: 0; }
    .section-title { font-weight: 600; margin: 14px 0 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 11px; }
    .footer {
      padding: 10px 16px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      align-items: center;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 0 14px;
      height: 28px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover { background: #0258a8; }
    button.secondary:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    }
    button:disabled { opacity: 0.5; cursor: default; }
    button.tab {
      -webkit-app-region: no-drag;
    }
    .field input:disabled, .field select:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      background: var(--vscode-input-background);
      color: var(--vscode-disabledForeground, var(--vscode-input-foreground));
      border-color: var(--vscode-input-border, transparent);
    }
    .output {
      display: none;
      margin-top: 12px;
      height: 180px;
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
    }
    .output.visible { display: block; }
    .status { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
    .status.success { color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
  </style>
</head>
<body>
  <div class="header" id="restore-header">
    <h2>${L('webview.restore.title', 'Restaurar')} &mdash; ${escapeHtml(title)}</h2>
    <div class="provider-tabs" role="tablist">
      <button type="button" class="tab provider-tab active" data-provider="dbadmin" role="tab" aria-selected="true">DbAdmin</button>
      <button type="button" class="tab provider-tab" data-provider="pgadmin" role="tab" aria-selected="false">PgAdmin</button>
    </div>
  </div>

  <div class="content">

    <div class="provider-pane" id="provider-pgadmin">
      <div class="tabs" role="tablist">
        <button type="button" class="tab pg-tab active" data-tab="geral" role="tab" aria-selected="true">${L('webview.common.general', 'Geral')}</button>
        <button type="button" class="tab pg-tab" data-tab="dados" role="tab" aria-selected="false">${L('webview.common.data', 'Dados')}</button>
        <button type="button" class="tab pg-tab" data-tab="query" role="tab" aria-selected="false">${L('webview.common.query', 'Query')}</button>
        <button type="button" class="tab pg-tab" data-tab="tabela" role="tab" aria-selected="false">${L('webview.settings.table.title', 'Tabela')}</button>
        <button type="button" class="tab pg-tab" data-tab="opcoes" role="tab" aria-selected="false">${L('webview.common.options', 'Opções')}</button>
      </div>

      <div class="tab-pane active" id="pane-geral">
        <div class="field">
          <label for="format">${L('webview.restore.format', 'Format')}</label>
          <select id="format">
            <option value="custom" selected>Custom</option>
            <option value="tar">Tar</option>
            <option value="directory">Directory</option>
          </select>
        </div>
        <div class="field row">
          <div>
            <label for="filename">${L('webview.restore.backupFile', 'Arquivo de backup')}</label>
            <input id="filename" type="text" placeholder="${L('webview.restore.backupPlaceholder', 'Caminho do arquivo de backup...')}" />
          </div>
          <button id="browseBtn" class="secondary" style="white-space:nowrap;flex-shrink:0;">${L('webview.common.browse', 'Procurar')}</button>
        </div>
        <div class="field">
          <label for="jobs">${L('webview.restore.jobs', 'Número de jobs paralelos')}</label>
          <input id="jobs" type="number" value="1" min="1" max="64" style="width:100px;" />
        </div>
        <div class="field">
          <label for="roleName">${L('webview.backup.role', 'Role (opcional)')}</label>
          <input id="roleName" type="text" placeholder="${L('webview.restore.rolePlaceholder', 'Nome da role')}" />
        </div>
      </div>

      <div class="tab-pane" id="pane-dados">
        <div class="section-title">${L('webview.backup.sections', 'Seções')}</div>
        <div class="check-row"><input type="checkbox" id="secPreData" checked /><label for="secPreData">Pre-data</label></div>
        <div class="check-row"><input type="checkbox" id="secData" checked /><label for="secData">Data</label></div>
        <div class="check-row"><input type="checkbox" id="secPostData" checked /><label for="secPostData">Post-data</label></div>

        <div class="section-title">${L('webview.backup.objectType', 'Tipo de objeto')}</div>
        <div class="check-row"><input type="checkbox" id="onlyData" /><label for="onlyData">${L('webview.backup.onlyData', 'Somente dados')}</label></div>
        <div class="check-row"><input type="checkbox" id="onlySchema" /><label for="onlySchema">${L('webview.backup.onlySchema', 'Somente schéma')}</label></div>
      </div>

      <div class="tab-pane" id="pane-query">
        <div class="check-row"><input type="checkbox" id="includeCreateDatabase" /><label for="includeCreateDatabase">${L('webview.restore.includeCreateDb', 'Incluir CREATE DATABASE')}</label></div>
        <div class="check-row"><input type="checkbox" id="cleanBeforeRestore" /><label for="cleanBeforeRestore">${L('webview.restore.cleanBefore', 'Limpar antes de restaurar')}</label></div>
        <div class="check-row"><input type="checkbox" id="includeIfExists" /><label for="includeIfExists">${L('webview.restore.includeIfExists', 'Incluir IF EXISTS')}</label></div>
        <div class="check-row"><input type="checkbox" id="singleTransaction" /><label for="singleTransaction">${L('webview.restore.singleTransaction', 'Transação única')}</label></div>
      </div>

      <div class="tab-pane" id="pane-tabela">
        <div class="check-row"><input type="checkbox" id="enableRowSecurity" /><label for="enableRowSecurity">${L('webview.restore.enableRowSecurity', 'Habilitar row security')}</label></div>
        <div class="check-row"><input type="checkbox" id="noDataForFailedTables" /><label for="noDataForFailedTables">${L('webview.restore.noDataFailed', 'Sem dados para tabelas com erro')}</label></div>
      </div>

      <div class="tab-pane" id="pane-opcoes">
        <div class="section-title">${L('webview.restore.disable', 'Desabilitar')}</div>
        <div class="check-row"><input type="checkbox" id="disableTriggers" /><label for="disableTriggers">${L('webview.restore.triggers', 'Triggers')}</label></div>

        <div class="section-title">${L('webview.common.general', 'Geral')}</div>
        <div class="check-row"><input type="checkbox" id="verbose" /><label for="verbose">${L('webview.backup.verbose', 'Verbose')}</label></div>
        <div class="check-row"><input type="checkbox" id="useSetSessionAuthorization" /><label for="useSetSessionAuthorization">${L('webview.restore.useSetSession', 'Usar SET SESSION AUTHORIZATION')}</label></div>
        <div class="check-row"><input type="checkbox" id="exitOnError" /><label for="exitOnError">${L('webview.restore.exitOnError', 'Abortar em caso de erro')}</label></div>
        <div class="check-row"><input type="checkbox" id="dropSchema" /><label for="dropSchema">${L('webview.restore.dropSchema', 'Excluir schema')}</label></div>

        <div class="section-title">${L('webview.restore.compatibility', 'Compatibilidade')}</div>
        <div class="check-row"><input type="checkbox" id="noPrivileges" /><label for="noPrivileges">${L('webview.restore.noPrivileges', 'Sem privilégios (no acl)')}</label></div>
        <div class="check-row"><input type="checkbox" id="noOwner" /><label for="noOwner">${L('webview.restore.noOwner', 'Sem owner')}</label></div>
      </div>
    </div>

    <div class="provider-pane active" id="provider-dbadmin">
      <div class="field row">
        <div>
          <label for="dbFilename">${L('webview.restore.sqlFile', 'Arquivo SQL')}</label>
          <input id="dbFilename" type="text" placeholder="${L('webview.restore.sqlPlaceholder', 'Caminho do arquivo .sql...')}" />
        </div>
        <button id="dbBrowseBtn" class="secondary" style="white-space:nowrap;flex-shrink:0;">${L('webview.common.browse', 'Procurar')}</button>
      </div>
      <div class="field">
        <label for="dbRoleName">${L('webview.backup.role', 'Role (opcional)')}</label>
        <input id="dbRoleName" type="text" placeholder="${L('webview.restore.rolePlaceholder', 'Nome da role')}" />
      </div>
      <div class="status">${L('webview.restore.sqlNote', 'O arquivo SQL inteiro é enviado ao PostgreSQL em uma única transação (BEGIN … COMMIT), como num script simples.')}</div>
      <div class="check-row" style="justify-content: space-between; gap: 12px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="dbCleanBeforeRestore" />
          <label for="dbCleanBeforeRestore">${L('webview.restore.cleanSchemaBefore', 'Limpar schema antes do restore')}</label>
        </div>
        <button id="clearSchemaBtn" class="secondary" type="button">${L('webview.restore.clearNow', 'Limpar agora')}</button>
      </div>
      <div class="status">${L('webview.restore.clearSchemaNote', 'Remove e recria o schema inteiro.')}</div>
      <div class="check-row"><input type="checkbox" id="dbVerbose" /><label for="dbVerbose">${L('webview.restore.verboseStats', 'Verbose (estatísticas no log)')}</label></div>
      <div class="check-row" style="justify-content: space-between; gap: 12px; margin-top: 10px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="dbClearTablesBeforeRestore" />
          <label for="dbClearTablesBeforeRestore">${L('webview.restore.clearTablesBefore', 'Limpar tabelas antes do restore')}</label>
        </div>
        <button id="clearTablesBtn" class="secondary" type="button">${L('webview.restore.clearNow', 'Limpar agora')}</button>
      </div>
      <div class="status">${L('webview.restore.clearTablesNote', 'Detecta tabelas com INSERT no SQL e executa TRUNCATE ... CASCADE nelas.')}</div>
    </div>

    <div id="outputBox" class="output"></div>
  </div>

  <div class="footer">
    <span id="statusMsg" class="status"></span>
    <button id="cancelBtn" class="secondary">${L('webview.common.close', 'Fechar')}</button>
    <button id="executeBtn">${L('webview.restore.execute', 'Restaurar')}</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let activeProvider = 'dbadmin';
    let isRunning = false;
    const dbFilenameEl = document.getElementById('dbFilename');
    const pgFilenameEl = document.getElementById('filename');
    const clearTablesBtn = document.getElementById('clearTablesBtn');
    const clearSchemaBtn = document.getElementById('clearSchemaBtn');

    const rememberFilename = (provider, path) => {
      vscode.postMessage({
        type: 'rememberFilename',
        provider,
        path: String(path || ''),
      });
    };

    dbFilenameEl.addEventListener('change', () => rememberFilename('dbadmin', dbFilenameEl.value));
    pgFilenameEl.addEventListener('change', () => rememberFilename('pgadmin', pgFilenameEl.value));

    function setActiveProvider(provider) {
      if (!provider) {
        return;
      }
      activeProvider = provider;
      document.querySelectorAll('.provider-tab').forEach((t) => {
        const isSel = t.getAttribute('data-provider') === provider;
        t.classList.toggle('active', isSel);
        t.setAttribute('aria-selected', isSel ? 'true' : 'false');
      });
      document.querySelectorAll('.provider-pane').forEach((p) => {
        p.classList.toggle('active', p.id === 'provider-' + provider);
      });
    }

    const restoreHeader = document.getElementById('restore-header');
    if (restoreHeader) {
      restoreHeader.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('button.provider-tab');
        if (!btn) {
          return;
        }
        const provider = btn.getAttribute('data-provider');
        if (!provider) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        setActiveProvider(provider);
      });
    }

    const pgProviderPane = document.getElementById('provider-pgadmin');
    if (pgProviderPane) {
      pgProviderPane.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('button.pg-tab');
        if (!btn || !pgProviderPane.contains(btn)) {
          return;
        }
        const tab = btn.getAttribute('data-tab');
        if (!tab) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        pgProviderPane.querySelectorAll('.pg-tab').forEach((t) => {
          const isSel = t.getAttribute('data-tab') === tab;
          t.classList.toggle('active', isSel);
          t.setAttribute('aria-selected', isSel ? 'true' : 'false');
        });
        pgProviderPane.querySelectorAll('.tab-pane').forEach((p) => {
          p.classList.toggle('active', p.id === 'pane-' + tab);
        });
      });
    }

    document.getElementById('browseBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'browse' });
    });

    document.getElementById('dbBrowseBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'browse' });
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      if (isRunning) {
        vscode.postMessage({ type: 'abort' });
      } else {
        vscode.postMessage({ type: 'cancel' });
      }
    });

    clearTablesBtn.addEventListener('click', () => {
      if (isRunning) {
        return;
      }
      vscode.postMessage({ type: 'clearTables', filename: dbFilenameEl.value });
    });

    clearSchemaBtn.addEventListener('click', () => {
      if (isRunning) {
        return;
      }
      vscode.postMessage({ type: 'clearSchema' });
    });

    document.getElementById('executeBtn').addEventListener('click', () => {
      if (activeProvider === 'dbadmin') {
        const options = {
          mode: 'dbadmin',
          filename: dbFilenameEl.value,
          roleName: document.getElementById('dbRoleName').value,
          cleanBeforeRestore: document.getElementById('dbCleanBeforeRestore').checked,
          clearTablesBeforeRestore: document.getElementById('dbClearTablesBeforeRestore').checked,
          verbose: document.getElementById('dbVerbose').checked,
        };

        rememberFilename('dbadmin', options.filename);

        if (!options.filename.trim()) {
          document.getElementById('statusMsg').textContent = t('webview.restore.needSqlFile', 'Informe o arquivo SQL.');
          document.getElementById('statusMsg').className = 'status error';
          return;
        }

        vscode.postMessage({ type: 'execute', options });
        return;
      }

      const sections = [];
      if (document.getElementById('secPreData').checked) sections.push('pre-data');
      if (document.getElementById('secData').checked) sections.push('data');
      if (document.getElementById('secPostData').checked) sections.push('post-data');

      const options = {
        mode: 'pgadmin',
        format: document.getElementById('format').value,
        filename: pgFilenameEl.value,
        jobs: parseInt(document.getElementById('jobs').value, 10) || 1,
        roleName: document.getElementById('roleName').value,
        sections,
        onlyData: document.getElementById('onlyData').checked,
        onlySchema: document.getElementById('onlySchema').checked,
        includeCreateDatabase: document.getElementById('includeCreateDatabase').checked,
        includeIfExists: document.getElementById('includeIfExists').checked,
        cleanBeforeRestore: document.getElementById('cleanBeforeRestore').checked,
        singleTransaction: document.getElementById('singleTransaction').checked,
        enableRowSecurity: document.getElementById('enableRowSecurity').checked,
        noDataForFailedTables: document.getElementById('noDataForFailedTables').checked,
        disableTriggers: document.getElementById('disableTriggers').checked,
        useSetSessionAuthorization: document.getElementById('useSetSessionAuthorization').checked,
        exitOnError: document.getElementById('exitOnError').checked,
        dropSchema: document.getElementById('dropSchema').checked,
        noPrivileges: document.getElementById('noPrivileges').checked,
        noOwner: document.getElementById('noOwner').checked,
        verbose: document.getElementById('verbose').checked,
      };

      rememberFilename('pgadmin', options.filename);

      if (!options.filename.trim()) {
        document.getElementById('statusMsg').textContent = t('webview.restore.needBackupFile', 'Informe o arquivo de backup.');
        document.getElementById('statusMsg').className = 'status error';
        return;
      }

      vscode.postMessage({ type: 'execute', options });
    });

    window.addEventListener('message', ({ data }) => {
      const msg = data;

      if (msg.type === 'browseResult') {
        if (activeProvider === 'dbadmin') {
          dbFilenameEl.value = msg.path;
          rememberFilename('dbadmin', msg.path);
        } else {
          pgFilenameEl.value = msg.path;
          rememberFilename('pgadmin', msg.path);
        }
        return;
      }

      if (msg.type === 'restoreLastFilenames') {
        if (!dbFilenameEl.value && msg.dbadmin) {
          dbFilenameEl.value = msg.dbadmin;
        }
        if (!pgFilenameEl.value && msg.pgadmin) {
          pgFilenameEl.value = msg.pgadmin;
        }
        return;
      }

      if (msg.type === 'started') {
        isRunning = true;
        document.getElementById('executeBtn').disabled = true;
        clearTablesBtn.disabled = true;
        clearSchemaBtn.disabled = true;
        document.getElementById('cancelBtn').textContent = t('webview.restore.abort', 'Abortar');
        document.getElementById('statusMsg').textContent = t('webview.restore.restoring', 'Restaurando...');
        document.getElementById('statusMsg').className = 'status';
        const box = document.getElementById('outputBox');
        box.textContent = '';
        box.classList.add('visible');
        return;
      }

      if (msg.type === 'line') {
        const box = document.getElementById('outputBox');
        box.textContent += msg.text + '\\n';
        box.scrollTop = box.scrollHeight;
        return;
      }

      if (msg.type === 'done') {
        isRunning = false;
        document.getElementById('executeBtn').disabled = false;
        clearTablesBtn.disabled = false;
        clearSchemaBtn.disabled = false;
        document.getElementById('cancelBtn').textContent = t('webview.common.close', 'Fechar');
        const statusEl = document.getElementById('statusMsg');
        if (msg.success) {
          statusEl.textContent = msg.label ?? t('webview.restore.completed', 'Restauração concluída com sucesso.');
          statusEl.className = 'status success';
        } else {
          statusEl.textContent = tf('error.failed', { detail: msg.error || t('webview.common.unknownFailure', 'Falha desconhecida.') }, 'Erro: ' + (msg.error || 'Falha desconhecida.'));
          statusEl.className = 'status error';
        }
        return;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
