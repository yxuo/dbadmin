import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "pg";
import * as vscode from "vscode";
import { PostgresConnection } from "./models";
import {
  buildPgRestoreSqlArgs,
  normalizePgRestoreSql,
} from "./dbeaverSqlConverter";

const PGADMIN_BIN_PATH_SETTING = "dbadmin.pgAdminBinPath";

export interface BackupOptions {
  /** Target file path */
  filename: string;
  /** custom | tar | directory | plain */
  format: "custom" | "tar" | "directory" | "plain";
  /** Number of parallel jobs (directory format only) */
  jobs: number;
  /** Role name to set in produced dump */
  roleName: string;

  // Dados
  /** Section: pre-data, data, post-data */
  sections: Array<"pre-data" | "data" | "post-data">;
  /** Object types to exclude */
  onlyData: boolean;
  onlySchema: boolean;

  // Query
  useInserts: boolean;
  columnInserts: boolean;
  disableDollarQuoting: boolean;
  disableTriggers: boolean;

  // Opções
  verbose: boolean;
  serializableDeferrable: boolean;
  lockWaitTimeout: number;
}

export interface RestoreOptions {
  /** Source file path */
  filename: string;
  /** custom | tar | directory */
  format: "custom" | "tar" | "directory";
  /** Restore mode (reserved for future providers) */
  mode?: "pgadmin";
  /** Number of parallel jobs */
  jobs: number;
  /** Role name override */
  roleName: string;

  // Dados
  onlyData: boolean;
  onlySchema: boolean;
  sections: Array<"pre-data" | "data" | "post-data">;

  // Query
  includeCreateDatabase: boolean;
  includeIfExists: boolean;
  cleanBeforeRestore: boolean;
  singleTransaction: boolean;

  // Tabela
  enableRowSecurity: boolean;
  noDataForFailedTables: boolean;

  // Desabilitar
  disableTriggers: boolean;

  // Geral
  useSetSessionAuthorization: boolean;
  exitOnError: boolean;
  dropSchema: boolean;

  // Compatibilidade
  noPrivileges: boolean;
  noOwner: boolean;

  // Opções
  verbose: boolean;
  listFilename?: string;
}

export async function listRoles(
  connection: PostgresConnection,
): Promise<string[]> {
  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });

  await client.connect();
  try {
    const result = await client.query<{ rolname: string }>(
      `SELECT rolname
       FROM pg_roles
       ORDER BY rolname`,
    );
    return result.rows.map((row) => row.rolname);
  } finally {
    await client.end();
  }
}

/**
 * Resolves the path to a pg binary (pg_dump, pg_restore) honouring the
 * configured pgAdminBinPath setting and falling back to auto-detection.
 */
export async function resolveBinPath(binary: string): Promise<string> {
  const configuredPath = vscode.workspace
    .getConfiguration()
    .get<string>(PGADMIN_BIN_PATH_SETTING, "");

  if (configuredPath.trim()) {
    const configuredBinary = path.join(
      configuredPath.trim(),
      os.platform() === "win32" ? `${binary}.exe` : binary,
    );
    if (fs.existsSync(configuredBinary)) {
      return configuredBinary;
    }
    throw new Error(
      `O binário ${binary} não foi encontrado em "${configuredPath.trim()}".`,
    );
  }

  // Auto-detect
  const detected = await detectPgAdminBinPath(binary);
  if (detected) {
    return path.join(
      detected,
      os.platform() === "win32" ? `${binary}.exe` : binary,
    );
  }

  // Fallback: assume it's on PATH
  return os.platform() === "win32" ? `${binary}.exe` : binary;
}

export async function detectPgAdminBinPath(
  binaryName = "pg_dump",
): Promise<string | undefined> {
  const candidates: string[] = [];

  if (os.platform() === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";

    for (const base of [localAppData, programFiles, programFilesX86]) {
      if (!base) {
        continue;
      }
      for (const version of ["", "v10", "v9", "v8", "v7", "v6"]) {
        const sub = version
          ? path.join("pgAdmin 4", version, "runtime")
          : path.join("pgAdmin 4", "runtime");
        candidates.push(path.join(base, sub));
        candidates.push(path.join(base, "Programs", sub));
      }
    }
  } else {
    candidates.push(
      "/usr/lib/postgresql/bin",
      "/usr/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
    );
  }

  const binary =
    os.platform() === "win32" ? `${binaryName}.exe` : binaryName;
  for (const candidate of candidates) {
    try {
      fs.accessSync(path.join(candidate, binary), fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

/**
 * Runs pg_dump and streams output lines to the provided callback.
 * Resolves when the process exits.
 */
export async function runDump(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: BackupOptions,
  onLine: (line: string) => void,
): Promise<void> {
  const pgDump = await resolveBinPath("pg_dump");
  const args = buildDumpArgs(connection, databaseName, schemaName, options);
  return spawnWithStreaming(
    pgDump,
    args,
    { PGPASSWORD: connection.password },
    onLine,
  );
}

/**
 * Runs pg_restore and streams output lines to the provided callback.
 * Resolves when the process exits.
 */
export async function runRestore(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: RestoreOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pgRestore = await resolveBinPath("pg_restore");
  const args = buildRestoreArgs(connection, databaseName, schemaName, options);
  return spawnWithStreaming(
    pgRestore,
    args,
    { PGPASSWORD: connection.password },
    onLine,
    signal,
  );
}

export async function runRestoreToSql(
  schemaName: string,
  options: RestoreOptions,
  outputFilename: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pgRestore = await resolveBinPath("pg_restore");
  const args = buildPgRestoreSqlArgs({
    filename: options.filename,
    format: options.format,
    schemaName,
    outputFilename,
    sections: options.sections ?? [],
    onlyData: options.onlyData,
    onlySchema: options.onlySchema,
    includeIfExists: options.includeIfExists,
    disableTriggers: options.disableTriggers,
    verbose: options.verbose,
    listFilename: options.listFilename,
  });
  await spawnWithStreaming(
    pgRestore,
    args,
    {},
    onLine,
    signal,
  );

  const generatedSql = fs.readFileSync(outputFilename, "utf8");
  fs.writeFileSync(outputFilename, normalizePgRestoreSql(generatedSql), "utf8");
}

export async function listRestoreToc(filename: string): Promise<string> {
  const pgRestore = await resolveBinPath("pg_restore");
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(pgRestore, ["--list", filename], {
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `pg_restore exited with code ${code}`));
      }
    });
  });
}

/**
 * Restores a dump while adapting SQL emitted by newer pg_dump versions to
 * older PostgreSQL servers. PostgreSQL 17 introduced transaction_timeout;
 * pg_restore emits SET transaction_timeout even when the target cannot
 * execute it. In that case, generate a SQL script, remove only that setting,
 * and execute the script with psql so COPY data remains supported.
 */
export async function runRestoreCompatible(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: RestoreOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const serverVersion = await getServerVersionNumber(
    connection,
    databaseName,
  );
  if (serverVersion >= 170000) {
    await runRestore(connection, databaseName, schemaName, options, onLine, signal);
    return;
  }

  const pgRestore = await resolveBinPath("pg_restore");
  const psql = await resolveBinPath("psql");
  const temporarySql = path.join(
    os.tmpdir(),
    `dbadmin-restore-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`,
  );

  try {
    onLine(
      `[DBeaver] PostgreSQL ${serverVersion}: convertendo temporariamente o dump para remover SET transaction_timeout incompatível.`,
    );
    const restoreArgs = buildRestoreArgs(
      connection,
      databaseName,
      schemaName,
      options,
    ).filter((arg, index, args) => {
      if (arg === "--dbname" || arg === "--jobs") {
        return false;
      }
      if (index > 0 && (args[index - 1] === "--dbname" || args[index - 1] === "--jobs")) {
        return false;
      }
      return true;
    });
    const outputIndex = restoreArgs.length - 1;
    restoreArgs.splice(outputIndex, 0, "--file", temporarySql);

    await spawnWithStreaming(
      pgRestore,
      restoreArgs,
      { PGPASSWORD: connection.password },
      onLine,
      signal,
    );

    const generatedSql = fs.readFileSync(temporarySql, "utf8");
    const compatibleSql = generatedSql
      .split(/\r?\n/)
      .filter((line) => !/^\s*SET\s+transaction_timeout\s*=\s*0\s*;\s*$/i.test(line))
      .join("\n");
    fs.writeFileSync(temporarySql, compatibleSql, "utf8");

    const psqlArgs = [
      "--host",
      connection.host,
      "--port",
      String(connection.port),
      "--username",
      connection.user,
      "--dbname",
      databaseName,
    ];
    if (options.exitOnError) {
      psqlArgs.push("--set", "ON_ERROR_STOP=1");
    }
    psqlArgs.push("--file", temporarySql);

    await spawnWithStreaming(
      psql,
      psqlArgs,
      {
        PGPASSWORD: connection.password,
        PGSSLMODE: connection.ssl ? "require" : "disable",
      },
      onLine,
      signal,
    );
  } finally {
    try {
      fs.unlinkSync(temporarySql);
    } catch {
      // Best effort cleanup.
    }
  }
}

async function getServerVersionNumber(
  connection: PostgresConnection,
  databaseName: string,
): Promise<number> {
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
  try {
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    return Number(result.rows[0]?.version ?? 0);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

function buildDumpArgs(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: BackupOptions,
): string[] {
  const args: string[] = [
    "--host",
    connection.host,
    "--port",
    String(connection.port),
    "--username",
    connection.user,
    "--dbname",
    databaseName,
    "--schema",
    schemaName,
    "--format",
    options.format,
    "--file",
    options.filename,
  ];

  if (options.format === "directory" && options.jobs > 1) {
    args.push("--jobs", String(options.jobs));
  }

  if (options.roleName) {
    args.push("--role", options.roleName);
  }

  const sections = options.sections ?? [];
  if (sections.length > 0 && sections.length < 3) {
    for (const section of sections) {
      args.push("--section", section);
    }
  }

  if (options.onlyData) {
    args.push("--data-only");
  } else if (options.onlySchema) {
    args.push("--schema-only");
  }

  if (options.useInserts) {
    args.push("--inserts");
  }
  if (options.columnInserts) {
    args.push("--column-inserts");
  }
  if (options.disableDollarQuoting) {
    args.push("--disable-dollar-quoting");
  }
  if (options.disableTriggers) {
    args.push("--disable-triggers");
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  if (options.serializableDeferrable) {
    args.push("--serializable-deferrable");
  }
  if (options.lockWaitTimeout > 0) {
    args.push("--lock-wait-timeout", String(options.lockWaitTimeout));
  }

  return args;
}

function buildRestoreArgs(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: RestoreOptions,
): string[] {
  const args: string[] = [
    "--host",
    connection.host,
    "--port",
    String(connection.port),
    "--username",
    connection.user,
    "--dbname",
    databaseName,
    "--schema",
    schemaName,
    "--format",
    options.format,
  ];

  if (options.listFilename) {
    args.push("--use-list", options.listFilename);
  }

  if (options.jobs > 1) {
    args.push("--jobs", String(options.jobs));
  }
  if (options.roleName) {
    args.push("--role", options.roleName);
  }

  const sections = options.sections ?? [];
  if (sections.length > 0 && sections.length < 3) {
    for (const section of sections) {
      args.push("--section", section);
    }
  }

  if (options.onlyData) {
    args.push("--data-only");
  } else if (options.onlySchema) {
    args.push("--schema-only");
  }

  if (options.disableTriggers) {
    args.push("--disable-triggers");
  }
  if (options.includeCreateDatabase) {
    args.push("--create");
  }
  if (options.includeIfExists) {
    args.push("--if-exists");
  }
  if (options.enableRowSecurity) {
    args.push("--enable-row-security");
  }
  if (options.noDataForFailedTables) {
    args.push("--no-data-for-failed-tables");
  }
  if (options.useSetSessionAuthorization) {
    args.push("--use-set-session-authorization");
  }
  if (options.noPrivileges) {
    args.push("--no-privileges");
  }
  if (options.noOwner) {
    args.push("--no-owner");
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  if (options.exitOnError) {
    args.push("--exit-on-error");
  }
  if (options.singleTransaction) {
    args.push("--single-transaction");
  }
  if (options.cleanBeforeRestore || options.dropSchema) {
    args.push("--clean");
  }

  // Input file last
  args.push(options.filename);

  return args;
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

function spawnWithStreaming(
  bin: string,
  args: string[],
  env: Record<string, string>,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(bin, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
    });

    let buffer = "";
    const output: string[] = [];
    let aborted = false;

    const abortListener = (): void => {
      aborted = true;
      proc.kill();
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    const handleData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) {
          output.push(line);
          onLine(line);
        }
      }
    };

    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", abortListener);
      if (buffer) {
        output.push(buffer);
        onLine(buffer);
      }
      if (code === 0) {
        resolve();
      } else if (aborted || signal?.aborted) {
        reject(new Error("Restore aborted by user."));
      } else {
        const detail = output.slice(-8).join("\n").trim();
        reject(
          new Error(
            detail
              ? `Process exited with code ${code}:\n${detail}`
              : `Process exited with code ${code}`,
          ),
        );
      }
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", abortListener);
      reject(err);
    });

    if (signal?.aborted) {
      abortListener();
    }
  });
}
