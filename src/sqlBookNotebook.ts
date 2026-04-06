import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { PostgresService, SqlQueryResult } from './postgresService';
import { PostgresConnection } from './models';

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

  constructor(
    private readonly store: ConnectionStore,
    private readonly postgresService: PostgresService
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
    controller: vscode.NotebookController
  ): Promise<void> {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return;
    }

    const execution = controller.createNotebookCellExecution(cell);
    execution.start(Date.now());
    await execution.clearOutput();

    try {
      const cellText = cell.document.getText();
      const { context, sql } = parseCellContent(cellText);

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

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(formatResultHtml(result), 'text/html'),
          vscode.NotebookCellOutputItem.json(result.rows),
        ]),
      ]);

      execution.end(true, Date.now());
    } catch (error) {
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(
            error instanceof Error ? error : new Error(String(error))
          ),
        ]),
      ]);
      execution.end(false, Date.now());
    }
  }

  dispose(): void {
    this._controller.dispose();
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

function formatResultHtml(result: SqlQueryResult): string {
  if (result.rows.length === 0) {
    const msg = result.command
      ? `${result.command} — ${result.rowCount} linha(s)`
      : '(sem resultados)';
    return `<p style="margin:4px 0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);opacity:0.7">${escHtml(msg)}</p>`;
  }

  const thCells = result.columns
    .map(
      (col) =>
        `<th style="padding:3px 10px;border-bottom:1px solid var(--vscode-editorGroup-border);text-align:left;white-space:nowrap;font-weight:600;opacity:0.85">${escHtml(col)}</th>`
    )
    .join('');

  const trRows = result.rows
    .map((row) => {
      const tdCells = result.columns
        .map((col) => {
          const val = row[col];
          const display =
            val === null || val === undefined
              ? `<em style="opacity:0.4">null</em>`
              : escHtml(String(val));
          return `<td style="padding:2px 10px;border-bottom:1px solid var(--vscode-editorGroup-border);white-space:nowrap">${display}</td>`;
        })
        .join('');
      return `<tr>${tdCells}</tr>`;
    })
    .join('');

  const footer = `<p style="margin:4px 0;opacity:0.55;font-size:11px">${result.rowCount} linha(s) — ${escHtml(result.command)}</p>`;

  return `<div style="font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);overflow:auto"><table style="border-collapse:collapse;min-width:max-content"><thead><tr>${thCells}</tr></thead><tbody>${trRows}</tbody></table>${footer}</div>`;
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
