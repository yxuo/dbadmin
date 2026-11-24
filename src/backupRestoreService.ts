import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Client } from "pg";
import { t } from "./i18n";
import { PostgresConnection } from "./models";
import {
  BackupOptions as PgAdminBackupOptions,
  RestoreOptions as PgAdminRestoreOptions,
  listRoles,
  runDump,
  runRestore,
  runRestoreCompatible,
  runRestoreToSql,
  listRestoreToc,
} from "./pgAdminService";
import {
  applyIgnoredDbeaverDataEntries,
  classifyDbeaverBackup,
  DbeaverBackupFormat,
} from "./dbeaverBackupService";

export { listRoles };

export async function analyzeDbeaverData(
  schemaName: string,
  options: DbeaverRestoreOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const detected = await classifyDbeaverBackup(options.filename);
  let filename = options.filename;
  let temporaryFilename: string | undefined;

  try {
    if (detected.format !== "plain") {
      temporaryFilename = path.join(
        os.tmpdir(),
        `dbadmin-dbeaver-analysis-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`,
      );
      onLine("[DBeaver] Extraindo somente os dados para contar registros...");
      await runRestoreToSql(
        schemaName,
        {
          filename: options.filename,
          format: detected.format as "custom" | "tar" | "directory",
          mode: "pgadmin",
          jobs: 1,
          roleName: options.roleName,
          onlyData: true,
          onlySchema: false,
          sections: ["data"],
          includeCreateDatabase: false,
          includeIfExists: false,
          cleanBeforeRestore: false,
          singleTransaction: false,
          enableRowSecurity: false,
          noDataForFailedTables: false,
          disableTriggers: false,
          useSetSessionAuthorization: false,
          exitOnError: false,
          dropSchema: false,
          noPrivileges: options.noPrivileges,
          noOwner: options.noOwner,
          verbose: false,
        },
        temporaryFilename,
        onLine,
        signal,
      );
      filename = temporaryFilename;
    }

    const sql = await fs.readFile(filename, "utf8");
    const counts: Record<string, number> = {};
    let copyTable: string | undefined;
    for (const line of sql.split(/\r?\n/)) {
      if (copyTable) {
        if (line.trim() === "\\.") {
          copyTable = undefined;
        } else {
          const key = copyTable.toLowerCase();
          counts[key] = (counts[key] ?? 0) + 1;
        }
        continue;
      }
      const copyMatch = line.match(
        /^\s*COPY\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\.(?:"[^"]+"|[a-zA-Z_][\w$]*))?)\s*(?:\([^)]*\))?\s+FROM\s+stdin\s*;/i,
      );
      if (copyMatch) {
        copyTable = copyMatch[1];
        continue;
      }
      const match = line.match(/^\s*INSERT\s+INTO\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\.(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/i);
      if (match) {
        const tableName = match[1];
        const key = tableName.toLowerCase();
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  } finally {
    if (temporaryFilename) {
      await fs.rm(temporaryFilename, { force: true });
    }
  }
}

export type BackupProviderMode = "pgadmin" | "dbadmin";
export type RestoreProviderMode = "pgadmin" | "dbadmin" | "dbeaver";

export type BackupOptions =
  | (PgAdminBackupOptions & { mode?: "pgadmin" })
  | DbAdminBackupOptions;

export type RestoreOptions =
  | (PgAdminRestoreOptions & { mode?: "pgadmin" })
  | DbAdminRestoreOptions
  | DbeaverRestoreOptions;

export interface DbAdminBackupOptions {
  mode: "dbadmin";
  filename: string;
  includeData: boolean;
  /** Nomes de tabela (sem schema) sem exportar linhas; o dump ainda inclui DDL da tabela. */
  excludeDataTables: string[];
  roleName: string;
  lockWaitTimeout: number;
  verbose: boolean;
}

export interface DbAdminRestoreOptions {
  mode: "dbadmin";
  filename: string;
  roleName: string;
  cleanBeforeRestore: boolean;
  clearTablesBeforeRestore: boolean;
  verbose: boolean;
}

export interface DbeaverRestoreOptions {
  mode: "dbeaver";
  filename: string;
  format: "auto" | Exclude<DbeaverBackupFormat, "unknown">;
  jobs: number;
  roleName: string;
  sections: Array<"pre-data" | "data" | "post-data">;
  onlyData: boolean;
  onlySchema: boolean;
  includeIfExists: boolean;
  cleanBeforeRestore: boolean;
  singleTransaction: boolean;
  disableTriggers: boolean;
  noPrivileges: boolean;
  noOwner: boolean;
  exitOnError: boolean;
  verbose: boolean;
  ignoredDataIds?: string[];
}

export interface DbeaverConversionOptions {
  mode: "dbeaver";
  filename: string;
  outputFilename: string;
  format: "auto" | Exclude<DbeaverBackupFormat, "unknown" | "plain">;
  sections: Array<"pre-data" | "data" | "post-data">;
  onlyData: boolean;
  onlySchema: boolean;
  includeIfExists: boolean;
  disableTriggers: boolean;
  verbose: boolean;
  ignoredDataIds?: string[];
}

export async function runBackup(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: BackupOptions,
  onLine: (line: string) => void,
): Promise<void> {
  if ((options.mode ?? "pgadmin") === "dbadmin") {
    await runDbAdminDump(
      connection,
      databaseName,
      schemaName,
      options as DbAdminBackupOptions,
      onLine,
    );
    return;
  }

  await runDump(
    connection,
    databaseName,
    schemaName,
    options as PgAdminBackupOptions,
    onLine,
  );
}

export async function runRestoreByMode(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: RestoreOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  onLine(
    `[DbAdmin] Conexão: ${connection.nickname} (${connection.host}:${connection.port}) | Banco: ${databaseName} | Schema: ${schemaName}`,
  );

  if ((options.mode ?? "pgadmin") === "dbadmin") {
    await runDbAdminRestore(
      connection,
      databaseName,
      schemaName,
      options as DbAdminRestoreOptions,
      onLine,
      signal,
    );
    return;
  }

  if ((options as DbeaverRestoreOptions).mode === "dbeaver") {
    await runDbeaverRestore(
      connection,
      databaseName,
      schemaName,
      options as DbeaverRestoreOptions,
      onLine,
      signal,
    );
    return;
  }

  await runRestoreCompatible(
    connection,
    databaseName,
    schemaName,
    options as PgAdminRestoreOptions,
    onLine,
    signal,
  );
}

export async function convertDbeaverBackupToSql(
  schemaName: string,
  options: DbeaverConversionOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const detected = await classifyDbeaverBackup(options.filename);
  if (
    detected.format === "unknown" ||
    detected.format === "plain"
  ) {
    throw new Error(
      detected.format === "plain"
        ? "O arquivo já é SQL puro; use-o diretamente ou escolha outro arquivo DBeaver."
        : detected.detail,
    );
  }
  if (options.format !== "auto" && options.format !== detected.format) {
    throw new Error(
      `O formato selecionado (${options.format}) não corresponde ao formato detectado (${detected.format}).`,
    );
  }

  onLine(`[DBeaver] ${detected.detail}`);
  onLine("[DBeaver] Gerando SQL com INSERTs compatíveis com o DBAdmin...");
  let listFilename: string | undefined;
  try {
    if (options.ignoredDataIds && options.ignoredDataIds.length > 0) {
      const toc = await listRestoreToc(options.filename);
      listFilename = path.join(
        os.tmpdir(),
        `dbadmin-dbeaver-convert-${Date.now()}-${Math.random().toString(16).slice(2)}.list`,
      );
      await fs.writeFile(
        listFilename,
        applyIgnoredDbeaverDataEntries(toc, options.ignoredDataIds),
        "utf8",
      );
      onLine(
        `[DBeaver] ${options.ignoredDataIds.length} tabela(s) sem dados serão ignoradas na conversão.`,
      );
    }

    await runRestoreToSql(
      schemaName,
      {
        filename: options.filename,
        format: detected.format,
        jobs: 1,
        roleName: "",
        sections: options.sections,
        onlyData: options.onlyData,
        onlySchema: options.onlySchema,
        includeCreateDatabase: false,
        includeIfExists: options.includeIfExists,
        cleanBeforeRestore: false,
        singleTransaction: false,
        enableRowSecurity: false,
        noDataForFailedTables: false,
        disableTriggers: options.disableTriggers,
        useSetSessionAuthorization: false,
        exitOnError: true,
        dropSchema: false,
        noPrivileges: true,
        noOwner: true,
        verbose: options.verbose,
        listFilename,
      },
      options.outputFilename,
      onLine,
      signal,
    );
  } finally {
    if (listFilename) {
      await fs.rm(listFilename, { force: true });
    }
  }

  const generated = await fs.readFile(options.outputFilename, "utf8");
  if (/^\s*COPY\b/im.test(generated)) {
    throw new Error(
      "O SQL gerado ainda contém COPY; a conversão não é segura para o executor DBAdmin.",
    );
  }
  const normalized = generated
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*SET\s+transaction_timeout\s*=\s*0\s*;\s*$/i.test(line) &&
        !/^\s*\\/.test(line),
    )
    .join("\n");
  if (/^\s*\\/m.test(normalized)) {
    throw new Error(
      "O SQL gerado ainda contém comandos de console do psql.",
    );
  }
  await fs.writeFile(options.outputFilename, normalized, "utf8");
  onLine(`[DBeaver] SQL DBAdmin gerado em ${options.outputFilename}.`);
}

async function runDbeaverRestore(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: DbeaverRestoreOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const detected = await classifyDbeaverBackup(options.filename);
  if (detected.format === "unknown") {
    throw new Error(detected.detail);
  }

  if (options.format !== "auto" && options.format !== detected.format) {
    throw new Error(
      `O formato selecionado (${options.format}) não corresponde ao formato detectado (${detected.format}).`,
    );
  }

  onLine(`[DBeaver] ${detected.detail}`);
  if (detected.format === "plain") {
    await runDbAdminRestore(
      connection,
      databaseName,
      schemaName,
      {
        mode: "dbadmin",
        filename: options.filename,
        roleName: options.roleName,
        cleanBeforeRestore: options.cleanBeforeRestore,
        clearTablesBeforeRestore: false,
        verbose: options.verbose,
      },
      onLine,
      signal,
    );
    return;
  }

  if (options.cleanBeforeRestore) {
    onLine(
      `[DBeaver] Limpando o schema "${schemaName}" antes do pg_restore...`,
    );
    await clearSchema(connection, databaseName, schemaName, onLine);
  }

  let listFilename: string | undefined;
  try {
    if (options.ignoredDataIds && options.ignoredDataIds.length > 0) {
      const toc = await listRestoreToc(options.filename);
      listFilename = path.join(
        os.tmpdir(),
        `dbadmin-dbeaver-${Date.now()}-${Math.random().toString(16).slice(2)}.list`,
      );
      await fs.writeFile(
        listFilename,
        applyIgnoredDbeaverDataEntries(toc, options.ignoredDataIds),
        "utf8",
      );
      onLine(
        `[DBeaver] ${options.ignoredDataIds.length} tabela(s) sem dados serão ignoradas.`,
      );
    }

    await runRestoreCompatible(
      connection,
      databaseName,
      schemaName,
      {
        filename: options.filename,
        format: detected.format,
        jobs: options.jobs,
        roleName: options.roleName,
        onlyData: options.onlyData,
        onlySchema: options.onlySchema,
        sections: options.sections,
        includeCreateDatabase: false,
        includeIfExists: options.includeIfExists,
        cleanBeforeRestore: false,
        singleTransaction: options.singleTransaction,
        enableRowSecurity: false,
        noDataForFailedTables: false,
        disableTriggers: options.disableTriggers,
        useSetSessionAuthorization: false,
        exitOnError: options.exitOnError,
        dropSchema: false,
        noPrivileges: options.noPrivileges,
        noOwner: options.noOwner,
        verbose: options.verbose,
        listFilename,
      },
      onLine,
      signal,
    );
  } finally {
    if (listFilename) {
      await fs.rm(listFilename, { force: true });
    }
  }
}

export async function clearSchema(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  onLine: (line: string) => void,
): Promise<void> {
  const client = await connectClient(connection, databaseName);
  try {
    onLine(`[DbAdmin] Limpando schema "${schemaName}" (DROP + CREATE)...`);
    await client.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
    );
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    onLine(`[DbAdmin] Schema "${schemaName}" limpo com sucesso.`);
  } finally {
    await client.end();
  }
}

export async function truncateInsertTablesFromScript(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  filename: string,
  onLine: (line: string) => void,
): Promise<void> {
  onLine(`[DbAdmin] Lendo script para detectar tabelas com INSERT...`);

  const script = await fs.readFile(filename, "utf8");
  const statements = splitSqlStatements(script);
  const tableList = getInsertTargetTables(statements, schemaName);

  if (tableList.length === 0) {
    onLine("[DbAdmin] Nenhuma tabela com INSERT encontrada no script.");
    return;
  }

  const client = await connectClient(connection, databaseName);
  try {
    await truncateTables(client, tableList, onLine);
  } finally {
    await client.end();
  }
}

async function runDbAdminDump(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: DbAdminBackupOptions,
  onLine: (line: string) => void,
): Promise<void> {
  onLine("[DbAdmin] Gerando SQL puro do schema sem pg_dump...");
  const script = await buildDbAdminDumpScript(
    connection,
    databaseName,
    schemaName,
    options,
    onLine,
  );
  await fs.writeFile(options.filename, script, "utf8");
  onLine(`[DbAdmin] Arquivo SQL gerado em ${options.filename}.`);
}

async function runDbAdminRestore(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: DbAdminRestoreOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const script = await fs.readFile(options.filename, "utf8");
  if (!script.trim()) {
    throw new Error(t("Empty SQL file."));
  }

  const statements = splitSqlStatements(script);
  const lineCount = script.split(/\r?\n/).length;

  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: databaseName,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  const abortListener = (): void => {
    forceTerminateClient(client);
  };
  signal?.addEventListener("abort", abortListener);
  const rollbackAllOnError = true;

  try {
    onLine(
      `[DbAdmin] Iniciando restore SQL para schema "${schemaName}" (transação única).`,
    );
    onLine(
      `[DbAdmin] Arquivo: ${options.filename} | ~${lineCount} linha(s) | ${script.length} caractere(s).`,
    );

    if (options.roleName.trim()) {
      await client.query(
        `SET ROLE ${quoteIdentifier(options.roleName.trim())}`,
      );
    }

    await client.query("BEGIN");
    throwIfAborted(signal);

    if (options.cleanBeforeRestore) {
      onLine(`[DbAdmin] Limpando schema "${schemaName}" antes do restore...`);
      await client.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
      );
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    }

    if (options.clearTablesBeforeRestore) {
      if (options.cleanBeforeRestore) {
        onLine(
          '[DbAdmin] "Limpar tabelas antes do restore" ignorado: o schema ja sera recriado.',
        );
      } else {
        const tableList = getInsertTargetTables(statements, schemaName);
        await truncateTables(client, tableList, onLine);
      }
    }

    onLine("[DbAdmin] Executando script completo no servidor...");
    if (options.verbose) {
      onLine(
        `[DbAdmin] Verbose: ${statements.length} comando(s) após divisão de statements.`,
      );
    }

    await client.query(script);

    await client.query("COMMIT");

    onLine(t("[DbAdmin] SQL restore completed."));
  } catch (error) {
    const aborted = isAbortError(error) || signal?.aborted;

    if (rollbackAllOnError) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors and rethrow original error.
      }
    }

    if (aborted) {
      onLine(t("[DbAdmin] Restore aborted by user."));
      throw createAbortError();
    }

    logDbAdminRestoreError(error, onLine);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortListener);
    await client.end();
  }
}

function logDbAdminRestoreError(
  error: unknown,
  onLine: (line: string) => void,
): void {
  if (error === null || error === undefined) {
    return;
  }
  const err = error as {
    message?: string;
    detail?: string;
    hint?: string;
    position?: string;
    code?: string;
  };
  const parts: string[] = [];
  if (typeof err.message === "string" && err.message) {
    parts.push(err.message);
  }
  if (typeof err.detail === "string" && err.detail) {
    parts.push(`detalhe: ${err.detail}`);
  }
  if (typeof err.hint === "string" && err.hint) {
    parts.push(`dica: ${err.hint}`);
  }
  if (typeof err.position === "string" && err.position) {
    parts.push(`posição: ${err.position}`);
  }
  if (typeof err.code === "string" && err.code) {
    parts.push(`código: ${err.code}`);
  }
  const text = parts.length > 0 ? parts.join(" | ") : String(error);
  onLine(`[DbAdmin] Erro: ${text}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function forceTerminateClient(client: Client): void {
  try {
    const stream = (
      client as unknown as {
        connection?: { stream?: { destroy: (err?: Error) => void } };
      }
    ).connection?.stream;
    if (stream) {
      stream.destroy(createAbortError());
    }
  } catch {
    // Best effort cancellation.
  }
}

function getInsertTargetTables(
  statements: string[],
  schemaName: string,
): string[] {
  const tables = new Set<string>();
  for (const rawSql of statements) {
    const sql = normalizeExecutableSql(rawSql);
    if (!sql) {
      continue;
    }

    const group = classifyParallelGroup(sql, schemaName);
    if (group?.startsWith("insert:")) {
      tables.add(group.slice("insert:".length)); // "schema.table"
    }
  }

  return [...tables];
}

async function truncateTables(
  client: Client,
  tableList: string[],
  onLine: (line: string) => void,
): Promise<void> {
  if (tableList.length === 0) {
    onLine("[DbAdmin] Nenhuma tabela com INSERT encontrada no script.");
    return;
  }

  onLine(
    `[DbAdmin] ${tableList.length} tabela(s) detectada(s): ${tableList.join(", ")}`,
  );
  const truncateList = tableList
    .map((key) => {
      const dotIndex = key.indexOf(".");
      const schema = key.slice(0, dotIndex);
      const table = key.slice(dotIndex + 1);
      return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    })
    .join(", ");

  onLine("[DbAdmin] Executando TRUNCATE CASCADE...");
  await client.query(`TRUNCATE TABLE ${truncateList} CASCADE`);
  onLine("[DbAdmin] Tabelas esvaziadas com sucesso.");
}

function normalizeExecutableSql(sql: string): string {
  let text = String(sql || "").trim();
  if (!text) {
    return "";
  }

  while (true) {
    const before = text;
    text = text.replace(/^\s*--[^\n]*(\n|$)/, "");
    text = text.replace(/^\s*\/\*[\s\S]*?\*\//, "");
    text = text.trim();
    if (text === before) {
      break;
    }
  }

  return text;
}

function createAbortError(): Error {
  const error = new Error(
    t("Restore aborted by user. Rollback applied."),
  );
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function classifyParallelGroup(
  sql: string,
  schemaName: string,
): string | undefined {
  const normalized = sql.trim();

  const insertMatch = normalized.match(
    /^INSERT\s+INTO\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))(?:\.)((?:"[^"]+"|[a-zA-Z_][\w$]*))/i,
  );
  if (insertMatch) {
    const schema = unquotePgIdentifier(insertMatch[1]);
    const table = unquotePgIdentifier(insertMatch[2]);
    if (schema === schemaName) {
      return `insert:${schema}.${table}`;
    }
  }

  const insertNoSchemaMatch = normalized.match(
    /^INSERT\s+INTO\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))/i,
  );
  if (insertNoSchemaMatch) {
    const table = unquotePgIdentifier(insertNoSchemaMatch[1]);
    return `insert:${schemaName}.${table}`;
  }

  const updateMatch = normalized.match(
    /^UPDATE\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))(?:\.)((?:"[^"]+"|[a-zA-Z_][\w$]*))/i,
  );
  if (updateMatch) {
    const schema = unquotePgIdentifier(updateMatch[1]);
    const table = unquotePgIdentifier(updateMatch[2]);
    if (schema === schemaName) {
      return `update:${schema}.${table}`;
    }
  }

  const updateNoSchemaMatch = normalized.match(
    /^UPDATE\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))/i,
  );
  if (updateNoSchemaMatch) {
    const table = unquotePgIdentifier(updateNoSchemaMatch[1]);
    return `update:${schemaName}.${table}`;
  }

  const deleteMatch = normalized.match(
    /^DELETE\s+FROM\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))(?:\.)((?:"[^"]+"|[a-zA-Z_][\w$]*))/i,
  );
  if (deleteMatch) {
    const schema = unquotePgIdentifier(deleteMatch[1]);
    const table = unquotePgIdentifier(deleteMatch[2]);
    if (schema === schemaName) {
      return `delete:${schema}.${table}`;
    }
  }

  const deleteNoSchemaMatch = normalized.match(
    /^DELETE\s+FROM\s+((?:"[^"]+"|[a-zA-Z_][\w$]*))/i,
  );
  if (deleteNoSchemaMatch) {
    const table = unquotePgIdentifier(deleteNoSchemaMatch[1]);
    return `delete:${schemaName}.${table}`;
  }

  return undefined;
}

function unquotePgIdentifier(identifier: string): string {
  const value = identifier.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

interface DumpTableColumn {
  name: string;
  dataType: string;
  isNotNull: boolean;
  defaultExpression: string | null;
  identityKind: "" | "a" | "d";
  generatedKind: "" | "s";
  generationExpression: string | null;
}

interface DumpTable {
  name: string;
  columns: DumpTableColumn[];
}

interface DumpSequence {
  name: string;
  dataType: string;
  startValue: string;
  incrementBy: string;
  minValue: string;
  maxValue: string;
  cacheSize: string;
  isCycled: boolean;
  ownedByTable: string | null;
  ownedByColumn: string | null;
}

interface DumpConstraint {
  tableName: string;
  constraintName: string;
  type: "p" | "u" | "f" | "c" | "x";
  definition: string;
}

interface DumpIndex {
  tableName: string;
  indexName: string;
  definition: string;
}

interface DumpRoutine {
  definition: string;
  kind: "f" | "p";
  name: string;
}

interface DumpTrigger {
  tableName: string;
  name: string;
  definition: string;
}

interface DumpView {
  name: string;
  definition: string;
}

interface TableDependency {
  tableName: string;
  dependsOn: string;
}

async function buildDbAdminDumpScript(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: DbAdminBackupOptions,
  onLine: (line: string) => void,
): Promise<string> {
  // TODO(dbadmin-backup): expand dump coverage for PostgreSQL objects not handled yet.
  // Pending items:
  // - materialized views
  // - rules
  // - row-level security policies
  // - extensions referenced by schema objects
  // - advanced DDL edge cases for sequences/identity/defaults
  const client = await connectClient(connection, databaseName);

  try {
    if (options.roleName.trim()) {
      await client.query(
        `SET ROLE ${quoteIdentifier(options.roleName.trim())}`,
      );
    }

    if (options.lockWaitTimeout > 0) {
      await client.query(
        `SET lock_timeout = '${Math.max(0, options.lockWaitTimeout)}ms'`,
      );
    }

    const [
      tables,
      sequences,
      views,
      routines,
      triggers,
      constraints,
      indexes,
      dependencies,
    ] = await Promise.all([
      getDumpTables(client, schemaName),
      getDumpSequences(client, schemaName),
      getDumpViews(client, schemaName),
      getDumpRoutines(client, schemaName),
      getDumpTriggers(client, schemaName),
      getDumpConstraints(client, schemaName),
      getDumpIndexes(client, schemaName),
      getTableDependencies(client, schemaName),
    ]);

    const identityColumns = new Set(
      tables.flatMap((table) =>
        table.columns
          .filter((column) => column.identityKind !== "")
          .map((column) => `${table.name}.${column.name}`),
      ),
    );

    const excludeDataTables = normalizeExcludedTableNames(
      options.excludeDataTables ?? [],
    );

    const scriptParts: string[] = [];
    scriptParts.push(
      buildDumpHeader(
        databaseName,
        schemaName,
        options.includeData,
        excludeDataTables,
      ),
    );
    scriptParts.push(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};`,
    );

    const explicitSequences = sequences.filter((sequence) => {
      if (!sequence.ownedByTable || !sequence.ownedByColumn) {
        return true;
      }
      return !identityColumns.has(
        `${sequence.ownedByTable}.${sequence.ownedByColumn}`,
      );
    });

    if (explicitSequences.length > 0) {
      onLine(`[DbAdmin] Gerando ${explicitSequences.length} sequence(s).`);
      scriptParts.push("\n-- Sequences");
      for (const sequence of explicitSequences) {
        scriptParts.push(buildSequenceStatement(schemaName, sequence));
      }
    }

    if (tables.length > 0) {
      onLine(`[DbAdmin] Gerando ${tables.length} tabela(s).`);
      scriptParts.push("\n-- Tables");
      for (const table of tables) {
        scriptParts.push(buildTableStatement(schemaName, table));
      }
    }

    const defaultStatements = buildDefaultStatements(schemaName, tables);
    if (defaultStatements.length > 0) {
      scriptParts.push("\n-- Column defaults");
      scriptParts.push(...defaultStatements);
    }

    const ownershipStatements = buildSequenceOwnershipStatements(
      schemaName,
      explicitSequences,
      identityColumns,
    );
    if (ownershipStatements.length > 0) {
      scriptParts.push("\n-- Sequence ownership");
      scriptParts.push(...ownershipStatements);
    }

    if (routines.length > 0) {
      onLine(`[DbAdmin] Gerando ${routines.length} rotina(s).`);
      scriptParts.push("\n-- Functions and procedures");
      for (const routine of routines) {
        scriptParts.push(ensureSqlTerminated(routine.definition.trim()));
      }
    }

    if (options.includeData) {
      const orderedTables = sortTablesByDependencies(
        tables.map((table) => table.name),
        dependencies,
      );
      scriptParts.push("\n-- Data");
      for (const tableName of orderedTables) {
        const table = tables.find((entry) => entry.name === tableName);
        if (!table) {
          continue;
        }
        if (excludeDataTables.has(table.name.toLowerCase())) {
          scriptParts.push(`-- Ignorando tabela ${table.name}`);
          onLine(
            `[DbAdmin] Ignorando dados de ${schemaName}.${table.name} (lista de exclusão).`,
          );
          continue;
        }
        onLine(`[DbAdmin] Exportando dados de ${schemaName}.${table.name}...`);
        const insertStatements = await buildInsertStatements(
          client,
          schemaName,
          table,
        );
        if (insertStatements.length > 0) {
          scriptParts.push(...insertStatements);
        }
      }

      const setValStatements = await buildSequenceSetValStatements(
        client,
        schemaName,
        sequences,
        excludeDataTables,
      );
      if (setValStatements.length > 0) {
        scriptParts.push("\n-- Sequence values");
        scriptParts.push(...setValStatements);
      }
    }

    if (views.length > 0) {
      onLine(`[DbAdmin] Gerando ${views.length} view(s).`);
      scriptParts.push("\n-- Views");
      for (const view of views) {
        scriptParts.push(
          `CREATE OR REPLACE VIEW ${quoteQualifiedName(schemaName, view.name)} AS\n${view.definition.trim()};`,
        );
      }
    }

    const nonForeignConstraints = constraints.filter(
      (constraint) => constraint.type !== "f",
    );
    const foreignConstraints = constraints.filter(
      (constraint) => constraint.type === "f",
    );

    if (nonForeignConstraints.length > 0) {
      scriptParts.push("\n-- Constraints");
      for (const constraint of nonForeignConstraints) {
        scriptParts.push(buildConstraintStatement(schemaName, constraint));
      }
    }

    if (indexes.length > 0) {
      scriptParts.push("\n-- Indexes");
      for (const index of indexes) {
        scriptParts.push(ensureSqlTerminated(index.definition));
      }
    }

    if (foreignConstraints.length > 0) {
      scriptParts.push("\n-- Foreign keys");
      for (const constraint of foreignConstraints) {
        scriptParts.push(buildConstraintStatement(schemaName, constraint));
      }
    }

    if (triggers.length > 0) {
      scriptParts.push("\n-- Triggers");
      for (const trigger of triggers) {
        scriptParts.push(ensureSqlTerminated(trigger.definition));
      }
    }

    return scriptParts.filter(Boolean).join("\n\n") + "\n";
  } finally {
    await client.end();
  }
}

function normalizeExcludedTableNames(names: string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of names) {
    const t = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (t) {
      set.add(t);
    }
  }
  return set;
}

function buildDumpHeader(
  databaseName: string,
  schemaName: string,
  includeData: boolean,
  excludeDataTables: Set<string>,
): string {
  const lines: string[] = [
    `-- Backup gerado em ${new Date().toISOString()}`,
    `-- Schema: ${schemaName}`,
    `-- Database: ${databaseName}`,
    `-- Include data: ${includeData ? "yes" : "no"}`,
  ];
  if (includeData && excludeDataTables.size > 0) {
    lines.push(
      `-- Sem dados para: ${[...excludeDataTables].sort().join(", ")}`,
    );
  }
  return lines.join("\n");
}

function buildSequenceStatement(
  schemaName: string,
  sequence: DumpSequence,
): string {
  return [
    `CREATE SEQUENCE IF NOT EXISTS ${quoteQualifiedName(schemaName, sequence.name)}`,
    `AS ${sequence.dataType}`,
    `INCREMENT BY ${sequence.incrementBy}`,
    `MINVALUE ${sequence.minValue}`,
    `MAXVALUE ${sequence.maxValue}`,
    `START WITH ${sequence.startValue}`,
    `CACHE ${sequence.cacheSize}`,
    sequence.isCycled ? "CYCLE;" : "NO CYCLE;",
  ].join("\n");
}

function buildTableStatement(schemaName: string, table: DumpTable): string {
  const columnSql = table.columns
    .map((column) => `  ${buildColumnDefinition(column)}`)
    .join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${quoteQualifiedName(schemaName, table.name)} (\n${columnSql}\n);`;
}

function buildColumnDefinition(column: DumpTableColumn): string {
  const parts = [`${quoteIdentifier(column.name)} ${column.dataType}`];

  if (column.generatedKind === "s" && column.generationExpression) {
    parts.push(`GENERATED ALWAYS AS (${column.generationExpression}) STORED`);
  } else if (column.identityKind === "a") {
    parts.push("GENERATED ALWAYS AS IDENTITY");
  } else if (column.identityKind === "d") {
    parts.push("GENERATED BY DEFAULT AS IDENTITY");
  }

  if (column.isNotNull) {
    parts.push("NOT NULL");
  }

  return parts.join(" ");
}

function buildDefaultStatements(
  schemaName: string,
  tables: DumpTable[],
): string[] {
  const statements: string[] = [];

  for (const table of tables) {
    for (const column of table.columns) {
      if (
        !column.defaultExpression ||
        column.identityKind !== "" ||
        column.generatedKind !== ""
      ) {
        continue;
      }

      statements.push(
        `ALTER TABLE ONLY ${quoteQualifiedName(schemaName, table.name)} ALTER COLUMN ${quoteIdentifier(column.name)} SET DEFAULT ${column.defaultExpression};`,
      );
    }
  }

  return statements;
}

function buildSequenceOwnershipStatements(
  schemaName: string,
  sequences: DumpSequence[],
  identityColumns: Set<string>,
): string[] {
  return sequences
    .filter((sequence) => sequence.ownedByTable && sequence.ownedByColumn)
    .filter(
      (sequence) =>
        !identityColumns.has(
          `${sequence.ownedByTable}.${sequence.ownedByColumn}`,
        ),
    )
    .map(
      (sequence) =>
        `ALTER SEQUENCE ${quoteQualifiedName(schemaName, sequence.name)} OWNED BY ${quoteQualifiedName(schemaName, sequence.ownedByTable!)}.${quoteIdentifier(sequence.ownedByColumn!)};`,
    );
}

function buildConstraintStatement(
  schemaName: string,
  constraint: DumpConstraint,
): string {
  return `ALTER TABLE ONLY ${quoteQualifiedName(schemaName, constraint.tableName)} ADD CONSTRAINT ${quoteIdentifier(constraint.constraintName)} ${constraint.definition};`;
}

function quoteQualifiedName(schemaName: string, objectName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function ensureSqlTerminated(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

async function connectClient(
  connection: PostgresConnection,
  databaseName: string,
): Promise<Client> {
  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: databaseName,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  return client;
}

async function getDumpTables(
  client: Client,
  schemaName: string,
): Promise<DumpTable[]> {
  const tablesResult = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`,
    [schemaName],
  );

  const tables: DumpTable[] = [];
  for (const row of tablesResult.rows) {
    const columnsResult = await client.query<{
      name: string;
      data_type: string;
      is_not_null: boolean;
      default_expression: string | null;
      identity_kind: "" | "a" | "d";
      generated_kind: "" | "s";
      generation_expression: string | null;
    }>(
      `SELECT
         a.attname AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS is_not_null,
         CASE
           WHEN a.attgenerated = 's' THEN NULL
           ELSE pg_get_expr(ad.adbin, ad.adrelid)
         END AS default_expression,
         a.attidentity AS identity_kind,
         a.attgenerated AS generated_kind,
         CASE
           WHEN a.attgenerated = 's' THEN pg_get_expr(ad.adbin, ad.adrelid)
           ELSE NULL
         END AS generation_expression
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad
         ON ad.adrelid = a.attrelid
        AND ad.adnum = a.attnum
       WHERE n.nspname = $1
         AND c.relname = $2
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schemaName, row.table_name],
    );

    tables.push({
      name: row.table_name,
      columns: columnsResult.rows.map((column) => ({
        name: column.name,
        dataType: column.data_type,
        isNotNull: Boolean(column.is_not_null),
        defaultExpression: column.default_expression,
        identityKind: column.identity_kind,
        generatedKind: column.generated_kind,
        generationExpression: column.generation_expression,
      })),
    });
  }

  return tables;
}

async function getDumpTable(
  client: Client,
  schemaName: string,
  tableName: string,
): Promise<DumpTable | null> {
  const tablesResult = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = $2
       AND c.relkind IN ('r', 'p')`,
    [schemaName, tableName],
  );

  if (tablesResult.rows.length === 0) {
    return null;
  }

  const columnsResult = await client.query<{
    name: string;
    data_type: string;
    is_not_null: boolean;
    default_expression: string | null;
    identity_kind: "" | "a" | "d";
    generated_kind: "" | "s";
    generation_expression: string | null;
  }>(
    `SELECT
       a.attname AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attnotnull AS is_not_null,
       CASE
         WHEN a.attgenerated = 's' THEN NULL
         ELSE pg_get_expr(ad.adbin, ad.adrelid)
       END AS default_expression,
       a.attidentity AS identity_kind,
       a.attgenerated AS generated_kind,
       CASE
         WHEN a.attgenerated = 's' THEN pg_get_expr(ad.adbin, ad.adrelid)
         ELSE NULL
       END AS generation_expression
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef ad
       ON ad.adrelid = a.attrelid
      AND ad.adnum = a.attnum
     WHERE n.nspname = $1
       AND c.relname = $2
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schemaName, tableName],
  );

  return {
    name: tableName,
    columns: columnsResult.rows.map((column) => ({
      name: column.name,
      dataType: column.data_type,
      isNotNull: Boolean(column.is_not_null),
      defaultExpression: column.default_expression,
      identityKind: column.identity_kind,
      generatedKind: column.generated_kind,
      generationExpression: column.generation_expression,
    })),
  };
}

export async function buildTableDdlScript(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  tableName: string,
): Promise<string> {
  const client = await connectClient(connection, databaseName);

  try {
    const table = await getDumpTable(client, schemaName, tableName);
    if (!table) {
      throw new Error(
        t('Table "{0}.{1}" was not found.', schemaName, tableName),
      );
    }

    const [allConstraints, allIndexes] = await Promise.all([
      getDumpConstraints(client, schemaName),
      getDumpIndexes(client, schemaName),
    ]);

    const constraints = allConstraints.filter(
      (constraint) => constraint.tableName === tableName,
    );
    const indexes = allIndexes.filter((index) => index.tableName === tableName);

    const scriptParts: string[] = [
      `-- DDL for ${quoteQualifiedName(schemaName, tableName)}`,
      buildTableStatement(schemaName, table),
    ];

    const defaultStatements = buildDefaultStatements(schemaName, [table]);
    if (defaultStatements.length > 0) {
      scriptParts.push("\n-- Column defaults");
      scriptParts.push(...defaultStatements);
    }

    const nonForeignConstraints = constraints.filter(
      (constraint) => constraint.type !== "f",
    );
    const foreignConstraints = constraints.filter(
      (constraint) => constraint.type === "f",
    );

    if (nonForeignConstraints.length > 0) {
      scriptParts.push("\n-- Constraints");
      for (const constraint of nonForeignConstraints) {
        scriptParts.push(buildConstraintStatement(schemaName, constraint));
      }
    }

    if (indexes.length > 0) {
      scriptParts.push("\n-- Indexes");
      for (const index of indexes) {
        scriptParts.push(ensureSqlTerminated(index.definition));
      }
    }

    if (foreignConstraints.length > 0) {
      scriptParts.push("\n-- Foreign keys");
      for (const constraint of foreignConstraints) {
        scriptParts.push(buildConstraintStatement(schemaName, constraint));
      }
    }

    return scriptParts.filter(Boolean).join("\n\n") + "\n";
  } finally {
    await client.end();
  }
}

async function getDumpSequences(
  client: Client,
  schemaName: string,
): Promise<DumpSequence[]> {
  const result = await client.query<{
    name: string;
    data_type: string;
    start_value: string;
    increment_by: string;
    min_value: string;
    max_value: string;
    cache_size: string;
    is_cycled: boolean;
    owned_by_table: string | null;
    owned_by_column: string | null;
  }>(
    `SELECT
       seq.relname AS name,
       pg_catalog.format_type(ps.seqtypid, NULL) AS data_type,
       ps.seqstart::text AS start_value,
       ps.seqincrement::text AS increment_by,
       ps.seqmin::text AS min_value,
       ps.seqmax::text AS max_value,
       ps.seqcache::text AS cache_size,
       ps.seqcycle AS is_cycled,
       tbl.relname AS owned_by_table,
       att.attname AS owned_by_column
     FROM pg_class seq
     JOIN pg_namespace n ON n.oid = seq.relnamespace
     JOIN pg_sequence ps ON ps.seqrelid = seq.oid
     LEFT JOIN pg_depend dep
       ON dep.objid = seq.oid
      AND dep.deptype IN ('a', 'i')
     LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid
     LEFT JOIN pg_attribute att
       ON att.attrelid = dep.refobjid
      AND att.attnum = dep.refobjsubid
     WHERE n.nspname = $1
       AND seq.relkind = 'S'
     ORDER BY seq.relname`,
    [schemaName],
  );

  return result.rows.map((row) => ({
    name: row.name,
    dataType: row.data_type,
    startValue: row.start_value,
    incrementBy: row.increment_by,
    minValue: row.min_value,
    maxValue: row.max_value,
    cacheSize: row.cache_size,
    isCycled: Boolean(row.is_cycled),
    ownedByTable: row.owned_by_table,
    ownedByColumn: row.owned_by_column,
  }));
}

async function getDumpViews(
  client: Client,
  schemaName: string,
): Promise<DumpView[]> {
  const result = await client.query<{ name: string; definition: string }>(
    `SELECT
       c.relname AS name,
       pg_get_viewdef(c.oid, true) AS definition
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relkind = 'v'
     ORDER BY c.relname`,
    [schemaName],
  );

  return result.rows.map((row) => ({
    name: row.name,
    definition: row.definition,
  }));
}

async function getDumpRoutines(
  client: Client,
  schemaName: string,
): Promise<DumpRoutine[]> {
  const result = await client.query<{
    definition: string;
    kind: "f" | "p";
    name: string;
  }>(
    `SELECT
       pg_get_functiondef(p.oid) AS definition,
       p.prokind AS kind,
       p.proname AS name
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1
       AND p.prokind IN ('f', 'p')
     ORDER BY p.prokind, p.proname, p.oid`,
    [schemaName],
  );

  return result.rows;
}

async function getDumpTriggers(
  client: Client,
  schemaName: string,
): Promise<DumpTrigger[]> {
  const result = await client.query<{
    table_name: string;
    name: string;
    definition: string;
  }>(
    `SELECT
       c.relname AS table_name,
       t.tgname AS name,
       pg_get_triggerdef(t.oid, true) AS definition
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`,
    [schemaName],
  );

  return result.rows.map((row) => ({
    tableName: row.table_name,
    name: row.name,
    definition: row.definition,
  }));
}

async function getDumpConstraints(
  client: Client,
  schemaName: string,
): Promise<DumpConstraint[]> {
  const result = await client.query<{
    table_name: string;
    constraint_name: string;
    type: "p" | "u" | "f" | "c" | "x";
    definition: string;
  }>(
    `SELECT
       rel.relname AS table_name,
       con.conname AS constraint_name,
       con.contype AS type,
       pg_get_constraintdef(con.oid, true) AS definition
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = $1
       AND con.contype IN ('p', 'u', 'f', 'c', 'x')
     ORDER BY rel.relname, con.conname`,
    [schemaName],
  );

  return result.rows.map((row) => ({
    tableName: row.table_name,
    constraintName: row.constraint_name,
    type: row.type,
    definition: row.definition,
  }));
}

async function getDumpIndexes(
  client: Client,
  schemaName: string,
): Promise<DumpIndex[]> {
  const result = await client.query<{
    table_name: string;
    index_name: string;
    definition: string;
  }>(
    `SELECT
       tbl.relname AS table_name,
       idx.relname AS index_name,
       pg_get_indexdef(idx.oid) AS definition
     FROM pg_index i
     JOIN pg_class idx ON idx.oid = i.indexrelid
     JOIN pg_class tbl ON tbl.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = tbl.relnamespace
     WHERE n.nspname = $1
       AND NOT i.indisprimary
       AND NOT EXISTS (
         SELECT 1
         FROM pg_constraint con
         WHERE con.conindid = idx.oid
       )
     ORDER BY tbl.relname, idx.relname`,
    [schemaName],
  );

  return result.rows.map((row) => ({
    tableName: row.table_name,
    indexName: row.index_name,
    definition: row.definition,
  }));
}

async function getTableDependencies(
  client: Client,
  schemaName: string,
): Promise<TableDependency[]> {
  const result = await client.query<{ table_name: string; depends_on: string }>(
    `SELECT
       child.relname AS table_name,
       parent.relname AS depends_on
     FROM pg_constraint con
     JOIN pg_class child ON child.oid = con.conrelid
     JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
     JOIN pg_class parent ON parent.oid = con.confrelid
     JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE con.contype = 'f'
       AND child_ns.nspname = $1
       AND parent_ns.nspname = $1`,
    [schemaName],
  );

  return result.rows.map((row) => ({
    tableName: row.table_name,
    dependsOn: row.depends_on,
  }));
}

function sortTablesByDependencies(
  tableNames: string[],
  dependencies: TableDependency[],
): string[] {
  const remaining = new Set(tableNames);
  const inDegree = new Map<string, number>(tableNames.map((name) => [name, 0]));
  const outgoing = new Map<string, string[]>();

  for (const dependency of dependencies) {
    if (
      !remaining.has(dependency.tableName) ||
      !remaining.has(dependency.dependsOn)
    ) {
      continue;
    }

    inDegree.set(
      dependency.tableName,
      (inDegree.get(dependency.tableName) ?? 0) + 1,
    );
    const items = outgoing.get(dependency.dependsOn) ?? [];
    items.push(dependency.tableName);
    outgoing.set(dependency.dependsOn, items);
  }

  const queue = [...tableNames]
    .filter((name) => (inDegree.get(name) ?? 0) === 0)
    .sort();
  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!remaining.has(current)) {
      continue;
    }

    remaining.delete(current);
    ordered.push(current);

    const dependents = outgoing.get(current) ?? [];
    for (const dependent of dependents) {
      const nextInDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextInDegree);
      if (nextInDegree === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  return ordered.concat([...remaining].sort());
}

async function buildInsertStatements(
  client: Client,
  schemaName: string,
  table: DumpTable,
): Promise<string[]> {
  const insertableColumns = table.columns.filter(
    (column) => column.generatedKind === "",
  );
  if (insertableColumns.length === 0) {
    return [];
  }

  const qualifiedTable = quoteQualifiedName(schemaName, table.name);
  const insertColumnsSql = insertableColumns
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  const valueExpressions = insertableColumns
    .map((column) => buildInsertValueExpression(column))
    .join(",\n         ");
  const hasIdentityAlways = insertableColumns.some(
    (column) => column.identityKind === "a",
  );
  const insertPrefix = hasIdentityAlways
    ? `INSERT INTO ${qualifiedTable} OVERRIDING SYSTEM VALUE (${insertColumnsSql}) VALUES (`
    : `INSERT INTO ${qualifiedTable} (${insertColumnsSql}) VALUES (`;

  const sql = `SELECT ${quoteLiteralText(insertPrefix)} || array_to_string(ARRAY[
         ${valueExpressions}
       ], ', ') || ');' AS statement
FROM ${qualifiedTable} row_data
ORDER BY ctid`;

  const result = await client.query<{ statement: string }>(sql);
  return result.rows.map((row) => row.statement);
}

function buildInsertValueExpression(column: DumpTableColumn): string {
  const columnSql = `row_data.${quoteIdentifier(column.name)}`;
  const typeLiteral = quoteLiteralText(`::${column.dataType}`);
  return `CASE
           WHEN ${columnSql} IS NULL THEN 'NULL'
           ELSE quote_literal(${columnSql}::text) || ${typeLiteral}
         END`;
}

async function buildSequenceSetValStatements(
  client: Client,
  schemaName: string,
  sequences: DumpSequence[],
  excludeDataTables: Set<string>,
): Promise<string[]> {
  const statements: string[] = [];

  for (const sequence of sequences) {
    if (
      sequence.ownedByTable &&
      excludeDataTables.has(sequence.ownedByTable.toLowerCase())
    ) {
      continue;
    }
    const result = await client.query<{
      last_value: string;
      is_called: boolean;
    }>(
      `SELECT last_value::text, is_called FROM ${quoteQualifiedName(schemaName, sequence.name)}`,
    );
    const row = result.rows[0];
    if (!row) {
      continue;
    }

    statements.push(
      `SELECT pg_catalog.setval(${quoteLiteralText(`${schemaName}.${sequence.name}`)}, ${row.last_value}, ${row.is_called ? "true" : "false"});`,
    );
  }

  return statements;
}

function quoteLiteralText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | undefined;

  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = i + 1 < script.length ? script[i + 1] : "";

    if (inLineComment) {
      current += char;
      if (char === "\n") {
        inLineComment = false;
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
        continue;
      }
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (!inSingle && !dollarTag && char === '"') {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (!dollarTag && char === "$") {
        const rest = script.slice(i);
        const match = rest.match(/^\$[A-Za-z0-9_]*\$/);
        if (match) {
          dollarTag = match[0];
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      } else if (dollarTag && script.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = undefined;
        continue;
      }
    }

    if (!inSingle && !inDouble && !dollarTag && char === ";") {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }

  return statements;
}
