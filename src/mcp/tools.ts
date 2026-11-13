import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionStore } from "../connectionStore";
import { formatMcpError, mcpT } from "../i18n/mcpLocale";
import { DbConnection, isSqliteConnection } from "../models";
import { DatabaseService } from "../engines/databaseService";
import { SqlQueryResult } from "../postgresService";
import { connectionDatabaseName } from "../connectionIdentity";
import { SQLITE_SCHEMA } from "../engines/types";
import { McpRuntimeConfig } from "./config";
import { assertSqlAllowed, truncateRows } from "./safety";

function jsonSafe(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (Buffer.isBuffer(current)) {
        return { type: "Buffer", encoding: "base64", data: current.toString("base64") };
      }
      return current;
    },
    2,
  );
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: jsonSafe(value) }],
  };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: formatMcpError(error) }],
    isError: true as const,
  };
}

function publicConnection(connection: DbConnection) {
  if (isSqliteConnection(connection)) {
    return {
      id: connection.id,
      engine: connection.engine,
      nickname: connection.nickname,
      filePath: connection.filePath,
      readOnly: Boolean(connection.readOnly),
    };
  }
  return {
    id: connection.id,
    engine: connection.engine,
    nickname: connection.nickname,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ssl: connection.ssl,
    visibleDatabases: connection.visibleDatabases,
  };
}

async function resolveConnection(
  store: ConnectionStore,
  input: { connectionId?: string; nickname?: string },
): Promise<DbConnection> {
  const connections = await store.listConnections();
  const connectionId = String(input.connectionId || "").trim();
  const nickname = String(input.nickname || "").trim().toLowerCase();

  if (connectionId) {
    const found = connections.find((connection) => connection.id === connectionId);
    if (!found) {
      throw new Error(mcpT("mcp.error.connectionNotFound"));
    }
    return found;
  }

  if (nickname) {
    const matches = connections.filter(
      (connection) => connection.nickname.trim().toLowerCase() === nickname,
    );
    if (matches.length === 0) {
      throw new Error(mcpT("mcp.error.connectionNotFound"));
    }
    if (matches.length > 1) {
      throw new Error(mcpT("mcp.error.multipleNicknames"));
    }
    return matches[0];
  }

  if (connections.length === 1) {
    return connections[0];
  }

  throw new Error(mcpT("mcp.error.needConnectionRef"));
}

function resolveSchema(connection: DbConnection, schema?: string): string {
  const name = String(schema || "").trim();
  if (name) {
    return name;
  }
  if (isSqliteConnection(connection)) {
    return SQLITE_SCHEMA;
  }
  throw new Error(mcpT("mcp.error.schemaRequired"));
}

function resolveDatabase(connection: DbConnection, database?: string): string {
  const name = String(database || "").trim() || connectionDatabaseName(connection);
  if (!name) {
    throw new Error(mcpT("mcp.error.databaseRequired"));
  }
  return name;
}

function summarizeQuery(result: SqlQueryResult, maxRows: number) {
  const truncated = truncateRows(result.rows, maxRows);
  const extraResults = (result.results || []).map((item) => {
    const extra = truncateRows(item.rows, maxRows);
    return {
      columns: item.columns,
      rows: extra.rows,
      rowCount: item.rowCount,
      returnedRows: extra.returnedRows,
      truncated: extra.truncated,
      command: item.command,
    };
  });

  return {
    columns: result.columns,
    rows: truncated.rows,
    rowCount: result.rowCount,
    returnedRows: truncated.returnedRows,
    truncated: truncated.truncated,
    command: result.command,
    results: extraResults,
  };
}

export function registerDbAdminTools(
  server: McpServer,
  store: ConnectionStore,
  postgres: DatabaseService,
  config: McpRuntimeConfig,
): void {
  const connectionRefShape = {
    connectionId: z.string().optional().describe(mcpT("mcp.param.connectionId")),
    nickname: z.string().optional().describe(mcpT("mcp.param.nickname")),
  };

  const databaseShape = {
    database: z.string().optional().describe(mcpT("mcp.param.database")),
  };

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  };
  const queryAnnotations = {
    readOnlyHint: !config.allowWrites,
    destructiveHint: config.allowWrites,
    openWorldHint: true,
  };

  server.registerTool(
    "list_connections",
    {
      title: mcpT("mcp.tools.list_connections.title"),
      description: mcpT("mcp.tools.list_connections.description"),
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const connections = await store.listConnections();
        return textResult({ connections: connections.map(publicConnection) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_databases",
    {
      title: mcpT("mcp.tools.list_databases.title"),
      description: mcpT("mcp.tools.list_databases.description"),
      inputSchema: connectionRefShape,
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      try {
        const connection = await resolveConnection(store, input);
        const databases = await postgres.listDatabases(connection);
        return textResult({
          connection: publicConnection(connection),
          databases,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_schemas",
    {
      title: mcpT("mcp.tools.list_schemas.title"),
      description: mcpT("mcp.tools.list_schemas.description"),
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
      },
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      try {
        const connection = await resolveConnection(store, input);
        const database = resolveDatabase(connection, input.database);
        const schemas = await postgres.listSchemas(connection, database);
        return textResult({
          connection: publicConnection(connection),
          database,
          schemas,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: mcpT("mcp.tools.list_tables.title"),
      description: mcpT("mcp.tools.list_tables.description"),
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
        schema: z.string().optional().describe(mcpT("mcp.param.schema")),
      },
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      try {
        const connection = await resolveConnection(store, input);
        const database = resolveDatabase(connection, input.database);
        const schema = resolveSchema(connection, input.schema);
        const tables = await postgres.listTables(connection, database, schema);
        return textResult({
          connection: publicConnection(connection),
          database,
          schema,
          tables,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: mcpT("mcp.tools.describe_table.title"),
      description: mcpT("mcp.tools.describe_table.description"),
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
        schema: z.string().optional().describe(mcpT("mcp.param.schema")),
        table: z.string().describe(mcpT("mcp.param.table")),
      },
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      try {
        const connection = await resolveConnection(store, input);
        const database = resolveDatabase(connection, input.database);
        const schema = resolveSchema(connection, input.schema);
        const table = String(input.table || "").trim();
        if (!table) {
          throw new Error(mcpT("mcp.error.tableRequired"));
        }
        const [columns, constraints] = await Promise.all([
          postgres.getTableColumns(connection, database, schema, table),
          postgres.listTableConstraints(connection, database, schema, table),
        ]);
        return textResult({
          connection: publicConnection(connection),
          database,
          schema,
          table,
          columns,
          constraints,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "query",
    {
      title: mcpT("mcp.tools.query.title"),
      description: config.allowWrites
        ? mcpT("mcp.tools.query.descriptionWrites")
        : mcpT("mcp.tools.query.descriptionReadonly"),
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
        sql: z.string().describe(mcpT("mcp.param.sql")),
      },
      annotations: queryAnnotations,
    },
    async (input) => {
      try {
        const sql = String(input.sql || "");
        assertSqlAllowed(sql, config.allowWrites);
        const connection = await resolveConnection(store, input);
        const database = resolveDatabase(connection, input.database);
        const result = await postgres.querySql(connection, database, sql);
        return textResult({
          connection: publicConnection(connection),
          database,
          ...summarizeQuery(result, config.maxRows),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
