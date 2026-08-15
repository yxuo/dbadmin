import * as vscode from "vscode";
import {
  DEFAULT_MCP_MAX_ROWS,
  buildMcpClientConfig,
} from "./config";
import {
  getCursorMcpJsonPath,
  upsertDbAdminInCursorMcpJson,
} from "./cursorMcpJson";

const PROVIDER_ID = "dbadmin";

export function readMcpSettings(): { allowWrites: boolean; maxRows: number } {
  const config = vscode.workspace.getConfiguration("dbadmin");
  const maxRows = Number(config.get("mcpMaxRows", DEFAULT_MCP_MAX_ROWS));
  return {
    allowWrites: Boolean(config.get("mcpAllowWrites", false)),
    maxRows: Number.isFinite(maxRows)
      ? Math.min(5000, Math.max(1, Math.floor(maxRows)))
      : DEFAULT_MCP_MAX_ROWS,
  };
}

async function syncCursorMcpJson(context: vscode.ExtensionContext): Promise<string> {
  const settings = readMcpSettings();
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  return upsertDbAdminInCursorMcpJson({
    serverJsPath: context.asAbsolutePath("out/mcp/server.js"),
    storageRoot: context.globalStorageUri.fsPath,
    allowWrites: settings.allowWrites,
    maxRows: settings.maxRows,
  });
}

/**
 * Registers the extension MCP provider so DBAdmin appears in Cursor's
 * "Configurar Ferramentas" list (same mechanism as quickdb/GitKraken).
 * mcp.json alone feeds the agent (user-dbadmin) but does not populate that menu.
 */
function registerProvider(context: vscode.ExtensionContext): vscode.Disposable | undefined {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") {
    return undefined;
  }

  try {
    const didChange = new vscode.EventEmitter<void>();
    const serverJsPath = context.asAbsolutePath("out/mcp/server.js");

    const provider = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: () => {
        const settings = readMcpSettings();
        const definition = new vscode.McpStdioServerDefinition(
          "DBAdmin",
          process.execPath,
          [serverJsPath],
          {
            ELECTRON_RUN_AS_NODE: "1",
            DBADMIN_STORAGE_ROOT: context.globalStorageUri.fsPath,
            DBADMIN_MCP_ALLOW_WRITES: settings.allowWrites ? "true" : "false",
            DBADMIN_MCP_MAX_ROWS: String(settings.maxRows),
          },
          `1.0.0-w${settings.allowWrites ? "1" : "0"}-r${settings.maxRows}`,
        );
        definition.cwd = vscode.Uri.file(context.extensionPath);
        return [definition];
      },
      resolveMcpServerDefinition: (server) => server,
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("dbadmin.mcpAllowWrites") ||
        event.affectsConfiguration("dbadmin.mcpMaxRows")
      ) {
        didChange.fire();
      }
    });

    return vscode.Disposable.from(provider, configListener, didChange);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[DBAdmin MCP] Provider não registrado: ${message}`);
    return undefined;
  }
}

/**
 * Dual registration (matches how quickdb actually shows in the tools menu):
 * 1) Extension MCP provider → item in "Configurar Ferramentas"
 * 2) ~/.cursor/mcp.json → agent tools (user-dbadmin) + gear opens this file
 */
export function setupDbAdminMcp(context: vscode.ExtensionContext): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  const provider = registerProvider(context);
  if (provider) {
    disposables.push(provider);
  }

  const runSync = (): void => {
    void syncCursorMcpJson(context).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DBAdmin MCP] Falha ao sincronizar mcp.json: ${message}`);
    });
  };

  runSync();

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("dbadmin.mcpAllowWrites") ||
        event.affectsConfiguration("dbadmin.mcpMaxRows")
      ) {
        runSync();
      }
    }),
  );

  return vscode.Disposable.from(...disposables);
}

export async function openDbAdminMcpJson(context?: vscode.ExtensionContext): Promise<void> {
  if (context) {
    await syncCursorMcpJson(context);
  }
  const filePath = getCursorMcpJsonPath();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

export async function copyDbAdminMcpConfig(
  context: vscode.ExtensionContext,
): Promise<void> {
  await syncCursorMcpJson(context);
  const settings = readMcpSettings();
  const snippet = buildMcpClientConfig({
    serverJsPath: context.asAbsolutePath("out/mcp/server.js"),
    storageRoot: context.globalStorageUri.fsPath,
    allowWrites: settings.allowWrites,
    maxRows: settings.maxRows,
  });
  await vscode.env.clipboard.writeText(snippet);
  await vscode.window.showInformationMessage(
    "Config MCP do DBAdmin copiada. Cole em mcp.json, claude_desktop_config.json ou use claude mcp add.",
  );
}
