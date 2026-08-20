import * as vscode from "vscode";
import { t } from "./i18n";
import { SqlBookController } from "./sqlBookNotebook";

export const SQLBOOK_RUN_PER_QUERY_SETTING = "dbadmin.sqlbookRunPerQuery";

function dbadminConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("dbadmin");
}

export function getSqlBookRunPerQueryEnabled(): boolean {
  return dbadminConfig().get<boolean>("sqlbookRunPerQuery", false);
}

export async function setSqlBookRunPerQueryEnabled(
  enabled: boolean,
): Promise<void> {
  await dbadminConfig().update(
    "sqlbookRunPerQuery",
    enabled,
    vscode.ConfigurationTarget.Global,
  );
}

export async function toggleSqlBookRunPerQueryEnabled(): Promise<boolean> {
  const next = !getSqlBookRunPerQueryEnabled();
  await setSqlBookRunPerQueryEnabled(next);
  return next;
}

export async function syncSqlBookRunPerQueryContext(): Promise<void> {
  const enabled = getSqlBookRunPerQueryEnabled();
  await vscode.commands.executeCommand(
    "setContext",
    "dbadmin.sqlbookRunPerQuery",
    !enabled,
  );
  await vscode.commands.executeCommand(
    "setContext",
    "dbadmin.sqlbookRunPerQuery",
    enabled,
  );
}

export interface SqlStatementSpan {
  sql: string;
  start: number;
  end: number;
}

export function findExecutableSqlStatements(text: string): SqlStatementSpan[] {
  const statements: SqlStatementSpan[] = [];
  let current = "";
  let currentStart = 0;
  let started = false;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | undefined;
  let parenDepth = 0;
  let consecutiveNewlines = 0;

  const flush = (end: number): void => {
    const sql = current.trim();
    if (sql && hasExecutableSql(sql)) {
      statements.push({
        sql,
        start: firstExecutableOffset(text, currentStart, end),
        end,
      });
    }
    current = "";
    started = false;
    consecutiveNewlines = 0;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (!started && /\s/.test(char)) {
      if (char === "\n") {
        consecutiveNewlines += 1;
      } else if (!/[ \t]/.test(char)) {
        consecutiveNewlines = 0;
      }
      continue;
    }

    if (
      started &&
      !inSingle &&
      !inDouble &&
      !inLineComment &&
      !inBlockComment &&
      !dollarTag &&
      parenDepth === 0 &&
      consecutiveNewlines >= 2 &&
      hasExecutableSql(current) &&
      looksLikeStatementStart(text, i)
    ) {
      flush(i);
    }

    if (!started && /\s/.test(char)) {
      continue;
    }

    if (!started) {
      currentStart = i;
      started = true;
    }

    if (inLineComment) {
      current += char;
      if (char === "\n") {
        inLineComment = false;
        consecutiveNewlines += 1;
      }
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += "/";
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingle && !inDouble && !dollarTag) {
      if (char === "-" && next === "-") {
        current += "--";
        i += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        current += "/*";
        i += 1;
        inBlockComment = true;
        continue;
      }
    }

    if (!inDouble && !dollarTag && char === "'") {
      if (inSingle && next === "'") {
        current += "''";
        i += 1;
        consecutiveNewlines = 0;
        continue;
      }
      inSingle = !inSingle;
      current += char;
      consecutiveNewlines = 0;
      continue;
    }

    if (!inSingle && !dollarTag && char === '"') {
      inDouble = !inDouble;
      current += char;
      consecutiveNewlines = 0;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (!dollarTag && char === "$") {
        const match = text.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
        if (match) {
          dollarTag = match[0];
          current += dollarTag;
          i += dollarTag.length - 1;
          consecutiveNewlines = 0;
          continue;
        }
      } else if (dollarTag && text.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = undefined;
        consecutiveNewlines = 0;
        continue;
      }
    }

    if (!inSingle && !inDouble && !dollarTag && !inLineComment && !inBlockComment) {
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")" && parenDepth > 0) {
        parenDepth -= 1;
      }
    }

    if (!inSingle && !inDouble && !dollarTag && char === ";") {
      flush(i);
      continue;
    }

    current += char;
    if (char === "\n") {
      consecutiveNewlines += 1;
    } else if (!/[ \t]/.test(char)) {
      consecutiveNewlines = 0;
    }
  }

  if (started) {
    flush(text.length);
  }

  return statements;
}

function hasExecutableSql(sql: string): boolean {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return withoutComments.length > 0;
}

export function createSqlBookRunPerQueryCodeLensProvider(): {
  provider: vscode.CodeLensProvider;
  refresh: () => void;
  dispose: () => void;
} {
  const onDidChange = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: onDidChange.event,
    provideCodeLenses(document): vscode.CodeLens[] {
      if (!getSqlBookRunPerQueryEnabled()) {
        return [];
      }
      if (document.languageId !== "sql") {
        return [];
      }

      const statements = findExecutableSqlStatements(document.getText());
      if (statements.length < 2) {
        return [];
      }

      const isSqlBookCell = Boolean(findSqlBookCell(document.uri));
      const command = isSqlBookCell
        ? "dbadmin.executeSqlBookStatement"
        : "dbadmin.executeSqlRunnerStatement";

      return statements.map((statement) => {
        const position = document.positionAt(statement.start);
        const range = new vscode.Range(position, position);
        return new vscode.CodeLens(range, {
          title: t("$(play) Run"),
          tooltip: t("Run"),
          command,
          arguments: [document.uri, statement.sql, statement.start],
        });
      });
    },
  };

  return {
    provider,
    refresh: () => onDidChange.fire(),
    dispose: () => onDidChange.dispose(),
  };
}

export function findSqlBookCell(
  uri: vscode.Uri,
): vscode.NotebookCell | undefined {
  const target = uri.toString();
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.notebookType !== "sqlbook") {
      continue;
    }
    const cell = notebook
      .getCells()
      .find((item) => item.document.uri.toString() === target);
    if (cell) {
      return cell;
    }
  }
  return undefined;
}

const SQL_STATEMENT_START =
  /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|ANALYZE|CALL|DO|COPY|VACUUM|COMMENT|SET|SHOW|PREPARE|EXECUTE|DEALLOCATE|MERGE|REFRESH|REINDEX|CLUSTER|LOCK|VALUES|TABLE|DECLARE|FETCH|MOVE|CLOSE|LISTEN|NOTIFY|UNLISTEN|DISCARD|RESET|LOAD|SECURITY)\b/i;

function looksLikeStatementStart(text: string, from: number): boolean {
  let i = from;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const char = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    return SQL_STATEMENT_START.test(text.slice(i));
  }

  return false;
}

function firstExecutableOffset(text: string, start: number, end: number): number {
  let i = start;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < end) {
    const char = text[i];
    const next = i + 1 < end ? text[i + 1] : "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    return i;
  }

  return start;
}

export async function executeSqlBookStatement(
  controller: SqlBookController,
  uri: vscode.Uri | string,
  sql: string,
  sourceOffset?: number,
): Promise<void> {
  const parsed = typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
  const cell = findSqlBookCell(parsed);
  if (!cell) {
    void vscode.window.showWarningMessage(
      t("Could not locate the SQL Book cell."),
    );
    return;
  }
  await controller.executeCellStatement(cell, sql, sourceOffset);
}
