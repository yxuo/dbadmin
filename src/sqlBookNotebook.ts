import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { loadLocaleDict, LocaleDict } from './i18n/webviewLocale';
import { PostgresService, SqlQueryResult } from './postgresService';
import { PostgresConnection } from './models';
import { getSqlBookIntegratedTableEnabled } from './sqlBookIntegratedTable';

const CELL_CODE_MARKER = '-- SQLBook: Code';
const CELL_MARKUP_MARKER = '-- SQLBook: Markup';

const CODE_MARKER_RE = /^-- SQLBook: Code(?:\[([^\]]+)\])?\s*$/;
const MARKUP_MARKER_RE = /^-- SQLBook: Markup\s*$/;
const DEFAULT_LANGUAGE = 'sql';
const ACTIVE_PREFIX = '-- Active:';

interface CellRunnerContext {
  connectionId?: string;
  connectionHost?: string;
  connectionPort?: number;
  databaseName?: string;
  schemaName?: string;
}

export interface SqlBookExecutionResult {
  connection: PostgresConnection;
  databaseName: string;
  schemaName?: string;
  sql: string;
  result: SqlQueryResult;
  source: "sqlBook";
  integratedTableMode?: boolean;
  forceOpenPanel?: boolean;
}

export const SQLBOOK_TABLE_MIME =
  "application/vnd.dbadmin.sqlbook-table+json";

export interface SqlBookTablePayload {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  command: string;
  i18n?: LocaleDict;
}

// ---------- Serializer ----------

export class SqlBookSerializer implements vscode.NotebookSerializer {
  async deserializeNotebook(content: Uint8Array): Promise<vscode.NotebookData> {
    const text = Buffer.from(content).toString('utf8');
    const cells: vscode.NotebookCellData[] = [];
    const lines = text.split(/\r?\n/);
    let currentKind: vscode.NotebookCellKind | null = null;
    let currentLanguage: string = DEFAULT_LANGUAGE;
    let currentLines: string[] = [];

    const flushCell = (): void => {
      if (currentKind === null) {
        return;
      }
      const cellContent = currentLines.join('\n').trimEnd();
      cells.push(
        new vscode.NotebookCellData(
          currentKind,
          cellContent,
          currentKind === vscode.NotebookCellKind.Code ? currentLanguage : 'markdown'
        )
      );
      currentLines = [];
    };

    for (const line of lines) {
      const codeMatch = CODE_MARKER_RE.exec(line);
      if (codeMatch) {
        flushCell();
        currentKind = vscode.NotebookCellKind.Code;
        currentLanguage = codeMatch[1] ?? DEFAULT_LANGUAGE;
      } else if (MARKUP_MARKER_RE.test(line)) {
        flushCell();
        currentKind = vscode.NotebookCellKind.Markup;
      } else if (currentKind !== null) {
        currentLines.push(line);
      }
    }
    flushCell();

    if (cells.length === 0) {
      cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', DEFAULT_LANGUAGE));
    }

    return new vscode.NotebookData(cells);
  }

  async serializeNotebook(data: vscode.NotebookData): Promise<Uint8Array> {
    const parts: string[] = [];
    for (const cell of data.cells) {
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        parts.push(CELL_MARKUP_MARKER);
      } else {
        const lang = cell.languageId ?? DEFAULT_LANGUAGE;
        // omit the tag for the default language to keep files clean
        parts.push(lang === DEFAULT_LANGUAGE ? CELL_CODE_MARKER : `${CELL_CODE_MARKER}[${lang}]`);
      }
      parts.push(cell.value);
    }
    return Buffer.from(parts.join('\n'));
  }
}

// ---------- Controller ----------

export class SqlBookController {
  private readonly _controller: vscode.NotebookController;
  private lastExecutionResult: SqlBookExecutionResult | null = null;

  constructor(
    private readonly store: ConnectionStore,
    private readonly postgresService: PostgresService,
    private readonly onResult?: (payload: SqlBookExecutionResult) => Promise<void> | void,
    private readonly extensionPath?: string,
  ) {
    this._controller = vscode.notebooks.createNotebookController(
      'dbadmin-sqlbook',
      'sqlbook',
      'DBAdmin'
    );
    this._controller.supportsExecutionOrder = true;
    this._controller.description = 'Execute SQL via DBAdmin';
    this._controller.executeHandler = (cells, _notebook, controller) => {
      void this._executeAll(cells, controller);
    };
  }

  public async executeCellStatement(
    cell: vscode.NotebookCell,
    sql: string,
  ): Promise<void> {
    await this._executeCell(cell, this._controller, sql);
  }

  private async _executeAll(
    cells: vscode.NotebookCell[],
    controller: vscode.NotebookController
  ): Promise<void> {
    for (const cell of cells) {
      await this._executeCell(cell, controller);
    }
  }

  private async _executeCell(
    cell: vscode.NotebookCell,
    controller: vscode.NotebookController,
    sqlOverride?: string,
  ): Promise<void> {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return;
    }

    const execution = controller.createNotebookCellExecution(cell);
    execution.start(Date.now());
    await execution.clearOutput();

    try {
      const cellText = cell.document.getText();
      const { context, sql: cellSql } = parseCellContent(cellText);
      const sql = String(sqlOverride || cellSql).trim();

      if (!sql.trim()) {
        execution.end(true, Date.now());
        return;
      }

      const allConnections = await this.store.listConnections();
      let connection = resolveConnection(allConnections, context);

      if (!connection && allConnections.length === 1) {
        connection = allConnections[0];
      }

      if (!connection) {
        throw new Error(
          'Nenhuma conexão ativa. Adicione a linha abaixo no início da célula:\n' +
            '-- Active: <id>@@<host>@<port>@<database>'
        );
      }

      const databaseName = context.databaseName?.trim() || connection.database;
      const result = await this.postgresService.querySql(connection, databaseName, sql);

      const executionPayload: SqlBookExecutionResult = {
        connection,
        databaseName,
        schemaName: context.schemaName,
        sql,
        result,
        source: "sqlBook",
      };

      this.lastExecutionResult = executionPayload;

      const integratedTableMode = getSqlBookIntegratedTableEnabled();
      executionPayload.integratedTableMode = integratedTableMode;

      if (this.onResult && !integratedTableMode) {
        await this.onResult(executionPayload);
      }

      if (integratedTableMode) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              toSqlBookTablePayload(result, this.extensionPath),
              SQLBOOK_TABLE_MIME,
            ),
          ]),
        ]);
      } else {
        execution.replaceOutput([]);
      }

      execution.end(true, Date.now());
    } catch (error) {
      const friendlyMessage = formatFriendlySqlError(error);

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(
            `<div style="font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-errorForeground);padding:4px 0;white-space:pre-wrap;">${escHtml(
              friendlyMessage,
            )}</div>`,
            'text/html',
          ),
          vscode.NotebookCellOutputItem.text(friendlyMessage, 'text/plain'),
        ]),
      ]);

      console.error('[dbadmin][sqlbook] execution failed:', error);
      execution.end(false, Date.now());
    }
  }

  dispose(): void {
    this._controller.dispose();
  }

  public async openLastResultInPanel(): Promise<void> {
    if (!this.lastExecutionResult || !this.onResult) {
      return;
    }

    const payload = { ...this.lastExecutionResult, forceOpenPanel: true };
    await this.onResult(payload);
  }
}

// ---------- Helpers ----------

function parseCellContent(text: string): { context: CellRunnerContext; sql: string } {
  const lines = String(text || '').split(/\r?\n/);
  const context: CellRunnerContext = {};
  const sqlLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith(ACTIVE_PREFIX)) {
      const payload = line.slice(ACTIVE_PREFIX.length).trim();
      Object.assign(context, parseActiveContext(payload));
    } else {
      sqlLines.push(rawLine);
    }
  }

  return { context, sql: sqlLines.join('\n').trim() };
}

function parseActiveContext(value: string): CellRunnerContext {
  const raw = String(value || '').trim();
  if (!raw) {
    return {};
  }
  const parts = raw.split('@@');
  const id = parts[0];
  const rest = parts[1] || '';
  const restParts = rest.split('@');
  const [host = '', portRaw = '', database = '', schema = ''] = restParts;
  const parsedPort = Number(portRaw);
  return {
    connectionId: id.trim() || undefined,
    connectionHost: host.trim() || undefined,
    connectionPort: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined,
    databaseName: database.trim() || undefined,
    schemaName: schema.trim() || undefined,
  };
}

function resolveConnection(
  allConnections: PostgresConnection[],
  context: CellRunnerContext
): PostgresConnection | undefined {
  const byId = String(context.connectionId || '').trim();
  if (byId) {
    const found = allConnections.find((c) => c.id === byId);
    if (found) {
      return found;
    }
  }

  const byHost = String(context.connectionHost || '').trim().toLowerCase();
  if (byHost && context.connectionPort) {
    return allConnections.find(
      (c) =>
        c.host.toLowerCase() === byHost &&
        c.port === context.connectionPort &&
        (!context.databaseName || c.database === context.databaseName)
    );
  }

  return undefined;
}

function quoteIdent(identifier: string): string {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function toSqlBookTablePayload(
  result: SqlQueryResult,
  extensionPath?: string,
): SqlBookTablePayload {
  const payload: SqlBookTablePayload = {
    columns: result.columns,
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.rowCount,
    command: result.command || "",
  };
  if (extensionPath) {
    payload.i18n = loadLocaleDict(extensionPath);
  }
  return payload;
}

function formatFriendlySqlError(error: unknown): string {
  const fallback = 'Falha ao executar SQL.';

  if (!error || typeof error !== 'object') {
    if (error instanceof Error && error.message) {
      return `Erro SQL: ${error.message}`;
    }
    if (typeof error === 'string' && error.trim()) {
      return `Erro SQL: ${error.trim()}`;
    }
    return fallback;
  }

  const sqlError = error as {
    message?: unknown;
    code?: unknown;
    detail?: unknown;
    hint?: unknown;
    position?: unknown;
  };

  const baseMessage =
    typeof sqlError.message === 'string' && sqlError.message.trim()
      ? sqlError.message.trim()
      : error instanceof Error && error.message
        ? error.message
        : fallback;

  const parts = [`Erro SQL: ${baseMessage}`];

  if (typeof sqlError.code === 'string' && sqlError.code.trim()) {
    parts.push(`Código: ${sqlError.code.trim()}`);
  }

  if (typeof sqlError.detail === 'string' && sqlError.detail.trim()) {
    parts.push(`Detalhe: ${sqlError.detail.trim()}`);
  }

  if (typeof sqlError.hint === 'string' && sqlError.hint.trim()) {
    parts.push(`Dica: ${sqlError.hint.trim()}`);
  }

  if (typeof sqlError.position === 'string' && sqlError.position.trim()) {
    parts.push(`Posição aproximada: ${sqlError.position.trim()}`);
  }

  return parts.join('\n');
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
