export interface PgRestoreSqlOptions {
  filename: string;
  format: "custom" | "tar" | "directory";
  schemaName: string;
  outputFilename: string;
  sections: Array<"pre-data" | "data" | "post-data">;
  onlyData: boolean;
  onlySchema: boolean;
  includeIfExists: boolean;
  disableTriggers: boolean;
  verbose: boolean;
  listFilename?: string;
}

export function buildPgRestoreSqlArgs(
  options: PgRestoreSqlOptions,
): string[] {
  const args = [
    "--format",
    options.format,
    "--schema",
    options.schemaName,
    "--no-owner",
    "--no-privileges",
  ];

  if (options.listFilename) {
    args.push("--use-list", options.listFilename);
  }
  args.push("--file", options.outputFilename);

  if (options.sections.length > 0 && options.sections.length < 3) {
    for (const section of options.sections) {
      args.push("--section", section);
    }
  }
  if (options.onlyData) {
    args.push("--data-only");
  } else if (options.onlySchema) {
    args.push("--schema-only");
  }
  if (options.includeIfExists) {
    args.push("--if-exists");
  }
  if (options.disableTriggers) {
    args.push("--disable-triggers");
  }
  if (options.verbose) {
    args.push("--verbose");
  }

  args.push(options.filename);
  return args;
}

export function normalizePgRestoreSql(sql: string): string {
  const lines = String(sql || "").split(/\r?\n/);
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const copyHeader = line.match(
      /^\s*COPY\s+(.+?)\s+\((.*)\)\s+FROM\s+stdin;\s*$/i,
    );

    if (!copyHeader) {
      if (
        !/^\s*SET\s+transaction_timeout\s*=\s*0\s*;\s*$/i.test(line) &&
        !/^\s*\\/.test(line)
      ) {
        output.push(line);
      }
      index += 1;
      continue;
    }

    const [, tableName, columns] = copyHeader;
    index += 1;
    while (index < lines.length && lines[index].trim() !== "\\.") {
      const values = splitCopyRow(lines[index]).map(copyValueToSql);
      output.push(
        `INSERT INTO ${tableName} (${columns}) VALUES (${values.join(", ")});`,
      );
      index += 1;
    }

    if (index >= lines.length) {
      throw new Error(`Bloco COPY incompleto para ${tableName}.`);
    }
    index += 1;
  }

  const normalized = output.join("\n");
  if (/^\s*COPY\b/im.test(normalized)) {
    throw new Error("O SQL normalizado ainda contém COPY.");
  }
  if (/^\s*\\/m.test(normalized)) {
    throw new Error("O SQL normalizado ainda contém comandos do psql.");
  }
  return normalized;
}

function splitCopyRow(row: string): Array<string | null> {
  const values: Array<string | null> = [];
  let current = "";

  const pushCurrent = (): void => {
    values.push(current);
    current = "";
  };

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "\t") {
      pushCurrent();
      continue;
    }
    if (char !== "\\") {
      current += char;
      continue;
    }

    const next = row[index + 1] ?? "";
    if (next === "N" && current.length === 0) {
      values.push(null);
      index += 1;
      continue;
    }
    if (next === "t") {
      current += "\t";
      index += 1;
      continue;
    }
    if (next === "n") {
      current += "\n";
      index += 1;
      continue;
    }
    if (next === "r") {
      current += "\r";
      index += 1;
      continue;
    }
    if (next === "b") {
      current += "\b";
      index += 1;
      continue;
    }
    if (next === "f") {
      current += "\f";
      index += 1;
      continue;
    }
    if (next === "v") {
      current += "\v";
      index += 1;
      continue;
    }
    if (next === "\\") {
      current += "\\";
      index += 1;
      continue;
    }
    if (next === "x") {
      current += "\\x";
      index += 1;
      continue;
    }

    const octal = row.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      current += String.fromCharCode(parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    current += next;
    index += 1;
  }

  pushCurrent();
  return values;
}

function copyValueToSql(value: string | null): string {
  if (value === null) {
    return "NULL";
  }

  if (/[\u0000-\u001f\\]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "''")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `E'${escaped}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}
