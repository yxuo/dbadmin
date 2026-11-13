export type EngineId = "postgres" | "sqlite";

export interface EngineCapabilities {
  multipleDatabases: boolean;
  schemas: boolean;
  functions: boolean;
  procedures: boolean;
  extensions: boolean;
  rls: boolean;
  rules: boolean;
  connectionDashboard: boolean;
  fileBackup: boolean;
}

export const POSTGRES_CAPABILITIES: EngineCapabilities = {
  multipleDatabases: true,
  schemas: true,
  functions: true,
  procedures: true,
  extensions: true,
  rls: true,
  rules: true,
  connectionDashboard: true,
  fileBackup: false,
};

export const SQLITE_CAPABILITIES: EngineCapabilities = {
  multipleDatabases: false,
  schemas: false,
  functions: false,
  procedures: false,
  extensions: false,
  rls: false,
  rules: false,
  connectionDashboard: false,
  fileBackup: true,
};

export function capabilitiesFor(engine: EngineId): EngineCapabilities {
  return engine === "sqlite" ? SQLITE_CAPABILITIES : POSTGRES_CAPABILITIES;
}

export const SQLITE_SCHEMA = "main";

export const SQLITE_FILE_EXTENSIONS = [".sqlite", ".sqlite3", ".db", ".db3"];

export const SQLITE_FILE_GLOBS = [
  "**/*.sqlite",
  "**/*.sqlite3",
  "**/*.db",
  "**/*.db3",
];

export function isSqliteFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SQLITE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
