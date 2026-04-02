import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { DatabaseTreeProvider } from './databaseTreeProvider';
import { PostgresConnection } from './models';
import { PostgresService } from './postgresService';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = ConnectionStore.getWorkspaceRoot();
  const storageRoot = workspaceRoot || context.globalStorageUri.fsPath;
  const store = new ConnectionStore(storageRoot);
  const postgresService = new PostgresService();
  const treeProvider = new DatabaseTreeProvider(store, postgresService, context.extensionPath);

  if (!workspaceRoot) {
    void vscode.window.showWarningMessage(
      'Nenhuma pasta aberta no Extension Host. As conexoes serao salvas no armazenamento global da extensao.'
    );
  }

  const treeView = vscode.window.createTreeView('databaseExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('database.refresh', () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('database.createConnection', async () => {
      try {
        const payload = await promptConnectionData();
        if (!payload) {
          return;
        }

        await store.createConnection(payload);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexao criada com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('database.editConnection', async (node?: { connection?: PostgresConnection }) => {
      try {
        const target = await resolveConnectionFromNodeOrPicker(store, node?.connection);
        if (!target) {
          return;
        }

        const payload = await promptConnectionData(target);
        if (!payload) {
          return;
        }

        await store.updateConnection(target.id, payload);
        treeProvider.clearConnectionCache(target.id);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexao atualizada com sucesso.');
      } catch (error) {
        showError(error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('database.deleteConnection', async (node?: { connection?: PostgresConnection }) => {
      try {
        const target = await resolveConnectionFromNodeOrPicker(store, node?.connection);
        if (!target) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Deseja remover a conexao "${target.nickname}"?`,
          { modal: true },
          'Remover'
        );

        if (confirmation !== 'Remover') {
          return;
        }

        await store.deleteConnection(target.id);
        treeProvider.clearConnectionCache(target.id);
        treeProvider.refresh();
        vscode.window.showInformationMessage('Conexao removida com sucesso.');
      } catch (error) {
        showError(error);
      }
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
    vscode.window.showInformationMessage('Nao existem conexoes cadastradas.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    all.map((connection) => ({
      label: connection.nickname,
      description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
      connection,
    })),
    {
      placeHolder: 'Selecione a conexao',
    }
  );

  return selected?.connection;
}

async function promptConnectionData(
  current?: PostgresConnection
): Promise<Omit<PostgresConnection, 'id' | 'engine' | 'createdAt' | 'updatedAt'> | undefined> {
  const nickname = await askValue('Apelido da conexao', current?.nickname);
  if (!nickname) {
    return undefined;
  }

  const host = await askValue('Host', current?.host ?? 'localhost');
  if (!host) {
    return undefined;
  }

  const portRaw = await askValue('Porta', String(current?.port ?? 5432));
  if (!portRaw) {
    return undefined;
  }

  const port = Number(portRaw);
  if (!Number.isInteger(port)) {
    throw new Error('Porta invalida.');
  }

  const database = await askValue('Database', current?.database ?? 'postgres');
  if (!database) {
    return undefined;
  }

  const user = await askValue('Usuario', current?.user ?? 'postgres');
  if (!user) {
    return undefined;
  }

  const password = await askPassword(current);
  if (password === undefined) {
    return undefined;
  }

  const ssl = await askSsl(current?.ssl ?? false);
  if (ssl === undefined) {
    return undefined;
  }

  return {
    nickname,
    host,
    port,
    database,
    user,
    password,
    ssl,
  };
}

async function askValue(placeHolder: string, value?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    placeHolder,
    value,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : 'Campo obrigatorio'),
  });
}

async function askPassword(current?: PostgresConnection): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    placeHolder: current ? 'Senha (deixe vazio para manter atual)' : 'Senha',
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (current) {
        return undefined;
      }
      return input.trim() ? undefined : 'Campo obrigatorio';
    },
  });

  if (password === undefined) {
    return undefined;
  }

  if (!password && current) {
    return current.password;
  }

  return password;
}

async function askSsl(current: boolean): Promise<boolean | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: 'Nao',
        value: false,
      },
      {
        label: 'Sim',
        value: true,
      },
    ],
    {
      placeHolder: `SSL (atual: ${current ? 'Sim' : 'Nao'})`,
      ignoreFocusOut: true,
    }
  );

  return selected?.value;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Erro inesperado';
  vscode.window.showErrorMessage(message);
}
