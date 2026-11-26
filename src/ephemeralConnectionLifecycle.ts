import * as path from "node:path";
import * as vscode from "vscode";
import { ConnectionStore } from "./connectionStore";
import { DatabaseTreeProvider } from "./databaseTreeProvider";
import { isSqliteConnection } from "./models";

const SQLITE_EDITOR_VIEW_TYPE = "dbadmin.sqliteEditor";
const RECONCILE_MS = 200;

export class EphemeralConnectionLifecycle implements vscode.Disposable {
  private readonly owners = new Map<string, Set<string>>();
  private readonly panelKeys = new WeakMap<vscode.WebviewPanel, { connectionId: string; key: string }>();
  private readonly documentKeys = new Map<string, { connectionId: string; key: string }>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private keySeq = 0;

  public constructor(
    private readonly store: ConnectionStore,
    private readonly treeProvider: DatabaseTreeProvider,
    private readonly closeSqliteFile: (filePath: string) => void,
  ) {
    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleReconcile()),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.releaseDocument(document);
      }),
    );
  }

  public bindPanel(panel: vscode.WebviewPanel, connectionId: string): void {
    const current = this.panelKeys.get(panel);
    if (current?.connectionId === connectionId) {
      return;
    }
    if (current) {
      this.release(current.connectionId, current.key);
    }
    const key = `panel:${++this.keySeq}`;
    this.panelKeys.set(panel, { connectionId, key });
    this.retain(connectionId, key);
  }

  public unbindPanel(panel: vscode.WebviewPanel): void {
    const current = this.panelKeys.get(panel);
    if (!current) {
      this.scheduleReconcile();
      return;
    }
    this.panelKeys.delete(panel);
    this.release(current.connectionId, current.key);
  }

  public bindDocument(document: vscode.TextDocument, connectionId: string): void {
    const uri = document.uri.toString();
    const current = this.documentKeys.get(uri);
    if (current?.connectionId === connectionId) {
      return;
    }
    if (current) {
      this.release(current.connectionId, current.key);
    }
    const key = `doc:${++this.keySeq}`;
    this.documentKeys.set(uri, { connectionId, key });
    this.retain(connectionId, key);
  }

  public scheduleReconcile(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile();
    }, RECONCILE_MS);
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const item of this.subscriptions) {
      item.dispose();
    }
  }

  private retain(connectionId: string, key: string): void {
    let keys = this.owners.get(connectionId);
    if (!keys) {
      keys = new Set();
      this.owners.set(connectionId, keys);
    }
    keys.add(key);
  }

  private release(connectionId: string, key: string): void {
    const keys = this.owners.get(connectionId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.owners.delete(connectionId);
      }
    }
    this.scheduleReconcile();
  }

  private releaseDocument(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const current = this.documentKeys.get(uri);
    if (!current) {
      return;
    }
    this.documentKeys.delete(uri);
    this.release(current.connectionId, current.key);
  }

  private openSqliteEditorPaths(): Set<string> {
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputCustom &&
          input.viewType === SQLITE_EDITOR_VIEW_TYPE &&
          input.uri.scheme === "file"
        ) {
          paths.add(this.normalizePath(input.uri.fsPath));
        }
      }
    }
    return paths;
  }

  private async reconcile(): Promise<void> {
    const editorPaths = this.openSqliteEditorPaths();
    const connections = await this.store.listConnections();
    let dropped = false;
    for (const connection of connections) {
      if (!isSqliteConnection(connection) || !connection.ephemeral) {
        continue;
      }
      const hasOwners = (this.owners.get(connection.id)?.size ?? 0) > 0;
      const hasEditor = editorPaths.has(this.normalizePath(connection.filePath));
      if (hasOwners || hasEditor) {
        continue;
      }
      await this.store.deleteConnection(connection.id);
      this.closeSqliteFile(connection.filePath);
      dropped = true;
    }
    if (dropped) {
      this.treeProvider.refresh();
    }
  }

  private normalizePath(filePath: string): string {
    return path.normalize(filePath).toLowerCase();
  }
}
