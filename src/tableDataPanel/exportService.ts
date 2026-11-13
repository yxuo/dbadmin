import { DbObjectNodeRef } from "../models";
import { PostgresService } from "../postgresService";
import { DatabaseService } from "../engines/databaseService";
import { TableState } from "./types";

export async function fetchAllRowsForExport(
  postgresService: DatabaseService,
  node: DbObjectNodeRef,
  state: TableState,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  const rows: Array<Record<string, unknown>> = [];
  let columns: string[] = [];
  let totalRows = 0;
  let page = 1;
  const limit = 500;

  while (true) {
    const result = await postgresService.getTableData(
      node.connection,
      node.databaseName,
      node.schemaName,
      node.objectName,
      {
        searchText: state.searchText,
        searchMode: state.searchMode,
        sortColumn: state.sortColumn,
        sortDirection: state.sortDirection,
        columnFilters: state.columnFilters,
        limit,
        page,
      },
    );

    if (page === 1) {
      columns = result.columns.map((column) => column.name);
      totalRows = Number(result.totalRows || 0);
    }

    rows.push(...result.rows);

    if (result.rows.length === 0 || rows.length >= totalRows) {
      break;
    }

    page += 1;
  }

  return { columns, rows };
}

export function buildExportContent(
  format: "json" | "csv",
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const normalizedColumns = columns.filter((columnName) => Boolean(columnName));

  const pickRowValues = (
    row: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (normalizedColumns.length === 0) {
      return { ...row };
    }

    const picked: Record<string, unknown> = {};
    normalizedColumns.forEach((columnName) => {
      picked[columnName] = row[columnName];
    });
    return picked;
  };

  if (format === "json") {
    return JSON.stringify(
      rows.map((row) => pickRowValues(row)),
      null,
      2,
    );
  }

  const escapeCsv = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }

    const text =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    if (!/[",\n\r]/.test(text)) {
      return text;
    }

    return `"${text.replace(/"/g, '""')}"`;
  };

  const header = normalizedColumns
    .map((columnName) => escapeCsv(columnName))
    .join(",");
  const lines = rows.map((row) => {
    const source = pickRowValues(row);
    return normalizedColumns
      .map((columnName) => escapeCsv(source[columnName]))
      .join(",");
  });

  return [header, ...lines].join("\n");
}
