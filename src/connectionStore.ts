import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConnectionsFile, PostgresConnection, PostgresConnectionInput } from './models';

const STORAGE_FOLDER = '.dbadmin';
const STORAGE_FILE = 'connections.json';

export class ConnectionStore {
  public constructor(private readonly storageRoot: string) {}

  public async getStorageFilePath(): Promise<string> {
    return this.ensureStorageFile();
  }

  public async listConnections(): Promise<PostgresConnection[]> {
    const data = await this.readFile();
    return data.connections;
  }

  public async getConnection(id: string): Promise<PostgresConnection | undefined> {
    const data = await this.readFile();
    return data.connections.find((connection) => connection.id === id);
  }

  public async createConnection(
    input: PostgresConnectionInput
  ): Promise<PostgresConnection> {
    const normalizedInput = this.normalizeInput(input);
    this.validateInput(normalizedInput);
    const data = await this.readFile();

    const duplicated = data.connections.some(
      (connection) =>
        connection.nickname.trim().toLowerCase() === normalizedInput.nickname.trim().toLowerCase()
    );

    if (duplicated) {
      throw new Error('Ja existe uma conexão com esse apelido.');
    }

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

  public async updateConnection(
    id: string,
    patch: PostgresConnectionInput
  ): Promise<PostgresConnection> {
    const normalizedPatch = this.normalizeInput(patch);
    this.validateInput(normalizedPatch);
    const data = await this.readFile();
    const index = data.connections.findIndex((connection) => connection.id === id);

    if (index < 0) {
      throw new Error('Conexão não encontrada.');
    }

    const duplicated = data.connections.some(
      (connection) =>
        connection.id !== id &&
        connection.nickname.trim().toLowerCase() === normalizedPatch.nickname.trim().toLowerCase()
    );

    if (duplicated) {
      throw new Error('Ja existe uma conexão com esse apelido.');
    }

    const current = data.connections[index];
    const updated: PostgresConnection = {
      ...current,
      ...normalizedPatch,
      updatedAt: new Date().toISOString(),
    };

    data.connections[index] = updated;
    await this.writeFile(data);

    return updated;
  }

  public async deleteConnection(id: string): Promise<void> {
    const data = await this.readFile();
    const next = data.connections.filter((connection) => connection.id !== id);

    if (next.length === data.connections.length) {
      throw new Error('Conexão não encontrada.');
    }

    await this.writeFile({ ...data, connections: next });
  }

  private validateInput(input: PostgresConnectionInput): void {
    if (!input.nickname.trim()) {
      throw new Error('Apelido e obrigatorio.');
    }

    if (!input.host.trim()) {
      throw new Error('Host e obrigatorio.');
    }

    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new Error('Porta invalida. Use um valor entre 1 e 65535.');
    }

    if (!input.database.trim()) {
      throw new Error('Database e obrigatorio.');
    }

    if (!input.user.trim()) {
      throw new Error('Usuario e obrigatorio.');
    }

    if (input.visibleDatabases && !Array.isArray(input.visibleDatabases)) {
      throw new Error('Lista de bancos visiveis invalida.');
    }
  }

  private async ensureStorageFile(): Promise<string> {
    const storageFolder = path.join(this.storageRoot, STORAGE_FOLDER);
    const storagePath = path.join(storageFolder, STORAGE_FILE);

    await fs.mkdir(storageFolder, { recursive: true });

    try {
      await fs.access(storagePath);
    } catch {
      const initial: ConnectionsFile = {
        version: 1,
        connections: [],
      };
      await fs.writeFile(storagePath, JSON.stringify(initial, null, 2), 'utf8');
    }

    return storagePath;
  }

  private async readFile(): Promise<ConnectionsFile> {
    const storagePath = await this.ensureStorageFile();
    const raw = await fs.readFile(storagePath, 'utf8');

    try {
      const parsed = JSON.parse(raw) as Partial<ConnectionsFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.connections)) {
        throw new Error('Formato invalido.');
      }

      return {
        version: 1,
        connections: (parsed.connections as PostgresConnection[]).map((connection) =>
          this.sanitizeConnection(connection)
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      throw new Error(`Arquivo de conexoes corrompido: ${message}`);
    }
  }

  private async writeFile(data: ConnectionsFile): Promise<void> {
    const storagePath = await this.ensureStorageFile();
    const tmpPath = `${storagePath}.tmp`;

    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, storagePath);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  private normalizeInput(input: PostgresConnectionInput): PostgresConnectionInput {
    return {
      ...input,
      visibleDatabases: this.normalizeVisibleDatabases(input.visibleDatabases),
    };
  }

  private sanitizeConnection(connection: PostgresConnection): PostgresConnection {
    return {
      ...connection,
      visibleDatabases: this.normalizeVisibleDatabases(connection.visibleDatabases),
    };
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
