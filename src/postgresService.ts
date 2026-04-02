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

          const quotedColumn = this.quoteIdentifier(columnName);

          if (value === '__DBADMIN_DEFAULT__') {
            assignments.push(`${quotedColumn} = DEFAULT`);
          } else {
            params.push(value);
            assignments.push(`${quotedColumn} = $${params.length}`);
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

          insertColumns.push(this.quoteIdentifier(columnName));

          if (value === '__DBADMIN_DEFAULT__') {
            insertValuesSql.push('DEFAULT');
          } else {
            params.push(value);
            insertValuesSql.push(`$${params.length}`);
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
