import * as vscode from "vscode";

export const SHOW_QUERY_SETTING = "dbadmin.showQueryEditor";
export const HIDE_TAB_HEADER_SETTING = "dbadmin.hideTabHeader";
export const PERSIST_LAYOUT_SETTING = "dbadmin.persistColumnLayout";
export const DEFAULT_PAGE_SIZE_SETTING = "dbadmin.defaultPageSize";
export const DYNAMIC_DEFAULT_COLUMN_WIDTH_SETTING =
  "dbadmin.dynamicDefaultColumnWidth";
export const SQLBOOK_INTEGRATED_TABLE_SETTING =
  "dbadmin.sqlbookIntegratedTable";

export class PanelConfig {
  public getShowQueryEditor(): boolean {
    return vscode.workspace
      .getConfiguration()
      .get<boolean>(SHOW_QUERY_SETTING, true);
  }

  public getHideTabHeader(): boolean {
    return vscode.workspace
      .getConfiguration()
      .get<boolean>(HIDE_TAB_HEADER_SETTING, false);
  }

  public getPersistLayoutOutsideRestore(): boolean {
    return vscode.workspace
      .getConfiguration()
      .get<boolean>(PERSIST_LAYOUT_SETTING, false);
  }

  public getDefaultPageSize(): number {
    const configured = vscode.workspace
      .getConfiguration()
      .get<number>(DEFAULT_PAGE_SIZE_SETTING, 50);
    const numeric = Number(configured);
    if (!Number.isFinite(numeric)) {
      return 50;
    }
    return Math.max(1, Math.min(500, Math.trunc(numeric)));
  }

  public getDynamicDefaultColumnWidth(): boolean {
    return vscode.workspace
      .getConfiguration()
      .get<boolean>(DYNAMIC_DEFAULT_COLUMN_WIDTH_SETTING, true);
  }
}
