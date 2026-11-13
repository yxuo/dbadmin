import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ConnectionsFile,
  DbConnection,
  isSqliteConnection,
  PostgresConnection,
  PostgresConnectionInput,
  SqliteConnection,
  SqliteConnectionInput,
} from './models';

const STORAGE_FOLDER = '.dbadmin';
const STORAGE_FILE = 'connections.json';

export type CreateConnectionInput =
  | ({ engine?: 'postgres' } & PostgresConnectionInput)
  | ({ engine: 'sqlite' } & SqliteConnectionInput);

export class ConnectionStore {
  private readonly ephemeral = new Map<string, SqliteConnection>();
  private ioQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly storageRoot: string) {}

  public async ensureInitialized(): Promise<void> {
    await this.readFile();
  }

  public async getStorageFilePath(): Promise<string> {
    await this.ensureInitialized();
    return this.getStoragePath();
  }

  public async listConnections(): Promise<DbConnection[]> {
    const data = await this.readFile();
    return [...data.connections, ...this.ephemeral.values()];
  }

  public async getConnection(id: string): Promise<DbConnection | undefined> {
    const ephemeral = this.ephemeral.get(id);
    if (ephemeral) {
      return ephemeral;
    }
    const data = await this.readFile();
    return data.connections.find((connection) => connection.id === id);
  }

  public async findSqliteByFilePath(filePath: string): Promise<DbConnection | undefined> {
    const normalized = this.normalizePath(filePath);
    const connections = await this.listConnections();
    return connections.find(
      (connection) =>
        isSqliteConnection(connection) &&
        this.normalizePath(connection.filePath) === normalized,
    );
  }

  public async createConnection(input: CreateConnectionInput): Promise<DbConnection> {
    if (input.engine === 'sqlite') {
      return this.createSqliteConnection(input, false);
    }
    return this.createPostgresConnection(input);
  }

  public async createEphemeralSqlite(
    input: SqliteConnectionInput,
  ): Promise<SqliteConnection> {
    const existing = await this.findSqliteByFilePath(input.filePath);
    if (existing && isSqliteConnection(existing)) {
      return existing;
    }
    const created = this.buildSqliteConnection(input, true);
    this.ephemeral.set(created.id, created);
    return created;
  }

  public async persistEphemeralSqlite(id: string): Promise<SqliteConnection> {
    const current = this.ephemeral.get(id);
    if (!current) {
      const found = await this.getConnection(id);
      if (found && isSqliteConnection(found) && !found.ephemeral) {
        return found;
      }
      throw new Error('Connection not found.');
    }
    this.ephemeral.delete(id);
    const persisted = await this.createSqliteConnection(current, false, current.id);
    return persisted;
  }

  public async updateConnection(
    id: string,
    patch: CreateConnectionInput,
  ): Promise<DbConnection> {
    if (this.ephemeral.has(id)) {
      if (patch.engine !== 'sqlite') {
        throw new Error('Ephemeral file connections can only stay as SQLite.');
      }
      const current = this.ephemeral.get(id)!;
      const updated: SqliteConnection = {
        ...current,
        ...this.normalizeSqliteInput(patch),
        id: current.id,
        engine: 'sqlite',
        ephemeral: true,
        updatedAt: new Date().toISOString(),
      };
      this.validateSqliteInput(updated);
      this.ephemeral.set(id, updated);
      return updated;
    }

    const data = await this.readFile();
    const index = data.connections.findIndex((connection) => connection.id === id);
    if (index < 0) {
      throw new Error('Connection not found.');
    }

    const current = data.connections[index];
    this.assertUniqueNickname(data.connections, patch.nickname, id);

    if (isSqliteConnection(current) || patch.engine === 'sqlite') {
      if (!isSqliteConnection(current)) {
        throw new Error('Cannot change a PostgreSQL connection into SQLite.');
      }
      const sqlitePatch = this.normalizeSqliteInput(
        patch.engine === 'sqlite' ? patch : { nickname: patch.nickname, filePath: current.filePath, readOnly: current.readOnly },
      );
      this.validateSqliteInput(sqlitePatch);
      const updated: SqliteConnection = {
        ...current,
        ...sqlitePatch,
        engine: 'sqlite',
        updatedAt: new Date().toISOString(),
      };
      data.connections[index] = updated;
      await this.writeFile(data);
      return updated;
    }

    const postgresPatch = this.normalizePostgresInput(patch as PostgresConnectionInput);
    this.validatePostgresInput(postgresPatch);
    const updated: PostgresConnection = {
      ...current,
      ...postgresPatch,
      engine: 'postgres',
      updatedAt: new Date().toISOString(),
    };
    data.connections[index] = updated;
    await this.writeFile(data);
    return updated;
  }

  public async replaceAllConnections(connections: DbConnection[]): Promise<void> {
    const sanitized = connections
      .filter((connection) => !(isSqliteConnection(connection) && connection.ephemeral))
      .map((connection) => this.sanitizeConnection(connection));
    for (const connection of sanitized) {
      if (isSqliteConnection(connection)) {
        this.validateSqliteInput(connection);
      } else {
        this.validatePostgresInput(connection);
      }
    }
    this.ephemeral.clear();
    await this.writeFile({ version: 2, connections: sanitized });
  }

  public async deleteConnection(id: string): Promise<void> {
    if (this.ephemeral.delete(id)) {
      return;
    }
    const data = await this.readFile();
    const next = data.connections.filter((connection) => connection.id !== id);
    if (next.length === data.connections.length) {
      throw new Error('Connection not found.');
    }
    await this.writeFile({ ...data, connections: next });
  }

  private async createPostgresConnection(
    input: PostgresConnectionInput,
  ): Promise<PostgresConnection> {
    const normalizedInput = this.normalizePostgresInput(input);
    this.validatePostgresInput(normalizedInput);
    const data = await this.readFile();
    this.assertUniqueNickname(data.connections, normalizedInput.nickname);
    const now = new Date().toISOString();
    const created: PostgresConnection = {
      ...normalizedInput,
      id: this.generateId(),
      engine: 'postgres',
      createdAt: now,
      updatedAt: now,
    };
    data.connections.push(created);
    await this.writeFile(data);
    return created;
  }

  private async createSqliteConnection(
    input: SqliteConnectionInput,
    ephemeral: boolean,
    id?: string,
  ): Promise<SqliteConnection> {
    const created = this.buildSqliteConnection(input, ephemeral, id);
    if (ephemeral) {
      this.ephemeral.set(created.id, created);
      return created;
    }
    const data = await this.readFile();
    this.assertUniqueNickname(data.connections, created.nickname, created.id);
    const existingIndex = data.connections.findIndex(
      (connection) =>
        isSqliteConnection(connection) &&
        this.normalizePath(connection.filePath) === this.normalizePath(created.filePath),
    );
    if (existingIndex >= 0) {
      const current = data.connections[existingIndex] as SqliteConnection;
      const updated: SqliteConnection = {
        ...current,
        ...created,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        ephemeral: undefined,
      };
      data.connections[existingIndex] = updated;
      await this.writeFile(data);
      return updated;
    }
    data.connections.push(created);
    await this.writeFile(data);
    return created;
  }

  private buildSqliteConnection(
    input: SqliteConnectionInput,
    ephemeral: boolean,
    id?: string,
  ): SqliteConnection {
    const normalized = this.normalizeSqliteInput(input);
    this.validateSqliteInput(normalized);
    const now = new Date().toISOString();
    return {
      ...normalized,
      id: id ?? this.generateId(),
      engine: 'sqlite',
      createdAt: now,
      updatedAt: now,
      ephemeral: ephemeral || undefined,
    };
  }

  private assertUniqueNickname(
    connections: DbConnection[],
    nickname: string,
    ignoreId?: string,
  ): void {
    const duplicated = connections.some(
      (connection) =>
        connection.id !== ignoreId &&
        connection.nickname.trim().toLowerCase() === nickname.trim().toLowerCase(),
    );
    if (duplicated) {
      throw new Error('A connection with this nickname already exists.');
    }
  }

  private validatePostgresInput(input: PostgresConnectionInput): void {
    if (!input.nickname.trim()) {
      throw new Error('Nickname is required.');
    }
    if (!input.host.trim()) {
      throw new Error('Host is required.');
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new Error('Invalid port. Use a value between 1 and 65535.');
    }
    if (!input.database.trim()) {
      throw new Error('Database is required.');
    }
    if (!input.user.trim()) {
      throw new Error('User is required.');
    }
    if (input.visibleDatabases && !Array.isArray(input.visibleDatabases)) {
      throw new Error('Invalid visible databases list.');
    }
  }

  private validateSqliteInput(input: SqliteConnectionInput): void {
    if (!input.nickname.trim()) {
      throw new Error('Nickname is required.');
    }
    if (!input.filePath.trim()) {
      throw new Error('File path is required.');
    }
  }

  private getStoragePath(): string {
    return path.join(this.storageRoot, STORAGE_FOLDER, STORAGE_FILE);
  }

  private emptyFile(): ConnectionsFile {
    return { version: 2, connections: [] };
  }

  private enqueueIo<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.ioQueue.then(operation, operation);
    this.ioQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureStorageDir(): Promise<string> {
    const storagePath = this.getStoragePath();
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    return storagePath;
  }

  private async readFile(): Promise<ConnectionsFile> {
    return this.enqueueIo(() => this.readFileExclusive());
  }

  private async readFileExclusive(): Promise<ConnectionsFile> {
    const storagePath = await this.ensureStorageDir();
    let raw: string;
    try {
      raw = await fs.readFile(storagePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.seedEmptyFile();
      }
      throw error;
    }

    if (!raw.trim()) {
      return this.seedEmptyFile();
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ConnectionsFile> & {
        connections?: unknown[];
      };
      if (!Array.isArray(parsed.connections)) {
        throw new Error('Invalid format.');
      }
      const connections = parsed.connections.map((item) =>
        this.sanitizeConnection(this.migrateConnection(item)),
      );
      const data: ConnectionsFile = { version: 2, connections };
      if (parsed.version !== 2) {
        await this.writeFileExclusive(data);
      }
      return data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return this.seedEmptyFile();
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Corrupted connections file: ${message}`);
    }
  }

  private async seedEmptyFile(): Promise<ConnectionsFile> {
    const empty = this.emptyFile();
    try {
      await this.writeFileExclusive(empty);
    } catch {
      // Missing store file must not block opening a SQLite database.
    }
    return empty;
  }

  private async writeFile(data: ConnectionsFile): Promise<void> {
    return this.enqueueIo(() => this.writeFileExclusive(data));
  }

  private async writeFileExclusive(data: ConnectionsFile): Promise<void> {
    const storagePath = await this.ensureStorageDir();
    const payload = JSON.stringify(
      { version: 2, connections: data.connections },
      null,
      2,
    );
    const dir = path.dirname(storagePath);
    const tmpPath = path.join(
      dir,
      `.${path.basename(storagePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await fs.writeFile(tmpPath, payload, 'utf8');
    try {
      // copyFile creates the destination when it is missing; Windows rename
      // of connections.json.tmp often fails with ENOENT on first run.
      await fs.copyFile(tmpPath, storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(storagePath, payload, 'utf8');
      } else {
        throw error;
      }
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  private migrateConnection(raw: unknown): DbConnection {
    const value = (raw ?? {}) as Record<string, unknown>;
    if (value.engine === 'sqlite' || typeof value.filePath === 'string') {
      return {
        id: String(value.id || this.generateId()),
        engine: 'sqlite',
        nickname: String(value.nickname || ''),
        filePath: String(value.filePath || ''),
        readOnly: Boolean(value.readOnly),
        createdAt: String(value.createdAt || new Date().toISOString()),
        updatedAt: String(value.updatedAt || new Date().toISOString()),
      };
    }
    return {
      id: String(value.id || this.generateId()),
      engine: 'postgres',
      nickname: String(value.nickname || ''),
      host: String(value.host || ''),
      port: Number(value.port || 5432),
      database: String(value.database || ''),
      visibleDatabases: this.normalizeVisibleDatabases(value.visibleDatabases),
      user: String(value.user || ''),
      password: String(value.password || ''),
      ssl: Boolean(value.ssl),
      createdAt: String(value.createdAt || new Date().toISOString()),
      updatedAt: String(value.updatedAt || new Date().toISOString()),
    };
  }

  private normalizePostgresInput(input: PostgresConnectionInput): PostgresConnectionInput {
    return {
      ...input,
      visibleDatabases: this.normalizeVisibleDatabases(input.visibleDatabases),
    };
  }

  private normalizeSqliteInput(input: SqliteConnectionInput): SqliteConnectionInput {
    return {
      nickname: input.nickname.trim(),
      filePath: path.resolve(input.filePath.trim()),
      readOnly: Boolean(input.readOnly),
    };
  }

  private sanitizeConnection(connection: DbConnection): DbConnection {
    if (isSqliteConnection(connection)) {
      return {
        ...connection,
        engine: 'sqlite',
        filePath: path.resolve(connection.filePath),
        ephemeral: undefined,
      };
    }
    return {
      ...connection,
      engine: 'postgres',
      visibleDatabases: this.normalizeVisibleDatabases(connection.visibleDatabases),
    };
  }

  private normalizePath(filePath: string): string {
    return path.normalize(filePath).toLowerCase();
  }

  private normalizeVisibleDatabases(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const uniqueByLower = new Map<string, string>();
    for (const item of value) {
      const name = String(item ?? '').trim();
      if (!name) {
        continue;
      }
      const key = name.toLowerCase();
      if (!uniqueByLower.has(key)) {
        uniqueByLower.set(key, name);
      }
    }
    const normalized = Array.from(uniqueByLower.values());
    return normalized.length > 0 ? normalized : undefined;
  }
}
