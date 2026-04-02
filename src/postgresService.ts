import { Client } from 'pg';
import { PostgresConnection } from './models';

export interface SchemaObjectCounts {
  tables: number;
  views: number;
  functions: number;
  procedures: number;
  triggers: number;
}

export class PostgresService {
  public async getVersion(connection: PostgresConnection): Promise<string> {
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

  private async connect(connection: PostgresConnection): Promise<Client> {
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
