import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import {
  DatabaseGroupKind,
  DatabaseGroupNodeRef,
  DbObjectKind,
  DbObjectNodeRef,
  FilterControlNodeRef,
  ConnectionNodeRef,
  DatabaseNodeRef,
  ExtensionNodeRef,
  ObjectGroupNodeRef,
  PlaceholderNodeRef,
  PostgresConnection,
  SchemaNodeRef,
  TableSectionKind,
  TableSectionItemNodeRef,
  TableSectionNodeRef,
  TreeNodeRef,
} from './models';
import { PostgresService } from './postgresService';

export class DatabaseTreeProvider implements vscode.TreeDataProvider<TreeNodeRef> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNodeRef | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly versions = new Map<string, string>();
  private tableNameFilter = '';
  private showFilterLabel = true;
  private filterHasResults = true;

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

  public setTableNameFilter(filter: string): void {
    this.tableNameFilter = filter.trim().toLowerCase();
    if (!this.tableNameFilter) {
      this.filterHasResults = true;
    }
    this.refresh();
  }

  public setFilterHasResults(hasResults: boolean): void {
    this.filterHasResults = hasResults;
    this.refresh();
  }

  public getTableNameFilter(): string {
    return this.tableNameFilter;
  }

  public setShowFilterLabel(show: boolean): void {
    this.showFilterLabel = show;
    this.refresh();
  }

  public async getChildren(element?: TreeNodeRef): Promise<TreeNodeRef[]> {
    if (!element) {
      const connections = await this.store.listConnections();
      const rootNodes: TreeNodeRef[] = [];

      if (this.showFilterLabel && this.tableNameFilter.trim()) {
        rootNodes.push({
          type: 'filterControl',
          value: this.tableNameFilter,
        } satisfies FilterControlNodeRef);
      }

      if (connections.length === 0) {
        rootNodes.push(
          {
            type: 'placeholder',
            message: 'Sem conexões.',
          } satisfies PlaceholderNodeRef
        );

        return rootNodes;
      }

      return [
        ...rootNodes,
        ...(connections.map((connection) => ({
          type: 'connection',
          connection,
        })) satisfies ConnectionNodeRef[]),
      ];
    }

    try {
      if (element.type === 'connection') {
        try {
          await this.postgresService.getVersion(element.connection);
        } catch {
          return [
            {
              type: 'placeholder',
              message: 'Erro ao conectar',
            } satisfies PlaceholderNodeRef,
          ];
        }

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
        return [
          {
            type: 'databaseGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            kind: 'schemas',
          },
          {
            type: 'databaseGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            kind: 'extensions',
          },
        ] satisfies DatabaseGroupNodeRef[];
      }

      if (element.type === 'databaseGroup') {
        if (element.kind === 'schemas') {
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

        const extensions = await this.postgresService.listExtensions(element.connection, element.databaseName);
        if (extensions.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem extensions.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return extensions.map((extensionName) => ({
          type: 'extension',
          connection: element.connection,
          databaseName: element.databaseName,
          extensionName,
        })) satisfies ExtensionNodeRef[];
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
        const filteredObjectNames =
          element.kind === 'table' && this.tableNameFilter
            ? objectNames.filter((name) => name.toLowerCase().includes(this.tableNameFilter))
            : objectNames;
        const tableCounts =
          element.kind === 'table'
            ? await this.postgresService.listTableEstimatedCounts(
                element.connection,
                element.databaseName,
                element.schemaName
              )
            : [];
        const tableCountByName = new Map(tableCounts.map((item) => [item.tableName, item.count]));

        if (filteredObjectNames.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem resultados.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return filteredObjectNames.map((objectName) => ({
          type: 'dbObject',
          connection: element.connection,
          databaseName: element.databaseName,
          schemaName: element.schemaName,
          kind: element.kind,
          objectName,
          count: element.kind === 'table' ? (tableCountByName.get(objectName) ?? 0) : undefined,
        })) satisfies DbObjectNodeRef[];
      }

      if (element.type === 'dbObject' && element.kind === 'table') {
        return this.tableSections(element);
      }

      if (element.type === 'tableSection' && element.section === 'columns') {
        const columns = await this.postgresService.listTableColumnsDetailed(
          element.connection,
          element.databaseName,
          element.schemaName,
          element.tableName
        );

        if (columns.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem colunas.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return columns.map((column) => ({
          type: 'tableSectionItem',
          connection: element.connection,
          databaseName: element.databaseName,
          schemaName: element.schemaName,
          tableName: element.tableName,
          section: element.section,
          itemKind: 'column',
          itemName: column.name,
        })) satisfies TableSectionItemNodeRef[];
      }

      if (element.type === 'tableSection' && element.section === 'constraints') {
        const constraints = await this.postgresService.listTableConstraints(
          element.connection,
          element.databaseName,
          element.schemaName,
          element.tableName
        );

        if (constraints.length === 0) {
          return [
            {
              type: 'placeholder',
              message: 'Sem restrições.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return constraints.map((constraint) => ({
          type: 'tableSectionItem',
          connection: element.connection,
          databaseName: element.databaseName,
          schemaName: element.schemaName,
          tableName: element.tableName,
          section: element.section,
          itemKind: 'constraint',
          itemName: constraint.name,
        })) satisfies TableSectionItemNodeRef[];
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

    if (element.type === 'filterControl') {
      const activeFilter = element.value.trim();
      const item = new vscode.TreeItem(
        activeFilter ? `${activeFilter}` : 'Filtrar tabelas...',
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = 'filterControl';
      item.description = activeFilter && !this.filterHasResults ? 'sem resultados' : undefined;
      item.tooltip = activeFilter
        ? `Filtro global de tabelas ativo: ${activeFilter}\n(Duplo clique ou F2 para editar)`
        : 'Filtro global de tabelas\n(Duplo clique ou F2 para editar)';
      item.iconPath = new vscode.ThemeIcon('search');
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

    if (element.type === 'databaseGroup') {
      const label = element.kind === 'schemas' ? 'Schemas' : 'Extensions';
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = `databaseGroup:${element.kind}`;
      item.iconPath =
        element.kind === 'schemas'
          ? new vscode.ThemeIcon('symbol-namespace')
          : new vscode.ThemeIcon('extensions');
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

    if (element.type === 'extension') {
      const item = new vscode.TreeItem(element.extensionName, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'extension';
      item.iconPath = new vscode.ThemeIcon('extensions');
      return item;
    }

    if (element.type === 'tableSection') {
      const canExpand = element.section === 'columns' || element.section === 'constraints';
      const item = new vscode.TreeItem(
        this.tableSectionLabel(element.section),
        canExpand && element.count > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = `tableSection:${element.section}`;
      item.iconPath = this.tableSectionIcon(element.section);
      item.description = `${element.count}`;
      return item;
    }

    if (element.type === 'tableSectionItem') {
      const item = new vscode.TreeItem(element.itemName, vscode.TreeItemCollapsibleState.None);
      item.contextValue = `tableSectionItem:${element.itemKind}`;
      item.iconPath = element.itemKind === 'column'
        ? new vscode.ThemeIcon('symbol-field')
        : new vscode.ThemeIcon('shield');
      item.command = {
        command:
          element.itemKind === 'column'
            ? 'dbadmin.openColumnDetails'
            : 'dbadmin.openConstraintDetails',
        title: 'Abrir detalhes',
        arguments: [element],
      };
      return item;
    }

    const objectItem = new vscode.TreeItem(
      element.objectName,
      element.kind === 'table' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
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

  public getParent(element: TreeNodeRef): TreeNodeRef | undefined {
    if (element.type === 'filterControl') {
      return undefined;
    }

    if (element.type === 'connection') {
      return undefined;
    }

    if (element.type === 'database') {
      return {
        type: 'connection',
        connection: element.connection,
      } satisfies ConnectionNodeRef;
    }

    if (element.type === 'databaseGroup') {
      return {
        type: 'database',
        connection: element.connection,
        databaseName: element.databaseName,
      } satisfies DatabaseNodeRef;
    }

    if (element.type === 'schema') {
      return {
        type: 'databaseGroup',
        connection: element.connection,
        databaseName: element.databaseName,
        kind: 'schemas',
      } satisfies DatabaseGroupNodeRef;
    }

    if (element.type === 'objectGroup') {
      return {
        type: 'schema',
        connection: element.connection,
        databaseName: element.databaseName,
        schemaName: element.schemaName,
      } satisfies SchemaNodeRef;
    }

    if (element.type === 'dbObject') {
      return {
        type: 'objectGroup',
        connection: element.connection,
        databaseName: element.databaseName,
        schemaName: element.schemaName,
        kind: element.kind,
        count: element.count ?? 0,
      } satisfies ObjectGroupNodeRef;
    }

    if (element.type === 'extension') {
      return {
        type: 'databaseGroup',
        connection: element.connection,
        databaseName: element.databaseName,
        kind: 'extensions',
      } satisfies DatabaseGroupNodeRef;
    }

    if (element.type === 'tableSection') {
      return {
        type: 'dbObject',
        connection: element.connection,
        databaseName: element.databaseName,
        schemaName: element.schemaName,
        kind: 'table',
        objectName: element.tableName,
      } satisfies DbObjectNodeRef;
    }

    if (element.type === 'tableSectionItem') {
      return {
        type: 'tableSection',
        connection: element.connection,
        databaseName: element.databaseName,
        schemaName: element.schemaName,
        tableName: element.tableName,
        section: element.section,
        count: 0,
      } satisfies TableSectionNodeRef;
    }

    return undefined;
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

  private tableSectionLabel(section: TableSectionKind): string {
    if (section === 'columns') {
      return 'Colunas';
    }
    if (section === 'constraints') {
      return 'Restrições';
    }
    if (section === 'indexes') {
      return 'Índices';
    }
    if (section === 'rls') {
      return 'RLS';
    }
    if (section === 'rules') {
      return 'Regras';
    }
    return 'Triggers';
  }

  private tableSectionIcon(section: TableSectionKind): vscode.ThemeIcon {
    if (section === 'columns') {
      return new vscode.ThemeIcon('symbol-field');
    }
    if (section === 'constraints') {
      return new vscode.ThemeIcon('shield');
    }
    if (section === 'indexes') {
      return new vscode.ThemeIcon('list-tree');
    }
    if (section === 'rls') {
      return new vscode.ThemeIcon('lock');
    }
    if (section === 'rules') {
      return new vscode.ThemeIcon('symbol-operator');
    }
    return new vscode.ThemeIcon('symbol-event');
  }

  private async tableSections(table: DbObjectNodeRef): Promise<TableSectionNodeRef[]> {
    const counts = await this.postgresService.getTableSectionCounts(
      table.connection,
      table.databaseName,
      table.schemaName,
      table.objectName
    );

    const sections: Array<{ section: TableSectionKind; count: number }> = [
      { section: 'columns', count: counts.columns },
      { section: 'constraints', count: counts.constraints },
      { section: 'indexes', count: counts.indexes },
      { section: 'rls', count: counts.rls },
      { section: 'rules', count: counts.rules },
      { section: 'triggers', count: counts.triggers },
    ];

    return sections.map(({ section, count }) => ({
      type: 'tableSection',
      connection: table.connection,
      databaseName: table.databaseName,
      schemaName: table.schemaName,
      tableName: table.objectName,
      section,
      count,
    }));
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
