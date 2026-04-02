import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import * as vscode from 'vscode';
import { PostgresConnection } from './models';

const PGADMIN_BIN_PATH_SETTING = 'dbadmin.pgAdminBinPath';

export interface BackupOptions {
  /** Target file path */
  filename: string;
  /** custom | tar | directory | plain */
  format: 'custom' | 'tar' | 'directory' | 'plain';
  /** Number of parallel jobs (directory format only) */
  jobs: number;
  /** Role name to set in produced dump */
  roleName: string;

  // Dados
  /** Section: pre-data, data, post-data */
  sections: Array<'pre-data' | 'data' | 'post-data'>;
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
  /** Restore mode (reserved for future providers) */
  mode?: 'pgadmin';
  /** Number of parallel jobs */
  jobs: number;
  /** Role name override */
  roleName: string;

  // Dados
  onlyData: boolean;
  onlySchema: boolean;
  sections: Array<'pre-data' | 'data' | 'post-data'>;

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
}

export async function listRoles(connection: PostgresConnection): Promise<string[]> {
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
       ORDER BY rolname`
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
    .get<string>(PGADMIN_BIN_PATH_SETTING, '');

  if (configuredPath.trim()) {
    return path.join(configuredPath.trim(), os.platform() === 'win32' ? `${binary}.exe` : binary);
  }

  // Auto-detect
  const detected = await detectPgAdminBinPath();
  if (detected) {
    return path.join(detected, os.platform() === 'win32' ? `${binary}.exe` : binary);
  }

  // Fallback: assume it's on PATH
  return os.platform() === 'win32' ? `${binary}.exe` : binary;
}

export async function detectPgAdminBinPath(): Promise<string | undefined> {
  const candidates: string[] = [];

  if (os.platform() === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';

    for (const base of [localAppData, programFiles, programFilesX86]) {
      if (!base) {
        continue;
      }
      for (const version of ['', 'v8', 'v7', 'v6']) {
        const sub = version ? path.join('pgAdmin 4', version, 'runtime') : path.join('pgAdmin 4', 'runtime');
        candidates.push(path.join(base, sub));
        candidates.push(path.join(base, 'Programs', sub));
      }
    }
  } else {
    candidates.push('/usr/lib/postgresql/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin');
  }

  const binary = os.platform() === 'win32' ? 'pg_dump.exe' : 'pg_dump';
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
  onLine: (line: string) => void
): Promise<void> {
  const pgDump = await resolveBinPath('pg_dump');
  const args = buildDumpArgs(connection, databaseName, schemaName, options);
  return spawnWithStreaming(pgDump, args, { PGPASSWORD: connection.password }, onLine);
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
  onLine: (line: string) => void
): Promise<void> {
  const pgRestore = await resolveBinPath('pg_restore');
  const args = buildRestoreArgs(connection, databaseName, schemaName, options);
  return spawnWithStreaming(pgRestore, args, { PGPASSWORD: connection.password }, onLine);
}

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

function buildDumpArgs(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: BackupOptions
): string[] {
  const args: string[] = [
    '--host', connection.host,
    '--port', String(connection.port),
    '--username', connection.user,
    '--dbname', databaseName,
    '--schema', schemaName,
    '--format', options.format,
    '--file', options.filename,
  ];

  if (options.format === 'directory' && options.jobs > 1) {
    args.push('--jobs', String(options.jobs));
  }

  if (options.roleName) {
    args.push('--role', options.roleName);
  }

  const sections = options.sections ?? [];
  if (sections.length > 0 && sections.length < 3) {
    for (const section of sections) {
      args.push('--section', section);
    }
  }

  if (options.onlyData) {
    args.push('--data-only');
  } else if (options.onlySchema) {
    args.push('--schema-only');
  }

  if (options.useInserts) {
    args.push('--inserts');
  }
  if (options.columnInserts) {
    args.push('--column-inserts');
  }
  if (options.disableDollarQuoting) {
    args.push('--disable-dollar-quoting');
  }
  if (options.disableTriggers) {
    args.push('--disable-triggers');
  }
  if (options.verbose) {
    args.push('--verbose');
  }
  if (options.serializableDeferrable) {
    args.push('--serializable-deferrable');
  }
  if (options.lockWaitTimeout > 0) {
    args.push('--lock-wait-timeout', String(options.lockWaitTimeout));
  }

  return args;
}

function buildRestoreArgs(
  connection: PostgresConnection,
  databaseName: string,
  schemaName: string,
  options: RestoreOptions
): string[] {
  const args: string[] = [
    '--host', connection.host,
    '--port', String(connection.port),
    '--username', connection.user,
    '--dbname', databaseName,
    '--schema', schemaName,
  ];

  if (options.jobs > 1) {
    args.push('--jobs', String(options.jobs));
  }
  if (options.roleName) {
    args.push('--role', options.roleName);
  }

  const sections = options.sections ?? [];
  if (sections.length > 0 && sections.length < 3) {
    for (const section of sections) {
      args.push('--section', section);
    }
  }

  if (options.onlyData) {
    args.push('--data-only');
  } else if (options.onlySchema) {
    args.push('--schema-only');
  }

  if (options.disableTriggers) {
    args.push('--disable-triggers');
  }
  if (options.includeCreateDatabase) {
    args.push('--create');
  }
  if (options.includeIfExists) {
    args.push('--if-exists');
  }
  if (options.enableRowSecurity) {
    args.push('--enable-row-security');
  }
  if (options.noDataForFailedTables) {
    args.push('--no-data-for-failed-tables');
  }
  if (options.useSetSessionAuthorization) {
    args.push('--use-set-session-authorization');
  }
  if (options.noPrivileges) {
    args.push('--no-privileges');
  }
  if (options.noOwner) {
    args.push('--no-owner');
  }
  if (options.verbose) {
    args.push('--verbose');
  }
  if (options.exitOnError) {
    args.push('--exit-on-error');
  }
  if (options.singleTransaction) {
    args.push('--single-transaction');
  }
  if (options.cleanBeforeRestore || options.dropSchema) {
    args.push('--clean');
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
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(bin, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
    });

    let buffer = '';

    const handleData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line) {
          onLine(line);
        }
      }
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('close', (code) => {
      if (buffer) {
        onLine(buffer);
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}
