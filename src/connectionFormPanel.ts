import * as vscode from 'vscode';
import { PostgresConnection, PostgresConnectionInput } from './models';
import { PostgresService } from './postgresService';

export type ConnectionDraft = PostgresConnectionInput;

type FormMode = 'create' | 'edit';

type FormMessage =
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'test'; payload: ConnectionDraft }
  | { type: 'save'; payload: ConnectionDraft };

export async function showConnectionForm(
  context: vscode.ExtensionContext,
  postgresService: PostgresService,
  mode: FormMode,
  current?: PostgresConnection
): Promise<ConnectionDraft | undefined> {
  const panel = vscode.window.createWebviewPanel(
    'database.connectionForm',
    mode === 'create' ? 'Nova conexão' : `Editar conexão: ${current?.nickname ?? ''}`,
    {
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Active,
    },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const initialData: ConnectionDraft = {
    nickname: current?.nickname ?? '',
    host: current?.host ?? 'localhost',
    port: current?.port ?? 5432,
    database: current?.database ?? 'postgres',
    visibleDatabases: current?.visibleDatabases ?? [],
    user: current?.user ?? 'postgres',
    password: current?.password ?? '',
    ssl: current?.ssl ?? false,
  };

  panel.webview.html = getHtml(panel.webview, context.extensionUri, mode, initialData);

  return new Promise<ConnectionDraft | undefined>((resolve) => {
    let settled = false;

    const finish = (value: ConnectionDraft | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const disposable = panel.webview.onDidReceiveMessage(async (message: FormMessage) => {
      if (message.type === 'ready') {
        panel.webview.postMessage({
          type: 'hydrate',
          payload: initialData,
        });
        return;
      }

      if (message.type === 'cancel') {
        disposable.dispose();
        finish(undefined);
        panel.dispose();
        return;
      }

      if (message.type === 'test') {
        try {
          validateDraft(message.payload);
          const version = await postgresService.testConnection(message.payload);
          panel.webview.postMessage({
            type: 'testResult',
            ok: true,
            message: `Conexão OK. ${version}`,
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          panel.webview.postMessage({
            type: 'testResult',
            ok: false,
            message: errorMessage,
          });
        }
        return;
      }

      if (message.type === 'save') {
        try {
          validateDraft(message.payload);
          disposable.dispose();
          finish(message.payload);
          panel.dispose();
        } catch (error) {
          panel.webview.postMessage({
            type: 'saveResult',
            ok: false,
            message: getErrorMessage(error),
          });
        }
      }
    });

    panel.onDidDispose(() => {
      disposable.dispose();
      finish(undefined);
    });
  });
}

function validateDraft(draft: ConnectionDraft): void {
  if (!draft.nickname.trim()) {
    throw new Error('Apelido e obrigatorio.');
  }
  if (!draft.host.trim()) {
    throw new Error('Host e obrigatorio.');
  }
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
    throw new Error('Porta invalida. Use um valor entre 1 e 65535.');
  }
  if (!draft.database.trim()) {
    throw new Error('Database e obrigatorio.');
  }
  if (!draft.user.trim()) {
    throw new Error('Usuario e obrigatorio.');
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    return message || 'Erro inesperado';
  }

  if (typeof error === 'string') {
    const message = error.trim();
    return message || 'Erro inesperado';
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
  }

  try {
    return JSON.stringify(error) || 'Erro inesperado';
  } catch {
    return 'Erro inesperado';
  }
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: FormMode,
  initialData: ConnectionDraft
): string {
  const nonce = String(Date.now());
  const title = mode === 'create' ? 'Nova conexão' : 'Editar conexão';
  const escaped = JSON.stringify(initialData).replace(/</g, '\\u003c');
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
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
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .shell {
      max-width: 760px;
      margin: 0 auto;
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 14px;
      background: var(--vscode-editorWidget-background);
    }
    .title {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
    }
    .subtitle {
      margin: 6px 0 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 16px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field.full {
      grid-column: 1 / -1;
    }
    label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
    }
    input, textarea {
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: var(--control-radius);
      min-height: var(--control-height);
      box-sizing: border-box;
      width: 100%;
      padding: 0 10px;
      outline: none;
      line-height: 1.35;
      font-family: inherit;
      font-size: 13px;
      overflow: hidden;
      background-clip: padding-box;
    }
    input:focus, textarea:focus {
      border-color: var(--dbadmin-input-focus);
    }
    input[readonly] {
      color: var(--vscode-descriptionForeground);
      cursor: default;
    }
    textarea {
      resize: vertical;
      min-height: 84px;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .row input[type="checkbox"] {
      width: 14px;
      height: 14px;
      min-height: 14px;
      margin: 0;
      accent-color: var(--dbadmin-input-focus);
      cursor: pointer;
    }
    .row span {
      color: var(--vscode-foreground);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 12px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: var(--control-radius);
      height: 28px;
      padding: 0 12px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-family: inherit;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover {
      border-color: var(--vscode-focusBorder);
    }
    .status {
      margin-top: 18px;
      min-height: 22px;
      color: var(--vscode-descriptionForeground);
    }
    .status.ok {
      color: var(--vscode-testing-iconPassed);
    }
    .status.error {
      color: var(--vscode-errorForeground);
    }
    @media (max-width: 720px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div>
        <h1 class="title">${title}</h1>
        <p class="subtitle">Escolha o tipo de banco, configure a conexão, teste e salve.</p>
      </div>

      <div class="grid">
        <div class="field full">
          <label for="engine">Tipo de banco</label>
          <input id="engine" readonly aria-readonly="true" value="PostgreSQL" />
        </div>
        <div class="field">
          <label for="nickname">Apelido</label>
          <input id="nickname" />
        </div>
        <div class="field">
          <label for="host">Host</label>
          <input id="host" />
        </div>
        <div class="field">
          <label for="port">Porta</label>
          <input id="port" type="number" min="1" max="65535" />
        </div>
        <div class="field">
          <label for="database">Database</label>
          <input id="database" />
        </div>
        <div class="field full">
          <label for="visibleDatabases">Bancos visiveis na sidebar (opcional)</label>
          <textarea id="visibleDatabases" placeholder="Um nome por linha ou separado por virgula"></textarea>
        </div>
        <div class="field">
          <label for="user">Usuario</label>
          <input id="user" />
        </div>
        <div class="field">
          <label for="password">Senha</label>
          <input id="password" type="password" />
        </div>
        <div class="field full">
          <label>SSL</label>
          <label class="row" for="ssl">
            <input id="ssl" type="checkbox" />
            <span>Ativar SSL</span>
          </label>
        </div>
      </div>

      <div id="status" class="status"></div>

      <div class="actions">
        <button id="cancel">Cancelar</button>
        <button id="test">Testar conexão</button>
        <button id="save" class="primary">Salvar</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialData = ${escaped};
    const status = document.getElementById('status');
    const fields = {
      engine: document.getElementById('engine'),
      nickname: document.getElementById('nickname'),
      host: document.getElementById('host'),
      port: document.getElementById('port'),
      database: document.getElementById('database'),
      visibleDatabases: document.getElementById('visibleDatabases'),
      user: document.getElementById('user'),
      password: document.getElementById('password'),
      ssl: document.getElementById('ssl'),
    };

    function hydrate(data) {
      fields.engine.value = 'PostgreSQL';
      fields.nickname.value = data.nickname || '';
      fields.host.value = data.host || 'localhost';
      fields.port.value = String(data.port || 5432);
      fields.database.value = data.database || 'postgres';
      fields.visibleDatabases.value = Array.isArray(data.visibleDatabases)
        ? data.visibleDatabases.join('\\n')
        : '';
      fields.user.value = data.user || 'postgres';
      fields.password.value = data.password || '';
      fields.ssl.checked = !!data.ssl;
    }

    function parseVisibleDatabases(rawValue) {
      const parts = String(rawValue || '')
        .split(/[\\n,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (parts.length === 0) {
        return undefined;
      }

      const unique = [];
      const seen = new Set();
      for (const item of parts) {
        const key = item.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        unique.push(item);
      }

      return unique.length > 0 ? unique : undefined;
    }

    function payload() {
      return {
        nickname: fields.nickname.value.trim(),
        host: fields.host.value.trim(),
        port: Number(fields.port.value),
        database: fields.database.value.trim(),
        visibleDatabases: parseVisibleDatabases(fields.visibleDatabases.value),
        user: fields.user.value.trim(),
        password: fields.password.value,
        ssl: fields.ssl.checked,
      };
    }

    function setStatus(message, kind) {
      status.textContent = message || '';
      status.className = 'status' + (kind ? ' ' + kind : '');
    }

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.getElementById('test').addEventListener('click', () => {
      setStatus('Testando conexão...', '');
      vscode.postMessage({ type: 'test', payload: payload() });
    });

    document.getElementById('save').addEventListener('click', () => {
      setStatus('', '');
      vscode.postMessage({ type: 'save', payload: payload() });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'hydrate') {
        hydrate(message.payload);
      }
      if (message.type === 'testResult') {
        setStatus(message.message, message.ok ? 'ok' : 'error');
      }
      if (message.type === 'saveResult') {
        setStatus(message.message, message.ok ? 'ok' : 'error');
      }
    });

    hydrate(initialData);
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
