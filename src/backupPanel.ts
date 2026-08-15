import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SchemaNodeRef } from './models';
import { BackupOptions, listRoles, runBackup } from './backupRestoreService';

type BackupWebviewMessage =
  | { type: 'ready' }
  | { type: 'execute'; options: BackupOptions }
  | { type: 'browse' }
  | { type: 'cancel' };

function logBackupPanelLifecycle(phase: string, key: string, node: SchemaNodeRef): void {
  console.log(`[dbadmin extension][backup] ${phase}`, {
    key,
    database: node.databaseName,
    schema: node.schemaName,
    connectionId: node.connection.id,
    at: new Date().toISOString(),
  });
}

export class BackupPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public show(context: vscode.ExtensionContext, node: SchemaNodeRef): void {
    void context;
    void this.context;
    const key = `${node.connection.id}:${node.databaseName}:${node.schemaName}`;
    logBackupPanelLifecycle('show() — abrir ou focar painel de backup', key, node);
    const existing = this.panels.get(key);
    if (existing) {
      existing.webview.html = buildBackupHtml(existing.webview, node);
      logBackupPanelLifecycle('HTML da webview atualizado (painel já existia)', key, node);
      existing.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbadmin.backup',
      `Backup — ${node.schemaName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.iconPath = new vscode.ThemeIcon('cloud-download');
    panel.webview.html = buildBackupHtml(panel.webview, node);
    logBackupPanelLifecycle('Painel novo criado + HTML definido', key, node);
    this.panels.set(key, panel);

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        logBackupPanelLifecycle('webview do backup ficou visível (onDidChangeViewState)', key, node);
      }
    });

    let running = false;

    const disposition = panel.webview.onDidReceiveMessage(
      async (message: BackupWebviewMessage) => {
        if (message.type === 'ready') {
          try {
            const roles = await listRoles(node.connection);
            panel.webview.postMessage({ type: 'roles', roles });
          } catch {
            panel.webview.postMessage({ type: 'roles', roles: [] });
          }
          return;
        }

        if (message.type === 'browse') {
          const uri = await vscode.window.showSaveDialog({
            title: 'Salvar arquivo de backup',
            filters: {
              'Backup PostgreSQL': ['backup', 'dump', 'tar', 'sql'],
              'Todos os arquivos': ['*'],
            },
          });
          if (uri) {
            panel.webview.postMessage({ type: 'browseResult', path: uri.fsPath });
          }
          return;
        }

        if (message.type === 'execute') {
          if (running) {
            return;
          }
          running = true;
          panel.webview.postMessage({ type: 'started' });

          try {
            await runBackup(
              node.connection,
              node.databaseName,
              node.schemaName,
              message.options,
              (line) => panel.webview.postMessage({ type: 'line', text: line })
            );
            panel.webview.postMessage({ type: 'done', success: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({ type: 'done', success: false, error: msg });
          } finally {
            running = false;
          }
          return;
        }

        if (message.type === 'cancel') {
          panel.dispose();
        }
      }
    );

    panel.onDidDispose(() => {
      this.panels.delete(key);
      disposition.dispose();
    });
  }
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildBackupHtml(webview: vscode.Webview, node: SchemaNodeRef): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const title = `${node.schemaName} @ ${node.databaseName}`;
  const dbSuggestion = suggestDumpPath('sql');
  const pgSuggestion = suggestDumpPath('backup');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
    }
    .header h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    .provider-tabs { display: flex; gap: 0; margin-bottom: 10px; }
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
      -webkit-app-region: no-drag;
    }
    .tab.active {
      border-bottom: 2px solid var(--vscode-focusBorder);
      opacity: 1;
      font-weight: 600;
    }
    .tab:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .content {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 16px;
    }
    .provider-pane { display: none; }
    .provider-pane.active { display: block; }
    .field { margin-bottom: 12px; }
    .field label { display: block; margin-bottom: 4px; font-weight: 500; }
    .field input[type=text], .field input[type=number], .field select, .field textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 4px 8px;
      overflow: hidden;
      background-clip: padding-box;
      font-family: inherit;
      font-size: inherit;
    }
    .field input[type=text], .field input[type=number], .field select { height: 28px; }
    .field textarea {
      min-height: 72px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .field.row { display: flex; gap: 8px; align-items: flex-end; }
    .field.row > :first-child { flex: 1; }
    .check-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .check-row label { margin: 0; }
    .section-title { font-weight: 600; margin: 14px 0 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 11px; }
    .tabs { display: flex; gap: 0; margin-bottom: 8px; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
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
    button.secondary:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    button:disabled { opacity: 0.5; cursor: default; }
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
  <div class="header" id="backup-header">
    <h2>Backup &mdash; ${escapeHtml(title)}</h2>
    <div class="provider-tabs" role="tablist">
      <button type="button" class="tab provider-tab active" data-provider="tab1" role="tab" aria-selected="true">DbAdmin</button>
      <button type="button" class="tab provider-tab" data-provider="tab2" role="tab" aria-selected="false">PgAdmin</button>
    </div>
  </div>

  <div class="content">
    <div class="provider-pane active" id="provider-tab1">
      <div class="field row">
        <div>
          <label for="dbFilename">Arquivo SQL de destino</label>
          <input id="dbFilename" type="text" placeholder="Caminho do arquivo .sql..." />
        </div>
        <button id="dbBrowseBtn" class="secondary" type="button" style="white-space:nowrap;flex-shrink:0;">Procurar</button>
      </div>
      <div class="check-row"><input type="checkbox" id="dbIncludeData" checked /><label for="dbIncludeData">Incluir dados no dump</label></div>
      <div class="field">
        <label for="dbRoleName">Role (opcional)</label>
        <select id="dbRoleName">
          <option value="">(Padrão)</option>
        </select>
      </div>
      <div class="check-row"><input type="checkbox" id="dbVerbose" /><label for="dbVerbose">Verbose</label></div>
      <div class="field" style="margin-top:12px;">
        <label for="dbLockWaitTimeout">Lock wait timeout (ms, 0 = sem limite)</label>
        <input id="dbLockWaitTimeout" type="number" value="0" min="0" style="width:120px;" />
      </div>
      <div class="field">
        <label for="dbExcludeTables">Ignorar dados das tabelas (opcional)</label>
        <textarea id="dbExcludeTables" rows="4" placeholder="Um nome por linha ou separados por vírgula&#10;Ex.: django_migrations&#10;tmp_financials"></textarea>
      </div>
      <div class="status">O schema e o DDL das tabelas continuam no arquivo; só as linhas (INSERT) e setval das sequences ligadas são omitidos.</div>
    </div>
    <div class="provider-pane" id="provider-tab2">
      <div id="pgadmin-tabs-root">
        <div class="tabs" role="tablist">
          <button type="button" class="tab pg-tab active" data-tab="geral" role="tab" aria-selected="true">Geral</button>
          <button type="button" class="tab pg-tab" data-tab="dados" role="tab" aria-selected="false">Dados</button>
          <button type="button" class="tab pg-tab" data-tab="query" role="tab" aria-selected="false">Query</button>
          <button type="button" class="tab pg-tab" data-tab="opcoes" role="tab" aria-selected="false">Op&ccedil;&otilde;es</button>
        </div>

        <div class="tab-pane active" id="pane-geral">
          <div class="field row">
            <div>
              <label for="filename">Arquivo de destino</label>
              <input id="filename" type="text" placeholder="Caminho do arquivo de saída..." />
            </div>
            <button id="browseBtn" class="secondary" type="button" style="white-space:nowrap;flex-shrink:0;">Procurar</button>
          </div>
          <div class="field">
            <label for="format">Formato</label>
            <select id="format">
              <option value="custom" selected>Custom</option>
              <option value="tar">Tar</option>
              <option value="plain">Plain</option>
              <option value="directory">Directory</option>
            </select>
          </div>
          <div class="field">
            <label for="jobs">N&uacute;mero de jobs paralelos (formato Directory)</label>
            <input id="jobs" type="number" value="1" min="1" max="64" style="width:100px;" />
          </div>
          <div class="field">
            <label for="roleName">Role (opcional)</label>
            <select id="roleName">
              <option value="">(Padrão)</option>
            </select>
          </div>
        </div>

        <div class="tab-pane" id="pane-dados">
          <div class="section-title">Seções</div>
          <div class="check-row"><input type="checkbox" id="secPreData" checked /><label for="secPreData">Pre-data</label></div>
          <div class="check-row"><input type="checkbox" id="secData" checked /><label for="secData">Data</label></div>
          <div class="check-row"><input type="checkbox" id="secPostData" checked /><label for="secPostData">Post-data</label></div>

          <div class="section-title">Tipo de objeto</div>
          <div class="check-row"><input type="checkbox" id="onlyData" /><label for="onlyData">Somente dados</label></div>
          <div class="check-row"><input type="checkbox" id="onlySchema" /><label for="onlySchema">Somente sch&eacute;ma</label></div>
        </div>

        <div class="tab-pane" id="pane-query">
          <div class="section-title">Opções de INSERT</div>
          <div class="check-row"><input type="checkbox" id="useInserts" /><label for="useInserts">Usar INSERT em vez de COPY</label></div>
          <div class="check-row"><input type="checkbox" id="columnInserts" /><label for="columnInserts">Listar colunas nos INSERTs</label></div>

          <div class="section-title">Outros</div>
          <div class="check-row"><input type="checkbox" id="disableDollarQuoting" /><label for="disableDollarQuoting">Desabilitar dollar-quoting</label></div>
          <div class="check-row"><input type="checkbox" id="disableTriggers" /><label for="disableTriggers">Desabilitar triggers</label></div>
        </div>

        <div class="tab-pane" id="pane-opcoes">
          <div class="check-row"><input type="checkbox" id="verbose" /><label for="verbose">Verbose</label></div>
          <div class="check-row"><input type="checkbox" id="serializableDeferrable" /><label for="serializableDeferrable">Serializable deferrable</label></div>
          <div class="field" style="margin-top:12px;">
            <label for="lockWaitTimeout">Lock wait timeout (ms, 0 = sem limite)</label>
            <input id="lockWaitTimeout" type="number" value="0" min="0" style="width:120px;" />
          </div>
        </div>
      </div>
    </div>
    <div id="outputBox" class="output"></div>
  </div>

  <div class="footer">
    <span id="statusMsg" class="status"></span>
    <button id="cancelBtn" class="secondary" type="button">Fechar</button>
    <button id="executeBtn" type="button">Executar</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialDbSuggestion = ${safeInlineJson(dbSuggestion)};
    const initialPgSuggestion = ${safeInlineJson(pgSuggestion)};
    let activeProvider = 'tab1';
    let lastPgSuggested = initialPgSuggestion;

    const dbFilenameEl = document.getElementById('dbFilename');
    const pgFilenameEl = document.getElementById('filename');
    const formatEl = document.getElementById('format');

    if (dbFilenameEl) {
      dbFilenameEl.value = initialDbSuggestion;
    }
    if (pgFilenameEl) {
      pgFilenameEl.value = initialPgSuggestion;
    }

    function setActiveProvider(provider) {
      if (!provider) {
        return;
      }
      activeProvider = provider;
      document.querySelectorAll('.provider-tab').forEach((tab) => {
        const isSel = tab.getAttribute('data-provider') === provider;
        tab.classList.toggle('active', isSel);
        tab.setAttribute('aria-selected', isSel ? 'true' : 'false');
      });
      document.querySelectorAll('.provider-pane').forEach((pane) => {
        pane.classList.toggle('active', pane.id === 'provider-' + provider);
      });
    }

    const backupHeader = document.getElementById('backup-header');
    if (backupHeader) {
      backupHeader.addEventListener('click', (ev) => {
        const target = ev.target;
        const button = target && target.closest && target.closest('button.provider-tab');
        if (!button) {
          return;
        }
        const provider = button.getAttribute('data-provider');
        if (!provider) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        setActiveProvider(provider);
      });
    }

    document.getElementById('dbBrowseBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'browse' });
    });

    document.getElementById('browseBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'browse' });
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    const pgTabsRoot = document.getElementById('pgadmin-tabs-root');
    if (pgTabsRoot) {
      pgTabsRoot.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('button.pg-tab');
        if (!btn || !pgTabsRoot.contains(btn)) {
          return;
        }
        const tab = btn.getAttribute('data-tab');
        if (!tab) {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        pgTabsRoot.querySelectorAll('.pg-tab').forEach((t) => {
          const isSel = t.getAttribute('data-tab') === tab;
          t.classList.toggle('active', isSel);
          t.setAttribute('aria-selected', isSel ? 'true' : 'false');
        });
        pgTabsRoot.querySelectorAll('.tab-pane').forEach((p) => {
          p.classList.toggle('active', p.id === 'pane-' + tab);
        });
      });
    }

    if (formatEl && pgFilenameEl) {
      formatEl.addEventListener('change', () => {
        const currentValue = pgFilenameEl.value.trim();
        const shouldUpdate = !currentValue || currentValue === lastPgSuggested;
        const nextSuggestion = replaceDumpExtension(initialPgSuggestion, extensionFromFormat(formatEl.value));
        lastPgSuggested = nextSuggestion;
        if (shouldUpdate) {
          pgFilenameEl.value = nextSuggestion;
        }
      });
    }

    function parseDbExcludeTables(text) {
      return String(text || '')
        .split(/[\\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    document.getElementById('executeBtn').addEventListener('click', () => {
      if (activeProvider === 'tab1') {
        const options = {
          mode: 'dbadmin',
          filename: document.getElementById('dbFilename').value,
          includeData: document.getElementById('dbIncludeData').checked,
          excludeDataTables: parseDbExcludeTables(document.getElementById('dbExcludeTables').value),
          roleName: document.getElementById('dbRoleName').value,
          lockWaitTimeout: parseInt(document.getElementById('dbLockWaitTimeout').value, 10) || 0,
          verbose: document.getElementById('dbVerbose').checked,
        };

        if (!options.filename.trim()) {
          document.getElementById('statusMsg').textContent = 'Informe o arquivo SQL de destino.';
          document.getElementById('statusMsg').className = 'status error';
          return;
        }

        vscode.postMessage({ type: 'execute', options });
        return;
      }

      const sections = [];
      if (document.getElementById('secPreData').checked) {
        sections.push('pre-data');
      }
      if (document.getElementById('secData').checked) {
        sections.push('data');
      }
      if (document.getElementById('secPostData').checked) {
        sections.push('post-data');
      }

      const options = {
        mode: 'pgadmin',
        filename: document.getElementById('filename').value,
        format: document.getElementById('format').value,
        jobs: parseInt(document.getElementById('jobs').value, 10) || 1,
        roleName: document.getElementById('roleName').value,
        sections,
        onlyData: document.getElementById('onlyData').checked,
        onlySchema: document.getElementById('onlySchema').checked,
        useInserts: document.getElementById('useInserts').checked,
        columnInserts: document.getElementById('columnInserts').checked,
        disableDollarQuoting: document.getElementById('disableDollarQuoting').checked,
        disableTriggers: document.getElementById('disableTriggers').checked,
        verbose: document.getElementById('verbose').checked,
        serializableDeferrable: document.getElementById('serializableDeferrable').checked,
        lockWaitTimeout: parseInt(document.getElementById('lockWaitTimeout').value, 10) || 0,
      };

      if (!options.filename.trim()) {
        document.getElementById('statusMsg').textContent = 'Informe o arquivo de destino.';
        document.getElementById('statusMsg').className = 'status error';
        return;
      }

      vscode.postMessage({ type: 'execute', options });
    });

    window.addEventListener('message', ({ data }) => {
      const msg = data;

      if (msg.type === 'roles') {
        const roles = Array.isArray(msg.roles) ? msg.roles : [];
        const pgSelect = document.getElementById('roleName');
        const dbSelect = document.getElementById('dbRoleName');

        [pgSelect, dbSelect].forEach((selectEl) => {
          if (!selectEl) {
            return;
          }
          const current = selectEl.value;
          selectEl.innerHTML = '';

          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent = '(Padrão)';
          selectEl.appendChild(blank);

          roles.forEach((role) => {
            const option = document.createElement('option');
            option.value = role;
            option.textContent = role;
            selectEl.appendChild(option);
          });

          if ([...selectEl.options].some((option) => option.value === current)) {
            selectEl.value = current;
          }
        });
        return;
      }

      if (msg.type === 'browseResult') {
        if (activeProvider === 'tab1') {
          document.getElementById('dbFilename').value = msg.path;
        } else {
          document.getElementById('filename').value = msg.path;
          lastPgSuggested = msg.path;
        }
        return;
      }

      if (msg.type === 'started') {
        document.getElementById('executeBtn').disabled = true;
        document.getElementById('statusMsg').textContent = 'Executando...';
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
        document.getElementById('executeBtn').disabled = false;
        const statusEl = document.getElementById('statusMsg');
        if (msg.success) {
          statusEl.textContent = 'Backup concluído com sucesso.';
          statusEl.className = 'status success';
        } else {
          statusEl.textContent = 'Erro: ' + (msg.error || 'Falha desconhecida.');
          statusEl.className = 'status error';
        }
      }
    });

    vscode.postMessage({ type: 'ready' });

    function extensionFromFormat(format) {
      if (format === 'tar') {
        return 'tar';
      }
      if (format === 'plain') {
        return 'sql';
      }
      if (format === 'directory') {
        return 'dir';
      }
      return 'backup';
    }

    function replaceDumpExtension(filePath, extension) {
      const normalized = String(filePath || '');
      const lastDot = normalized.lastIndexOf('.');
      const base = lastDot > 0 ? normalized.slice(0, lastDot) : normalized;
      return base + '.' + extension;
    }
  </script>
</body>
</html>`;
}

function suggestDumpPath(extension: string): string {
  const timestamp = buildTimestamp();
  const downloads = resolveDownloadsDir();
  return path.join(downloads, `dump-${timestamp}.${extension}`);
}

function resolveDownloadsDir(): string {
  const home = os.homedir();
  const downloads = path.join(home, 'Downloads');
  if (fs.existsSync(downloads)) {
    return downloads;
  }
  return home;
}

function buildTimestamp(): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}--${hh}-${min}-${ss}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
