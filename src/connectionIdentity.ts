import * as path from "node:path";
import {
  DbConnection,
  isPostgresConnection,
  isSqliteConnection,
  SqliteConnection,
} from "./models";
import { SQLITE_SCHEMA } from "./engines/types";

export function sqliteDatabaseName(connection: SqliteConnection): string {
  return path.basename(connection.filePath) || "main";
}

export function connectionDatabaseName(connection: DbConnection): string {
  if (isSqliteConnection(connection)) {
    return sqliteDatabaseName(connection);
  }
  return connection.database;
}

export function connectionSchemaName(connection: DbConnection, fallback?: string): string {
  if (isSqliteConnection(connection)) {
    return SQLITE_SCHEMA;
  }
  return fallback?.trim() || "public";
}

export function connectionLabel(connection: DbConnection): string {
  if (isSqliteConnection(connection)) {
    return connection.filePath;
  }
  return `${connection.host}:${connection.port}/${connection.database}`;
}

export function connectionTooltip(connection: DbConnection): string {
  if (isSqliteConnection(connection)) {
    const mode = connection.readOnly ? "read-only" : "read/write";
    return `${connection.filePath}\nSQLite (${mode})`;
  }
  return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
}

export function postgresOnlyError(): Error {
  return new Error("This action is only available for PostgreSQL connections.");
}

export function sqliteOnlyError(): Error {
  return new Error("This action is only available for SQLite connections.");
}

export function requirePostgresConnection(connection: DbConnection) {
  if (!isPostgresConnection(connection)) {
    throw postgresOnlyError();
  }
  return connection;
}

export function sqlRunnerContextFromConnection(
  connection: DbConnection,
  extras?: { databaseName?: string; schemaName?: string },
): {
  connectionId: string;
  connectionName: string;
  connectionHost?: string;
  connectionPort?: number;
  connectionFilePath?: string;
  databaseName: string;
  schemaName: string;
} {
  if (isSqliteConnection(connection)) {
    return {
      connectionId: connection.id,
      connectionName: connection.nickname,
      connectionFilePath: connection.filePath,
      databaseName: extras?.databaseName || sqliteDatabaseName(connection),
      schemaName: extras?.schemaName || SQLITE_SCHEMA,
    };
  }
  return {
    connectionId: connection.id,
    connectionName: connection.nickname,
    connectionHost: connection.host,
    connectionPort: connection.port,
    databaseName: extras?.databaseName || connection.database,
    schemaName: extras?.schemaName || "public",
  };
}
