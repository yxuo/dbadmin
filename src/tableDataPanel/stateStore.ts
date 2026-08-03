import * as vscode from "vscode";
import { DbObjectNodeRef } from "../models";
import {
  DEFAULT_PAGE_SIZE_SETTING,
  TableLayoutState,
  TableState,
} from "./types";

export interface StoredOpenTab {
  connectionId: string;
  databaseName: string;
  schemaName: string;
  objectName: string;
  newTab: boolean;
  layout?: TableLayoutState;
  state?: TableState;
}

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

export async function persistOpenTabs(
  context: vscode.ExtensionContext,
  openTabs: StoredOpenTab[],
): Promise<void> {
  await context.globalState.update("dbadmin.openTabs", openTabs);
}

export function getStoredOpenTabs(
  context: vscode.ExtensionContext,
): StoredOpenTab[] {
  return context.globalState.get("dbadmin.openTabs", []) as StoredOpenTab[];
}

export function buildOpenTabsSnapshot(
  panelNodes: Map<vscode.WebviewPanel, DbObjectNodeRef>,
  panelIsNewTab: Map<vscode.WebviewPanel, boolean>,
  panelLayouts: Map<vscode.WebviewPanel, TableLayoutState>,
  panelStates: Map<vscode.WebviewPanel, TableState>,
  cloneTableState: (state: TableState) => TableState,
  defaultState: TableState,
): StoredOpenTab[] {
  const openTabs: StoredOpenTab[] = [];

  for (const [panel, node] of panelNodes.entries()) {
    if (!node || !node.connection) {
      continue;
    }

    openTabs.push({
      connectionId: node.connection.id,
      databaseName: node.databaseName,
      schemaName: node.schemaName,
      objectName: node.objectName,
      newTab: panelIsNewTab.get(panel) ?? false,
      layout: panelLayouts.get(panel),
      state: cloneTableState(panelStates.get(panel) ?? defaultState),
    });
  }

  return openTabs;
}
