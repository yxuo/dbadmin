import { requirePostgresConnection } from "../connectionIdentity";
import { DbConnection, isSqliteConnection } from "../models";
import { ConnectionActivityLog } from "../connectionActivityLog";
import {
  ColumnInfo,
  ConstraintInfo,
  DiagramDataResult,
  PostgresService,
  SchemaObjectCounts,
  SqlQueryResult,
  TableColumnMeta,
  TableDataQuery,
  TableDataResult,
  TableEstimatedCount,
  TableSavePayload,
  TableSectionCounts,
} from "../postgresService";
import { PostgresConnectionInput } from "../models";
import { SqliteEngine, SqliteDashboardStats } from "./sqliteEngine";

export class DatabaseService {
  public constructor(
    public readonly postgres: PostgresService,
    public readonly sqlite: SqliteEngine,
  ) {}

  public setActivityLog(log: ConnectionActivityLog): void {
    this.postgres.setActivityLog(log);
    this.sqlite.setActivityLog(log);
  }

  public setStatementTimeoutMs(ms: number | undefined): void {
    this.postgres.setStatementTimeoutMs(ms);
  }

  public async testConnection(connection: DbConnection | PostgresConnectionInput): Promise<string> {
    if (this.isSqlite(connection)) {
      return this.sqlite.testConnection(connection);
    }
    return this.postgres.testConnection(connection);
  }

  public async getVersion(connection: DbConnection): Promise<string> {
    return this.testConnection(connection);
  }

  public async listDatabases(connection: DbConnection): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listDatabases(connection);
    }
    return this.postgres.listDatabases(connection);
  }

  public async listSchemas(connection: DbConnection, databaseName: string): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listSchemas();
    }
    return this.postgres.listSchemas(connection, databaseName);
  }

  public async listExtensions(connection: DbConnection, databaseName: string): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listExtensions();
    }
    return this.postgres.listExtensions(connection, databaseName);
  }

  public async listTables(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listTables(connection, databaseName, schemaName);
    }
    return this.postgres.listTables(connection, databaseName, schemaName);
  }

  public async listViews(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listViews(connection, databaseName, schemaName);
    }
    return this.postgres.listViews(connection, databaseName, schemaName);
  }

  public async listFunctions(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listFunctions();
    }
    return this.postgres.listFunctions(connection, databaseName, schemaName);
  }

  public async listProcedures(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listProcedures();
    }
    return this.postgres.listProcedures(connection, databaseName, schemaName);
  }

  public async listTriggers(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listTriggers(connection, databaseName, schemaName);
    }
    return this.postgres.listTriggers(connection, databaseName, schemaName);
  }

  public async getSchemaObjectCounts(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<SchemaObjectCounts> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getSchemaObjectCounts(connection);
    }
    return this.postgres.getSchemaObjectCounts(connection, databaseName, schemaName);
  }

  public async listTableEstimatedCounts(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<TableEstimatedCount[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listTableEstimatedCounts(connection, databaseName, schemaName);
    }
    return this.postgres.listTableEstimatedCounts(connection, databaseName, schemaName);
  }

  public async getTableSectionCounts(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<TableSectionCounts> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getTableSectionCounts(
        connection,
        databaseName,
        schemaName,
        tableName,
      );
    }
    return this.postgres.getTableSectionCounts(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
  }

  public async listTableColumnsDetailed(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<ColumnInfo[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listTableColumnsDetailed(
        connection,
        databaseName,
        schemaName,
        tableName,
      );
    }
    return this.postgres.listTableColumnsDetailed(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
  }

  public async listTableConstraints(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<ConstraintInfo[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.listTableConstraints(
        connection,
        databaseName,
        schemaName,
        tableName,
      );
    }
    return this.postgres.listTableConstraints(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
  }

  public async getColumnDetails(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    columnName: string,
  ): Promise<ColumnInfo | undefined> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getColumnDetails(
        connection,
        databaseName,
        schemaName,
        tableName,
        columnName,
      );
    }
    return this.postgres.getColumnDetails(
      connection,
      databaseName,
      schemaName,
      tableName,
      columnName,
    );
  }

  public async getConstraintDetails(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    constraintName: string,
  ): Promise<ConstraintInfo | undefined> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getConstraintDetails(
        connection,
        databaseName,
        schemaName,
        tableName,
        constraintName,
      );
    }
    return this.postgres.getConstraintDetails(
      connection,
      databaseName,
      schemaName,
      tableName,
      constraintName,
    );
  }

  public async updateColumnProperties(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    columnName: string,
    payload: { isNullable: boolean; defaultValue: string },
  ): Promise<void> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.updateColumnProperties();
    }
    return this.postgres.updateColumnProperties(
      connection,
      databaseName,
      schemaName,
      tableName,
      columnName,
      payload,
    );
  }

  public async getTableColumns(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<TableColumnMeta[]> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getTableColumns(connection, databaseName, schemaName, tableName);
    }
    return this.postgres.getTableColumns(connection, databaseName, schemaName, tableName);
  }

  public async getTableData(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    queryInput: TableDataQuery,
  ): Promise<TableDataResult> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getTableData(
        connection,
        databaseName,
        schemaName,
        tableName,
        queryInput,
      );
    }
    return this.postgres.getTableData(
      connection,
      databaseName,
      schemaName,
      tableName,
      queryInput,
    );
  }

  public async saveTableData(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    payload: TableSavePayload,
  ): Promise<void> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.saveTableData(
        connection,
        databaseName,
        schemaName,
        tableName,
        payload,
      );
    }
    return this.postgres.saveTableData(
      connection,
      databaseName,
      schemaName,
      tableName,
      payload,
    );
  }

  public async getTableDiagramData(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    mainColumns?: TableColumnMeta[],
  ): Promise<DiagramDataResult> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getTableDiagramData(
        connection,
        databaseName,
        schemaName,
        tableName,
        mainColumns,
      );
    }
    return this.postgres.getTableDiagramData(
      connection,
      databaseName,
      schemaName,
      tableName,
      mainColumns,
    );
  }

  public async findForeignKeyMentions(
    connection: DbConnection,
    databaseName: string,
    targetSchema: string,
    targetTable: string,
    targetColumn: string,
    value: unknown,
    options?: { perTableLimit?: number },
  ): Promise<SqlQueryResult & { sql: string }> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.findForeignKeyMentions(
        connection,
        databaseName,
        targetSchema,
        targetTable,
        targetColumn,
        value,
        options,
      );
    }
    return this.postgres.findForeignKeyMentions(
      connection,
      databaseName,
      targetSchema,
      targetTable,
      targetColumn,
      value,
      options,
    );
  }

  public async querySql(
    connection: DbConnection,
    databaseName: string,
    sql: string,
  ): Promise<SqlQueryResult> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.querySql(connection, databaseName, sql);
    }
    return this.postgres.querySql(connection, databaseName, sql);
  }

  public async executeSql(
    connection: DbConnection,
    databaseName: string,
    sql: string,
  ): Promise<void> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.executeSql(connection, databaseName, sql);
    }
    return this.postgres.executeSql(connection, databaseName, sql);
  }

  public async truncateTable(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<void> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.truncateTable(connection, databaseName, schemaName, tableName);
    }
    return this.postgres.truncateTable(connection, databaseName, schemaName, tableName);
  }

  public async dropTable(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<void> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.dropTable(connection, databaseName, schemaName, tableName);
    }
    return this.postgres.dropTable(connection, databaseName, schemaName, tableName);
  }

  public async getTriggerDefinition(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    triggerName: string,
  ): Promise<{ tableName: string; definition: string }> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.getTriggerDefinition(
        connection,
        databaseName,
        schemaName,
        triggerName,
      );
    }
    return this.postgres.getTriggerDefinition(
      connection,
      databaseName,
      schemaName,
      triggerName,
    );
  }

  public async dropTrigger(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    triggerName: string,
  ): Promise<void> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.dropTrigger(connection, databaseName, schemaName, triggerName);
    }
    return this.postgres.dropTrigger(connection, databaseName, schemaName, triggerName);
  }

  public async createDatabase(connection: DbConnection, name: string): Promise<void> {
    return this.postgres.createDatabase(requirePostgresConnection(connection), name);
  }

  public async duplicateDatabase(
    connection: DbConnection,
    sourceName: string,
    targetName: string,
  ): Promise<void> {
    return this.postgres.duplicateDatabase(
      requirePostgresConnection(connection),
      sourceName,
      targetName,
    );
  }

  public async renameDatabase(
    connection: DbConnection,
    oldName: string,
    newName: string,
  ): Promise<void> {
    return this.postgres.renameDatabase(requirePostgresConnection(connection), oldName, newName);
  }

  public async dropDatabase(connection: DbConnection, name: string): Promise<void> {
    return this.postgres.dropDatabase(requirePostgresConnection(connection), name);
  }

  public async createSchema(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<void> {
    return this.postgres.createSchema(
      requirePostgresConnection(connection),
      databaseName,
      schemaName,
    );
  }

  public async dropSchema(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<void> {
    return this.postgres.dropSchema(
      requirePostgresConnection(connection),
      databaseName,
      schemaName,
    );
  }

  public async getFunctionDefinition(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    functionName: string,
  ): Promise<string> {
    return this.postgres.getFunctionDefinition(
      requirePostgresConnection(connection),
      databaseName,
      schemaName,
      functionName,
    );
  }

  public async dropFunction(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    functionName: string,
  ): Promise<void> {
    return this.postgres.dropFunction(
      requirePostgresConnection(connection),
      databaseName,
      schemaName,
      functionName,
    );
  }

  public async getProcedureDefinition(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    procedureName: string,
  ): Promise<string> {
    return this.postgres.getProcedureDefinition(
      requirePostgresConnection(connection),
      databaseName,
      schemaName,
      procedureName,
    );
  }

  public async dropProcedure(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    procedureName: string,
  ): Promise<void> {
    return this.postgres.dropProcedure(
      requirePostgresConnection(connection),
      databaseName,
      schemaName,
      procedureName,
    );
  }

  public async buildTableDdl(
    connection: DbConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<string> {
    if (isSqliteConnection(connection)) {
      return this.sqlite.buildTableDdl(connection, tableName);
    }
    const { buildTableDdlScript } = await import("../backupRestoreService");
    return buildTableDdlScript(connection, databaseName, schemaName, tableName);
  }

  public async getSqliteDashboard(
    connection: DbConnection,
  ): Promise<SqliteDashboardStats> {
    if (!isSqliteConnection(connection)) {
      throw new Error("This dashboard is only available for SQLite connections.");
    }
    return this.sqlite.getDashboardStats(connection);
  }

  public async dumpSqlite(connection: DbConnection, includeData: boolean): Promise<string> {
    if (!isSqliteConnection(connection)) {
      throw new Error("SQL dump is only available for SQLite connections.");
    }
    return this.sqlite.dumpDatabase(connection, includeData);
  }

  private isSqlite(
    connection: DbConnection | PostgresConnectionInput,
  ): connection is import("../models").SqliteConnection {
    return isSqliteConnection(connection as DbConnection);
  }
}

export function asDatabaseService(
  postgres: PostgresService,
  sqlite: SqliteEngine,
): DatabaseService {
  return new DatabaseService(postgres, sqlite);
}
