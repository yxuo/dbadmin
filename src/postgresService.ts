import { Client } from 'pg';
import { PostgresConnection, PostgresConnectionInput } from './models';

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
}

export type TableSortDirection = 'asc' | 'desc';

export interface TableDataQuery {
  searchText: string;
  searchMode: 'local' | 'query';
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

export class PostgresService {
  public async getVersion(connection: PostgresConnection): Promise<string> {
    return this.testConnection(connection);
  }

  public async testConnection(connection: PostgresConnectionInput): Promise<string> {
    const client = await this.connect(connection);
    try {
      const versionResult = await client.query<{ version: string }>('SELECT version() AS version');
      return versionResult.rows[0]?.version ?? 'Unknown version';
    } finally {
      await client.end();
    }
  }

  public async listDatabases(connection: PostgresConnection): Promise<string[]> {
    const client = await this.connect(connection);
    try {
      const result = await client.query<{ datname: string }>(
        `SELECT datname
         FROM pg_database
         WHERE datistemplate = false
         ORDER BY datname`
      );
      return result.rows.map((row) => row.datname);
    } finally {
      await client.end();
    }
  }

  public async createDatabase(connection: PostgresConnection, name: string): Promise<void> {
    const client = await this.connect({ ...connection, database: 'postgres' });
    try {
      await client.query(`CREATE DATABASE ${this.quoteIdentifier(name)}`);
    } finally {
      await client.end();
    }
  }

  public async renameDatabase(
    connection: PostgresConnection,
    oldName: string,
    newName: string
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: 'postgres' });
    try {
      await client.query(
        `ALTER DATABASE ${this.quoteIdentifier(oldName)} RENAME TO ${this.quoteIdentifier(newName)}`
      );
    } finally {
      await client.end();
    }
  }

  public async dropDatabase(connection: PostgresConnection, name: string): Promise<void> {
    const client = await this.connect({ ...connection, database: 'postgres' });
    try {
      await client.query(`DROP DATABASE ${this.quoteIdentifier(name)}`);
    } finally {
      await client.end();
    }
  }

  public async listSchemas(connection: PostgresConnection, databaseName: string): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schema_name`
      );
      return result.rows.map((row) => row.schema_name);
    } finally {
      await client.end();
    }
  }

  public async listExtensions(connection: PostgresConnection, databaseName: string): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ extname: string }>(
        `SELECT extname
         FROM pg_extension
         ORDER BY extname`
      );
      return result.rows.map((row) => row.extname);
    } finally {
      await client.end();
    }
  }

  public async listTables(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schemaName]
      );
      return result.rows.map((row) => row.table_name);
    } finally {
      await client.end();
    }
  }

  public async listViews(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.views
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schemaName]
      );
      return result.rows.map((row) => row.table_name);
    } finally {
      await client.end();
    }
  }

  public async listFunctions(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ routine_name: string }>(
        `SELECT routine_name
         FROM information_schema.routines
         WHERE routine_schema = $1
           AND routine_type = 'FUNCTION'
         ORDER BY routine_name`,
        [schemaName]
      );
      return result.rows.map((row) => row.routine_name);
    } finally {
      await client.end();
    }
  }

  public async listProcedures(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ routine_name: string }>(
        `SELECT routine_name
         FROM information_schema.routines
         WHERE routine_schema = $1
           AND routine_type = 'PROCEDURE'
         ORDER BY routine_name`,
        [schemaName]
      );
      return result.rows.map((row) => row.routine_name);
    } finally {
      await client.end();
    }
  }

  public async listTriggers(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<string[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ trigger_name: string }>(
        `SELECT DISTINCT trigger_name
         FROM information_schema.triggers
         WHERE trigger_schema = $1
         ORDER BY trigger_name`,
        [schemaName]
      );
      return result.rows.map((row) => row.trigger_name);
    } finally {
      await client.end();
    }
  }

  public async getTableSectionCounts(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string
  ): Promise<TableSectionCounts> {
    const client = await this.connect({ ...connection, database: databaseName });
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
        [schemaName, tableName]
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
    tableName: string
  ): Promise<ColumnInfo[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{
        name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
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
        [schemaName, tableName]
      );

      return result.rows.map((row) => ({
        name: row.name,
        dataType: row.data_type,
        isNullable: row.is_nullable === 'YES',
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
    tableName: string
  ): Promise<ConstraintInfo[]> {
    const client = await this.connect({ ...connection, database: databaseName });
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
        [schemaName, tableName]
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
    columnName: string
  ): Promise<ColumnInfo | undefined> {
    const columns = await this.listTableColumnsDetailed(connection, databaseName, schemaName, tableName);
    return columns.find((column) => column.name === columnName);
  }

  public async getConstraintDetails(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    constraintName: string
  ): Promise<ConstraintInfo | undefined> {
    const constraints = await this.listTableConstraints(connection, databaseName, schemaName, tableName);
    return constraints.find((constraint) => constraint.name === constraintName);
  }

  public async updateColumnProperties(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    columnName: string,
    payload: { isNullable: boolean; defaultValue: string }
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: databaseName });
    const tableSql = `${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}`;
    const columnSql = this.quoteIdentifier(columnName);

    try {
      await client.query('BEGIN');

      if (payload.isNullable) {
        await client.query(`ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} DROP NOT NULL`);
      } else {
        await client.query(`ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} SET NOT NULL`);
      }

      const trimmedDefault = payload.defaultValue.trim();
      if (!trimmedDefault) {
        await client.query(`ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} DROP DEFAULT`);
      } else {
        await client.query(`ALTER TABLE ${tableSql} ALTER COLUMN ${columnSql} SET DEFAULT ${trimmedDefault}`);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }

  public async listTableEstimatedCounts(
    connection: PostgresConnection,
    databaseName: string,
    schemaName: string
  ): Promise<TableEstimatedCount[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{ table_name: string; row_count: number }>(
        `SELECT
           t.table_name,
           COALESCE(
             NULLIF(GREATEST(0, COALESCE(s.n_live_tup::bigint, c.reltuples::bigint, 0)), 0),
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
         LEFT JOIN pg_namespace n
           ON n.nspname = t.table_schema
         LEFT JOIN pg_class c
           ON c.relnamespace = n.oid
          AND c.relname = t.table_name
          AND c.relkind IN ('r', 'p')
         LEFT JOIN pg_stat_user_tables s
           ON s.schemaname = t.table_schema
          AND s.relname = t.table_name
         WHERE t.table_schema = $1
           AND t.table_type = 'BASE TABLE'
         ORDER BY t.table_name`,
        [schemaName]
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
    schemaName: string
  ): Promise<SchemaObjectCounts> {
    const client = await this.connect({ ...connection, database: databaseName });
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
        [schemaName]
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
    tableName: string
  ): Promise<TableColumnMeta[]> {
    const client = await this.connect({ ...connection, database: databaseName });
    try {
      const result = await client.query<{
        name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
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
        [schemaName, tableName]
      );

      return result.rows.map((row) => ({
        name: row.name,
        dataType: row.data_type,
        isNullable: row.is_nullable === 'YES',
        hasDefault: row.column_default !== null,
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
    queryInput: TableDataQuery
  ): Promise<TableDataResult> {
    const columns = await this.getTableColumns(connection, databaseName, schemaName, tableName);
    const columnNames = columns.map((column) => column.name);
    const validColumns = new Set(columnNames);

    const safeLimit = Math.max(1, Math.min(500, Math.trunc(queryInput.limit || 100)));
    const safePage = Math.max(1, Math.trunc(queryInput.page || 1));
    const safeOffset = (safePage - 1) * safeLimit;
    const params: unknown[] = [];
    const whereParts: string[] = [];

    for (const [columnName, filterValueRaw] of Object.entries(queryInput.columnFilters)) {
      if (!validColumns.has(columnName)) {
        continue;
      }

      const filterValue = filterValueRaw.trim();
      if (!filterValue) {
        continue;
      }

      params.push(`%${filterValue}%`);
      whereParts.push(`${this.quoteIdentifier(columnName)}::text ILIKE $${params.length}`);
    }

    if (queryInput.searchMode === 'query') {
      const searchText = queryInput.searchText.trim();
      if (searchText && columnNames.length > 0) {
        params.push(`%${searchText}%`);
        const searchParamIndex = params.length;
        const globalSearch = columnNames
          .map((columnName) => `CAST(${this.quoteIdentifier(columnName)} AS TEXT) ILIKE $${searchParamIndex}`)
          .join(' OR ');
        whereParts.push(`(${globalSearch})`);
      }
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const baseColumns = columnNames.map((name) => this.quoteIdentifier(name)).join(', ');
    const selectColumns =
      baseColumns.length > 0
        ? `ctid::text AS "__dbadmin_ctid", ${baseColumns}`
        : `ctid::text AS "__dbadmin_ctid"`;

    let orderClause = '';
    if (queryInput.sortColumn && validColumns.has(queryInput.sortColumn)) {
      const direction = queryInput.sortDirection === 'desc' ? 'DESC' : 'ASC';
      orderClause = `ORDER BY ${this.quoteIdentifier(queryInput.sortColumn)} ${direction}`;
    }

    const countSql = `SELECT COUNT(*)::int AS total
FROM ${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}
${whereClause}`.trim();

    const countResult = await this.runCountQuery(connection, databaseName, countSql, params);

    const dataParams = [...params, safeLimit, safeOffset];
    const limitPlaceholder = `$${dataParams.length - 1}`;
    const offsetPlaceholder = `$${dataParams.length}`;

    const sql = `SELECT ${selectColumns}
FROM ${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}
${whereClause}
${orderClause}
LIMIT ${limitPlaceholder}
OFFSET ${offsetPlaceholder}`.trim();

    const rows = await this.runTableDataQuery(connection, databaseName, sql, dataParams);

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
    payload: TableSavePayload
  ): Promise<void> {
    const client = await this.connect({ ...connection, database: databaseName });

    try {
      const columns = await this.getTableColumns(connection, databaseName, schemaName, tableName);
      const validColumns = new Set(columns.map((column) => column.name));
      const columnsByName = new Map(columns.map((column) => [column.name, column]));
      const qualifiedTable = `${this.quoteIdentifier(schemaName)}.${this.quoteIdentifier(tableName)}`;
      const deleteSet = new Set((payload.deletes ?? []).filter(Boolean));

      await client.query('BEGIN');

      for (const ctid of deleteSet) {
        await client.query(`DELETE FROM ${qualifiedTable} WHERE ctid::text = $1`, [ctid]);
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

          if (value === '__DBADMIN_DEFAULT__') {
            assignments.push(`${quotedColumn} = DEFAULT`);
          } else {
            const normalizedValue = this.normalizeValueForColumn(value, columnMeta);
            params.push(normalizedValue);
            const placeholder = `$${params.length}`;
            assignments.push(`${quotedColumn} = ${this.castValuePlaceholder(placeholder, columnMeta)}`);
          }
        }

        if (assignments.length === 0) {
          continue;
        }

        params.push(update.ctid);
        const ctidParam = `$${params.length}`;

        const sql = `UPDATE ${qualifiedTable}
SET ${assignments.join(', ')}
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

          if (value === '__DBADMIN_DEFAULT__') {
            insertValuesSql.push('DEFAULT');
          } else {
            const normalizedValue = this.normalizeValueForColumn(value, columnMeta);
            params.push(normalizedValue);
            const placeholder = `$${params.length}`;
            insertValuesSql.push(this.castValuePlaceholder(placeholder, columnMeta));
          }
        }

        if (insertColumns.length === 0) {
          await client.query(`INSERT INTO ${qualifiedTable} DEFAULT VALUES`);
          continue;
        }

        const sql = `INSERT INTO ${qualifiedTable} (${insertColumns.join(', ')})
VALUES (${insertValuesSql.join(', ')})`;

        await client.query(sql, params);
      }

      await client.query('COMMIT');
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }

  private async runTableDataQuery(
    connection: PostgresConnection,
    databaseName: string,
    sql: string,
    params: unknown[]
  ): Promise<Array<Record<string, unknown>>> {
    const client = await this.connect({ ...connection, database: databaseName });
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
    params: unknown[]
  ): Promise<number> {
    const client = await this.connect({ ...connection, database: databaseName });
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

  private castValuePlaceholder(placeholder: string, column: TableColumnMeta): string {
    const dataType = column.dataType.toLowerCase();
    if (dataType === 'json' || dataType === 'jsonb') {
      return `${placeholder}::${dataType}`;
    }

    return placeholder;
  }

  private normalizeValueForColumn(value: unknown, column: TableColumnMeta): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    const dataType = column.dataType.toLowerCase();
    if (dataType !== 'json' && dataType !== 'jsonb') {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error(
          `Valor invalido para a coluna "${column.name}" (${column.dataType}). Informe um JSON valido.`
        );
      }
    }

    return value;
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
