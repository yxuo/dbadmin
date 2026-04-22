import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import {
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

type SnapshotLoadStatus = 'created' | 'loading' | 'ready' | 'error';

interface SchemaSnapshot {
  status: SnapshotLoadStatus;
  tableNames: string[];
  viewNames: string[];
  functionNames: string[];
  procedureNames: string[];
  triggerNames: string[];
  tableCountByName: Map<string, number>;
  errorMessage?: string;
}

interface DatabaseSnapshot {
  status: SnapshotLoadStatus;
  schemaByName: Map<string, SchemaSnapshot>;
  extensionNames: string[];
  errorMessage?: string;
}

interface ConnectionSnapshot {
  connection: PostgresConnection;
  status: SnapshotLoadStatus;
  databaseByName: Map<string, DatabaseSnapshot>;
  errorMessage?: string;
}

export class DatabaseTreeProvider implements vscode.TreeDataProvider<TreeNodeRef> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNodeRef | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly connectionProbeTimeoutMs = 10000;
  private readonly databaseLoadTimeoutMs = 15000;

  private readonly versions = new Map<string, string>();
  private readonly connectionSnapshots = new Map<string, ConnectionSnapshot>();
  private readonly connectionLoadGeneration = new Map<string, number>();
  private metadataLoadSeq = 0;
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

  public initializeMetadataCache(): void {
    void this.reloadAllMetadata();
  }

  public async reloadAllMetadata(): Promise<void> {
    const currentSeq = ++this.metadataLoadSeq;
    const connections = await this.store.listConnections();
    const validConnectionIds = new Set(connections.map((connection) => connection.id));

    for (const cachedConnectionId of this.connectionSnapshots.keys()) {
      if (!validConnectionIds.has(cachedConnectionId)) {
        this.connectionSnapshots.delete(cachedConnectionId);
        this.connectionLoadGeneration.delete(cachedConnectionId);
        this.versions.delete(cachedConnectionId);
      }
    }

    for (const connection of connections) {
      const previousSnapshot = this.connectionSnapshots.get(connection.id);
      const preservedDatabaseByName = previousSnapshot
        ? this.cloneDatabaseMap(previousSnapshot.databaseByName)
        : new Map<string, DatabaseSnapshot>();

      this.connectionSnapshots.set(connection.id, {
        connection,
        status: previousSnapshot ? 'loading' : 'created',
        databaseByName: preservedDatabaseByName,
      });

      this.startConnectionLoad(connection, currentSeq);
    }

    this.refresh();
  }

  public reloadConnection(connection: PostgresConnection): void {
    this.startConnectionLoad(connection, this.metadataLoadSeq);
  }

  public reloadDatabase(connection: PostgresConnection, databaseName: string): void {
    const snapshot = this.connectionSnapshots.get(connection.id);
    if (!snapshot) {
      return;
    }

    const generation = this.connectionLoadGeneration.get(connection.id) ?? 0;
    const db = snapshot.databaseByName.get(databaseName);
    if (db) {
      db.status = 'loading';
      db.errorMessage = undefined;
    }

    this.refresh();
    void this.loadDatabaseIncremental(connection, databaseName, this.metadataLoadSeq, generation);
  }

  public reloadSchema(connection: PostgresConnection, databaseName: string, schemaName: string): void {
    const snapshot = this.connectionSnapshots.get(connection.id);
    if (!snapshot) {
      return;
    }

    const generation = this.connectionLoadGeneration.get(connection.id) ?? 0;
    const schema = this.getSchemaSnapshot(connection.id, databaseName, schemaName);
    if (schema) {
      schema.status = 'loading';
      schema.errorMessage = undefined;
    }

    this.refresh();
    void this.loadSchemaIncremental(connection, databaseName, schemaName, this.metadataLoadSeq, generation);
  }

  public clearConnectionCache(connectionId: string): void {
    this.versions.delete(connectionId);
    this.connectionSnapshots.delete(connectionId);
    this.connectionLoadGeneration.delete(connectionId);
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

  public getFilteredTableExpandPaths(): ObjectGroupNodeRef[] {
    if (!this.tableNameFilter) {
      return [];
    }

    const paths: ObjectGroupNodeRef[] = [];
    for (const [, snapshot] of this.connectionSnapshots.entries()) {
      if (snapshot.status === 'error') {
        continue;
      }

      const connection = snapshot.connection;

      for (const [databaseName, database] of snapshot.databaseByName.entries()) {
        for (const [schemaName, schema] of database.schemaByName.entries()) {
          const hasMatches = schema.tableNames.some((name) =>
            name.toLowerCase().includes(this.tableNameFilter)
          );
          if (!hasMatches) {
            continue;
          }

          paths.push({
            type: 'objectGroup',
            connection,
            databaseName,
            schemaName,
            kind: 'table',
            count: schema.tableNames.length,
          });
        }
      }
    }

    return paths;
  }

  public async getChildren(element?: TreeNodeRef): Promise<TreeNodeRef[]> {
    if (!element) {
      const connections = await this.store.listConnections();
      for (const connection of connections) {
        this.ensureConnectionSnapshotLoaded(connection);
      }

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
        this.ensureConnectionSnapshotLoaded(element.connection);
        const snapshot = this.connectionSnapshots.get(element.connection.id);
        if (!snapshot) {
          return [
            {
              type: 'placeholder',
              message: 'Preparando snapshot...',
            } satisfies PlaceholderNodeRef,
          ];
        }

        const databases = Array.from(snapshot.databaseByName.keys()).sort((a, b) =>
          a.localeCompare(b)
        );

        if (snapshot.status === 'error' && databases.length === 0) {
          return [
            {
              type: 'placeholder',
              message: snapshot.errorMessage ?? 'Erro ao conectar',
            } satisfies PlaceholderNodeRef,
          ];
        }

        if (databases.length === 0) {
          if (snapshot.status === 'created' || snapshot.status === 'loading') {
            return [
              {
                type: 'placeholder',
                message: 'Carregando bancos...',
              } satisfies PlaceholderNodeRef,
            ];
          }

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
        const snapshot = this.connectionSnapshots.get(element.connection.id);
        const database = snapshot?.databaseByName.get(element.databaseName);
        if (!snapshot || !database) {
          return [
            {
              type: 'placeholder',
              message: 'Carregando metadados...',
            } satisfies PlaceholderNodeRef,
          ];
        }

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
        const snapshot = this.connectionSnapshots.get(element.connection.id);
        const database = snapshot?.databaseByName.get(element.databaseName);
        if (!snapshot || !database) {
          return [
            {
              type: 'placeholder',
              message: 'Carregando metadados...',
            } satisfies PlaceholderNodeRef,
          ];
        }

        if (element.kind === 'schemas') {
          const schemas = Array.from(database.schemaByName.keys()).sort((a, b) => a.localeCompare(b));
          if (schemas.length === 0) {
            if (database.status === 'error') {
              return [
                {
                  type: 'placeholder',
                  message: database.errorMessage ?? 'Erro ao carregar schemas.',
                } satisfies PlaceholderNodeRef,
              ];
            }

            if (database.status === 'created' || database.status === 'loading') {
              return [
                {
                  type: 'placeholder',
                  message: 'Carregando schemas...',
                } satisfies PlaceholderNodeRef,
              ];
            }

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

        const extensions = [...database.extensionNames];
        if (extensions.length === 0) {
          if (database.status === 'error') {
            return [
              {
                type: 'placeholder',
                message: database.errorMessage ?? 'Erro ao carregar extensions.',
              } satisfies PlaceholderNodeRef,
            ];
          }

          if (database.status === 'created' || database.status === 'loading') {
            return [
              {
                type: 'placeholder',
                message: 'Carregando extensions...',
              } satisfies PlaceholderNodeRef,
            ];
          }

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
        const schema = this.getSchemaSnapshot(element.connection.id, element.databaseName, element.schemaName);
        if (!schema) {
          return [
            {
              type: 'placeholder',
              message: 'Carregando metadados...',
            } satisfies PlaceholderNodeRef,
          ];
        }

        const hasObjects =
          schema.tableNames.length > 0 ||
          schema.viewNames.length > 0 ||
          schema.functionNames.length > 0 ||
          schema.procedureNames.length > 0 ||
          schema.triggerNames.length > 0;

        if (!hasObjects && schema.status === 'error') {
          return [
            {
              type: 'placeholder',
              message: schema.errorMessage ?? 'Erro ao carregar objetos do schema.',
            } satisfies PlaceholderNodeRef,
          ];
        }

        if (
          !hasObjects &&
          (schema.status === 'created' || schema.status === 'loading')
        ) {
          return [
            {
              type: 'placeholder',
              message: 'Carregando objetos do schema...',
            } satisfies PlaceholderNodeRef,
          ];
        }

        return [
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'table',
            count: schema.tableNames.length,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'view',
            count: schema.viewNames.length,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'function',
            count: schema.functionNames.length,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'procedure',
            count: schema.procedureNames.length,
          },
          {
            type: 'objectGroup',
            connection: element.connection,
            databaseName: element.databaseName,
            schemaName: element.schemaName,
            kind: 'trigger',
            count: schema.triggerNames.length,
          },
        ] satisfies ObjectGroupNodeRef[];
      }

      if (element.type === 'objectGroup') {
        const schemaSnapshot = this.getSchemaSnapshot(
          element.connection.id,
          element.databaseName,
          element.schemaName
        );
        if (!schemaSnapshot) {
          return [
            {
              type: 'placeholder',
              message: 'Carregando objetos...',
            } satisfies PlaceholderNodeRef,
          ];
        }

        const objectNames = this.listGroupObjectsFromSnapshot(element);
        const filteredObjectNames =
          element.kind === 'table' && this.tableNameFilter
            ? objectNames.filter((name) => name.toLowerCase().includes(this.tableNameFilter))
            : objectNames;
        const tableCountByName = schemaSnapshot.tableCountByName;

        if (filteredObjectNames.length === 0) {
          if (schemaSnapshot.status === 'error') {
            return [
              {
                type: 'placeholder',
                message: schemaSnapshot.errorMessage ?? 'Erro ao carregar objetos.',
              } satisfies PlaceholderNodeRef,
            ];
          }

          if (schemaSnapshot.status === 'created' || schemaSnapshot.status === 'loading') {
            return [
              {
                type: 'placeholder',
                message: 'Carregando lista...',
              } satisfies PlaceholderNodeRef,
            ];
          }

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

      const snapshot = this.connectionSnapshots.get(element.connection.id);
      if (snapshot?.status === 'loading' || snapshot?.status === 'created') {
        item.description = `${item.description} • carregando`;
      }
      if (snapshot?.status === 'error') {
        item.description = `${item.description} • erro`;
      }

      const cachedVersion = this.versions.get(element.connection.id);
      if (cachedVersion) {
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
        element.kind === "schemas"
          ? new vscode.ThemeIcon("type-hierarchy-sub")
          : new vscode.ThemeIcon("extensions");
      return item;
    }

    if (element.type === 'schema') {
      const item = new vscode.TreeItem(element.schemaName, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'schema';
      item.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
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

  private listGroupObjectsFromSnapshot(group: ObjectGroupNodeRef): string[] {
    const schema = this.getSchemaSnapshot(group.connection.id, group.databaseName, group.schemaName);
    if (!schema) {
      return [];
    }

    if (group.kind === 'table') {
      return [...schema.tableNames];
    }

    if (group.kind === 'view') {
      return [...schema.viewNames];
    }

    if (group.kind === 'function') {
      return [...schema.functionNames];
    }

    if (group.kind === 'procedure') {
      return [...schema.procedureNames];
    }

    return [...schema.triggerNames];
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

  private getSchemaSnapshot(
    connectionId: string,
    databaseName: string,
    schemaName: string
  ): SchemaSnapshot | undefined {
    return this.connectionSnapshots.get(connectionId)?.databaseByName.get(databaseName)?.schemaByName.get(schemaName);
  }

  private ensureConnectionSnapshotLoaded(connection: PostgresConnection): void {
    const existingSnapshot = this.connectionSnapshots.get(connection.id);
    const hasActiveLoad = (this.connectionLoadGeneration.get(connection.id) ?? 0) > 0;
    if (existingSnapshot?.status === 'ready' || hasActiveLoad) {
      return;
    }

    if (!existingSnapshot) {
      this.connectionSnapshots.set(connection.id, {
        connection,
        status: 'created',
        databaseByName: new Map<string, DatabaseSnapshot>(),
      });
    }

    this.startConnectionLoad(connection, this.metadataLoadSeq);
  }

  private startConnectionLoad(
    connection: PostgresConnection,
    expectedSeq: number
  ): void {
    const nextGeneration = (this.connectionLoadGeneration.get(connection.id) ?? 0) + 1;
    this.connectionLoadGeneration.set(connection.id, nextGeneration);

    const existingSnapshot = this.connectionSnapshots.get(connection.id);
    const preservedDatabaseByName = existingSnapshot
      ? this.cloneDatabaseMap(existingSnapshot.databaseByName)
      : new Map<string, DatabaseSnapshot>();

    this.connectionSnapshots.set(connection.id, {
      connection,
      status: 'loading',
      databaseByName: preservedDatabaseByName,
    });
    this.logConnectionEvent(connection, `status=loading generation=${nextGeneration} seq=${expectedSeq}`);
    this.refresh();

    void this.loadConnectionIncrementalWithRetries(connection, expectedSeq, nextGeneration);
  }

  private async loadConnectionIncrementalWithRetries(
    connection: PostgresConnection,
    expectedSeq: number,
    generation: number
  ): Promise<void> {
    const retryDelaysMs = [5000, 10000, 60000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
        this.logConnectionEvent(
          connection,
          `cancelado: geração/seq mudou (generation=${generation}, seq=${expectedSeq})`
        );
        return;
      }

      try {
        this.logConnectionEvent(
          connection,
          `tentativa ${attempt + 1}/${retryDelaysMs.length + 1}: iniciando teste/listagem`
        );
        await this.loadConnectionIncremental(connection, expectedSeq, generation, attempt);
        this.logConnectionEvent(connection, `tentativa ${attempt + 1}: sucesso`);
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : 'Erro desconhecido';
        this.logConnectionEvent(connection, `tentativa ${attempt + 1}: falhou - ${message}`);
        const snapshot = this.ensureConnectionSnapshot(connection);
        snapshot.status = 'error';
        snapshot.errorMessage = `Erro ao conectar: ${message}`;
        this.versions.set(connection.id, 'Não conectado');
        this.logConnectionEvent(connection, `status=error motivo="${snapshot.errorMessage}"`);
        this.refresh();
        if (attempt < retryDelaysMs.length) {
          this.logConnectionEvent(
            connection,
            `aguardando ${retryDelaysMs[attempt]}ms para nova tentativa`
          );
          await this.delay(retryDelaysMs[attempt]);
          continue;
        }
      }
    }

    if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
      return;
    }

    const snapshot = this.ensureConnectionSnapshot(connection);
    const message = lastError instanceof Error ? lastError.message : 'Erro ao conectar';
    snapshot.status = 'error';
    snapshot.errorMessage = `Erro ao conectar: ${message}`;
    this.versions.set(connection.id, 'Não conectado');
    this.logConnectionEvent(connection, `status=error motivo="${snapshot.errorMessage}"`);
    this.refresh();
  }

  private async loadConnectionIncremental(
    connection: PostgresConnection,
    expectedSeq: number,
    generation: number,
    attempt: number
  ): Promise<void> {
    const snapshot = this.ensureConnectionSnapshot(connection);
    if (attempt === 0) {
      snapshot.status = 'loading';
      snapshot.errorMessage = undefined;
      this.logConnectionEvent(connection, 'iniciando carregamento incremental');
      this.refresh();
    } else {
      this.logConnectionEvent(connection, `retry em background (tentativa ${attempt + 1})`);
    }

    this.logConnectionEvent(connection, 'executando teste de conexão');
    const version = await this.withTimeout(
      this.postgresService.testConnection(connection),
      this.connectionProbeTimeoutMs,
      'testar conexão'
    );
    if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
      this.logConnectionEvent(connection, 'teste concluído, mas carga ficou obsoleta');
      return;
    }

    this.versions.set(connection.id, version);
    this.logConnectionEvent(connection, `teste de conexão OK: ${version}`);
    this.refresh();

    this.logConnectionEvent(connection, 'listando bancos');
    const databaseNames = await this.withTimeout(
      this.postgresService.listDatabases(connection),
      this.databaseLoadTimeoutMs,
      'listar bancos'
    );
    if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
      this.logConnectionEvent(connection, 'listagem concluída, mas carga ficou obsoleta');
      return;
    }
    this.logConnectionEvent(connection, `bancos carregados: ${databaseNames.length}`);

    const validDatabaseNames = new Set(databaseNames);
    for (const databaseName of Array.from(snapshot.databaseByName.keys())) {
      if (!validDatabaseNames.has(databaseName)) {
        snapshot.databaseByName.delete(databaseName);
      }
    }

    for (const databaseName of databaseNames) {
      const existingDatabase = snapshot.databaseByName.get(databaseName);
      snapshot.databaseByName.set(databaseName, existingDatabase ? this.cloneDatabaseSnapshot(existingDatabase) : {
        status: 'created',
        schemaByName: new Map<string, SchemaSnapshot>(),
        extensionNames: [],
      });
    }

    this.refresh();

    await Promise.all(
      databaseNames.map((databaseName) =>
        this.loadDatabaseIncremental(connection, databaseName, expectedSeq, generation)
      )
    );

    if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
      this.logConnectionEvent(connection, 'carregamento de bancos concluído, mas carga ficou obsoleta');
      return;
    }

    snapshot.status = 'ready';
    snapshot.errorMessage = undefined;
    this.logConnectionEvent(connection, 'status=ready carregamento finalizado');
    this.refresh();
  }

  private async loadDatabaseIncremental(
    connection: PostgresConnection,
    databaseName: string,
    expectedSeq: number,
    generation: number
  ): Promise<void> {
    if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
      return;
    }

    const snapshot = this.ensureConnectionSnapshot(connection);
    const database = snapshot.databaseByName.get(databaseName);
    if (!database) {
      return;
    }

    database.status = 'loading';
    database.errorMessage = undefined;
    this.refresh();

    try {
      const [schemaNames, extensionNames] = await Promise.all([
        this.postgresService.listSchemas(connection, databaseName),
        this.postgresService.listExtensions(connection, databaseName),
      ]);

      if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
        return;
      }

      database.extensionNames = [...extensionNames].sort((a, b) => a.localeCompare(b));

      const validSchemaNames = new Set(schemaNames);
      for (const schemaName of Array.from(database.schemaByName.keys())) {
        if (!validSchemaNames.has(schemaName)) {
          database.schemaByName.delete(schemaName);
        }
      }

      for (const schemaName of schemaNames) {
        const existingSchema = database.schemaByName.get(schemaName);
        database.schemaByName.set(schemaName, existingSchema ? this.cloneSchemaSnapshot(existingSchema) : {
          status: 'created',
          tableNames: [],
          viewNames: [],
          functionNames: [],
          procedureNames: [],
          triggerNames: [],
          tableCountByName: new Map<string, number>(),
        });
      }

      this.refresh();

      await Promise.all(
        schemaNames.map((schemaName) =>
          this.loadSchemaIncremental(connection, databaseName, schemaName, expectedSeq, generation)
        )
      );

      if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
        return;
      }

      database.status = 'ready';
      database.errorMessage = undefined;
      this.refresh();
    } catch (error) {
      if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
        return;
      }

      database.status = 'error';
      database.errorMessage = error instanceof Error ? error.message : 'Erro ao carregar banco';
      this.refresh();
    }
  }

  private async loadSchemaIncremental(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    expectedSeq: number,
    generation: number
  ): Promise<void> {
    const schema = this.getSchemaSnapshot(connection.id, databaseName, schemaName);
    if (!schema) {
      return;
    }

    schema.status = 'loading';
    schema.errorMessage = undefined;
    this.refresh();

    const safeUpdate = (update: (target: SchemaSnapshot) => void): void => {
      if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
        return;
      }

      const target = this.getSchemaSnapshot(connection.id, databaseName, schemaName);
      if (!target) {
        return;
      }

      update(target);
      this.refresh();
    };

    let failed = false;
    const failureMessages: string[] = [];
    const registerFailure = (label: string, error: unknown): void => {
      failed = true;
      failureMessages.push(`${label}: ${this.describeError(error)}`);
    };

    const tasks: Promise<void>[] = [
      this.postgresService.listTables(connection, databaseName, schemaName)
        .then((items) => safeUpdate((target) => {
          target.tableNames = [...items].sort((a, b) => a.localeCompare(b));
        }))
        .catch((error) => {
          registerFailure('Tabelas', error);
        }),
      this.postgresService.listViews(connection, databaseName, schemaName)
        .then((items) => safeUpdate((target) => {
          target.viewNames = [...items].sort((a, b) => a.localeCompare(b));
        }))
        .catch((error) => {
          registerFailure('Views', error);
        }),
      this.postgresService.listFunctions(connection, databaseName, schemaName)
        .then((items) => safeUpdate((target) => {
          target.functionNames = [...items].sort((a, b) => a.localeCompare(b));
        }))
        .catch((error) => {
          registerFailure('Functions', error);
        }),
      this.postgresService.listProcedures(connection, databaseName, schemaName)
        .then((items) => safeUpdate((target) => {
          target.procedureNames = [...items].sort((a, b) => a.localeCompare(b));
        }))
        .catch((error) => {
          registerFailure('Procedures', error);
        }),
      this.postgresService.listTriggers(connection, databaseName, schemaName)
        .then((items) => safeUpdate((target) => {
          target.triggerNames = [...items].sort((a, b) => a.localeCompare(b));
        }))
        .catch((error) => {
          registerFailure('Triggers', error);
        }),
      this.postgresService.listTableEstimatedCounts(connection, databaseName, schemaName)
        .then((items) => safeUpdate((target) => {
          target.tableCountByName = new Map(items.map((item) => [item.tableName, item.count]));
        }))
        .catch((error) => {
          registerFailure('Contagem de tabelas', error);
        }),
    ];

    await Promise.all(tasks);

    if (!this.isLoadCurrent(connection.id, expectedSeq, generation)) {
      return;
    }

    const target = this.getSchemaSnapshot(connection.id, databaseName, schemaName);
    if (!target) {
      return;
    }

    target.status = failed ? 'error' : 'ready';
    target.errorMessage = failed
      ? `Falha ao carregar o schema ${schemaName}: ${failureMessages.join(' | ')}`
      : undefined;
    this.refresh();
  }

  private ensureConnectionSnapshot(connection: PostgresConnection): ConnectionSnapshot {
    const existing = this.connectionSnapshots.get(connection.id);
    if (existing) {
      existing.connection = connection;
      return existing;
    }

    const created: ConnectionSnapshot = {
      connection,
      status: 'created',
      databaseByName: new Map<string, DatabaseSnapshot>(),
    };
    this.connectionSnapshots.set(connection.id, created);
    return created;
  }

  private isLoadCurrent(connectionId: string, expectedSeq: number, generation: number): boolean {
    return (
      expectedSeq === this.metadataLoadSeq &&
      this.connectionLoadGeneration.get(connectionId) === generation
    );
  }

  private cloneSchemaSnapshot(source: SchemaSnapshot): SchemaSnapshot {
    return {
      status: source.status,
      tableNames: [...source.tableNames],
      viewNames: [...source.viewNames],
      functionNames: [...source.functionNames],
      procedureNames: [...source.procedureNames],
      triggerNames: [...source.triggerNames],
      tableCountByName: new Map(source.tableCountByName),
      errorMessage: source.errorMessage,
    };
  }

  private cloneDatabaseSnapshot(source: DatabaseSnapshot): DatabaseSnapshot {
    const schemaByName = new Map<string, SchemaSnapshot>();
    for (const [schemaName, schemaSnapshot] of source.schemaByName.entries()) {
      schemaByName.set(schemaName, this.cloneSchemaSnapshot(schemaSnapshot));
    }

    return {
      status: source.status,
      schemaByName,
      extensionNames: [...source.extensionNames],
      errorMessage: source.errorMessage,
    };
  }

  private cloneDatabaseMap(source: Map<string, DatabaseSnapshot>): Map<string, DatabaseSnapshot> {
    const cloned = new Map<string, DatabaseSnapshot>();
    for (const [databaseName, databaseSnapshot] of source.entries()) {
      cloned.set(databaseName, this.cloneDatabaseSnapshot(databaseSnapshot));
    }
    return cloned;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    operationName: string
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout ao ${operationName} após ${timeoutMs}ms`));
      }, timeoutMs);

      operation
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : 'Erro desconhecido';
  }

  private logConnectionEvent(connection: PostgresConnection, message: string): void {
    // console.log(`[dbadmin][tree][${connection.nickname}][${connection.host}:${connection.port}/${connection.database}] ${message}`);
  }

}
