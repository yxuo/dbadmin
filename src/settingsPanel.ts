import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SHOW_QUERY_SETTING = 'dbadmin.showQueryEditor';
const HIDE_TAB_HEADER_SETTING = 'dbadmin.hideTabHeader';
const PERSIST_LAYOUT_SETTING = 'dbadmin.persistColumnLayout';
const PGADMIN_BIN_PATH_SETTING = 'dbadmin.pgAdminBinPath';
const SHOW_FILTER_LABEL_SETTING = 'dbadmin.showFilterLabel';
const DEFAULT_PAGE_SIZE_SETTING = 'dbadmin.defaultPageSize';

type SettingsWebviewMessage =
  | { type: 'ready' }
  | {
      type: 'saveSettings';
      settings: {
        showQueryEditor: boolean;
        hideTabHeader: boolean;
        showFilterLabel: boolean;
        persistColumnLayout: boolean;
        defaultPageSize: number;
        pgAdminBinPath: string;
      };
    }
  | { type: 'detectPgAdminBinPath' }
  | { type: 'openConnectionsFile' }
  | { type: 'openExtensionSettings' };

export class SettingsPanelManager {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConnectionsFilePath: () => Promise<string>
  ) {}

  public show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      void this.pushCurrentState(this.panel);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbadmin.settings',
      'DBAdmin: Configurações',
      {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

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

        await Promise.all([
          vscode.workspace
            .getConfiguration()
            .update(
              SHOW_QUERY_SETTING,
              Boolean(message.settings.showQueryEditor),
              vscode.ConfigurationTarget.Global
            ),
          vscode.workspace
            .getConfiguration()
            .update(
              HIDE_TAB_HEADER_SETTING,
              Boolean(message.settings.hideTabHeader),
              vscode.ConfigurationTarget.Global
            ),
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
        ]);

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
            'Não foi possível detectar o diretório do pgAdmin automaticamente. Informe o caminho manualmente.'
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
      onMessage.dispose();
      onConfigChange.dispose();
    });
  }

  private async pushCurrentState(panel: vscode.WebviewPanel): Promise<void> {
    const storagePath = await this.getConnectionsFilePath();
    const showQueryEditor = vscode.workspace
      .getConfiguration()
      .get<boolean>(SHOW_QUERY_SETTING, true);
    const hideTabHeader = vscode.workspace
      .getConfiguration()
      .get<boolean>(HIDE_TAB_HEADER_SETTING, false);
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

    panel.webview.postMessage({
      type: 'settingsState',
      showQueryEditor,
      hideTabHeader,
      showFilterLabel,
      persistColumnLayout,
      defaultPageSize,
      pgAdminBinPath,
      storagePath,
    });
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
    body {
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    .card {
      max-width: 760px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 14px;
      background: var(--vscode-editorWidget-background);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 16px;
    }
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .item:last-child { border-bottom: 0; }
    .actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
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
  <div class="card">
    <h1>Configurações da extensão</h1>

    <div class="item">
      <div class="meta">
        <span class="title">Mostrar query</span>
        <span class="desc">Exibe o editor de query na visualização de tabela.</span>
      </div>
      <label>
        <input id="showQueryEditor" type="checkbox" />
      </label>
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">Ocultar cabeçalho da aba de tabela</span>
        <span class="desc">Oculta o cabeçalho da aba e move o botão de menu para a toolbar.</span>
      </div>
      <label>
        <input id="hideTabHeader" type="checkbox" />
      </label>
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">Mostrar label do filtro na árvore</span>
        <span class="desc">Exibe o item de label do filtro no topo da treeview quando houver filtro ativo.</span>
      </div>
      <label>
        <input id="showFilterLabel" type="checkbox" />
      </label>
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">Persistir layout de colunas</span>
        <span class="desc">Ao abrir uma nova aba, as configurações de layout de colunas serão mantidas.</span>
      </div>
      <label>
        <input id="persistColumnLayout" type="checkbox" />
      </label>
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">Número padrão de itens por página</span>
        <span class="desc">Define o número padrão de itens exibidos por página na visualização de tabela. Pode ser ajustado para cada tabela individualmente.</span>
      </div>
      <input id="defaultPageSize" type="number" min="1" max="500" style="width:80px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:0 6px;height:26px;font-family:inherit;font-size:inherit;" />
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">pgAdmin &ndash; diretório dos binários</span>
        <span class="desc">Caminho para pg_dump e pg_restore. Deixe vazio para auto-detectar no momento do uso.</span>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <input id="pgAdminBinPath" type="text" placeholder="Ex: C:\\Program Files\\pgAdmin 4\\runtime"
            style="flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:0 6px;height:26px;font-family:inherit;font-size:inherit;" />
          <button id="detectPgAdmin" class="secondary" style="white-space:nowrap;">Detectar</button>
        </div>
      </div>
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">Arquivo de conexões</span>
        <span class="desc path" id="storagePath"></span>
      </div>
      <button id="openConnectionsFile" class="secondary">Abrir</button>
    </div>

    <div class="item">
      <div class="meta">
        <span class="title">Configurações no VS Code</span>
        <span class="desc">Abrir o editor de settings da extensão.</span>
      </div>
      <button id="openExtensionSettings" class="secondary">Abrir settings</button>
    </div>

    <div class="actions">
      <span id="saveStatus" class="status"></span>
      <button id="saveSettings">Salvar</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const showQueryEditor = document.getElementById('showQueryEditor');
    const hideTabHeader = document.getElementById('hideTabHeader');
    const showFilterLabel = document.getElementById('showFilterLabel');
    const persistColumnLayout = document.getElementById('persistColumnLayout');
    const defaultPageSize = document.getElementById('defaultPageSize');
    const pgAdminBinPath = document.getElementById('pgAdminBinPath');
    const storagePath = document.getElementById('storagePath');
    const saveSettingsBtn = document.getElementById('saveSettings');
    const saveStatus = document.getElementById('saveStatus');
    let hasUnsavedChanges = false;

    function clampPageSize(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(1, Math.min(500, Math.trunc(numeric))) : 50;
    }

    function setDirty(value) {
      hasUnsavedChanges = value;
      saveStatus.textContent = hasUnsavedChanges ? 'Alterações não salvas' : '';
    }

    function buildSettingsPayload() {
      return {
        showQueryEditor: Boolean(showQueryEditor.checked),
        hideTabHeader: Boolean(hideTabHeader.checked),
        showFilterLabel: Boolean(showFilterLabel.checked),
        persistColumnLayout: Boolean(persistColumnLayout.checked),
        defaultPageSize: clampPageSize(defaultPageSize.value),
        pgAdminBinPath: String(pgAdminBinPath.value || ''),
      };
    }

    showQueryEditor.addEventListener('change', () => {
      setDirty(true);
    });

    hideTabHeader.addEventListener('change', () => {
      setDirty(true);
    });

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

    document.getElementById('detectPgAdmin').addEventListener('click', () => {
      vscode.postMessage({ type: 'detectPgAdminBinPath' });
    });

    document.getElementById('openConnectionsFile').addEventListener('click', () => {
      vscode.postMessage({ type: 'openConnectionsFile' });
    });

    document.getElementById('openExtensionSettings').addEventListener('click', () => {
      vscode.postMessage({ type: 'openExtensionSettings' });
    });

    saveSettingsBtn.addEventListener('click', () => {
      const payload = buildSettingsPayload();
      defaultPageSize.value = String(payload.defaultPageSize);
      vscode.postMessage({ type: 'saveSettings', settings: payload });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'settingsSaved') {
        setDirty(false);
        saveStatus.textContent = 'Configurações salvas';
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

      showQueryEditor.checked = Boolean(message.showQueryEditor);
      hideTabHeader.checked = Boolean(message.hideTabHeader);
      showFilterLabel.checked = Boolean(message.showFilterLabel);
      persistColumnLayout.checked = Boolean(message.persistColumnLayout);
      defaultPageSize.value = String(message.defaultPageSize ?? 50);
      pgAdminBinPath.value = String(message.pgAdminBinPath || '');
      storagePath.textContent = String(message.storagePath || '');
      storagePath.title = String(message.storagePath || '');
      setDirty(false);
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
