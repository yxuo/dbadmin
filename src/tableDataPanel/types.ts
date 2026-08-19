import * as vscode from "vscode";
import { DbObjectNodeRef } from "../models";
import {
  TableColumnMeta,
  TableSavePayload,
  TableSortDirection,
} from "../postgresService";

export interface OpenTableInput {
  node: DbObjectNodeRef;
  newTab: boolean;
  restoringOnStartup?: boolean;
  layout?: TableLayoutState;
  initialState?: TableState;
}

export interface TableWebviewSession {
  connectionId: string;
  databaseName: string;
  schemaName: string;
  objectName: string;
  newTab: boolean;
  layout?: TableLayoutState;
  state?: TableState;
}

export interface TableState {
  searchText: string;
  searchMode: "local" | "query";
  sortColumn?: string;
  sortDirection?: TableSortDirection;
  columnFilters: Record<string, string>;
  limit: number;
  page: number;
}

export interface TableLayoutState {
  columnOrder: string[];
  visibleColumns: string[];
  columnWidths: Record<string, number>;
}

export type WebviewMessage =
  | { type: "ready" }
  | { type: "reload"; state: TableState; clearSelectionAndPreview?: boolean }
  | { type: "updateState"; state: TableState }
  | { type: "save"; state: TableState; payload: TableSavePayload }
  | {
      type: "exportData";
      format: "json" | "csv";
      dataScope: "result" | "all" | "selected";
      state: TableState;
      columns: string[];
      rows: Array<Record<string, unknown>>;
    }
  | {
      type: "copyAdvancedClipboard";
      format: "json" | "csv";
      columns: string[];
      rows: Array<Record<string, unknown>>;
    }
  | { type: "openInNewTab" }
  | { type: "togglePin" }
  | { type: "openSettings" }
  | { type: "showInExplorer" }
  | { type: "showTableDdl" }
  | {
      type: "openJsonInNativeEditor";
      content: string;
      columnName: string;
      isJson?: boolean;
      ctid?: string | null;
      rowKey?: string | null;
      preserveFocus?: boolean;
    }
  | {
      type: "syncNativeJsonPreview";
      content: string;
      columnName: string;
      isJson?: boolean;
      ctid?: string | null;
      rowKey?: string | null;
      open?: boolean;
    }
  | {
      type: "openForeignKeyTarget";
      sourceValue: string;
      targetSchemaName: string;
      targetTableName: string;
      targetColumnName: string;
    }
  | {
      type: "searchForeignKeyMentions";
      sourceValue: string;
      targetSchemaName: string;
      targetTableName: string;
      targetColumnName: string;
    }
  | { type: "toggleIntegratedTable" }
  | { type: "openConnectionManager" }
  | { type: "updateLayout"; layout: TableLayoutState }
  | { type: "loadDiagram"; mainColumns?: TableColumnMeta[] }
  | {
      type: "exportDiagram";
      format: "png" | "drawio";
      target: "file" | "clipboard";
      data: string;
      tableName: string;
    }
  | { type: "openDiagramTableInNewTab"; schemaName: string; tableName: string };

export interface NativeJsonPreviewState {
  document: vscode.TextDocument;
  tmpFilePath: string;
  tmpFilePrefix: string;
  isJson: boolean;
  ctid: string | null;
  rowKey: string | null;
  columnName: string;
  viewColumn?: vscode.ViewColumn;
}

export const GLOBAL_REUSED_KEY = "__global__";
export const PERSIST_LAYOUT_SETTING = "dbadmin.persistColumnLayout";
export const DEFAULT_PAGE_SIZE_SETTING = "dbadmin.defaultPageSize";
export const DYNAMIC_DEFAULT_COLUMN_WIDTH_SETTING =
  "dbadmin.dynamicDefaultColumnWidth";
export const SQLBOOK_INTEGRATED_TABLE_SETTING =
  "dbadmin.sqlbookIntegratedTable";
