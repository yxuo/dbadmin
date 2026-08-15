import { mcpT } from "../i18n/mcpLocale";

const READ_ONLY_START = /^(WITH|SELECT|EXPLAIN|SHOW|VALUES|TABLE)\b/i;

export function stripSqlComments(sql: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        result += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        result += ch;
      }
      continue;
    }

    if (!inSingle && !inDouble && ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        result += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (inSingle) {
      result += ch;
      if (ch === "'" && next === "'") {
        result += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      result += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      result += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      result += ch;
      continue;
    }

    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
      }
      result += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      result += " ";
      continue;
    }

    result += ch;
  }

  return result;
}

export function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (!inSingle && !inDouble && ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        current += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      current += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}

export function assertSqlAllowed(sql: string, allowWrites: boolean): void {
  const trimmed = String(sql || "").trim();
  if (!trimmed) {
    throw new Error(mcpT("mcp.error.emptySql"));
  }

  const statements = splitSqlStatements(stripSqlComments(trimmed));
  if (statements.length === 0) {
    throw new Error(mcpT("mcp.error.emptySql"));
  }

  if (!allowWrites && statements.length > 1) {
    throw new Error(mcpT("mcp.error.multiStatementReadonly"));
  }

  if (allowWrites) {
    return;
  }

  for (const statement of statements) {
    const start = statement.replace(/^\(+/, "").trim();
    if (!READ_ONLY_START.test(start)) {
      throw new Error(mcpT("mcp.error.readonlyOnly"));
    }
  }
}

export function truncateRows<T>(rows: T[], maxRows: number): {
  rows: T[];
  returnedRows: number;
  truncated: boolean;
} {
  const limited = rows.slice(0, maxRows);
  return {
    rows: limited,
    returnedRows: limited.length,
    truncated: rows.length > maxRows,
  };
}
