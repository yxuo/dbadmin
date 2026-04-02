export interface PostgresConnection {
  id: string;
  engine: 'postgres';
  nickname: string;
  host: string;
  port: number;
  database: string;
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

export interface ConnectionsFile {
  version: 1;
  connections: PostgresConnection[];
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
  | 'connection'
  | 'database'
  | 'databaseGroup'
  | 'schema'
  | 'objectGroup'
  | 'dbObject'
  | 'extension'
  | 'tableSection'
  | 'placeholder';

export interface ConnectionNodeRef {
  type: 'connection';
  connection: PostgresConnection;
}

export interface FilterControlNodeRef {
  type: 'filterControl';
  value: string;
}

export interface DatabaseNodeRef {
  type: 'database';
  connection: PostgresConnection;
  databaseName: string;
}

export interface SchemaNodeRef {
  type: 'schema';
  connection: PostgresConnection;
  databaseName: string;
  schemaName: string;
}

export interface DatabaseGroupNodeRef {
  type: 'databaseGroup';
  connection: PostgresConnection;
  databaseName: string;
  kind: DatabaseGroupKind;
}

export interface ObjectGroupNodeRef {
  type: 'objectGroup';
  connection: PostgresConnection;
  databaseName: string;
  schemaName: string;
  kind: DbObjectKind;
  count: number;
}

export interface DbObjectNodeRef {
  type: 'dbObject';
  connection: PostgresConnection;
  databaseName: string;
  schemaName: string;
  kind: DbObjectKind;
  objectName: string;
  count?: number;
}

export interface ExtensionNodeRef {
  type: 'extension';
  connection: PostgresConnection;
  databaseName: string;
  extensionName: string;
}

export interface TableSectionNodeRef {
  type: 'tableSection';
  connection: PostgresConnection;
  databaseName: string;
  schemaName: string;
  tableName: string;
  section: TableSectionKind;
  count: number;
}

export interface TableSectionItemNodeRef {
  type: 'tableSectionItem';
  connection: PostgresConnection;
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
