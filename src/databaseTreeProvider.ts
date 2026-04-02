import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import {
  DbObjectKind,
  DbObjectNodeRef,
  ConnectionNodeRef,
  DatabaseNodeRef,
  ObjectGroupNodeRef,
  PlaceholderNodeRef,
  PostgresConnection,
  SchemaNodeRef,
  TreeNodeRef,
} from './models';
import { PostgresService } from './postgresService';

export class DatabaseTreeProvider implements vscode.TreeDataProvider<TreeNodeRef> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNodeRef | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly versions = new Map<string, string>();

  public constructor(
    private readonly store: ConnectionStore,
    private readonly postgresService: PostgresService,
    private readonly extensionPath: string
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public clearConnectionCache(connectionId: string): void {
    this.versions.delete(connectionId);
  }

  public async getChildren(element?: TreeNodeRef): Promise<TreeNodeRef[]> {
    if (!element) {
      const connections = await this.store.listConnections();
      if (connections.length === 0) {
        return [
          {
            type: 'placeholder',
            message: 'Sem conexões.',
          } satisfies PlaceholderNodeRef,
        ];
      }

      return connections.map((connection) => ({
        type: 'connection',
        connection,
      })) satisfies ConnectionNodeRef[];
    }

    try {
      if (element.type === 'connection') {
        const databases = await this.postgresService.listDatabases(element.connection);
        if (databases.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem databases.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return databases.map((databaseName) => ({
          type: 'database',
          connection: element.connection,
          databaseName,
        })) satisfies DatabaseNodeRef[];
      }

      if (element.type === 'database') {
        const schemas = await this.postgresService.listSchemas(element.connection, element.databaseName);
        if (schemas.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem schemas.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return schemas.map((schemaName) => ({
          type: 'schema',
          connection: element.connection,
          databaseName: element.databaseName,
          schemaName,
        })) satisfies SchemaNodeRef[];
      }

      if (element.type === 'schema') {
        const counts = await this.postgresService.getSchemaObjectCounts(
          element.connection,
          element.databaseName,
          element.schemaName
        );

        return [
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'table',
            count: counts.tables,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'view',
            count: counts.views,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'function',
            count: counts.functions,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'procedure',
            count: counts.procedures,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'trigger',
            count: counts.triggers,
          },
        ] satisfies ObjectGroupNodeRef[];
      }

      if (element.type === 'objectGroup') {
        const objectNames = await this.listGroupObjects(element);
        const tableCounts =
          element.kind === 'table'
            ? await this.postgresService.listTableEstimatedCounts(
                element.connection,
                element.databaseName,
                element.schemaName
              )
            : [];
        const tableCountByName = new Map(tableCounts.map((item) => [item.tableName, item.count]));

        if (objectNames.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem itens.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return objectNames.map((objectName) => ({
          type: 'dbObject',
          connection: element.connection,
          databaseName: element.databaseName,
          schemaName: element.schemaName,
          kind: element.kind,
          objectName,
          count: element.kind === 'table' ? (tableCountByName.get(objectName) ?? 0) : undefined,
        })) satisfies DbObjectNodeRef[];
      }

      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      return [
        {
          type: 'placeholder',
          message,
        } satisfies PlaceholderNodeRef,
      ];
    }
  }

  public getTreeItem(element: TreeNodeRef): vscode.TreeItem {
    if (element.type === 'placeholder') {
      const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'placeholder';
      return item;
    }

    if (element.type === 'connection') {
      const item = new vscode.TreeItem(element.connection.nickname, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'connection';
      item.tooltip = `${element.connection.user}@${element.connection.host}:${element.connection.port}/${element.connection.database}`;
      item.description = `${element.connection.host}:${element.connection.port}`;

      item.iconPath = {
        light: vscode.Uri.file(
          path.join(this.extensionPath, 'resources', 'icons', 'light', 'postgres.svg')
        ),
        dark: vscode.Uri.file(
          path.join(this.extensionPath, 'resources', 'icons', 'dark', 'postgres.svg')
        ),
      };

      const cachedVersion = this.versions.get(element.connection.id);
      if (!cachedVersion) {
        void this.loadVersion(element.connection);
      } else {
        item.tooltip = `${item.tooltip}\n${cachedVersion}`;
      }

      return item;
    }

    if (element.type === 'database') {
      const item = new vscode.TreeItem(element.databaseName, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'database';
      item.iconPath = new vscode.ThemeIcon('database');
      return item;
    }

    if (element.type === 'schema') {
      const item = new vscode.TreeItem(element.schemaName, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'schema';
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      return item;
    }

    if (element.type === 'objectGroup') {
      const item = new vscode.TreeItem(
        this.groupLabel(element.kind),
        element.count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = `objectGroup:${element.kind}`;
      item.description = `(${element.count})`;
      item.iconPath = this.objectIcon(element.kind);
      return item;
    }

    const objectItem = new vscode.TreeItem(element.objectName, vscode.TreeItemCollapsibleState.None);
    objectItem.contextValue = `dbObject:${element.kind}`;
    objectItem.iconPath = this.objectIcon(element.kind);
    if (element.kind === 'table' && typeof element.count === 'number') {
      objectItem.description = `${element.count}`;
    }
    if (element.kind === 'table') {
      objectItem.command = {
        command: 'dbadmin.openTable',
        title: 'Open Table',
        arguments: [element],
      };
    }
    return objectItem;
  }

  private async listGroupObjects(group: ObjectGroupNodeRef): Promise<string[]> {
    if (group.kind === 'table') {
      return this.postgresService.listTables(group.connection, group.databaseName, group.schemaName);
    }

    if (group.kind === 'view') {
      return this.postgresService.listViews(group.connection, group.databaseName, group.schemaName);
    }

    if (group.kind === 'function') {
      return this.postgresService.listFunctions(group.connection, group.databaseName, group.schemaName);
    }

    if (group.kind === 'procedure') {
      return this.postgresService.listProcedures(group.connection, group.databaseName, group.schemaName);
    }

    return this.postgresService.listTriggers(group.connection, group.databaseName, group.schemaName);
  }

  private groupLabel(kind: DbObjectKind): string {
    if (kind === 'table') {
      return 'Tabelas';
    }
    if (kind === 'view') {
      return 'Views';
    }
    if (kind === 'function') {
      return 'Functions';
    }
    if (kind === 'procedure') {
      return 'Procedures';
    }

    return 'Triggers';
  }

  private objectIcon(kind: DbObjectKind): vscode.ThemeIcon {
    if (kind === 'table') {
      return new vscode.ThemeIcon('table');
    }
    if (kind === 'view') {
      return new vscode.ThemeIcon('eye');
    }
    if (kind === 'function') {
      return new vscode.ThemeIcon('symbol-function');
    }
    if (kind === 'procedure') {
      return new vscode.ThemeIcon('tools');
    }

    return new vscode.ThemeIcon('symbol-event');
  }

  private async loadVersion(connection: PostgresConnection): Promise<void> {
    try {
      const version = await this.postgresService.getVersion(connection);
      this.versions.set(connection.id, version);
      this.refresh();
    } catch {
      this.versions.set(connection.id, 'Não conectado');
      this.refresh();
    }
  }
}
