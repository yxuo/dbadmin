import * as vscode from 'vscode';
import { SchemaNodeRef } from './models';
import { BackupOptions, listRoles, runDump } from './pgAdminService';

type BackupWebviewMessage =
  | { type: 'ready' }
  | { type: 'execute'; options: BackupOptions }
  | { type: 'browse' }
  | { type: 'cancel' };

export class BackupPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public show(context: vscode.ExtensionContext, node: SchemaNodeRef): void {
    const key = `${node.connection.id}:${node.databaseName}:${node.schemaName}`;
    const existing = this.panels.get(key);
    if (existing) {
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
    this.panels.set(key, panel);

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
            await runDump(
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

function buildBackupHtml(webview: vscode.Webview, node: SchemaNodeRef): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const title = `${node.schemaName} @ ${node.databaseName}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
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
    }
    .header h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    .tabs { display: flex; gap: 0; }
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
    .content { flex: 1; overflow-y: auto; padding: 14px 16px; }
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
    button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
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
  <div class="header">
    <h2>Backup &mdash; ${escapeHtml(title)}</h2>
    <div class="tabs">
      <button class="tab active" data-tab="geral">Geral</button>
      <button class="tab" data-tab="dados">Dados</button>
      <button class="tab" data-tab="query">Query</button>
      <button class="tab" data-tab="opcoes">Op&ccedil;&otilde;es</button>
    </div>
  </div>

  <div class="content">

    <!-- ABA GERAL -->
    <div class="tab-pane active" id="pane-geral">
      <div class="field row">
        <div>
          <label for="filename">Arquivo de destino</label>
          <input id="filename" type="text" placeholder="Caminho do arquivo de saída..." />
        </div>
        <button id="browseBtn" class="secondary" style="white-space:nowrap;flex-shrink:0;">Procurar</button>
      </div>
      <div class="field">
        <label for="format">Formato</label>
        <select id="format">
          <option value="custom" selected>Custom ou tar</option>
          <option value="tar">Custom ou tar (tar)</option>
          <option value="directory">Diret&oacute;rio</option>
        </select>
      </div>
      <div class="field">
        <label for="jobs">N&uacute;mero de jobs paralelos (formato Directory)</label>
        <input id="jobs" type="number" value="1" min="1" max="64" style="width:100px;" />
      </div>
      <div class="field">
        <label for="roleName">Role (opcional)</label>
        <input id="roleName" list="roleList" type="text" placeholder="Selecione ou digite uma role" />
        <datalist id="roleList"></datalist>
      </div>
    </div>

    <!-- ABA DADOS -->
    <div class="tab-pane" id="pane-dados">
      <div class="section-title">Seções</div>
      <div class="check-row"><input type="checkbox" id="secPreData" checked /><label for="secPreData">Pre-data</label></div>
      <div class="check-row"><input type="checkbox" id="secData" checked /><label for="secData">Data</label></div>
      <div class="check-row"><input type="checkbox" id="secPostData" checked /><label for="secPostData">Post-data</label></div>

      <div class="section-title">Tipo de objeto</div>
      <div class="check-row"><input type="checkbox" id="onlyData" /><label for="onlyData">Somente dados</label></div>
      <div class="check-row"><input type="checkbox" id="onlySchema" /><label for="onlySchema">Somente sch&eacute;ma</label></div>
    </div>

    <!-- ABA QUERY -->
    <div class="tab-pane" id="pane-query">
      <div class="section-title">Opções de INSERT</div>
      <div class="check-row"><input type="checkbox" id="useInserts" /><label for="useInserts">Usar INSERT em vez de COPY</label></div>
      <div class="check-row"><input type="checkbox" id="columnInserts" /><label for="columnInserts">Listar colunas nos INSERTs</label></div>

      <div class="section-title">Outros</div>
      <div class="check-row"><input type="checkbox" id="disableDollarQuoting" /><label for="disableDollarQuoting">Desabilitar dollar-quoting</label></div>
      <div class="check-row"><input type="checkbox" id="disableTriggers" /><label for="disableTriggers">Desabilitar triggers</label></div>
    </div>

    <!-- ABA OPÇÕES -->
    <div class="tab-pane" id="pane-opcoes">
      <div class="check-row"><input type="checkbox" id="verbose" /><label for="verbose">Verbose</label></div>
      <div class="check-row"><input type="checkbox" id="serializableDeferrable" /><label for="serializableDeferrable">Serializable deferrable</label></div>
      <div class="field" style="margin-top:12px;">
        <label for="lockWaitTimeout">Lock wait timeout (ms, 0 = sem limite)</label>
        <input id="lockWaitTimeout" type="number" value="0" min="0" style="width:120px;" />
      </div>
    </div>

    <div id="outputBox" class="output"></div>
  </div>

  <div class="footer">
    <span id="statusMsg" class="status"></span>
    <button id="cancelBtn" class="secondary">Fechar</button>
    <button id="executeBtn">Executar</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Tab switching
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('pane-' + btn.dataset.tab).classList.add('active');
      });
    });

    document.getElementById('browseBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'browse' });
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.getElementById('executeBtn').addEventListener('click', () => {
      const sections = [];
      if (document.getElementById('secPreData').checked) sections.push('pre-data');
      if (document.getElementById('secData').checked) sections.push('data');
      if (document.getElementById('secPostData').checked) sections.push('post-data');

      const options = {
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
        const datalist = document.getElementById('roleList');
        datalist.innerHTML = '';
        (msg.roles || []).forEach((role) => {
          const option = document.createElement('option');
          option.value = role;
          datalist.appendChild(option);
        });
        return;
      }

      if (msg.type === 'browseResult') {
        document.getElementById('filename').value = msg.path;
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
