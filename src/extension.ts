import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { showConnectionForm } from './connectionFormPanel';
import { DatabaseTreeProvider } from './databaseTreeProvider';
import { DbObjectNodeRef, PostgresConnection } from './models';
import { PostgresService } from './postgresService';
import { TableDataPanelManager } from './tableDataPanel';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = ConnectionStore.getWorkspaceRoot();
  const storageRoot = workspaceRoot || context.globalStorageUri.fsPath;
  const store = new ConnectionStore(storageRoot);
  const postgresService = new PostgresService();
  const treeProvider = new DatabaseTreeProvider(store, postgresService, context.extensionPath);
  const tablePanels = new TableDataPanelManager(context, postgresService);

  if (!workspaceRoot) {
    // void vscode.window.showWarningMessage(
    //   'Nenhuma pasta aberta no Extension Host. As conexoes serao salvas no armazenamento global da extensão.'
    // );
  }

  // Restaura abas abertas anteriormente
  void tablePanels.restoreOpenTabs(store);

  const treeView = vscode.window.createTreeView('databaseExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.refresh', () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.createConnection', async () => {
      try {
        const payload = await showConnectionForm(context, postgresService, 'create');
        if (!payload) {
          return;
        }

        await store.createConnection(payload);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexão criada com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.editConnection', async (node?: { connection?: PostgresConnection }) => {
      try {
        const target = await resolveConnectionFromNodeOrPicker(store, node?.connection);
        if (!target) {
          return;
        }

        const payload = await showConnectionForm(context, postgresService, 'edit', target);
        if (!payload) {
          return;
        }

        const updated = await store.updateConnection(target.id, payload);
        if (node?.connection) {
          Object.assign(node.connection, updated);
        }
        treeProvider.clearConnectionCache(target.id);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexão atualizada com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.deleteConnection', async (node?: { connection?: PostgresConnection }) => {
      try {
        const target = await resolveConnectionFromNodeOrPicker(store, node?.connection);
        if (!target) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Deseja remover a conexão "${target.nickname}"?`,
          { modal: true },
          'Remover'
        );

        if (confirmation !== 'Remover') {
          return;
        }

        await store.deleteConnection(target.id);
        treeProvider.clearConnectionCache(target.id);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexão removida com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openSettings', async () => {
      try {
        const storagePath = await store.getStorageFilePath();
        const isWorkspaceStorage = Boolean(workspaceRoot);
        const selection = await vscode.window.showQuickPick(
          [
            {
              label: 'Database',
              description: 'DBAdmin',
              detail: 'Gerenciador de Banco de dados para VS Code.',
            },
            {
              label: isWorkspaceStorage ? 'Salvamento no workspace' : 'Salvamento global da extensão',
              description: storagePath,
              detail: isWorkspaceStorage
                ? 'As conexões ficam no projeto atual.'
                : 'As conexões ficam no armazenamento global do VS Code.',
            },
            {
              label: 'Abrir arquivo de conexões',
              description: storagePath,
              detail: 'Abre o JSON usado para persistir as conexões.',
            },
          ],
          {
            title: 'Configurações da extensão',
            placeHolder: 'Selecione uma ação',
            ignoreFocusOut: true,
          }
        );

        if (selection?.label !== 'Abrir arquivo de conexões') {
          return;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(storagePath));
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openTable', async (node?: DbObjectNodeRef) => {
      if (!node || node.type !== 'dbObject' || node.kind !== 'table') {
        return;
      }

      await tablePanels.openTable({
        node,
        newTab: false,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbadmin.openTableInNewTab', async (node?: DbObjectNodeRef) => {
      if (!node || node.type !== 'dbObject' || node.kind !== 'table') {
        return;
      }

      await tablePanels.openTable({
        node,
        newTab: true,
      });
    })
  );
}

export function deactivate(): void {}

async function resolveConnectionFromNodeOrPicker(
  store: ConnectionStore,
  selectedFromTree?: PostgresConnection
): Promise<PostgresConnection | undefined> {
  if (selectedFromTree) {
    return selectedFromTree;
  }

  const all = await store.listConnections();
  if (all.length === 0) {
    vscode.window.showInformationMessage('Não existem conexões cadastradas.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    all.map((connection) => ({
      label: connection.nickname,
      description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
      connection,
    })),
    {
      placeHolder: 'Selecione a conexão',
    }
  );

  return selected?.connection;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Erro inesperado';
  vscode.window.showErrorMessage(message);
}
