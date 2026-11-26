import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { loadLocaleDict, LocaleDict } from './i18n/webviewLocale';
import { DatabaseService } from './engines/databaseService';
import { SqlQueryResult } from './postgresService';
import { DbConnection, isPostgresConnection } from './models';
import { connectionDatabaseName } from './connectionIdentity';
import { getSqlBookIntegratedTableEnabled } from './sqlBookIntegratedTable';
import { getSqlBookSaveIntegratedTableEnabled } from './sqlBookSaveIntegratedTable';
import {
  SqlDiagnostics,
  getSqlBodyLocation,
  isSqlActiveHeaderLine,
} from './sqlDiagnostics';

const CELL_CODE_MARKER = '-- SQLBook: Code';
const CELL_MARKUP_MARKER = '-- SQLBook: Markup';
const CELL_OUTPUT_MARKER = '-- SQLBook: Output';

const CODE_MARKER_RE = /^-- SQLBook: Code(?:\[([^\]]+)\])?\s*$/;
const MARKUP_MARKER_RE = /^-- SQLBook: Markup\s*$/;
const OUTPUT_MARKER_RE = /^-- SQLBook: Output(?:\[([^\]]+)\])?\s*$/;
const DEFAULT_LANGUAGE = 'sql';
const ACTIVE_PREFIX = '-- Active:';
const TEXT_PLAIN_MIME = 'text/plain';
const TEXT_HTML_MIME = 'text/html';

interface CellRunnerContext {
  connectionId?: string;
  connectionHost?: string;
  connectionPort?: number;
  databaseName?: string;
  schemaName?: string;
}

export interface SqlBookExecutionResult {
  connection: DbConnection;
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
  sql?: string;
  connectionId?: string;
  connectionHost?: string;
  connectionPort?: number;
  databaseName?: string;
  schemaName?: string;
  i18n?: LocaleDict;
}

// ---------- Serializer ----------

export class SqlBookSerializer implements vscode.NotebookSerializer {
  constructor(private readonly extensionPath?: string) {}

  async deserializeNotebook(content: Uint8Array): Promise<vscode.NotebookData> {
    const text = Buffer.from(content).toString('utf8');
    const cells: vscode.NotebookCellData[] = [];
    const lines = text.split(/\r?\n/);
    let currentKind: vscode.NotebookCellKind | null = null;
    let currentLanguage: string = DEFAULT_LANGUAGE;
    let currentLines: string[] = [];
    let collectingOutput = false;
    let currentOutputMime = SQLBOOK_TABLE_MIME;
    let currentOutputLines: string[] = [];
    let pendingOutputs: vscode.NotebookCellOutput[] = [];

    const flushOutputItem = (): void => {
      if (!collectingOutput) {
        return;
      }
      const raw = currentOutputLines.join('\n').trim();
      const restored = restoreNotebookOutput(
        currentOutputMime,
        raw,
        this.extensionPath,
      );
      if (restored) {
        pendingOutputs.push(restored);
      }
      collectingOutput = false;
      currentOutputLines = [];
    };

    const flushCell = (): void => {
      flushOutputItem();
      if (currentKind === null) {
        return;
      }
      const cellContent = currentLines.join('\n').trimEnd();
      const cell = new vscode.NotebookCellData(
        currentKind,
        cellContent,
        currentKind === vscode.NotebookCellKind.Code ? currentLanguage : 'markdown',
      );
      if (
        currentKind === vscode.NotebookCellKind.Code &&
        pendingOutputs.length > 0
      ) {
        cell.outputs = pendingOutputs;
      }
      cells.push(cell);
      currentLines = [];
      pendingOutputs = [];
    };

    for (const line of lines) {
      const codeMatch = CODE_MARKER_RE.exec(line);
      if (codeMatch) {
        flushCell();
        currentKind = vscode.NotebookCellKind.Code;
        currentLanguage = codeMatch[1] ?? DEFAULT_LANGUAGE;
        collectingOutput = false;
        continue;
      }

      if (MARKUP_MARKER_RE.test(line)) {
        flushCell();
        currentKind = vscode.NotebookCellKind.Markup;
        collectingOutput = false;
        continue;
      }

      const outputMatch = OUTPUT_MARKER_RE.exec(line);
      if (outputMatch) {
        if (currentKind !== vscode.NotebookCellKind.Code) {
          continue;
        }
        flushOutputItem();
        collectingOutput = true;
        currentOutputMime = outputMatch[1]?.trim() || SQLBOOK_TABLE_MIME;
        currentOutputLines = [];
        continue;
      }

      if (collectingOutput) {
        currentOutputLines.push(line);
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
    const persistOutputs = getSqlBookSaveIntegratedTableEnabled();
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

      if (
        persistOutputs &&
        cell.kind === vscode.NotebookCellKind.Code &&
        cell.outputs
      ) {
        for (const serialized of serializeCellOutputs(cell.outputs)) {
          parts.push(`${CELL_OUTPUT_MARKER}[${serialized.mime}]`);
          parts.push(serialized.body);
        }
      }
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
    private readonly postgresService: DatabaseService,
    private readonly onResult?: (payload: SqlBookExecutionResult) => Promise<void> | void,
    private readonly extensionPath?: string,
    private readonly sqlDiagnostics?: SqlDiagnostics,
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
    sourceOffset?: number,
  ): Promise<void> {
    await this._executeCell(cell, this._controller, sql, sourceOffset);
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
    sourceOffset?: number,
  ): Promise<void> {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return;
    }

    const execution = controller.createNotebookCellExecution(cell);
    execution.start(Date.now());
    await execution.clearOutput();
    this.sqlDiagnostics?.clear(cell.document.uri);

    const cellText = cell.document.getText();
    const { context, sql: cellSql } = parseCellContent(cellText);
    const sql = String(sqlOverride || cellSql).trim();
    const body = getSqlBodyLocation(cellText, isSqlActiveHeaderLine);
    const overrideIndex = sqlOverride ? cellText.indexOf(sqlOverride) : -1;
    const documentOffset =
      sourceOffset ?? (overrideIndex >= 0 ? overrideIndex : body.start);

    try {
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

      const databaseName = context.databaseName?.trim() || connectionDatabaseName(connection);
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
              toSqlBookTablePayload(result, this.extensionPath, {
                sql,
                connection,
                databaseName,
                schemaName: context.schemaName,
              }),
              SQLBOOK_TABLE_MIME,
            ),
          ]),
        ]);
      } else {
        execution.replaceOutput([]);
      }

      execution.end(true, Date.now());
    } catch (error) {
      this.sqlDiagnostics?.show(
        {
          document: cell.document,
          executedSql: sql,
          executedSqlDocumentStart: 0,
          documentOffset,
        },
        error,
      );
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

  public async openTableResult(
    rawPayload?: Partial<SqlBookTablePayload> | null,
  ): Promise<void> {
    if (rawPayload && this.onResult) {
      const opened = await this.openPersistedTableResult(rawPayload);
      if (opened) {
        return;
      }
    }

    await this.openLastResultInPanel();
  }

  private async openPersistedTableResult(
    rawPayload: Partial<SqlBookTablePayload>,
  ): Promise<boolean> {
    if (!this.onResult) {
      return false;
    }

    const columns = Array.isArray(rawPayload.columns)
      ? rawPayload.columns.map(String)
      : [];
    const rows = Array.isArray(rawPayload.rows) ? rawPayload.rows : [];
    if (columns.length === 0 && rows.length === 0 && !rawPayload.command) {
      return false;
    }

    const allConnections = await this.store.listConnections();
    let connection = resolveConnection(allConnections, {
      connectionId: rawPayload.connectionId,
      connectionHost: rawPayload.connectionHost,
      connectionPort: rawPayload.connectionPort,
      databaseName: rawPayload.databaseName,
      schemaName: rawPayload.schemaName,
    });

    if (!connection && allConnections.length === 1) {
      connection = allConnections[0];
    }

    if (!connection) {
      return false;
    }

    await this.onResult({
      connection,
      databaseName: String(rawPayload.databaseName || connectionDatabaseName(connection)),
      schemaName: rawPayload.schemaName,
      sql: String(rawPayload.sql || ""),
      result: {
        columns,
        rows,
        rowCount: Number.isFinite(rawPayload.rowCount)
          ? Number(rawPayload.rowCount)
          : rows.length,
        command: String(rawPayload.command || ""),
      },
      source: "sqlBook",
      forceOpenPanel: true,
    });
    return true;
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
  allConnections: DbConnection[],
  context: CellRunnerContext
): DbConnection | undefined {
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
        isPostgresConnection(c) &&
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
  context?: {
    sql: string;
    connection: DbConnection;
    databaseName: string;
    schemaName?: string;
  },
): SqlBookTablePayload {
  const payload: SqlBookTablePayload = {
    columns: result.columns,
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.rowCount,
    command: result.command || "",
  };
  if (context) {
    payload.sql = context.sql;
    payload.connectionId = context.connection.id;
    if (isPostgresConnection(context.connection)) {
      payload.connectionHost = context.connection.host;
      payload.connectionPort = context.connection.port;
    }
    payload.databaseName = context.databaseName;
    payload.schemaName = context.schemaName;
  }
  if (extensionPath) {
    payload.i18n = loadLocaleDict(extensionPath);
  }
  return payload;
}

function serializeCellOutputs(
  outputs: readonly vscode.NotebookCellOutput[],
): Array<{ mime: string; body: string }> {
  const serialized: Array<{ mime: string; body: string }> = [];
  const seenPlain = new Set<string>();

  for (const output of outputs) {
    for (const item of output.items) {
      if (item.mime === TEXT_HTML_MIME) {
        continue;
      }

      const text = Buffer.from(item.data).toString("utf8");
      if (item.mime === SQLBOOK_TABLE_MIME) {
        const payload = parseJsonValue(text);
        if (!isSqlBookTablePayload(payload)) {
          continue;
        }
        serialized.push({
          mime: SQLBOOK_TABLE_MIME,
          body: JSON.stringify(toPersistedTablePayload(payload)),
        });
        continue;
      }

      if (item.mime === TEXT_PLAIN_MIME) {
        if (seenPlain.has(text)) {
          continue;
        }
        seenPlain.add(text);
        serialized.push({
          mime: TEXT_PLAIN_MIME,
          body: JSON.stringify(text),
        });
      }
    }
  }

  return serialized;
}

function restoreNotebookOutput(
  mime: string,
  raw: string,
  extensionPath?: string,
): vscode.NotebookCellOutput | undefined {
  if (!raw) {
    return undefined;
  }

  if (mime === SQLBOOK_TABLE_MIME) {
    const payload = parseJsonValue(raw);
    if (!isSqlBookTablePayload(payload)) {
      return undefined;
    }
    const withI18n = { ...payload };
    if (extensionPath) {
      withI18n.i18n = loadLocaleDict(extensionPath);
    }
    return new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.json(withI18n, SQLBOOK_TABLE_MIME),
    ]);
  }

  if (mime === TEXT_PLAIN_MIME) {
    const message = parsePersistedText(raw);
    if (!message) {
      return undefined;
    }
    return new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text(
        `<div style="font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-errorForeground);padding:4px 0;white-space:pre-wrap;">${escHtml(
          message,
        )}</div>`,
        TEXT_HTML_MIME,
      ),
      vscode.NotebookCellOutputItem.text(message, TEXT_PLAIN_MIME),
    ]);
  }

  return undefined;
}

function toPersistedTablePayload(payload: SqlBookTablePayload): SqlBookTablePayload {
  return {
    columns: payload.columns,
    rows: payload.rows,
    rowCount: payload.rowCount,
    command: payload.command,
    sql: payload.sql,
    connectionId: payload.connectionId,
    connectionHost: payload.connectionHost,
    connectionPort: payload.connectionPort,
    databaseName: payload.databaseName,
    schemaName: payload.schemaName,
  };
}

function isSqlBookTablePayload(value: unknown): value is SqlBookTablePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as SqlBookTablePayload;
  return Array.isArray(payload.columns) && Array.isArray(payload.rows);
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parsePersistedText(raw: string): string {
  const parsed = parseJsonValue(raw);
  if (typeof parsed === "string") {
    return parsed;
  }
  return raw;
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
