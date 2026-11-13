import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import initSqlJs, { Database, SqlJsStatic, SqlValue } from "sql.js";
import { ConnectionActivityLog } from "../connectionActivityLog";
import { sqliteDatabaseName } from "../connectionIdentity";
import { SqliteConnection } from "../models";
import {
  ColumnInfo,
  ConstraintInfo,
  DiagramDataResult,
  SchemaObjectCounts,
  SqlQueryResult,
  TableColumnMeta,
  TableDataQuery,
  TableDataResult,
  TableEstimatedCount,
  TableSavePayload,
  TableSectionCounts,
} from "../postgresService";
import { SQLITE_SCHEMA } from "./types";
import { log, logError } from "../output";

export interface SqliteDashboardStats {
  version: string;
  filePath: string;
  fileSizeBytes: number;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  tableCount: number;
}

function quoteIdent(identifier: string): string {
  return `"${String(identifier || "").replace(/"/g, '""')}"`;
}

function isSqliteDatabaseBuffer(buffer: Buffer): boolean {
  const header = "SQLite format 3";
  if (buffer.length < header.length) {
    return false;
  }
  return buffer.subarray(0, header.length).toString("utf8") === header;
}

function locateSqlJsAsset(extensionPath: string, file: string): string {
  const candidates = [
    path.join(extensionPath, "resources", "sqljs", file),
    path.join(extensionPath, "node_modules", "sql.js", "dist", file),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function rowToObject(
  columns: string[],
  values: unknown[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i += 1) {
    row[columns[i]] = values[i] ?? null;
  }
  return row;
}

export class SqliteEngine {
  private sqlJs: SqlJsStatic | undefined;
  private initPromise: Promise<SqlJsStatic> | undefined;
  private readonly databases = new Map<string, Database>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private activityLog: ConnectionActivityLog | undefined;

  public constructor(private readonly extensionPath: string) {}

  public setActivityLog(log: ConnectionActivityLog): void {
    this.activityLog = log;
  }

  public async testConnection(connection: SqliteConnection): Promise<string> {
    return this.withDatabase(connection, (db) => {
      const rows = this.select(db, "SELECT sqlite_version() AS version");
      const version = String(rows[0]?.version || "unknown");
      return `SQLite ${version}`;
    });
  }

  public async listDatabases(connection: SqliteConnection): Promise<string[]> {
    return [sqliteDatabaseName(connection)];
  }

  public async listSchemas(): Promise<string[]> {
    return [SQLITE_SCHEMA];
  }

  public async listExtensions(): Promise<string[]> {
    return [];
  }

  public async listTables(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
  ): Promise<string[]> {
    return this.withDatabase(connection, (db) =>
      this.select(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .map((row) => String(row.name)),
    );
  }

  public async listViews(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
  ): Promise<string[]> {
    return this.withDatabase(connection, (db) =>
      this.select(db, `SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`).map(
        (row) => String(row.name),
      ),
    );
  }

  public async listFunctions(): Promise<string[]> {
    return [];
  }

  public async listProcedures(): Promise<string[]> {
    return [];
  }

  public async listTriggers(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
  ): Promise<string[]> {
    return this.withDatabase(connection, (db) =>
      this.select(db, `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).map(
        (row) => String(row.name),
      ),
    );
  }

  public async getSchemaObjectCounts(
    connection: SqliteConnection,
  ): Promise<SchemaObjectCounts> {
    return this.withDatabase(connection, (db) => {
      const count = (type: string, extra = ""): number => {
        const rows = this.select(
          db,
          `SELECT COUNT(*) AS total FROM sqlite_master WHERE type = ? ${extra}`,
          [type],
        );
        return Number(rows[0]?.total || 0);
      };
      return {
        tables: count("table", "AND name NOT LIKE 'sqlite_%'"),
        views: count("view"),
        functions: 0,
        procedures: 0,
        triggers: count("trigger"),
      };
    });
  }

  public async listTableEstimatedCounts(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
  ): Promise<TableEstimatedCount[]> {
    const tables = await this.listTables(connection, "", SQLITE_SCHEMA);
    return this.withDatabase(connection, (db) =>
      tables.map((tableName) => {
        const rows = this.select(
          db,
          `SELECT COUNT(*) AS total FROM ${quoteIdent(tableName)}`,
        );
        return { tableName, count: Number(rows[0]?.total || 0) };
      }),
    );
  }

  public async getTableSectionCounts(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
  ): Promise<TableSectionCounts> {
    return this.withDatabase(connection, (db) => {
      const columns = this.pragma(db, `PRAGMA table_info(${quoteIdent(tableName)})`);
      const fks = this.pragma(db, `PRAGMA foreign_key_list(${quoteIdent(tableName)})`);
      const indexes = this.pragma(db, `PRAGMA index_list(${quoteIdent(tableName)})`);
      const pkCount = columns.filter((row) => Number(row.pk) > 0).length;
      const triggers = this.select(
        db,
        `SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`,
        [tableName],
      );
      return {
        columns: columns.length,
        constraints: pkCount > 0 ? 1 + fks.length : fks.length,
        indexes: indexes.length,
        rls: 0,
        rules: 0,
        triggers: Number(triggers[0]?.total || 0),
      };
    });
  }

  public async listTableColumnsDetailed(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
  ): Promise<ColumnInfo[]> {
    return this.withDatabase(connection, (db) =>
      this.pragma(db, `PRAGMA table_info(${quoteIdent(tableName)})`).map((row) => ({
        name: String(row.name),
        dataType: String(row.type || "ANY"),
        isNullable: Number(row.notnull) === 0,
        defaultValue: row.dflt_value == null ? null : String(row.dflt_value),
      })),
    );
  }

  public async listTableConstraints(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
  ): Promise<ConstraintInfo[]> {
    return this.withDatabase(connection, (db) => {
      const constraints: ConstraintInfo[] = [];
      const columns = this.pragma(db, `PRAGMA table_info(${quoteIdent(tableName)})`);
      const pkCols = columns
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name));
      if (pkCols.length > 0) {
        constraints.push({
          name: `${tableName}_pk`,
          type: "PRIMARY KEY",
          definition: `PRIMARY KEY (${pkCols.map(quoteIdent).join(", ")})`,
        });
      }
      const fks = this.pragma(db, `PRAGMA foreign_key_list(${quoteIdent(tableName)})`);
      for (const fk of fks) {
        constraints.push({
          name: `fk_${tableName}_${fk.id}_${fk.from}`,
          type: "FOREIGN KEY",
          definition: `FOREIGN KEY (${quoteIdent(String(fk.from))}) REFERENCES ${quoteIdent(String(fk.table))}(${quoteIdent(String(fk.to))})`,
        });
      }
      return constraints;
    });
  }

  public async getColumnDetails(
    connection: SqliteConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    columnName: string,
  ): Promise<ColumnInfo | undefined> {
    const columns = await this.listTableColumnsDetailed(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
    return columns.find((column) => column.name === columnName);
  }

  public async getConstraintDetails(
    connection: SqliteConnection,
    databaseName: string,
    schemaName: string,
    tableName: string,
    constraintName: string,
  ): Promise<ConstraintInfo | undefined> {
    const constraints = await this.listTableConstraints(
      connection,
      databaseName,
      schemaName,
      tableName,
    );
    return constraints.find((constraint) => constraint.name === constraintName);
  }

  public async updateColumnProperties(): Promise<void> {
    throw new Error(
      "SQLite cannot change nullability or defaults in place. Edit the table DDL instead.",
    );
  }

  public async getTableColumns(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
  ): Promise<TableColumnMeta[]> {
    return this.withDatabase(connection, (db) => this.readTableColumns(db, tableName));
  }

  public async getTableData(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
    queryInput: TableDataQuery,
  ): Promise<TableDataResult> {
    return this.withUserActivity(
      connection.id,
      `Executando: SELECT * FROM ${quoteIdent(tableName)}`,
      () =>
        this.withDatabase(connection, (db) => {
          const columns = this.readTableColumns(db, tableName);
          const columnNames = columns.map((column) => column.name);
          const validColumns = new Set(columnNames);
          const whereParts: string[] = [];
          const params: SqlValue[] = [];

          for (const [columnName, filterValueRaw] of Object.entries(
            queryInput.columnFilters,
          )) {
            if (!validColumns.has(columnName)) {
              continue;
            }
            const filterValue = filterValueRaw.trim();
            if (!filterValue) {
              continue;
            }
            if (filterValue.toLowerCase() === "null") {
              whereParts.push(`${quoteIdent(columnName)} IS NULL`);
              continue;
            }
            if (filterValue.toLowerCase() === "!null" || filterValue.toLowerCase() === "not null") {
              whereParts.push(`${quoteIdent(columnName)} IS NOT NULL`);
              continue;
            }
            params.push(`%${filterValue}%`);
            whereParts.push(
              `CAST(${quoteIdent(columnName)} AS TEXT) LIKE ? COLLATE NOCASE`,
            );
          }

          if (queryInput.searchMode === "query") {
            const searchText = queryInput.searchText.trim();
            if (searchText && columnNames.length > 0) {
              params.push(`%${searchText}%`);
              const globalSearch = columnNames
                .map(
                  (columnName) =>
                    `CAST(${quoteIdent(columnName)} AS TEXT) LIKE ? COLLATE NOCASE`,
                )
                .join(" OR ");
              whereParts.push(`(${globalSearch})`);
              for (let i = 1; i < columnNames.length; i += 1) {
                params.push(`%${searchText}%`);
              }
            }
          }

          const whereClause =
            whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
          const baseColumns = columnNames.map(quoteIdent).join(", ");
          const selectColumns =
            baseColumns.length > 0
              ? `rowid AS "__dbadmin_ctid", ${baseColumns}`
              : `rowid AS "__dbadmin_ctid"`;

          let orderClause = "";
          if (queryInput.sortColumn && validColumns.has(queryInput.sortColumn)) {
            const direction = queryInput.sortDirection === "desc" ? "DESC" : "ASC";
            orderClause = `ORDER BY ${quoteIdent(queryInput.sortColumn)} ${direction}`;
          }

          const safeLimit = Math.max(1, Math.min(500, Math.trunc(queryInput.limit || 100)));
          const safePage = Math.max(1, Math.trunc(queryInput.page || 1));
          const safeOffset = (safePage - 1) * safeLimit;

          const countRows = this.select(
            db,
            `SELECT COUNT(*) AS total FROM ${quoteIdent(tableName)} ${whereClause}`,
            params,
          );
          const dataSql = `SELECT ${selectColumns}
FROM ${quoteIdent(tableName)}
${whereClause}
${orderClause}
LIMIT ? OFFSET ?`.trim();
          const rows = this.select(db, dataSql, [...params, safeLimit, safeOffset]);
          return {
            query: `${dataSql}\n-- params: ${JSON.stringify([...params, safeLimit, safeOffset])}`,
            columns,
            rows,
            totalRows: Number(countRows[0]?.total || 0),
          };
        }),
      (result, elapsedMs) => `Result: ${result.rows.length} rows in ${elapsedMs}ms`,
    );
  }

  public async saveTableData(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
    payload: TableSavePayload,
  ): Promise<void> {
    this.assertWritable(connection);
    const changeCount =
      (payload.updates?.length || 0) +
      (payload.inserts?.length || 0) +
      (payload.deletes?.length || 0);
    await this.withUserActivity(
      connection.id,
      `Executando: SALVAR ${quoteIdent(tableName)} (${changeCount} alterações)`,
      () =>
        this.withDatabase(
          connection,
          (db) => {
            const columns = this.readTableColumns(db, tableName);
            const validColumns = new Set(columns.map((column) => column.name));
            const qualified = quoteIdent(tableName);
            const deleteSet = new Set((payload.deletes ?? []).filter(Boolean));
            db.run("BEGIN");
            try {
              for (const rowid of deleteSet) {
                db.run(`DELETE FROM ${qualified} WHERE rowid = ?`, [Number(rowid)]);
              }
              for (const update of payload.updates ?? []) {
                if (!update.ctid || deleteSet.has(update.ctid)) {
                  continue;
                }
                const assignments: string[] = [];
                const params: SqlValue[] = [];
                for (const [columnName, value] of Object.entries(update.values)) {
                  if (!validColumns.has(columnName)) {
                    continue;
                  }
                  assignments.push(`${quoteIdent(columnName)} = ?`);
                  params.push(value === "__DBADMIN_DEFAULT__" ? null : (value as SqlValue));
                }
                if (assignments.length === 0) {
                  continue;
                }
                params.push(Number(update.ctid));
                db.run(
                  `UPDATE ${qualified} SET ${assignments.join(", ")} WHERE rowid = ?`,
                  params,
                );
              }
              for (const insert of payload.inserts ?? []) {
                const names: string[] = [];
                const placeholders: string[] = [];
                const params: SqlValue[] = [];
                for (const [columnName, value] of Object.entries(insert)) {
                  if (!validColumns.has(columnName) || value === "__DBADMIN_DEFAULT__") {
                    continue;
                  }
                  names.push(quoteIdent(columnName));
                  placeholders.push("?");
                  params.push(value as SqlValue);
                }
                if (names.length === 0) {
                  db.run(`INSERT INTO ${qualified} DEFAULT VALUES`);
                } else {
                  db.run(
                    `INSERT INTO ${qualified} (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
                    params,
                  );
                }
              }
              db.run("COMMIT");
            } catch (error) {
              db.run("ROLLBACK");
              throw error;
            }
            this.persistLocked(connection.filePath, db);
          },
          { persist: false },
        ),
      (_result, elapsedMs) => `Completed in ${elapsedMs}ms`,
    );
  }

  public async getTableDiagramData(
    connection: SqliteConnection,
    _databaseName: string,
    schemaName: string,
    tableName: string,
    mainColumns?: TableColumnMeta[],
  ): Promise<DiagramDataResult> {
    return this.withDatabase(connection, (db) => {
      const resolvedMainColumns =
        mainColumns ?? this.readTableColumns(db, tableName);
      const tablesList = this.select(
        db,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      ).map((row) => String(row.name));

      const foreignKeys: DiagramDataResult["foreignKeys"] = [];
      const related = new Set<string>();

      for (const fromTable of tablesList) {
        const fks = this.pragma(db, `PRAGMA foreign_key_list(${quoteIdent(fromTable)})`);
        for (const fk of fks) {
          const toTable = String(fk.table);
          foreignKeys.push({
            fromSchema: schemaName,
            fromTable,
            fromColumn: String(fk.from),
            toSchema: schemaName,
            toTable,
            toColumn: String(fk.to),
          });
          if (fromTable === tableName) {
            related.add(toTable);
          }
          if (toTable === tableName) {
            related.add(fromTable);
          }
        }
      }

      related.delete(tableName);
      const tables: DiagramDataResult["tables"] = [
        {
          schemaName,
          tableName,
          columns: resolvedMainColumns,
          isMain: true,
        },
      ];
      for (const relatedTable of related) {
        tables.push({
          schemaName,
          tableName: relatedTable,
          columns: this.readTableColumns(db, relatedTable),
          isMain: false,
        });
      }
      return { tables, foreignKeys };
    });
  }

  public async findForeignKeyMentions(
    connection: SqliteConnection,
    _databaseName: string,
    _targetSchema: string,
    targetTable: string,
    targetColumn: string,
    value: unknown,
    options?: { perTableLimit?: number },
  ): Promise<SqlQueryResult & { sql: string }> {
    const perTableLimit = Math.max(1, Math.min(50, options?.perTableLimit ?? 20));
    return this.withDatabase(connection, (db) => {
      const tables = this.select(
        db,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      ).map((row) => String(row.name));
      const rows: Array<Record<string, unknown>> = [];
      const sqlParts: string[] = [];
      for (const table of tables) {
        const fks = this.pragma(db, `PRAGMA foreign_key_list(${quoteIdent(table)})`);
        const matches = fks.filter(
          (fk) => String(fk.table) === targetTable && String(fk.to) === targetColumn,
        );
        for (const fk of matches) {
          const sql = `SELECT ${quoteIdent(String(fk.from))} AS value, COUNT(*) AS mentions FROM ${quoteIdent(table)} WHERE ${quoteIdent(String(fk.from))} = ? GROUP BY 1 LIMIT ${perTableLimit}`;
          sqlParts.push(sql);
          const found = this.select(db, sql, [value as SqlValue]);
          for (const row of found) {
            rows.push({
              fromTable: table,
              fromColumn: String(fk.from),
              ...row,
            });
          }
        }
      }
      return {
        columns: rows.length > 0 ? Object.keys(rows[0]) : ["fromTable", "fromColumn", "value", "mentions"],
        rows,
        rowCount: rows.length,
        command: "SELECT",
        sql: sqlParts.join(";\n"),
      };
    });
  }

  public async querySql(
    connection: SqliteConnection,
    _databaseName: string,
    sql: string,
  ): Promise<SqlQueryResult> {
    const trimmed = String(sql || "").trim();
    if (!trimmed) {
      throw new Error("SQL is empty.");
    }
    this.assertWritableIfMutating(connection, trimmed);
    return this.withUserActivity(
      connection.id,
      `Executando: ${trimmed}`,
      () =>
        this.withDatabase(connection, (db) => {
          const results: SqlQueryResult[] = [];
          const statements = db.exec(trimmed);
          if (statements.length === 0) {
            const result: SqlQueryResult = {
              columns: [],
              rows: [],
              rowCount: db.getRowsModified(),
              command: this.inferCommand(trimmed),
              results: [],
            };
            this.persistIfWritable(connection, db);
            return result;
          }
          for (const statement of statements) {
            results.push({
              columns: statement.columns,
              rows: statement.values.map((values) =>
                rowToObject(statement.columns, values),
              ),
              rowCount: statement.values.length,
              command: "SELECT",
            });
          }
          const last = results[results.length - 1];
          this.persistIfWritable(connection, db);
          return {
            ...last,
            results: results.length > 1 ? results : [],
          };
        }),
      (result, elapsedMs) => {
        if (result.columns.length > 0) {
          return `Result: ${result.rowCount} rows in ${elapsedMs}ms`;
        }
        return `Completed in ${elapsedMs}ms`;
      },
    );
  }

  public async executeSql(
    connection: SqliteConnection,
    databaseName: string,
    sql: string,
  ): Promise<void> {
    await this.querySql(connection, databaseName, sql);
  }

  public async truncateTable(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
  ): Promise<void> {
    this.assertWritable(connection);
    await this.withDatabase(connection, (db) => {
      db.run(`DELETE FROM ${quoteIdent(tableName)}`);
      this.persistLocked(connection.filePath, db);
    });
  }

  public async dropTable(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    tableName: string,
  ): Promise<void> {
    this.assertWritable(connection);
    await this.withDatabase(connection, (db) => {
      db.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      this.persistLocked(connection.filePath, db);
    });
  }

  public async getTriggerDefinition(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    triggerName: string,
  ): Promise<{ tableName: string; definition: string }> {
    return this.withDatabase(connection, (db) => {
      const rows = this.select(
        db,
        `SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
        [triggerName],
      );
      if (rows.length === 0) {
        throw new Error(`Trigger "${triggerName}" was not found.`);
      }
      return {
        tableName: String(rows[0].tbl_name),
        definition: String(rows[0].sql || ""),
      };
    });
  }

  public async dropTrigger(
    connection: SqliteConnection,
    _databaseName: string,
    _schemaName: string,
    triggerName: string,
  ): Promise<void> {
    this.assertWritable(connection);
    await this.withDatabase(connection, (db) => {
      db.run(`DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)}`);
      this.persistLocked(connection.filePath, db);
    });
  }

  public async buildTableDdl(
    connection: SqliteConnection,
    tableName: string,
  ): Promise<string> {
    return this.withDatabase(connection, (db) => {
      const rows = this.select(
        db,
        `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`,
        [tableName],
      );
      if (rows.length === 0) {
        throw new Error(`Table "${tableName}" was not found.`);
      }
      return rows
        .map((row) => String(row.sql || "").trim())
        .filter(Boolean)
        .map((sql) => (sql.endsWith(";") ? sql : `${sql};`))
        .join("\n\n") + "\n";
    });
  }

  public async dumpDatabase(
    connection: SqliteConnection,
    includeData: boolean,
  ): Promise<string> {
    return this.withDatabase(connection, (db) => {
      const objects = this.select(
        db,
        `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`,
      );
      const parts = ["BEGIN TRANSACTION;", "PRAGMA foreign_keys=OFF;"];
      for (const object of objects) {
        const sql = String(object.sql || "").trim();
        if (sql) {
          parts.push(sql.endsWith(";") ? sql : `${sql};`);
        }
      }
      if (includeData) {
        const tables = objects
          .filter((object) => object.type === "table")
          .map((object) => String(object.name));
        for (const table of tables) {
          const rows = this.select(db, `SELECT * FROM ${quoteIdent(table)}`);
          for (const row of rows) {
            const columns = Object.keys(row);
            const values = columns.map((column) => this.sqlLiteral(row[column]));
            parts.push(
              `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${values.join(", ")});`,
            );
          }
        }
      }
      parts.push("COMMIT;");
      return `${parts.join("\n")}\n`;
    });
  }

  public async getDashboardStats(
    connection: SqliteConnection,
  ): Promise<SqliteDashboardStats> {
    const stat = await fs.stat(connection.filePath);
    return this.withDatabase(connection, (db) => {
      const version = String(
        this.select(db, "SELECT sqlite_version() AS version")[0]?.version || "unknown",
      );
      const pageCount = Number(
        this.pragma(db, "PRAGMA page_count")[0]?.page_count ??
          this.select(db, "PRAGMA page_count")[0]?.["page_count"] ??
          (Object.values(this.select(db, "PRAGMA page_count")[0] || {})[0] || 0),
      );
      const pageSize = Number(
        Object.values(this.select(db, "PRAGMA page_size")[0] || {})[0] || 0,
      );
      const freelistCount = Number(
        Object.values(this.select(db, "PRAGMA freelist_count")[0] || {})[0] || 0,
      );
      const tableCount = this.select(
        db,
        `SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      );
      return {
        version: `SQLite ${version}`,
        filePath: connection.filePath,
        fileSizeBytes: stat.size,
        pageCount,
        pageSize,
        freelistCount,
        tableCount: Number(tableCount[0]?.total || 0),
      };
    });
  }

  public closeFile(filePath: string): void {
    const key = this.normalizePath(filePath);
    const db = this.databases.get(key);
    if (db) {
      db.close();
      this.databases.delete(key);
    }
  }

  private readTableColumns(db: Database, tableName: string): TableColumnMeta[] {
    const columns = this.pragma(db, `PRAGMA table_info(${quoteIdent(tableName)})`);
    const fks = this.pragma(db, `PRAGMA foreign_key_list(${quoteIdent(tableName)})`);
    const uniqueIndexes = this.pragma(
      db,
      `PRAGMA index_list(${quoteIdent(tableName)})`,
    ).filter((row) => Number(row.unique) === 1);
    const uniqueColumns = new Set<string>();
    for (const index of uniqueIndexes) {
      const info = this.pragma(db, `PRAGMA index_info(${quoteIdent(String(index.name))})`);
      if (info.length === 1) {
        uniqueColumns.add(String(info[0].name));
      }
    }
    const fkByColumn = new Map<string, { table: string; to: string }>();
    for (const fk of fks) {
      fkByColumn.set(String(fk.from), { table: String(fk.table), to: String(fk.to) });
    }
    return columns.map((row) => {
      const name = String(row.name);
      const fk = fkByColumn.get(name);
      return {
        name,
        dataType: String(row.type || "ANY"),
        isNullable: Number(row.notnull) === 0,
        hasDefault: row.dflt_value != null,
        isPrimaryKey: Number(row.pk) > 0,
        isUnique: uniqueColumns.has(name),
        isForeignKey: Boolean(fk),
        foreignKeyTargetSchema: fk ? SQLITE_SCHEMA : null,
        foreignKeyTargetTable: fk?.table ?? null,
        foreignKeyTargetColumn: fk?.to ?? null,
      };
    });
  }

  private select(
    db: Database,
    sql: string,
    params: SqlValue[] = [],
  ): Array<Record<string, unknown>> {
    const stmt = db.prepare(sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      const rows: Array<Record<string, unknown>> = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as Record<string, unknown>);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private pragma(db: Database, sql: string): Array<Record<string, unknown>> {
    return this.select(db, sql);
  }

  private async withDatabase<T>(
    connection: SqliteConnection,
    fn: (db: Database) => T | Promise<T>,
    options?: { persist?: boolean },
  ): Promise<T> {
    await this.ensureSqlJs();
    const key = this.normalizePath(connection.filePath);
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeQueues.set(key, previous.then(() => next));
    await previous;
    try {
      const db = await this.openDatabase(connection);
      const result = await fn(db);
      if (options?.persist) {
        this.persistIfWritable(connection, db);
      }
      return result;
    } finally {
      release();
    }
  }

  private async openDatabase(connection: SqliteConnection): Promise<Database> {
    const SQL = await this.ensureSqlJs();
    const key = this.normalizePath(connection.filePath);
    const existing = this.databases.get(key);
    if (existing) {
      return existing;
    }
    await fs.mkdir(path.dirname(connection.filePath), { recursive: true });
    let db: Database;
    try {
      const buffer = await fs.readFile(connection.filePath);
      if (buffer.length === 0) {
        log(`SQLite file is empty, creating a new database: ${connection.filePath}`);
        db = new SQL.Database();
        if (!connection.readOnly) {
          this.persistLocked(connection.filePath, db);
        }
      } else if (!isSqliteDatabaseBuffer(buffer)) {
        throw new Error(
          `File is not a SQLite database: ${connection.filePath}`,
        );
      } else {
        db = new SQL.Database(buffer);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      log(`SQLite file not found, creating: ${connection.filePath}`);
      db = new SQL.Database();
      if (!connection.readOnly) {
        this.persistLocked(connection.filePath, db);
      }
    }
    try {
      db.run("PRAGMA foreign_keys = ON");
    } catch {
      // ignore
    }
    this.databases.set(key, db);
    return db;
  }

  private persistIfWritable(connection: SqliteConnection, db: Database): void {
    if (connection.readOnly) {
      return;
    }
    this.persistLocked(connection.filePath, db);
  }

  private persistLocked(filePath: string, db: Database): void {
    const data = db.export();
    fsSync.writeFileSync(filePath, Buffer.from(data));
  }

  private async ensureSqlJs(): Promise<SqlJsStatic> {
    if (this.sqlJs) {
      return this.sqlJs;
    }
    if (!this.initPromise) {
      this.initPromise = this.loadSqlJs().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    this.sqlJs = await this.initPromise;
    return this.sqlJs;
  }

  private async loadSqlJs(): Promise<SqlJsStatic> {
    const wasmPath = locateSqlJsAsset(this.extensionPath, "sql-wasm.wasm");
    log(`Initializing sql.js from ${wasmPath}`);
    if (!fsSync.existsSync(wasmPath)) {
      throw new Error(`sql.js WASM file was not found: ${wasmPath}`);
    }
    const wasmFile = fsSync.readFileSync(wasmPath);
    const wasmBinary = wasmFile.buffer.slice(
      wasmFile.byteOffset,
      wasmFile.byteOffset + wasmFile.byteLength,
    );
    try {
      const sqlJs = await initSqlJs({ wasmBinary });
      log("sql.js initialized");
      return sqlJs;
    } catch (error) {
      logError("Failed to initialize sql.js", error);
      throw error;
    }
  }

  private normalizePath(filePath: string): string {
    return path.normalize(filePath).toLowerCase();
  }

  private assertWritable(connection: SqliteConnection): void {
    if (connection.readOnly) {
      throw new Error("This SQLite connection is read-only.");
    }
  }

  private assertWritableIfMutating(connection: SqliteConnection, sql: string): void {
    if (!connection.readOnly) {
      return;
    }
    const command = this.inferCommand(sql);
    if (command !== "SELECT" && command !== "PRAGMA" && command !== "EXPLAIN") {
      this.assertWritable(connection);
    }
  }

  private inferCommand(sql: string): string {
    const match = sql.trim().match(/^([A-Za-z]+)/);
    return (match?.[1] || "").toUpperCase();
  }

  private sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL";
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }
    if (value instanceof Uint8Array) {
      return `X'${Buffer.from(value).toString("hex")}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private async withUserActivity<T>(
    connectionId: string,
    executing: string,
    fn: () => Promise<T>,
    resultMessage: (result: T, elapsedMs: number) => string,
  ): Promise<T> {
    const started = Date.now();
    this.activityLog?.append(connectionId, "executing", executing);
    try {
      const result = await fn();
      const elapsedMs = Date.now() - started;
      const message = resultMessage(result, elapsedMs);
      this.activityLog?.append(
        connectionId,
        message.startsWith("Result:") ? "result" : "completed",
        message,
      );
      return result;
    } catch (error) {
      this.activityLog?.append(
        connectionId,
        "fail",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
