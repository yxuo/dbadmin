import * as vscode from "vscode";

const ACTIVE_PREFIX = "-- Active:";
const LEGACY_RUNNER_MARKER = "-- DBADMIN-SQL-RUNNER";

export interface SqlBodyLocation {
  sql: string;
  start: number;
}

export interface SqlQueryErrorTarget {
  document: vscode.TextDocument;
  executedSql: string;
  executedSqlDocumentStart: number;
  documentOffset: number;
}

export function getSqlBodyLocation(
  text: string,
  skipLine: (trimmedLine: string) => boolean = isSqlHeaderLine,
): SqlBodyLocation {
  const lfText = String(text || "").replace(/\r\n/g, "\n");
  const lines = lfText.split("\n");
  let lfOffset = 0;
  const kept: Array<{ line: string; offset: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!skipLine(line.trim())) {
      kept.push({ line, offset: lfOffset });
    }
    lfOffset += line.length + (i < lines.length - 1 ? 1 : 0);
  }

  const joined = kept.map((item) => item.line).join("\n");
  const leadingWs = joined.length - joined.trimStart().length;
  const sql = joined.trim();
  const lfStart = (kept[0]?.offset ?? 0) + leadingWs;
  return {
    sql,
    start: lfOffsetToDocumentOffset(text, lfStart),
  };
}

export function isSqlHeaderLine(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith(ACTIVE_PREFIX) ||
    trimmedLine === LEGACY_RUNNER_MARKER
  );
}

export function isSqlActiveHeaderLine(trimmedLine: string): boolean {
  return trimmedLine.startsWith(ACTIVE_PREFIX);
}

export class SqlDiagnostics implements vscode.Disposable {
  private readonly highlightType: vscode.TextEditorDecorationType;
  private readonly messageType: vscode.TextEditorDecorationType;
  private readonly highlights = new Map<string, vscode.DecorationOptions[]>();
  private readonly messages = new Map<string, vscode.DecorationOptions[]>();
  private readonly visibleSub: vscode.Disposable;

  public constructor(context: vscode.ExtensionContext) {
    const gutterIconPath = vscode.Uri.file(
      context.asAbsolutePath("resources/icons/sql-error.svg"),
    );
    this.highlightType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
      gutterIconPath,
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("errorForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: false,
    });
    this.messageType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 1.6em",
        color: new vscode.ThemeColor("errorForeground"),
      },
    });
    this.visibleSub = vscode.window.onDidChangeVisibleTextEditors(() => {
      this.refreshEditors();
    });
  }

  public clear(uri: vscode.Uri): void {
    const key = uri.toString();
    this.highlights.delete(key);
    this.messages.delete(key);
    this.refreshEditors(uri);
  }

  public show(target: SqlQueryErrorTarget, error: unknown): void {
    const message = getSqlDriverMessage(error);
    const range = mapQueryErrorRange(target, error);
    const line = target.document.lineAt(range.start.line);
    const key = target.document.uri.toString();

    this.highlights.set(key, [{ range }]);
    this.messages.set(key, [
      {
        range: new vscode.Range(line.range.end, line.range.end),
        renderOptions: {
          after: {
            contentText: message.replace(/\s+/g, " ").trim(),
          },
        },
      },
    ]);
    this.refreshEditors(target.document.uri);
  }

  public dispose(): void {
    this.highlightType.dispose();
    this.messageType.dispose();
    this.visibleSub.dispose();
    this.highlights.clear();
    this.messages.clear();
  }

  private refreshEditors(uri?: vscode.Uri): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (uri && editor.document.uri.toString() !== uri.toString()) {
        continue;
      }
      const key = editor.document.uri.toString();
      editor.setDecorations(this.highlightType, this.highlights.get(key) ?? []);
      editor.setDecorations(this.messageType, this.messages.get(key) ?? []);
    }
  }
}

export function getSqlDriverMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { message?: unknown };
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message.trim();
    }
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "SQL error";
}

function mapQueryErrorRange(
  target: SqlQueryErrorTarget,
  error: unknown,
): vscode.Range {
  const document = target.document;
  const pgPosition = getPgPosition(error);
  const sourceStart = Math.max(0, target.documentOffset);
  let documentOffset = sourceStart;

  if (pgPosition !== undefined) {
    const executedIndex = pgPosition - 1;
    if (executedIndex <= target.executedSqlDocumentStart) {
      documentOffset = sourceStart;
    } else {
      documentOffset =
        sourceStart + (executedIndex - target.executedSqlDocumentStart);
    }
  }

  documentOffset = Math.max(
    0,
    Math.min(documentOffset, Math.max(0, document.getText().length - 1)),
  );
  const start = document.positionAt(documentOffset);
  const end = extendToTokenEnd(document, start);
  return new vscode.Range(start, end);
}

function extendToTokenEnd(
  document: vscode.TextDocument,
  start: vscode.Position,
): vscode.Position {
  const line = document.lineAt(start.line);
  const text = line.text;
  let index = start.character;
  if (index >= text.length) {
    return line.range.end;
  }

  const first = text[index];
  if (first === "'" || first === '"' || first === "`") {
    return line.range.end;
  }

  while (index < text.length && !/\s/.test(text[index])) {
    index += 1;
  }
  return new vscode.Position(start.line, index);
}

function getPgPosition(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const raw = (error as { position?: unknown }).position;
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(numeric) || numeric < 1) {
    return undefined;
  }
  return Math.trunc(numeric);
}

function lfOffsetToDocumentOffset(text: string, lfOffset: number): number {
  if (!text.includes("\r\n")) {
    return Math.max(0, Math.min(lfOffset, text.length));
  }

  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (lf === lfOffset) {
      return i;
    }
    if (text[i] === "\r" && text[i + 1] === "\n") {
      lf += 1;
      i += 1;
    } else {
      lf += 1;
    }
  }
  return text.length;
}
