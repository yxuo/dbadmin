import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionStore } from "../connectionStore";
import { PostgresConnection } from "../models";
import { PostgresService, SqlQueryResult } from "../postgresService";
import { McpRuntimeConfig } from "./config";
import { assertSqlAllowed, truncateRows } from "./safety";

const connectionRefShape = {
  connectionId: z.string().optional().describe("Id da conexao salva no DBAdmin"),
  nickname: z.string().optional().describe("Apelido da conexao salva no DBAdmin"),
};

const databaseShape = {
  database: z.string().optional().describe("Banco alvo. Se omitido, usa o database padrao da conexao"),
};

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
  const message = error instanceof Error ? error.message : String(error || "Erro desconhecido");
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function publicConnection(connection: PostgresConnection) {
  return {
    id: connection.id,
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
): Promise<PostgresConnection> {
  const connections = await store.listConnections();
  const connectionId = String(input.connectionId || "").trim();
  const nickname = String(input.nickname || "").trim().toLowerCase();

  if (connectionId) {
    const found = connections.find((connection) => connection.id === connectionId);
    if (!found) {
      throw new Error("Conexao nao encontrada.");
    }
    return found;
  }

  if (nickname) {
    const matches = connections.filter(
      (connection) => connection.nickname.trim().toLowerCase() === nickname,
    );
    if (matches.length === 0) {
      throw new Error("Conexao nao encontrada.");
    }
    if (matches.length > 1) {
      throw new Error("Ha varias conexoes com esse apelido. Use connectionId.");
    }
    return matches[0];
  }

  if (connections.length === 1) {
    return connections[0];
  }

  throw new Error("Informe connectionId ou nickname.");
}

function resolveDatabase(connection: PostgresConnection, database?: string): string {
  const name = String(database || "").trim() || connection.database;
  if (!name) {
    throw new Error("Database e obrigatorio.");
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
  postgres: PostgresService,
  config: McpRuntimeConfig,
): void {
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
      title: "Listar conexoes",
      description:
        "Lista as conexoes PostgreSQL salvas no DBAdmin (sem senha). Use o id ou o nickname nas demais tools.",
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
      title: "Listar databases",
      description: "Lista os databases visiveis na conexao PostgreSQL escolhida.",
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
      title: "Listar schemas",
      description: "Lista os schemas de um database (exceto pg_catalog e information_schema).",
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
      title: "Listar tabelas",
      description: "Lista as tabelas de um schema.",
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
        schema: z.string().describe("Nome do schema"),
      },
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      try {
        const connection = await resolveConnection(store, input);
        const database = resolveDatabase(connection, input.database);
        const schema = String(input.schema || "").trim();
        if (!schema) {
          throw new Error("Schema e obrigatorio.");
        }
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
      title: "Descrever tabela",
      description: "Retorna colunas (PK/UK/FK) e constraints de uma tabela.",
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
        schema: z.string().describe("Nome do schema"),
        table: z.string().describe("Nome da tabela"),
      },
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      try {
        const connection = await resolveConnection(store, input);
        const database = resolveDatabase(connection, input.database);
        const schema = String(input.schema || "").trim();
        const table = String(input.table || "").trim();
        if (!schema) {
          throw new Error("Schema e obrigatorio.");
        }
        if (!table) {
          throw new Error("Tabela e obrigatoria.");
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
      title: "Executar SQL",
      description: config.allowWrites
        ? "Executa SQL na conexao escolhida. Escritas estao habilitadas."
        : "Executa SQL de leitura (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) na conexao escolhida.",
      inputSchema: {
        ...connectionRefShape,
        ...databaseShape,
        sql: z.string().describe("Instrucao SQL"),
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
