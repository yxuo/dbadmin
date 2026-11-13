export type EngineId = 'postgres' | 'sqlite';

export interface PostgresConnection {
  id: string;
  engine: 'postgres';
  nickname: string;
  host: string;
  port: number;
  database: string;
  visibleDatabases?: string[];
  user: string;
  password: string;
  ssl: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PostgresConnectionInput = Omit<
  PostgresConnection,
  'id' | 'engine' | 'createdAt' | 'updatedAt'
>;

export interface SqliteConnection {
  id: string;
  engine: 'sqlite';
  nickname: string;
  filePath: string;
  readOnly?: boolean;
  createdAt: string;
  updatedAt: string;
  ephemeral?: boolean;
}

export type SqliteConnectionInput = Omit<
  SqliteConnection,
  'id' | 'engine' | 'createdAt' | 'updatedAt' | 'ephemeral'
>;

export type DbConnection = PostgresConnection | SqliteConnection;

export type DbConnectionInput = PostgresConnectionInput | SqliteConnectionInput;

export interface ConnectionsFile {
  version: 1 | 2;
  connections: DbConnection[];
}

export function isPostgresConnection(
  connection: DbConnection,
): connection is PostgresConnection {
  return connection.engine === 'postgres';
}

export function isSqliteConnection(
  connection: DbConnection,
): connection is SqliteConnection {
  return connection.engine === 'sqlite';
}

export type DbObjectKind = 'table' | 'view' | 'function' | 'procedure' | 'trigger';

export type DatabaseGroupKind = 'schemas' | 'extensions';

export type TableSectionKind =
  | 'columns'
  | 'constraints'
  | 'indexes'
  | 'rls'
  | 'rules'
  | 'triggers';

export type TableSectionItemKind = 'column' | 'constraint';

export type NodeType =
  | 'filterControl'
  | 'connectionGroup'
  | 'connection'
  | 'database'
  | 'databaseGroup'
  | 'schema'
  | 'objectGroup'
  | 'dbObject'
  | 'extension'
  | 'tableSection'
  | 'placeholder';

export interface ConnectionGroupNodeRef {
  type: 'connectionGroup';
  kind: 'ephemeral';
}

export interface ConnectionNodeRef {
  type: 'connection';
  connection: DbConnection;
}

export interface FilterControlNodeRef {
  type: 'filterControl';
  value: string;
}

export interface DatabaseNodeRef {
  type: 'database';
  connection: DbConnection;
  databaseName: string;
}

export interface SchemaNodeRef {
  type: 'schema';
  connection: DbConnection;
  databaseName: string;
  schemaName: string;
}

export interface DatabaseGroupNodeRef {
  type: 'databaseGroup';
  connection: DbConnection;
  databaseName: string;
  kind: DatabaseGroupKind;
}

export interface ObjectGroupNodeRef {
  type: 'objectGroup';
  connection: DbConnection;
  databaseName: string;
  schemaName: string;
  kind: DbObjectKind;
  count: number;
}

export interface DbObjectNodeRef {
  type: 'dbObject';
  connection: DbConnection;
  databaseName: string;
  schemaName: string;
  kind: DbObjectKind;
  objectName: string;
  count?: number;
}

export interface ExtensionNodeRef {
  type: 'extension';
  connection: DbConnection;
  databaseName: string;
  extensionName: string;
}

export interface TableSectionNodeRef {
  type: 'tableSection';
  connection: DbConnection;
  databaseName: string;
  schemaName: string;
  tableName: string;
  section: TableSectionKind;
  count: number;
}

export interface TableSectionItemNodeRef {
  type: 'tableSectionItem';
  connection: DbConnection;
  databaseName: string;
  schemaName: string;
  tableName: string;
  section: TableSectionKind;
  itemKind: TableSectionItemKind;
  itemName: string;
}

export interface PlaceholderNodeRef {
  type: 'placeholder';
  message: string;
}

export type TreeNodeRef =
  | FilterControlNodeRef
  | ConnectionGroupNodeRef
  | ConnectionNodeRef
  | DatabaseNodeRef
  | DatabaseGroupNodeRef
  | SchemaNodeRef
  | ObjectGroupNodeRef
  | DbObjectNodeRef
  | ExtensionNodeRef
  | TableSectionNodeRef
  | TableSectionItemNodeRef
  | PlaceholderNodeRef;
