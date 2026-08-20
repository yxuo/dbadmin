import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBcp47Locale, t } from './i18n';
import { loadLocaleDict, webviewI18nBootstrap } from './i18n/webviewLocale';
import { getSqlBookIntegratedTableEnabled, setSqlBookIntegratedTableEnabled } from './sqlBookIntegratedTable';
import { getSqlBookSaveIntegratedTableEnabled, setSqlBookSaveIntegratedTableEnabled, syncSqlBookSaveIntegratedTableContext } from './sqlBookSaveIntegratedTable';
import { getSqlBookRunPerQueryEnabled, setSqlBookRunPerQueryEnabled } from './sqlBookRunPerQuery';

const PERSIST_LAYOUT_SETTING = 'dbadmin.persistColumnLayout';
const PGADMIN_BIN_PATH_SETTING = 'dbadmin.pgAdminBinPath';
const SHOW_FILTER_LABEL_SETTING = 'dbadmin.showFilterLabel';
const DEFAULT_PAGE_SIZE_SETTING = 'dbadmin.defaultPageSize';
const SQLBOOK_INTEGRATED_TABLE_SETTING = 'dbadmin.sqlbookIntegratedTable';
const MCP_ALLOW_WRITES_SETTING = 'dbadmin.mcpAllowWrites';
const MCP_MAX_ROWS_SETTING = 'dbadmin.mcpMaxRows';

type SettingsSection = 'mcp';

type SettingsWebviewMessage =
  | { type: 'ready' }
  | {
      type: 'saveSettings';
      settings: {
        showFilterLabel: boolean;
        persistColumnLayout: boolean;
        defaultPageSize: number;
        pgAdminBinPath: string;
        sqlbookIntegratedTable: boolean;
        sqlbookSaveIntegratedTable: boolean;
        sqlbookRunPerQuery: boolean;
        mcpAllowWrites: boolean;
        mcpMaxRows: number;
      };
    }
  | { type: 'detectPgAdminBinPath' }
  | { type: 'openConnectionsFile' }
  | { type: 'openExtensionSettings' }
  | { type: 'openMcpJson' }
  | { type: 'copyMcpConfig' }
  | { type: 'exportConfig' }
  | { type: 'importConfig' };

export class SettingsPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private pendingSection: SettingsSection | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConnectionsFilePath: () => Promise<string>
  ) {}

  public show(options?: { section?: SettingsSection }): void {
    this.pendingSection = options?.section;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      this.panel.webview.html = this.buildHtml(this.panel.webview);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbadmin.settings',
      t('DBAdmin: Settings'),
      {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.attachPanel(panel);
  }

  public deserialize(webviewPanel: vscode.WebviewPanel, state: unknown): void {
    if (this.panel && this.panel !== webviewPanel) {
      this.panel.dispose();
    }

    const raw = state && typeof state === 'object'
      ? (state as { section?: unknown })
      : undefined;
    if (raw?.section === 'mcp') {
      this.pendingSection = 'mcp';
    }

    this.attachPanel(webviewPanel);
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    panel.iconPath = new vscode.ThemeIcon('settings-gear');
    panel.webview.html = this.buildHtml(panel.webview);
    this.panel = panel;

    const onMessage = panel.webview.onDidReceiveMessage(async (message: SettingsWebviewMessage) => {
      if (message.type === 'ready') {
        await this.pushCurrentState(panel);
        return;
      }

      if (message.type === 'saveSettings') {
        const numeric = Number(message.settings.defaultPageSize);
        const safePageSize = Number.isFinite(numeric)
          ? Math.max(1, Math.min(500, Math.trunc(numeric)))
          : 50;
        const mcpMaxRowsRaw = Number(message.settings.mcpMaxRows);
        const safeMcpMaxRows = Number.isFinite(mcpMaxRowsRaw)
          ? Math.max(1, Math.min(5000, Math.trunc(mcpMaxRowsRaw)))
          : 200;

        await Promise.all([
          vscode.workspace
            .getConfiguration()
            .update(
              SHOW_FILTER_LABEL_SETTING,
              Boolean(message.settings.showFilterLabel),
              vscode.ConfigurationTarget.Global
            ),
          vscode.workspace
            .getConfiguration()
            .update(
              PERSIST_LAYOUT_SETTING,
              Boolean(message.settings.persistColumnLayout),
              vscode.ConfigurationTarget.Global
            ),
          vscode.workspace
            .getConfiguration()
            .update(
              DEFAULT_PAGE_SIZE_SETTING,
              safePageSize,
              vscode.ConfigurationTarget.Global
            ),
          vscode.workspace
            .getConfiguration()
            .update(
              PGADMIN_BIN_PATH_SETTING,
              String(message.settings.pgAdminBinPath || ''),
              vscode.ConfigurationTarget.Global
            ),
          vscode.workspace
            .getConfiguration()
            .update(
              MCP_ALLOW_WRITES_SETTING,
              Boolean(message.settings.mcpAllowWrites),
              vscode.ConfigurationTarget.Global
            ),
          vscode.workspace
            .getConfiguration()
            .update(
              MCP_MAX_ROWS_SETTING,
              safeMcpMaxRows,
              vscode.ConfigurationTarget.Global
            ),
          setSqlBookIntegratedTableEnabled(
            Boolean(message.settings.sqlbookIntegratedTable),
          ),
          setSqlBookSaveIntegratedTableEnabled(
            Boolean(message.settings.sqlbookSaveIntegratedTable),
          ),
          setSqlBookRunPerQueryEnabled(
            Boolean(message.settings.sqlbookRunPerQuery),
          ),
        ]);

        await vscode.commands.executeCommand(
          'setContext',
          'dbadmin.sqlbookIntegratedTable',
          Boolean(message.settings.sqlbookIntegratedTable),
        );
        await syncSqlBookSaveIntegratedTableContext();
        await vscode.commands.executeCommand(
          'setContext',
          'dbadmin.sqlbookRunPerQuery',
          Boolean(message.settings.sqlbookRunPerQuery),
        );

        await panel.webview.postMessage({ type: 'settingsSaved' });
        return;
      }

      if (message.type === 'detectPgAdminBinPath') {
        const detected = await detectPgAdminBinPathAsync();
        if (detected) {
          await panel.webview.postMessage({
            type: 'pgAdminBinPathDetected',
            value: detected,
          });
        } else {
          vscode.window.showWarningMessage(
            t('Could not detect the pgAdmin directory automatically. Enter the path manually.')
          );
        }
        return;
      }

      if (message.type === 'openConnectionsFile') {
        const storagePath = await this.getConnectionsFilePath();
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storagePath));
        await vscode.window.showTextDocument(document, { preview: false });
        return;
      }

      if (message.type === 'openExtensionSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.dbadmin dbadmin');
        return;
      }

      if (message.type === 'openMcpJson') {
        await vscode.commands.executeCommand('dbadmin.openMcpJson');
        return;
      }

      if (message.type === 'copyMcpConfig') {
        await vscode.commands.executeCommand('dbadmin.copyMcpConfig');
        return;
      }

      if (message.type === 'exportConfig') {
        await vscode.commands.executeCommand('dbadmin.exportConfig');
        return;
      }

      if (message.type === 'importConfig') {
        await vscode.commands.executeCommand('dbadmin.importConfig');
      }
    });

    const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dbadmin')) {
        return;
      }
      void this.pushCurrentState(panel);
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.pendingSection = undefined;
      onMessage.dispose();
      onConfigChange.dispose();
    });
  }

  private async pushCurrentState(panel: vscode.WebviewPanel): Promise<void> {
    const storagePath = await this.getConnectionsFilePath();
    const showFilterLabel = vscode.workspace
      .getConfiguration()
      .get<boolean>(SHOW_FILTER_LABEL_SETTING, true);
    const persistColumnLayout = vscode.workspace
      .getConfiguration()
      .get<boolean>(PERSIST_LAYOUT_SETTING, false);
    const pgAdminBinPath = vscode.workspace
      .getConfiguration()
      .get<string>(PGADMIN_BIN_PATH_SETTING, '');
    const defaultPageSize = vscode.workspace
      .getConfiguration()
      .get<number>(DEFAULT_PAGE_SIZE_SETTING, 50);
    const mcpAllowWrites = vscode.workspace
      .getConfiguration()
      .get<boolean>(MCP_ALLOW_WRITES_SETTING, false);
    const mcpMaxRows = vscode.workspace
      .getConfiguration()
      .get<number>(MCP_MAX_ROWS_SETTING, 200);
    const sqlbookIntegratedTable = getSqlBookIntegratedTableEnabled();
    const sqlbookSaveIntegratedTable = getSqlBookSaveIntegratedTableEnabled();
    const sqlbookRunPerQuery = getSqlBookRunPerQueryEnabled();
    const focusSection = this.pendingSection;
    this.pendingSection = undefined;

    panel.webview.postMessage({
      type: 'settingsState',
      showFilterLabel,
      persistColumnLayout,
      defaultPageSize,
      pgAdminBinPath,
      sqlbookIntegratedTable,
      sqlbookSaveIntegratedTable,
      sqlbookRunPerQuery,
      mcpAllowWrites,
      mcpMaxRows,
      storagePath,
      focusSection,
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const extensionPath = this.context.extensionPath;
    const i18n = loadLocaleDict(extensionPath);
    const i18nScript = webviewI18nBootstrap(extensionPath);
    const i18nLang = getBcp47Locale();
    const L = (key: string, fallback: string) =>
      escapeHtmlAttr(i18n[key] || fallback);

    return `<!DOCTYPE html>
<html lang="${i18nLang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
    body {
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    .page-title {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 700;
    }
    .cards {
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 760px;
    }
    .card {
      max-width: 760px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 14px;
      background: var(--vscode-editorWidget-background);
    }
    .card-title {
      margin: 0;
      padding: 0 0 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 0 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .item:last-child { border-bottom: 0; }
    .actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      padding-bottom: 12px;
    }
    .status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .meta { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
    .title { font-weight: 600; }
    .desc { color: var(--vscode-descriptionForeground); }
    .path {
      display: block;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-textLink-foreground);
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 0 10px;
      height: 28px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      border-color: var(--vscode-focusBorder);
    }
  </style>
</head>
<body>
  <h1 class="page-title">${L('webview.settings.pageTitle', 'Configurações da extensão')}</h1>

  <div class="cards">
    <div class="card">
      <h2 class="card-title">${L('webview.settings.sidebar.title', 'Barra lateral')}</h2>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.sidebar.showFilterLabel', 'Mostrar label do filtro na árvore')}</span>
          <span class="desc">${L('webview.settings.sidebar.showFilterLabelDesc', 'Exibe o item de label do filtro no topo da treeview quando houver filtro ativo.')}</span>
        </div>
        <label>
          <input id="showFilterLabel" type="checkbox" />
        </label>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">${L('webview.settings.table.title', 'Tabela')}</h2>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.table.persistLayout', 'Persistir layout de colunas')}</span>
          <span class="desc">${L('webview.settings.table.persistLayoutDesc', 'Ao abrir uma nova aba, as configurações de layout de colunas serão mantidas.')}</span>
        </div>
        <label>
          <input id="persistColumnLayout" type="checkbox" />
        </label>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.table.defaultPageSize', 'Número padrão de itens por página')}</span>
          <span class="desc">${L('webview.settings.table.defaultPageSizeDesc', 'Define o número padrão de itens exibidos por página na visualização de tabela. Pode ser ajustado para cada tabela individualmente.')}</span>
        </div>
        <input id="defaultPageSize" type="number" min="1" max="500" style="width:80px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:0 6px;height:26px;font-family:inherit;font-size:inherit;" />
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">${L('webview.settings.sqlbook.title', 'SQL Book')}</h2>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.sqlbook.integratedTable', 'Mostrar tabela integrada')}</span>
          <span class="desc">${L('webview.settings.sqlbook.integratedTableDesc', 'Exibe o resultado inline na célula do SQL Book em vez de abrir o painel de resultados.')}</span>
        </div>
        <label>
          <input id="sqlbookIntegratedTable" type="checkbox" />
        </label>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.sqlbook.saveIntegratedTable', 'Salvar tabela integrada')}</span>
          <span class="desc">${L('webview.settings.sqlbook.saveIntegratedTableDesc', 'Persiste o resultado da tabela integrada no arquivo .sqlbook, como notebooks Jupyter.')}</span>
        </div>
        <label>
          <input id="sqlbookSaveIntegratedTable" type="checkbox" />
        </label>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.sqlbook.runPerQuery', 'Botão executar por query')}</span>
          <span class="desc">${L('webview.settings.sqlbook.runPerQueryDesc', 'Quando o arquivo SQL ou a célula tiver duas ou mais queries, mostra um botão Executar em cada uma. O Executar principal continua rodando o bloco inteiro.')}</span>
        </div>
        <label>
          <input id="sqlbookRunPerQuery" type="checkbox" />
        </label>
      </div>
    </div>

    <div class="card" id="mcpCard">
      <h2 class="card-title">${L('webview.settings.mcp.title', 'MCP (IA)')}</h2>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.mcp.allowWrites', 'Permitir SQL de escrita')}</span>
          <span class="desc">${L('webview.settings.mcp.allowWritesDesc', 'Por padrão a IA só executa SELECT/WITH/EXPLAIN/SHOW. Ative para INSERT/UPDATE/DELETE/DDL.')}</span>
        </div>
        <label>
          <input id="mcpAllowWrites" type="checkbox" />
        </label>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.mcp.maxRows', 'Máximo de linhas no query')}</span>
          <span class="desc">${L('webview.settings.mcp.maxRowsDesc', 'Limite de linhas retornadas pela tool MCP query.')}</span>
        </div>
        <input id="mcpMaxRows" type="number" min="1" max="5000" style="width:80px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:0 6px;height:26px;font-family:inherit;font-size:inherit;" />
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.mcp.jsonFile', 'Arquivo mcp.json do Cursor')}</span>
          <span class="desc">${L('webview.settings.mcp.jsonFileDesc', 'Sincronizado automaticamente. O gear das entradas vindas do mcp.json abre este arquivo. A lista "Configurar Ferramentas" usa o provider da extensão.')}</span>
        </div>
        <button id="openMcpJson" class="secondary">${L('webview.settings.mcp.open', 'Abrir')}</button>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.mcp.copyConfig', 'Config para Claude / outros clientes')}</span>
          <span class="desc">${L('webview.settings.mcp.copyConfigDesc', 'Copia o JSON pronto para colar em claude_desktop_config.json ou claude mcp add.')}</span>
        </div>
        <button id="copyMcpConfig" class="secondary">${L('webview.settings.mcp.copy', 'Copiar')}</button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">${L('webview.settings.other.title', 'Outros')}</h2>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.other.pgAdminBin', 'pgAdmin – diretório dos binários')}</span>
          <span class="desc">${L('webview.settings.other.pgAdminBinDesc', 'Caminho para pg_dump e pg_restore. Deixe vazio para auto-detectar no momento do uso.')}</span>
          <div style="display:flex;gap:6px;margin-top:4px;">
            <input id="pgAdminBinPath" type="text" placeholder="${L('webview.settings.other.pgAdminBinPlaceholder', 'Ex: C:\\\\Program Files\\\\pgAdmin 4\\\\runtime')}"
              style="flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:0 6px;height:26px;font-family:inherit;font-size:inherit;" />
            <button id="detectPgAdmin" class="secondary" style="white-space:nowrap;">${L('webview.common.detect', 'Detectar')}</button>
          </div>
        </div>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.backup.title', 'Exportar / importar')}</span>
          <span class="desc">${L('webview.settings.backup.desc', 'Exporta ou importa todas as configurações do DBAdmin, conexões (incluindo senhas) e layouts de tabela.')}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button id="exportConfig" class="secondary">${L('webview.settings.backup.export', 'Exportar')}</button>
          <button id="importConfig" class="secondary">${L('webview.settings.backup.import', 'Importar')}</button>
        </div>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.other.connectionsFile', 'Arquivo global de conexões')}</span>
          <span class="desc">${L('webview.settings.other.connectionsFileDesc', 'Compartilhado entre todos os workspaces deste usuário no VS Code.')}</span>
          <span class="desc path" id="storagePath"></span>
        </div>
        <button id="openConnectionsFile" class="secondary">${L('webview.common.open', 'Abrir')}</button>
      </div>

      <div class="item">
        <div class="meta">
          <span class="title">${L('webview.settings.other.vscodeSettings', 'Configurações no VS Code')}</span>
          <span class="desc">${L('webview.settings.other.vscodeSettingsDesc', 'Abrir o editor de settings da extensão.')}</span>
        </div>
        <button id="openExtensionSettings" class="secondary">${L('webview.settings.other.openSettings', 'Abrir settings')}</button>
      </div>
    </div>

  </div>

  <div class="actions">
    <span id="saveStatus" class="status"></span>
    <button id="saveSettings">${L('webview.common.save', 'Salvar')}</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.setState({
      kind: 'settings',
      ...((vscode.getState() && vscode.getState().section === 'mcp')
        ? { section: 'mcp' }
        : {}),
    });
    const showFilterLabel = document.getElementById('showFilterLabel');
    const persistColumnLayout = document.getElementById('persistColumnLayout');
    const defaultPageSize = document.getElementById('defaultPageSize');
    const pgAdminBinPath = document.getElementById('pgAdminBinPath');
    const sqlbookIntegratedTable = document.getElementById('sqlbookIntegratedTable');
    const sqlbookSaveIntegratedTable = document.getElementById('sqlbookSaveIntegratedTable');
    const sqlbookRunPerQuery = document.getElementById('sqlbookRunPerQuery');
    const mcpAllowWrites = document.getElementById('mcpAllowWrites');
    const mcpMaxRows = document.getElementById('mcpMaxRows');
    const storagePath = document.getElementById('storagePath');
    const saveSettingsBtn = document.getElementById('saveSettings');
    const saveStatus = document.getElementById('saveStatus');
    let hasUnsavedChanges = false;
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

    function restoreFocusIfTransient() {
      if (Date.now() > focusGuardUntil) {
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

    window.addEventListener('focus', () => {
      focusGuardUntil = Date.now() + FOCUS_GUARD_MS;
      runStickyFocus();
    });

    document.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement) {
        lastPointerTarget = event.target;
        beginStickyFocus(event.target);
      }
      restoreFocusIfTransient();
    }, true);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        runStickyFocus();
      }
    });

    function clampPageSize(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(1, Math.min(500, Math.trunc(numeric))) : 50;
    }

    function clampMcpMaxRows(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(1, Math.min(5000, Math.trunc(numeric))) : 200;
    }

    function setDirty(value) {
      hasUnsavedChanges = value;
      saveStatus.textContent = hasUnsavedChanges ? 'Alterações não salvas' : '';
    }

    function buildSettingsPayload() {
      return {
        showFilterLabel: Boolean(showFilterLabel.checked),
        persistColumnLayout: Boolean(persistColumnLayout.checked),
        defaultPageSize: clampPageSize(defaultPageSize.value),
        pgAdminBinPath: String(pgAdminBinPath.value || ''),
        sqlbookIntegratedTable: Boolean(sqlbookIntegratedTable.checked),
        sqlbookSaveIntegratedTable: Boolean(sqlbookSaveIntegratedTable && sqlbookSaveIntegratedTable.checked),
        sqlbookRunPerQuery: Boolean(sqlbookRunPerQuery.checked),
        mcpAllowWrites: Boolean(mcpAllowWrites.checked),
        mcpMaxRows: clampMcpMaxRows(mcpMaxRows.value),
      };
    }

    showFilterLabel.addEventListener('change', () => {
      setDirty(true);
    });

    persistColumnLayout.addEventListener('change', () => {
      setDirty(true);
    });

    defaultPageSize.addEventListener('change', () => {
      defaultPageSize.value = String(clampPageSize(defaultPageSize.value));
      setDirty(true);
    });

    pgAdminBinPath.addEventListener('change', () => {
      setDirty(true);
    });

    sqlbookIntegratedTable.addEventListener('change', () => {
      setDirty(true);
    });

    sqlbookSaveIntegratedTable?.addEventListener('change', () => {
      setDirty(true);
    });

    sqlbookRunPerQuery.addEventListener('change', () => {
      setDirty(true);
    });

    mcpAllowWrites.addEventListener('change', () => {
      setDirty(true);
    });

    mcpMaxRows.addEventListener('change', () => {
      mcpMaxRows.value = String(clampMcpMaxRows(mcpMaxRows.value));
      setDirty(true);
    });

    document.getElementById('detectPgAdmin').addEventListener('click', () => {
      vscode.postMessage({ type: 'detectPgAdminBinPath' });
    });

    document.getElementById('openConnectionsFile').addEventListener('click', () => {
      vscode.postMessage({ type: 'openConnectionsFile' });
    });

    document.getElementById('exportConfig').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportConfig' });
    });

    document.getElementById('importConfig').addEventListener('click', () => {
      vscode.postMessage({ type: 'importConfig' });
    });

    document.getElementById('openExtensionSettings').addEventListener('click', () => {
      vscode.postMessage({ type: 'openExtensionSettings' });
    });

    document.getElementById('openMcpJson').addEventListener('click', () => {
      vscode.postMessage({ type: 'openMcpJson' });
    });

    document.getElementById('copyMcpConfig').addEventListener('click', () => {
      vscode.postMessage({ type: 'copyMcpConfig' });
    });

    saveSettingsBtn.addEventListener('click', () => {
      const payload = buildSettingsPayload();
      defaultPageSize.value = String(payload.defaultPageSize);
      mcpMaxRows.value = String(payload.mcpMaxRows);
      vscode.postMessage({ type: 'saveSettings', settings: payload });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'settingsSaved') {
        setDirty(false);
        saveStatus.textContent = t('webview.settings.saved', 'Configurações salvas');
        setTimeout(() => {
          if (!hasUnsavedChanges) {
            saveStatus.textContent = '';
          }
        }, 1600);
        return;
      }

      if (message.type === 'pgAdminBinPathDetected') {
        pgAdminBinPath.value = String(message.value || '');
        setDirty(true);
        return;
      }

      if (message.type !== 'settingsState') {
        return;
      }

      showFilterLabel.checked = Boolean(message.showFilterLabel);
      persistColumnLayout.checked = Boolean(message.persistColumnLayout);
      defaultPageSize.value = String(message.defaultPageSize ?? 50);
      pgAdminBinPath.value = String(message.pgAdminBinPath || '');
      sqlbookIntegratedTable.checked = Boolean(message.sqlbookIntegratedTable);
      if (sqlbookSaveIntegratedTable) {
        sqlbookSaveIntegratedTable.checked = Boolean(message.sqlbookSaveIntegratedTable);
      }
      sqlbookRunPerQuery.checked = Boolean(message.sqlbookRunPerQuery);
      mcpAllowWrites.checked = Boolean(message.mcpAllowWrites);
      mcpMaxRows.value = String(message.mcpMaxRows ?? 200);
      storagePath.textContent = String(message.storagePath || '');
      storagePath.title = String(message.storagePath || '');
      setDirty(false);

      vscode.setState({
        kind: 'settings',
        ...(message.focusSection === 'mcp' ? { section: 'mcp' } : {}),
      });

      if (message.focusSection === 'mcp') {
        const mcpCard = document.getElementById('mcpCard');
        if (mcpCard) {
          mcpCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

async function detectPgAdminBinPathAsync(): Promise<string | undefined> {
  const candidates: string[] = [];

  if (os.platform() === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';

    for (const base of [localAppData, programFiles, programFilesX86]) {
      if (!base) {
        continue;
      }
      candidates.push(path.join(base, 'pgAdmin 4', 'runtime'));
      candidates.push(path.join(base, 'Programs', 'pgAdmin 4', 'runtime'));
      candidates.push(path.join(base, 'pgAdmin 4', 'v8', 'runtime'));
      candidates.push(path.join(base, 'pgAdmin 4', 'v7', 'runtime'));
      candidates.push(path.join(base, 'pgAdmin 4', 'v6', 'runtime'));
    }
  } else {
    candidates.push(
      '/usr/lib/postgresql/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin'
    );
  }

  for (const candidate of candidates) {
    const binary = os.platform() === 'win32' ? 'pg_dump.exe' : 'pg_dump';
    try {
      fs.accessSync(path.join(candidate, binary), fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }

  return undefined;
}

function escapeHtmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
