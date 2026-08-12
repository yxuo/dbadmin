import { Client } from "pg";
import { PostgresConnection, PostgresConnectionInput } from "./models";
import { parseAdvancedFilterForDataType } from "./advancedFilter";

export interface SchemaObjectCounts {
  tables: number;
  views: number;
  functions: number;
  procedures: number;
  triggers: number;
}

export interface TableColumnMeta {
  name: string;
  dataType: string;
  isNullable: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
  /** True when the column participates in a UNIQUE constraint (not just PK). */
  isUnique: boolean;
  isForeignKey: boolean;
  foreignKeyTargetSchema: string | null;
  foreignKeyTargetTable: string | null;
  foreignKeyTargetColumn: string | null;
}

export type TableSortDirection = "asc" | "desc";

export interface TableDataQuery {
  searchText: string;
  searchMode: "local" | "query";
  sortColumn?: string;
  sortDirection?: TableSortDirection;
  columnFilters: Record<string, string>;
  limit: number;
  page: number;
}

export interface TableDataResult {
  query: string;
  columns: TableColumnMeta[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
}

export interface TableSavePayload {
  updates: Array<{ ctid: string; values: Record<string, unknown> }>;
  inserts: Array<Record<string, unknown>>;
  deletes: string[];
}

export interface TableEstimatedCount {
  tableName: string;
  count: number;
}

export interface TableSectionCounts {
  columns: number;
  constraints: number;
  indexes: number;
  rls: number;
  rules: number;
  triggers: number;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  definition: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
}

export interface SqlQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  command: string;
  results?: SqlQueryResult[];
}

export class PostgresService {
  public async getVersion(connection: PostgresConnection): Promise<string> {
    return this.testConnection(connection);
  }

  public async testConnection(
    connection: PostgresConnectionInput,
  ): Promise<string> {
    const client = await this.connect(connection);
    try {
      const versionResult = await client.query<{ version: string }>(
        "SELECT version() AS version",
      );
      return versionResult.rows[0]?.version ?? "Unknown version";
    } finally {
      await client.end();
    }
  }

  public async listDatabases(
    connection: PostgresConnection,
  ): Promise<string[]> {
    const client = await this.connect(connection);
    try {
      const result = await client.query<{ datname: string }>(
        `SELECT datname
         FROM pg_database
         WHERE datistemplate = false
         ORDER BY datname`,
      );
      return result.rows.map((row) => row.datname);
    } finally {
      await client.end();
    }
  }

  public async createDatabase(
    connection: PostgresConnection,
    name: string,
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: "postgres" });
    try {
      await client.query(`CREATE DATABASE ${this.quoteIdentifier(name)}`);
    } finally {
      await client.end();
    }
  }

  public async duplicateDatabase(
    connection: PostgresConnection,
    sourceName: string,
    targetName: string,
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: "postgres" });
    try {
      await client.query(
        `CREATE DATABASE ${this.quoteIdentifier(targetName)} WITH TEMPLATE ${this.quoteIdentifier(sourceName)}`,
      );
    } finally {
      await client.end();
    }
  }

  public async renameDatabase(
    connection: PostgresConnection,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: "postgres" });
    try {
      await client.query(
        `ALTER DATABASE ${this.quoteIdentifier(oldName)} RENAME TO ${this.quoteIdentifier(newName)}`,
      );
    } finally {
      await client.end();
    }
  }

  public async dropDatabase(
    connection: PostgresConnection,
    name: string,
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: "postgres" });
    try {
      await client.query(`DROP DATABASE ${this.quoteIdentifier(name)}`);
    } finally {
      await client.end();
    }
  }

  public async createSchema(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<void> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(`CREATE SCHEMA ${this.quoteIdentifier(schemaName)}`);
    } finally {
      await client.end();
    }
  }

  public async dropSchema(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<void> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(
        `DROP SCHEMA ${this.quoteIdentifier(schemaName)} CASCADE`,
      );
    } finally {
      await client.end();
    }
  }

  public async truncateTable(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<void> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(
        `TRUNCATE TABLE ${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)} CASCADE`,
      );
    } finally {
      await client.end();
    }
  }

  public async listSchemas(
    connection: PostgresConnection,
    databaseName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schema_name`,
      );
      return result.rows.map((row) => row.schema_name);
    } finally {
      await client.end();
    }
  }

  public async listExtensions(
    connection: PostgresConnection,
    databaseName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ extname: string }>(
        `SELECT extname
         FROM pg_extension
         ORDER BY extname`,
      );
      return result.rows.map((row) => row.extname);
    } finally {
      await client.end();
    }
  }

  public async listTables(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schemaName],
      );
      return result.rows.map((row) => row.table_name);
    } finally {
      await client.end();
    }
  }

  public async listViews(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.views
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schemaName],
      );
      return result.rows.map((row) => row.table_name);
    } finally {
      await client.end();
    }
  }

  public async listFunctions(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ routine_name: string }>(
        `SELECT routine_name
         FROM information_schema.routines
         WHERE routine_schema = $1
           AND routine_type = 'FUNCTION'
         ORDER BY routine_name`,
        [schemaName],
      );
      return result.rows.map((row) => row.routine_name);
    } finally {
      await client.end();
    }
  }

  public async listProcedures(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ routine_name: string }>(
        `SELECT routine_name
         FROM information_schema.routines
         WHERE routine_schema = $1
           AND routine_type = 'PROCEDURE'
         ORDER BY routine_name`,
        [schemaName],
      );
      return result.rows.map((row) => row.routine_name);
    } finally {
      await client.end();
    }
  }

  public async listTriggers(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<string[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ trigger_name: string }>(
        `SELECT DISTINCT trigger_name
         FROM information_schema.triggers
         WHERE trigger_schema = $1
         ORDER BY trigger_name`,
        [schemaName],
      );
      return result.rows.map((row) => row.trigger_name);
    } finally {
      await client.end();
    }
  }

  public async executeSql(
    connection: PostgresConnection,
    databaseName: string,
    sql: string,
  ): Promise<void> {
    const trimmed = String(sql || "").trim();
    if (!trimmed) {
      throw new Error("SQL vazio.");
    }

    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(trimmed);
    } finally {
      await client.end();
    }
  }

  public async querySql(
    connection: PostgresConnection,
    databaseName: string,
    sql: string,
  ): Promise<SqlQueryResult> {
    const trimmed = String(sql || "").trim();
    if (!trimmed) {
      throw new Error("SQL vazio.");
    }

    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const rawResult = await client.query(trimmed);
      const result = rawResult;
      const results = Array.isArray(rawResult)
        ? rawResult.map((r) => ({
            columns: (r.fields ?? []).map((f: { name: string }) => f.name),
            rows: r.rows,
            rowCount: r.rowCount ?? r.rows.length,
            command: r.command ?? "",
          }))
        : [];

      if (!result) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          command: "",
          results: [],
        };
      }

      if (results.length > 1) {
        const last = results[results.length - 1];
        return {
          columns: last.columns,
          rows: last.rows,
          rowCount: last.rowCount,
          command: last.command,
          results: results,
        };
      }

      return {
        columns: (result.fields ?? []).map((f: { name: string }) => f.name),
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
        command: result.command ?? "",
        results: [],
      };
    } finally {
      await client.end();
    }
  }

  public async getFunctionDefinition(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    functionName: string,
  ): Promise<string> {
    const row = await this.getRoutineDefinitionRow(
      connection,
      databaseName,
      schemaName,
      functionName,
      "f",
      "function",
    );
    return row.definition;
  }

  public async getProcedureDefinition(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    procedureName: string,
  ): Promise<string> {
    const row = await this.getRoutineDefinitionRow(
      connection,
      databaseName,
      schemaName,
      procedureName,
      "p",
      "procedure",
    );
    return row.definition;
  }

  public async dropFunction(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    functionName: string,
  ): Promise<void> {
    const row = await this.getRoutineDefinitionRow(
      connection,
      databaseName,
      schemaName,
      functionName,
      "f",
      "function",
    );

    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(`DROP FUNCTION ${row.signature}`);
    } finally {
      await client.end();
    }
  }

  public async dropProcedure(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    procedureName: string,
  ): Promise<void> {
    const row = await this.getRoutineDefinitionRow(
      connection,
      databaseName,
      schemaName,
      procedureName,
      "p",
      "procedure",
    );

    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(`DROP PROCEDURE ${row.signature}`);
    } finally {
      await client.end();
    }
  }

  public async getTriggerDefinition(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    triggerName: string,
  ): Promise<{ tableName: string; definition: string }> {
    const rows = await this.getTriggerDefinitionRows(
      connection,
      databaseName,
      schemaName,
      triggerName,
    );

    if (rows.length === 0) {
      throw new Error(
        `Trigger "${triggerName}" não encontrada em ${schemaName}.`,
      );
    }

    if (rows.length > 1) {
      throw new Error(
        `Há mais de uma trigger chamada "${triggerName}" em ${schemaName}. Remoção/edição ambígua.`,
      );
    }

    return {
      tableName: rows[0].table_name,
      definition: rows[0].definition,
    };
  }

  public async dropTrigger(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    triggerName: string,
  ): Promise<void> {
    const trigger = await this.getTriggerDefinition(
      connection,
      databaseName,
      schemaName,
      triggerName,
    );

    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      await client.query(
        `DROP TRIGGER ${this.quoteIdentifier(triggerName)} ON ${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(trigger.tableName)}`,
      );
    } finally {
      await client.end();
    }
  }

  public async getTableSectionCounts(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<TableSectionCounts> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<TableSectionCounts>(
        `SELECT
           (SELECT COUNT(*)::int
            FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2) AS columns,
           (SELECT COUNT(*)::int
            FROM information_schema.table_constraints tc
            WHERE tc.table_schema = $1 AND tc.table_name = $2) AS constraints,
           (SELECT COUNT(*)::int
            FROM pg_indexes i
            WHERE i.schemaname = $1 AND i.tablename = $2) AS indexes,
           (SELECT COUNT(*)::int
            FROM pg_policy p
            JOIN pg_class cl ON cl.oid = p.polrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE n.nspname = $1 AND cl.relname = $2) AS rls,
           (SELECT COUNT(*)::int
            FROM pg_rules r
            WHERE r.schemaname = $1 AND r.tablename = $2) AS rules,
           (SELECT COUNT(DISTINCT trigger_name)::int
            FROM information_schema.triggers t
            WHERE t.trigger_schema = $1 AND t.event_object_table = $2) AS triggers`,
        [schemaName, tableName],
      );

      return (
        result.rows[0] ?? {
          columns: 0,
          constraints: 0,
          indexes: 0,
          rls: 0,
          rules: 0,
          triggers: 0,
        }
      );
    } finally {
      await client.end();
    }
  }

  public async listTableColumnsDetailed(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<ColumnInfo[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{
        name: string;
        data_type: string;
        is_nullable: "YES" | "NO";
        column_default: string | null;
      }>(
        `SELECT
           column_name AS name,
           data_type,
           is_nullable,
           column_default
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = $2
         ORDER BY ordinal_position`,
        [schemaName, tableName],
      );

      return result.rows.map((row) => ({
        name: row.name,
        dataType: row.data_type,
        isNullable: row.is_nullable === "YES",
        defaultValue: row.column_default,
      }));
    } finally {
      await client.end();
    }
  }

  public async listTableConstraints(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<ConstraintInfo[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{
        name: string;
        type: string;
        definition: string;
      }>(
        `SELECT
           tc.constraint_name AS name,
           tc.constraint_type AS type,
           COALESCE(pg_get_constraintdef(c.oid, true), '') AS definition
         FROM information_schema.table_constraints tc
         LEFT JOIN pg_constraint c
           ON c.conname = tc.constraint_name
         LEFT JOIN pg_class cl
           ON cl.oid = c.conrelid
         LEFT JOIN pg_namespace n
           ON n.oid = cl.relnamespace
         WHERE tc.table_schema = $1
           AND tc.table_name = $2
           AND (n.nspname = $1 OR n.nspname IS NULL)
         ORDER BY tc.constraint_name`,
        [schemaName, tableName],
      );

      return result.rows.map((row) => ({
        name: row.name,
        type: row.type,
        definition: row.definition,
      }));
    } finally {
      await client.end();
    }
  }

  public async getColumnDetails(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    columnName: string,
  ): Promise<ColumnInfo | undefined> {
    const columns = await this.listTableColumnsDetailed(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
    return columns.find((column) => column.name === columnName);
  }

  public async getConstraintDetails(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    constraintName: string,
  ): Promise<ConstraintInfo | undefined> {
    const constraints = await this.listTableConstraints(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
    return constraints.find((constraint) => constraint.name === constraintName);
  }

  public async updateColumnProperties(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    columnName: string,
    payload: { isNullable: boolean; defaultValue: string },
  ): Promise<void> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    const tableSql = `${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}`;
    const columnSql = this.quoteIdentifier(columnName);

    try {
      await client.query("BEGIN");

      if (payload.isNullable) {
        await client.query(
          `ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} DROP NOT NULL`,
        );
      } else {
        await client.query(
          `ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} SET NOT NULL`,
        );
      }

      const trimmedDefault = payload.defaultValue.trim();
      if (!trimmedDefault) {
        await client.query(
          `ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} DROP DEFAULT`,
        );
      } else {
        await client.query(
          `ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} SET DEFAULT ${trimmedDefault}`,
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  public async listTableEstimatedCounts(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<TableEstimatedCount[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{
        table_name: string;
        row_count: number;
      }>(
        `SELECT
           t.table_name,
           COALESCE(
             (
               xpath(
                 '/row/c/text()',
                 query_to_xml(
                   format('SELECT COUNT(*) AS c FROM %I.%I', t.table_schema, t.table_name),
                   false,
                   true,
                   ''
                 )
               )
             )[1]::text::bigint,
             0
           )::int AS row_count
         FROM information_schema.tables t
         WHERE t.table_schema = $1
           AND t.table_type = 'BASE TABLE'
         ORDER BY t.table_name`,
        [schemaName],
      );

      return result.rows.map((row) => ({
        tableName: row.table_name,
        count: Number(row.row_count || 0),
      }));
    } finally {
      await client.end();
    }
  }

  public async getSchemaObjectCounts(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
  ): Promise<SchemaObjectCounts> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<SchemaObjectCounts>(
        `SELECT
           (SELECT COUNT(*)::int
            FROM information_schema.tables
            WHERE table_schema = $1
              AND table_type = 'BASE TABLE') AS tables,
           (SELECT COUNT(*)::int
            FROM information_schema.views
            WHERE table_schema = $1) AS views,
           (SELECT COUNT(*)::int
            FROM information_schema.routines
            WHERE routine_schema = $1
              AND routine_type = 'FUNCTION') AS functions,
           (SELECT COUNT(*)::int
            FROM information_schema.routines
            WHERE routine_schema = $1
              AND routine_type = 'PROCEDURE') AS procedures,
           (SELECT COUNT(DISTINCT trigger_name)::int
            FROM information_schema.triggers
            WHERE trigger_schema = $1) AS triggers`,
        [schemaName],
      );

      return (
        result.rows[0] ?? {
          tables: 0,
          views: 0,
          functions: 0,
          procedures: 0,
          triggers: 0,
        }
      );
    } finally {
      await client.end();
    }
  }

  public async getTableColumns(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
  ): Promise<TableColumnMeta[]> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{
        name: string;
        data_type: string;
        is_nullable: "YES" | "NO";
        column_default: string | null;
        is_primary_key: boolean;
        is_unique: boolean;
        is_foreign_key: boolean;
        foreign_key_target_schema: string | null;
        foreign_key_target_table: string | null;
        foreign_key_target_column: string | null;
      }>(
        `SELECT
           c.column_name AS name,
           c.data_type,
           c.is_nullable,
           c.column_default,
           EXISTS (
             SELECT 1
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.constraint_schema = kcu.constraint_schema
             WHERE tc.constraint_type = 'PRIMARY KEY'
               AND kcu.table_schema = c.table_schema
               AND kcu.table_name = c.table_name
               AND kcu.column_name = c.column_name
           ) AS is_primary_key,
           EXISTS (
             SELECT 1
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.constraint_schema = kcu.constraint_schema
             WHERE tc.constraint_type = 'UNIQUE'
               AND kcu.table_schema = c.table_schema
               AND kcu.table_name = c.table_name
               AND kcu.column_name = c.column_name
           ) AS is_unique,
           EXISTS (
             SELECT 1
             FROM information_schema.key_column_usage kcu
             JOIN information_schema.referential_constraints rc
               ON rc.constraint_name = kcu.constraint_name
              AND rc.constraint_schema = kcu.constraint_schema
             WHERE kcu.table_schema = c.table_schema
               AND kcu.table_name = c.table_name
               AND kcu.column_name = c.column_name
           ) AS is_foreign_key,
           fk.foreign_key_target_schema,
           fk.foreign_key_target_table,
           fk.foreign_key_target_column
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT
             kcu.table_schema,
             kcu.table_name,
             kcu.column_name,
             ukcu.table_schema AS foreign_key_target_schema,
             ukcu.table_name AS foreign_key_target_table,
             ukcu.column_name AS foreign_key_target_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name
            AND rc.constraint_schema = tc.constraint_schema
           JOIN information_schema.key_column_usage ukcu
             ON ukcu.constraint_name = rc.unique_constraint_name
            AND ukcu.constraint_schema = rc.unique_constraint_schema
            AND ukcu.ordinal_position = kcu.position_in_unique_constraint
           WHERE tc.constraint_type = 'FOREIGN KEY'
         ) fk
           ON fk.table_schema = c.table_schema
          AND fk.table_name = c.table_name
          AND fk.column_name = c.column_name
         WHERE c.table_schema = $1
           AND c.table_name = $2
         ORDER BY c.ordinal_position`,
        [schemaName, tableName],
      );

      return result.rows.map((row) => ({
        name: row.name,
        dataType: row.data_type,
        isNullable: row.is_nullable === "YES",
        hasDefault: row.column_default !== null,
        isPrimaryKey: Boolean(row.is_primary_key),
        isUnique: Boolean(row.is_unique),
        isForeignKey: Boolean(row.is_foreign_key),
        foreignKeyTargetSchema: row.foreign_key_target_schema,
        foreignKeyTargetTable: row.foreign_key_target_table,
        foreignKeyTargetColumn: row.foreign_key_target_column,
      }));
    } finally {
      await client.end();
    }
  }

  public async getTableData(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    queryInput: TableDataQuery,
  ): Promise<TableDataResult> {
    const columns = await this.getTableColumns(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
    const columnNames = columns.map((column) => column.name);
    const validColumns = new Set(columnNames);
    const columnsByName = new Map(
      columns.map((column) => [column.name, column]),
    );

    const safeLimit = Math.max(
      1,
      Math.min(500, Math.trunc(queryInput.limit || 100)),
    );
    const safePage = Math.max(1, Math.trunc(queryInput.page || 1));
    const safeOffset = (safePage - 1) * safeLimit;
    const params: unknown[] = [];
    const whereParts: string[] = [];

    for (const [columnName, filterValueRaw] of Object.entries(
      queryInput.columnFilters,
    )) {
      if (!validColumns.has(columnName)) {
        continue;
      }

      const filterValue = filterValueRaw.trim();
      if (!filterValue) {
        continue;
      }

      const nullFilter = this.parseNullFilterToken(filterValue);
      if (nullFilter === "null") {
        whereParts.push(`${this.quoteIdentifier(columnName)} IS NULL`);
        continue;
      }
      if (nullFilter === "not-null") {
        whereParts.push(`${this.quoteIdentifier(columnName)} IS NOT NULL`);
        continue;
      }

      const columnMeta = columnsByName.get(columnName);
      if (columnMeta) {
        const advancedCondition = this.buildAdvancedFilterCondition(
          columnMeta,
          filterValue,
          params,
        );
        if (advancedCondition) {
          whereParts.push(advancedCondition);
          continue;
        }
      }

      const shouldUseExactMatch =
        columnMeta?.isPrimaryKey === true || columnMeta?.isForeignKey === true;
      params.push(shouldUseExactMatch ? filterValue : `%${filterValue}%`);
      whereParts.push(
        `${this.quoteIdentifier(columnName)}::text ILIKE $${params.length}`,
      );
    }

    if (queryInput.searchMode === "query") {
      const searchText = queryInput.searchText.trim();
      if (searchText && columnNames.length > 0) {
        const nullFilter = this.parseNullFilterToken(searchText);
        if (nullFilter === "null" || nullFilter === "not-null") {
          const nullSql = nullFilter === "null" ? "IS NULL" : "IS NOT NULL";
          const globalSearch = columnNames
            .map(
              (columnName) => `${this.quoteIdentifier(columnName)} ${nullSql}`,
            )
            .join(" OR ");
          whereParts.push(`(${globalSearch})`);
        } else {
          const advancedGlobalConditions = columns
            .map((column) =>
              this.buildAdvancedFilterCondition(column, searchText, params),
            )
            .filter((condition): condition is string => Boolean(condition));

          if (advancedGlobalConditions.length > 0) {
            whereParts.push(`(${advancedGlobalConditions.join(" OR ")})`);
          } else {
            params.push(`%${searchText}%`);
            const searchParamIndex = params.length;
            const globalSearch = columnNames
              .map(
                (columnName) =>
                  `CAST(${this.quoteIdentifier(columnName)} AS TEXT) ILIKE $${searchParamIndex}`,
              )
              .join(" OR ");
            whereParts.push(`(${globalSearch})`);
          }
        }
      }
    }

    const whereClause =
      whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const baseColumns = columnNames
      .map((name) => this.quoteIdentifier(name))
      .join(", ");
    const selectColumns =
      baseColumns.length > 0
        ? `ctid::text AS "__dbadmin_ctid", ${baseColumns}`
        : `ctid::text AS "__dbadmin_ctid"`;

    let orderClause = "";
    if (queryInput.sortColumn && validColumns.has(queryInput.sortColumn)) {
      const direction = queryInput.sortDirection === "desc" ? "DESC" : "ASC";
      orderClause = `ORDER BY ${this.quoteIdentifier(queryInput.sortColumn)} ${direction}`;
    }

    const countSql = `SELECT COUNT(*)::int AS total
FROM ${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}
${whereClause}`.trim();

    const countResult = await this.runCountQuery(
      connection,
      databaseName,
      countSql,
      params,
    );

    const dataParams = [...params, safeLimit, safeOffset];
    const limitPlaceholder = `$${dataParams.length - 1}`;
    const offsetPlaceholder = `$${dataParams.length}`;

    const sql = `SELECT ${selectColumns}
FROM ${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}
${whereClause}
${orderClause}
LIMIT ${limitPlaceholder}
OFFSET ${offsetPlaceholder}`.trim();

    const rows = await this.runTableDataQuery(
      connection,
      databaseName,
      sql,
      dataParams,
    );

    return {
      query: `${sql}\n-- params: ${JSON.stringify(dataParams)}`,
      columns,
      rows,
      totalRows: countResult,
    };
  }

  public async saveTableData(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    payload: TableSavePayload,
  ): Promise<void> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });

    try {
      const columns = await this.getTableColumns(
        connection,
        databaseName,
        schemaName,
        tableName,
      );
      const validColumns = new Set(columns.map((column) => column.name));
      const columnsByName = new Map(
        columns.map((column) => [column.name, column]),
      );
      const qualifiedTable = `${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}`;
      const deleteSet = new Set((payload.deletes ?? []).filter(Boolean));

      await client.query("BEGIN");

      for (const ctid of deleteSet) {
        await client.query(
          `DELETE FROM ${qualifiedTable} WHERE ctid::text = $1`,
          [ctid],
        );
      }

      for (const update of payload.updates) {
        if (!update.ctid) {
          continue;
        }

        if (deleteSet.has(update.ctid)) {
          continue;
        }

        const assignments: string[] = [];
        const params: unknown[] = [];

        for (const [columnName, value] of Object.entries(update.values)) {
          if (!validColumns.has(columnName)) {
            continue;
          }

          const columnMeta = columnsByName.get(columnName);
          if (!columnMeta) {
            continue;
          }

          const quotedColumn = this.quoteIdentifier(columnName);

          if (value === "__DBADMIN_DEFAULT__") {
            assignments.push(`${quotedColumn} = DEFAULT`);
          } else {
            const normalizedValue = this.normalizeValueForColumn(
              value,
              columnMeta,
            );
            params.push(normalizedValue);
            const placeholder = `$${params.length}`;
            assignments.push(
              `${quotedColumn} = ${this.castValuePlaceholder(placeholder, columnMeta)}`,
            );
          }
        }

        if (assignments.length === 0) {
          continue;
        }

        params.push(update.ctid);
        const ctidParam = `$${params.length}`;

        const sql = `UPDATE ${qualifiedTable}
SET ${assignments.join(", ")}
WHERE ctid::text = ${ctidParam}`;

        await client.query(sql, params);
      }

      for (const insertRow of payload.inserts) {
        const insertColumns: string[] = [];
        const insertValuesSql: string[] = [];
        const params: unknown[] = [];

        for (const [columnName, value] of Object.entries(insertRow)) {
          if (!validColumns.has(columnName)) {
            continue;
          }

          const columnMeta = columnsByName.get(columnName);
          if (!columnMeta) {
            continue;
          }

          insertColumns.push(this.quoteIdentifier(columnName));

          if (value === "__DBADMIN_DEFAULT__") {
            insertValuesSql.push("DEFAULT");
          } else {
            const normalizedValue = this.normalizeValueForColumn(
              value,
              columnMeta,
            );
            params.push(normalizedValue);
            const placeholder = `$${params.length}`;
            insertValuesSql.push(
              this.castValuePlaceholder(placeholder, columnMeta),
            );
          }
        }

        if (insertColumns.length === 0) {
          await client.query(`INSERT INTO ${qualifiedTable} DEFAULT VALUES`);
          continue;
        }

        const sql = `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")})
VALUES (${insertValuesSql.join(", ")})`;

        await client.query(sql, params);
      }

      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  private parseNullFilterToken(value: string): "null" | "not-null" | undefined {
    const normalized = String(value || "");
    if (normalized === "NULL") {
      return "null";
    }
    if (normalized === "NOT NULL") {
      return "not-null";
    }
    return undefined;
  }

  private buildAdvancedFilterCondition(
    column: TableColumnMeta,
    rawFilterValue: string,
    params: unknown[],
  ): string | undefined {
    const parsed = parseAdvancedFilterForDataType(
      column.dataType,
      rawFilterValue,
    );
    if (!parsed) {
      return undefined;
    }

    if (parsed.valueType === "number") {
      const columnSql = `${this.quoteIdentifier(column.name)}::numeric`;
      if (parsed.kind === "comparison") {
        params.push(parsed.operand);
        return `(${columnSql} ${parsed.operator} $${params.length})`;
      }

      params.push(parsed.start);
      const startPlaceholder = `$${params.length}`;
      params.push(parsed.end);
      const endPlaceholder = `$${params.length}`;
      return `(${columnSql} BETWEEN ${startPlaceholder} AND ${endPlaceholder})`;
    }

    const columnSql = `${this.quoteIdentifier(column.name)}::date`;
    if (parsed.kind === "comparison") {
      params.push(parsed.operand);
      return `(${columnSql} ${parsed.operator} $${params.length}::date)`;
    }

    params.push(parsed.start);
    const startPlaceholder = `$${params.length}`;
    params.push(parsed.end);
    const endPlaceholder = `$${params.length}`;
    return `(${columnSql} BETWEEN ${startPlaceholder}::date AND ${endPlaceholder}::date)`;
  }

  private async getRoutineDefinitionRow(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    routineName: string,
    routineKind: "f" | "p",
    routineLabel: "function" | "procedure",
  ): Promise<{ signature: string; definition: string }> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{
        signature: string;
        definition: string;
      }>(
        `SELECT
           p.oid::regprocedure::text AS signature,
           pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
           AND p.proname = $2
           AND p.prokind = $3
         ORDER BY p.oid`,
        [schemaName, routineName, routineKind],
      );

      if (result.rows.length === 0) {
        throw new Error(
          `${routineLabel} "${routineName}" não encontrada em ${schemaName}.`,
        );
      }

      if (result.rows.length > 1) {
        throw new Error(
          `Há mais de uma ${routineLabel} chamada "${routineName}" em ${schemaName}. Operação ambígua.`,
        );
      }

      return result.rows[0];
    } finally {
      await client.end();
    }
  }

  private async getTriggerDefinitionRows(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    triggerName: string,
  ): Promise<Array<{ table_name: string; definition: string }>> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{
        table_name: string;
        definition: string;
      }>(
        `SELECT
           c.relname AS table_name,
           pg_get_triggerdef(t.oid, true) AS definition
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND t.tgname = $2
           AND NOT t.tgisinternal
         ORDER BY c.relname`,
        [schemaName, triggerName],
      );

      return result.rows;
    } finally {
      await client.end();
    }
  }

  private async runTableDataQuery(
    connection: PostgresConnection,
    databaseName: string,
    sql: string,
    params: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<Record<string, unknown>>(sql, params);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  private async runCountQuery(
    connection: PostgresConnection,
    databaseName: string,
    sql: string,
    params: unknown[],
  ): Promise<number> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      const result = await client.query<{ total: number }>(sql, params);
      return result.rows[0]?.total ?? 0;
    } finally {
      await client.end();
    }
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private castValuePlaceholder(
    placeholder: string,
    column: TableColumnMeta,
  ): string {
    const dataType = column.dataType.toLowerCase();
    if (dataType === "json" || dataType === "jsonb") {
      return `${placeholder}::${dataType}`;
    }

    return placeholder;
  }

  private normalizeValueForColumn(
    value: unknown,
    column: TableColumnMeta,
  ): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    const dataType = column.dataType.toLowerCase();
    if (dataType !== "json" && dataType !== "jsonb") {
      return value;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      try {
        // Keep JSON payload as text so pg does not coerce JS arrays to postgres arrays.
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        throw new Error(
          `Valor invalido para a coluna "${column.name}" (${column.dataType}). Informe um JSON valido.`,
        );
      }
    }

    try {
      return JSON.stringify(value);
    } catch {
      throw new Error(
        `Valor invalido para a coluna "${column.name}" (${column.dataType}). Informe um JSON valido.`,
      );
    }
  }

  public async getTableDiagramData(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    mainColumns?: TableColumnMeta[],
  ): Promise<DiagramDataResult> {
    const client = await this.connect({
      ...connection,
      database: databaseName,
    });
    try {
      // Use provided columns (already loaded from table panel) or fetch fresh
      const resolvedMainColumns =
        mainColumns ??
        (await this.queryColumnsWithClient(client, schemaName, tableName));

      // Fetch reverse FKs (other tables pointing TO this table) via pg_catalog (fast)
      const reverseResult = await client.query<{
        from_schema: string;
        from_table: string;
        from_column: string;
        to_column: string;
      }>(
        `SELECT
           n.nspname       AS from_schema,
           c.relname       AS from_table,
           a.attname       AS from_column,
           ta.attname      AS to_column
         FROM pg_constraint con
         JOIN pg_class c       ON c.oid  = con.conrelid
         JOIN pg_namespace n   ON n.oid  = c.relnamespace
         JOIN pg_class tc      ON tc.oid = con.confrelid
         JOIN pg_namespace tn  ON tn.oid = tc.relnamespace
         CROSS JOIN LATERAL (
           SELECT unnest(con.conkey) AS la, unnest(con.confkey) AS ra
         ) AS cols
         JOIN pg_attribute a   ON a.attrelid  = c.oid  AND a.attnum = cols.la
         JOIN pg_attribute ta  ON ta.attrelid = tc.oid AND ta.attnum = cols.ra
         WHERE con.contype = 'f'
           AND tn.nspname = $1
           AND tc.relname = $2`,
        [schemaName, tableName],
      );
      const reverseFks = reverseResult.rows;

      // Collect all related table keys
      const relatedKeySet = new Set<string>();
      for (const col of resolvedMainColumns) {
        if (
          col.isForeignKey &&
          col.foreignKeyTargetTable &&
          col.foreignKeyTargetSchema
        ) {
          relatedKeySet.add(
            `${col.foreignKeyTargetSchema}.${col.foreignKeyTargetTable}`,
          );
        }
      }
      for (const fk of reverseFks) {
        relatedKeySet.add(`${fk.from_schema}.${fk.from_table}`);
      }
      const relatedTablesList = [...relatedKeySet]
        .filter((k) => k !== `${schemaName}.${tableName}`)
        .map((key) => {
          const dotIdx = key.indexOf(".");
          return {
            schema: key.substring(0, dotIdx),
            name: key.substring(dotIdx + 1),
          };
        });

      // Fetch ALL related table columns in a single query (one round-trip)
      const relatedColumnsMap = await this.queryMultipleTablesColumnsWithClient(
        client,
        relatedTablesList,
      );

      const tables: DiagramTableInfo[] = [
        { schemaName, tableName, columns: resolvedMainColumns, isMain: true },
      ];
      for (const { schema, name } of relatedTablesList) {
        tables.push({
          schemaName: schema,
          tableName: name,
          columns: relatedColumnsMap.get(`${schema}.${name}`) ?? [],
          isMain: false,
        });
      }

      const foreignKeys: DiagramDataResult["foreignKeys"] = [];
      for (const col of resolvedMainColumns) {
        if (
          col.isForeignKey &&
          col.foreignKeyTargetTable &&
          col.foreignKeyTargetSchema &&
          col.foreignKeyTargetColumn
        ) {
          foreignKeys.push({
            fromSchema: schemaName,
            fromTable: tableName,
            fromColumn: col.name,
            toSchema: col.foreignKeyTargetSchema,
            toTable: col.foreignKeyTargetTable,
            toColumn: col.foreignKeyTargetColumn,
          });
        }
      }
      for (const fk of reverseFks) {
        foreignKeys.push({
          fromSchema: fk.from_schema,
          fromTable: fk.from_table,
          fromColumn: fk.from_column,
          toSchema: schemaName,
          toTable: tableName,
          toColumn: fk.to_column,
        });
      }

      return { tables, foreignKeys };
    } finally {
      await client.end();
    }
  }

  /**
   * Lists rows in tables that reference {@link targetSchema}.{@link targetTable}.{@link targetColumn}
   * with the given value (incoming FK mentions).
   */
  public async findForeignKeyMentions(
    connection: PostgresConnection,
    databaseName: string,
    targetSchema: string,
    targetTable: string,
    targetColumn: string,
    value: unknown,
    options?: { perTableLimit?: number },
  ): Promise<SqlQueryResult & { sql: string }> {
    const schema = String(targetSchema || "").trim();
    const table = String(targetTable || "").trim();
    const column = String(targetColumn || "").trim();
    if (!schema || !table || !column) {
      throw new Error("Alvo da chave estrangeira incompleto.");
    }
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Valor vazio para pesquisar menções.");
    }

    const perTableLimit = Math.max(
      1,
      Math.min(500, Math.trunc(options?.perTableLimit ?? 100)),
    );

    const client = await this.connect({
      ...connection,
      database: databaseName,
    });

    try {
      const reverseResult = await client.query<{
        from_schema: string;
        from_table: string;
        from_column: string;
        to_column: string;
      }>(
        `SELECT
           n.nspname       AS from_schema,
           c.relname       AS from_table,
           a.attname       AS from_column,
           ta.attname      AS to_column
         FROM pg_constraint con
         JOIN pg_class c       ON c.oid  = con.conrelid
         JOIN pg_namespace n   ON n.oid  = c.relnamespace
         JOIN pg_class tc      ON tc.oid = con.confrelid
         JOIN pg_namespace tn  ON tn.oid = tc.relnamespace
         CROSS JOIN LATERAL (
           SELECT unnest(con.conkey) AS la, unnest(con.confkey) AS ra
         ) AS cols
         JOIN pg_attribute a   ON a.attrelid  = c.oid  AND a.attnum = cols.la
         JOIN pg_attribute ta  ON ta.attrelid = tc.oid AND ta.attnum = cols.ra
         WHERE con.contype = 'f'
           AND tn.nspname = $1
           AND tc.relname = $2
           AND ta.attname = $3
         ORDER BY n.nspname, c.relname, a.attname`,
        [schema, table, column],
      );

      const refs = reverseResult.rows;
      if (refs.length === 0) {
        return {
          columns: ["tabela", "coluna", "id"],
          rows: [],
          rowCount: 0,
          command: "SELECT",
          sql: `-- Nenhuma FK apontando para ${schema}.${table}.${column}`,
        };
      }

      const rows: Array<Record<string, unknown>> = [];
      const sqlParts: string[] = [];

      for (const ref of refs) {
        const fromSchemaSql = this.quoteIdentifier(ref.from_schema);
        const fromTableSql = this.quoteIdentifier(ref.from_table);
        const fromColumnSql = this.quoteIdentifier(ref.from_column);
        const qualified = `${ref.from_schema}.${ref.from_table}`;

        const fromColumns = await this.queryColumnsWithClient(
          client,
          ref.from_schema,
          ref.from_table,
        );
        const pkColumns = fromColumns
          .filter((col) => col.isPrimaryKey)
          .map((col) => col.name);

        let idExpr: string;
        if (pkColumns.length === 1) {
          idExpr = `${this.quoteIdentifier(pkColumns[0])}::text`;
        } else if (pkColumns.length > 1) {
          idExpr = `concat_ws('|', ${pkColumns
            .map((name) => `${this.quoteIdentifier(name)}::text`)
            .join(", ")})`;
        } else {
          idExpr = `ctid::text`;
        }

        const cleanSql = `SELECT
  '${qualified.replace(/'/g, "''")}' AS tabela,
  '${ref.from_column.replace(/'/g, "''")}' AS coluna,
  ${idExpr} AS id
FROM ${fromSchemaSql}.${fromTableSql}
WHERE ${fromColumnSql} IS NOT DISTINCT FROM $1
LIMIT ${perTableLimit}`;

        sqlParts.push(cleanSql);
        const result = await client.query<Record<string, unknown>>(cleanSql, [
          value,
        ]);
        for (const row of result.rows) {
          rows.push(row);
        }
      }

      return {
        columns: ["tabela", "coluna", "id"],
        rows,
        rowCount: rows.length,
        command: "SELECT",
        sql: sqlParts.join("\n\n-- next table\n\n"),
      };
    } finally {
      await client.end();
    }
  }

  private async queryColumnsWithClient(
    client: Client,
    schemaName: string,
    tableName: string,
  ): Promise<TableColumnMeta[]> {
    const result = await client.query<{
      name: string;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      is_primary_key: boolean;
      is_unique: boolean;
      is_foreign_key: boolean;
      foreign_key_target_schema: string | null;
      foreign_key_target_table: string | null;
      foreign_key_target_column: string | null;
    }>(
      `SELECT
         a.attname      AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         NOT a.attnotnull                                 AS is_nullable,
         pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)    AS column_default,
         EXISTS (
           SELECT 1 FROM pg_constraint pk
           WHERE pk.conrelid = a.attrelid AND pk.contype = 'p'
             AND a.attnum = ANY(pk.conkey)
         ) AS is_primary_key,
         EXISTS (
           SELECT 1 FROM pg_constraint uq
           WHERE uq.conrelid = a.attrelid AND uq.contype = 'u'
             AND a.attnum = ANY(uq.conkey)
         ) AS is_unique,
         fk.fk_target_schema IS NOT NULL AS is_foreign_key,
         fk.fk_target_schema             AS foreign_key_target_schema,
         fk.fk_target_table              AS foreign_key_target_table,
         fk.fk_target_column             AS foreign_key_target_column
       FROM pg_attribute a
       JOIN pg_class     c  ON c.oid = a.attrelid
       JOIN pg_namespace n  ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       LEFT JOIN (
         SELECT
           con.conrelid,
           cols.la                 AS fk_attnum,
           tn.nspname              AS fk_target_schema,
           tc.relname              AS fk_target_table,
           ta.attname              AS fk_target_column
         FROM pg_constraint con
         JOIN pg_class     tc ON tc.oid = con.confrelid
         JOIN pg_namespace tn ON tn.oid = tc.relnamespace
         CROSS JOIN LATERAL (
           SELECT unnest(con.conkey) AS la, unnest(con.confkey) AS ra
         ) AS cols
         JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = cols.ra
         WHERE con.contype = 'f'
       ) fk ON fk.conrelid = a.attrelid AND fk.fk_attnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND n.nspname = $1
         AND c.relname = $2
       ORDER BY a.attnum`,
      [schemaName, tableName],
    );
    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      isNullable: Boolean(row.is_nullable),
      hasDefault: row.column_default !== null,
      isPrimaryKey: Boolean(row.is_primary_key),
      isUnique: Boolean(row.is_unique),
      isForeignKey: Boolean(row.is_foreign_key),
      foreignKeyTargetSchema: row.foreign_key_target_schema,
      foreignKeyTargetTable: row.foreign_key_target_table,
      foreignKeyTargetColumn: row.foreign_key_target_column,
    }));
  }

  private async queryMultipleTablesColumnsWithClient(
    client: Client,
    tables: Array<{ schema: string; name: string }>,
  ): Promise<Map<string, TableColumnMeta[]>> {
    if (tables.length === 0) return new Map();
    const schemas = tables.map((t) => t.schema);
    const names = tables.map((t) => t.name);
    const result = await client.query<{
      table_schema: string;
      table_name: string;
      name: string;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      is_primary_key: boolean;
      is_unique: boolean;
      is_foreign_key: boolean;
      foreign_key_target_schema: string | null;
      foreign_key_target_table: string | null;
      foreign_key_target_column: string | null;
    }>(
      `SELECT
         n.nspname      AS table_schema,
         c.relname      AS table_name,
         a.attname      AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         NOT a.attnotnull                                 AS is_nullable,
         pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)    AS column_default,
         EXISTS (
           SELECT 1 FROM pg_constraint pk
           WHERE pk.conrelid = a.attrelid AND pk.contype = 'p'
             AND a.attnum = ANY(pk.conkey)
         ) AS is_primary_key,
         EXISTS (
           SELECT 1 FROM pg_constraint uq
           WHERE uq.conrelid = a.attrelid AND uq.contype = 'u'
             AND a.attnum = ANY(uq.conkey)
         ) AS is_unique,
         fk.fk_target_schema IS NOT NULL AS is_foreign_key,
         fk.fk_target_schema             AS foreign_key_target_schema,
         fk.fk_target_table              AS foreign_key_target_table,
         fk.fk_target_column             AS foreign_key_target_column
       FROM pg_attribute a
       JOIN pg_class     c  ON c.oid = a.attrelid
       JOIN pg_namespace n  ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       LEFT JOIN (
         SELECT
           con.conrelid,
           cols.la                 AS fk_attnum,
           tn.nspname              AS fk_target_schema,
           tc.relname              AS fk_target_table,
           ta.attname              AS fk_target_column
         FROM pg_constraint con
         JOIN pg_class     c2 ON c2.oid = con.conrelid
         JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
         JOIN pg_class     tc ON tc.oid = con.confrelid
         JOIN pg_namespace tn ON tn.oid = tc.relnamespace
         CROSS JOIN LATERAL (
           SELECT unnest(con.conkey) AS la, unnest(con.confkey) AS ra
         ) AS cols
         JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = cols.ra
         WHERE con.contype = 'f'
           AND (n2.nspname, c2.relname) IN (
             SELECT unnest($1::text[]), unnest($2::text[])
           )
       ) fk ON fk.conrelid = a.attrelid AND fk.fk_attnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND (n.nspname, c.relname) IN (
           SELECT unnest($1::text[]), unnest($2::text[])
         )
       ORDER BY n.nspname, c.relname, a.attnum`,
      [schemas, names],
    );
    const map = new Map<string, TableColumnMeta[]>();
    for (const row of result.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({
        name: row.name,
        dataType: row.data_type,
        isNullable: Boolean(row.is_nullable),
        hasDefault: row.column_default !== null,
        isPrimaryKey: Boolean(row.is_primary_key),
        isUnique: Boolean(row.is_unique),
        isForeignKey: Boolean(row.is_foreign_key),
        foreignKeyTargetSchema: row.foreign_key_target_schema,
        foreignKeyTargetTable: row.foreign_key_target_table,
        foreignKeyTargetColumn: row.foreign_key_target_column,
      });
    }
    return map;
  }

  private async connect(connection: PostgresConnectionInput): Promise<Client> {
    const client = new Client({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      ssl: connection.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000,
    });

    await client.connect();
    return client;
  }
}

export interface DiagramTableInfo {
  schemaName: string;
  tableName: string;
  columns: TableColumnMeta[];
  isMain: boolean;
}

export interface DiagramDataResult {
  tables: DiagramTableInfo[];
  foreignKeys: Array<{
    fromSchema: string;
    fromTable: string;
    fromColumn: string;
    toSchema: string;
    toTable: string;
    toColumn: string;
  }>;
}
