import * as vscode from "vscode";
import { DbObjectNodeRef } from "../models";
import {
  DEFAULT_PAGE_SIZE_SETTING,
  TableLayoutState,
  TableState,
  TableWebviewSession,
} from "./types";

export function getConfiguredDefaultPageSize(): number {
  const configured = vscode.workspace
    .getConfiguration()
    .get<number>(DEFAULT_PAGE_SIZE_SETTING, 50);
  const numeric = Number(configured);
  if (!Number.isFinite(numeric)) {
    return 50;
  }
  return Math.max(1, Math.min(500, Math.trunc(numeric)));
}

export function createDefaultTableState(defaultPageSize: number): TableState {
  return {
    searchText: "",
    searchMode: "local",
    sortColumn: undefined,
    sortDirection: undefined,
    columnFilters: {},
    limit: defaultPageSize,
    page: 1,
  };
}

export function cloneTableStateWithPageSize(
  state: TableState,
  defaultPageSize: number,
): TableState {
  return {
    searchText: String(state.searchText || ""),
    searchMode: state.searchMode === "query" ? "query" : "local",
    sortColumn: state.sortColumn,
    sortDirection: state.sortDirection,
    columnFilters: { ...(state.columnFilters || {}) },
    limit: Number.isFinite(Number(state.limit))
      ? Math.max(1, Math.trunc(Number(state.limit)))
      : defaultPageSize,
    page: Number.isFinite(Number(state.page))
      ? Math.max(1, Math.trunc(Number(state.page)))
      : 1,
  };
}

export function buildTableLayoutStorageKey(node: DbObjectNodeRef): string {
  return [
    "dbadmin.tableLayout",
    node.connection.id,
    node.databaseName,
    node.schemaName,
    node.objectName,
  ].join(":");
}

export function readStoredLayout(
  context: vscode.ExtensionContext,
  node: DbObjectNodeRef,
): TableLayoutState | undefined {
  return context.globalState.get<TableLayoutState>(
    buildTableLayoutStorageKey(node),
  );
}

export async function persistLayout(
  context: vscode.ExtensionContext,
  node: DbObjectNodeRef,
  layout: TableLayoutState,
): Promise<void> {
  await context.globalState.update(buildTableLayoutStorageKey(node), layout);
}

export function parseTableWebviewSession(
  raw: unknown,
): TableWebviewSession | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Partial<TableWebviewSession>;
  const connectionId = String(value.connectionId || "").trim();
  const databaseName = String(value.databaseName || "").trim();
  const schemaName = String(value.schemaName || "").trim();
  const objectName = String(value.objectName || "").trim();
  if (!connectionId || !databaseName || !schemaName || !objectName) {
    return undefined;
  }

  return {
    connectionId,
    databaseName,
    schemaName,
    objectName,
    newTab: Boolean(value.newTab),
    layout: value.layout,
    state: value.state,
  };
}
