#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConnectionStore } from "../connectionStore";
import { initMcpLocale, mcpT } from "../i18n/mcpLocale";
import { PostgresService } from "../postgresService";
import { loadMcpRuntimeConfig } from "./config";
import { registerDbAdminTools } from "./tools";

async function main(): Promise<void> {
  initMcpLocale();
  const config = await loadMcpRuntimeConfig();
  const store = new ConnectionStore(config.storageRoot);
  const postgres = new PostgresService();
  postgres.setStatementTimeoutMs(config.statementTimeoutMs);

  const server = new McpServer({
    name: "dbadmin",
    version: "0.0.1",
  });

  registerDbAdminTools(server, store, postgres, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  const message =
    error instanceof Error ? error.message : String(error || mcpT("error.unknown"));
  console.error(message);
  process.exit(1);
});
