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

export interface ConnectionsFile {
  version: 1;
  connections: PostgresConnection[];
}

export type DbObjectKind = 'table' | 'view' | 'function' | 'procedure' | 'trigger';

export type NodeType =
  | 'connection'
  | 'database'
  | 'schema'
  | 'objectGroup'
  | 'dbObject'
  | 'placeholder';

export interface ConnectionNodeRef {
  type: 'connection';
  connection: PostgresConnection;
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
}

export interface PlaceholderNodeRef {
  type: 'placeholder';
  message: string;
}

export type TreeNodeRef =
  | ConnectionNodeRef
  | DatabaseNodeRef
  | SchemaNodeRef
  | ObjectGroupNodeRef
  | DbObjectNodeRef
  | PlaceholderNodeRef;
