import * as vscode from 'vscode';
import { formatErrorForUi, getBcp47Locale, t } from './i18n';
import { loadLocaleDict, webviewI18nBootstrap } from './i18n/webviewLocale';
import { TableSectionItemNodeRef } from './models';
import { DatabaseService } from './engines/databaseService';
import { EphemeralConnectionLifecycle } from './ephemeralConnectionLifecycle';

type MetadataWebviewMessage =
  | { type: 'saveColumn'; isNullable: boolean; defaultValue: string }
  | { type: 'ready' };

interface ShowMetadataOptions {
  newTab?: boolean;
}

export class TableMetadataPanelManager {
  private globalColumnPanel: vscode.WebviewPanel | undefined;
  private globalConstraintPanel: vscode.WebviewPanel | undefined;
  private globalColumnNode: TableSectionItemNodeRef | undefined;
  private globalColumnMessageDisposable: vscode.Disposable | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postgresService: DatabaseService,
    private readonly ephemeralLifecycle?: EphemeralConnectionLifecycle,
  ) {}

  public async showColumn(node: TableSectionItemNodeRef, options?: ShowMetadataOptions): Promise<void> {
    const details = await this.postgresService.getColumnDetails(
      node.connection,
      node.databaseName,
      node.schemaName,
      node.tableName,
      node.itemName
    );

    if (!details) {
      vscode.window.showWarningMessage(t('Could not load column details.'));
      return;
    }

    if (options?.newTab) {
      const panel = vscode.window.createWebviewPanel(
        'dbadmin.columnDetails',
        t('Column: {0}', node.itemName),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: false }
      );

      panel.iconPath = new vscode.ThemeIcon('symbol-field');
      panel.webview.html = this.buildColumnHtml(panel.webview, node, details);
      this.ephemeralLifecycle?.bindPanel(panel, node.connection.id);

      const disposable = panel.webview.onDidReceiveMessage(async (message: MetadataWebviewMessage) => {
        if (message.type === 'saveColumn') {
          try {
            await this.postgresService.updateColumnProperties(
              node.connection,
              node.databaseName,
              node.schemaName,
              node.tableName,
              node.itemName,
              {
                isNullable: Boolean(message.isNullable),
                defaultValue: String(message.defaultValue ?? ''),
              }
            );

            vscode.window.showInformationMessage(t('Column "{0}" updated successfully.', node.itemName));
            panel.dispose();
          } catch (error) {
            const msg = formatErrorForUi(error);
            vscode.window.showErrorMessage(msg);
          }
        }
      });

      panel.onDidDispose(() => {
        disposable.dispose();
        this.ephemeralLifecycle?.unbindPanel(panel);
      });
      return;
    }

    if (!this.globalColumnPanel) {
      this.globalColumnPanel = vscode.window.createWebviewPanel(
        'dbadmin.columnDetailsGlobal',
        t('Column: {0}', node.itemName),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: false }
      );
      this.globalColumnPanel.iconPath = new vscode.ThemeIcon('symbol-field');

      this.globalColumnMessageDisposable = this.globalColumnPanel.webview.onDidReceiveMessage(
        async (message: MetadataWebviewMessage) => {
          if (message.type !== 'saveColumn' || !this.globalColumnNode) {
            return;
          }

          const currentNode = this.globalColumnNode;
          try {
            await this.postgresService.updateColumnProperties(
              currentNode.connection,
              currentNode.databaseName,
              currentNode.schemaName,
              currentNode.tableName,
              currentNode.itemName,
              {
                isNullable: Boolean(message.isNullable),
                defaultValue: String(message.defaultValue ?? ''),
              }
            );

            vscode.window.showInformationMessage(
              t('Column "{0}" updated successfully.', currentNode.itemName)
            );
            this.globalColumnPanel?.dispose();
          } catch (error) {
            const msg = formatErrorForUi(error);
            vscode.window.showErrorMessage(msg);
          }
        }
      );

      this.globalColumnPanel.onDidDispose(() => {
        this.globalColumnMessageDisposable?.dispose();
        this.globalColumnMessageDisposable = undefined;
        if (this.globalColumnPanel) {
          this.ephemeralLifecycle?.unbindPanel(this.globalColumnPanel);
        }
        this.globalColumnPanel = undefined;
        this.globalColumnNode = undefined;
      });
    }

    this.globalColumnNode = node;
    this.globalColumnPanel.title = t('Column: {0}', node.itemName);
    this.ephemeralLifecycle?.bindPanel(this.globalColumnPanel, node.connection.id);
    this.globalColumnPanel.webview.html = this.buildColumnHtml(this.globalColumnPanel.webview, node, details);
    this.globalColumnPanel.reveal(vscode.ViewColumn.Active, false);
  }

  public async showConstraint(node: TableSectionItemNodeRef, options?: ShowMetadataOptions): Promise<void> {
    const details = await this.postgresService.getConstraintDetails(
      node.connection,
      node.databaseName,
      node.schemaName,
      node.tableName,
      node.itemName
    );

    if (!details) {
      vscode.window.showWarningMessage(t('Could not load constraint details.'));
      return;
    }

    if (options?.newTab) {
      const panel = vscode.window.createWebviewPanel(
        'dbadmin.constraintDetails',
        t('Constraint: {0}', node.itemName),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: false, retainContextWhenHidden: false }
      );

      panel.iconPath = new vscode.ThemeIcon('shield');
      panel.webview.html = this.buildConstraintHtml(panel.webview, node, details);
      this.ephemeralLifecycle?.bindPanel(panel, node.connection.id);
      panel.onDidDispose(() => {
        this.ephemeralLifecycle?.unbindPanel(panel);
      });
      return;
    }

    if (!this.globalConstraintPanel) {
      this.globalConstraintPanel = vscode.window.createWebviewPanel(
        'dbadmin.constraintDetailsGlobal',
        t('Constraint: {0}', node.itemName),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: false, retainContextWhenHidden: false }
      );

      this.globalConstraintPanel.iconPath = new vscode.ThemeIcon('shield');
      this.globalConstraintPanel.onDidDispose(() => {
        if (this.globalConstraintPanel) {
          this.ephemeralLifecycle?.unbindPanel(this.globalConstraintPanel);
        }
        this.globalConstraintPanel = undefined;
      });
    }

    this.globalConstraintPanel.title = t('Constraint: {0}', node.itemName);
    this.ephemeralLifecycle?.bindPanel(this.globalConstraintPanel, node.connection.id);
    this.globalConstraintPanel.webview.html = this.buildConstraintHtml(
      this.globalConstraintPanel.webview,
      node,
      details
    );
    this.globalConstraintPanel.reveal(vscode.ViewColumn.Active, false);
  }

  private buildColumnHtml(
    webview: vscode.Webview,
    node: TableSectionItemNodeRef,
    details: { name: string; dataType: string; isNullable: boolean; defaultValue: string | null }
  ): string {
    const nonce = String(Date.now());
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const extensionPath = this.context.extensionPath;
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
    :root { --dbadmin-input-focus: #007acc; accent-color: var(--dbadmin-input-focus); }
    input, textarea, select { accent-color: var(--dbadmin-input-focus); }
    input:focus, textarea:focus, select:focus,
    input:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: none;
      border-color: var(--dbadmin-input-focus);
    }
    input[type=text] { width: 100%; height: 28px; padding: 4px 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); overflow: hidden; background-clip: padding-box; }
    .field { margin-bottom: 12px; }
    label { display: block; margin-bottom: 4px; font-weight: 600; }
    button { height: 30px; padding: 0 12px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .meta { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  </style>
</head>
<body>
  <h2>${L('webview.metadata.column', 'Coluna')}: ${escapeHtml(details.name)}</h2>
  <div class="meta">${L('webview.metadata.table', 'Tabela')}: ${escapeHtml(node.schemaName)}.${escapeHtml(node.tableName)}</div>

  <div class="field">
    <label>${L('webview.metadata.type', 'Tipo')}</label>
    <input type="text" value="${escapeHtml(details.dataType)}" readonly />
  </div>

  <div class="field">
    <label><input id="nullable" type="checkbox" ${details.isNullable ? 'checked' : ''} /> ${L('webview.metadata.allowNull', 'Permitir nulo')}</label>
  </div>

  <div class="field">
    <label for="defaultValue">${L('webview.metadata.default', 'Default (expressão SQL)')}</label>
    <input id="defaultValue" type="text" value="${escapeHtml(details.defaultValue ?? '')}" />
  </div>

  <button id="saveBtn">${L('webview.common.save', 'Salvar')}</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('saveBtn').addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveColumn',
        isNullable: Boolean(document.getElementById('nullable').checked),
        defaultValue: String(document.getElementById('defaultValue').value || ''),
      });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private buildConstraintHtml(
    webview: vscode.Webview,
    node: TableSectionItemNodeRef,
    details: { name: string; type: string; definition: string }
  ): string {
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';`;
    const extensionPath = this.context.extensionPath;
    const i18n = loadLocaleDict(extensionPath);
    const i18nLang = getBcp47Locale();
    const L = (key: string, fallback: string) =>
      escapeHtml(i18n[key] || fallback);

    return `<!DOCTYPE html>
<html lang="${i18nLang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
    .card { border: 1px solid var(--vscode-panel-border); padding: 12px; border-radius: 6px; background: var(--vscode-editorWidget-background); }
    .label { font-weight: 700; margin-top: 10px; }
    pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h2>${L('webview.metadata.constraint', 'Restrição')}: ${escapeHtml(details.name)}</h2>
  <div class="card">
    <div class="label">${L('webview.metadata.table', 'Tabela')}</div>
    <div>${escapeHtml(node.schemaName)}.${escapeHtml(node.tableName)}</div>
    <div class="label">${L('webview.metadata.type', 'Tipo')}</div>
    <div>${escapeHtml(details.type)}</div>
    <div class="label">${L('webview.metadata.definition', 'Definição')}</div>
    <pre>${escapeHtml(details.definition)}</pre>
  </div>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
