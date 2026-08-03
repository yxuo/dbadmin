import * as vscode from "vscode";
import { DbObjectNodeRef } from "../models";
import { NativeJsonPreviewState, TableLayoutState, TableState } from "./types";

export class PanelRegistry {
  // Painéis reutilizáveis (chave global ou por painel)
  private readonly reusedPanels = new Map<string, vscode.WebviewPanel>();

  // Mapeamento de painel para o node da tabela atual
  private readonly panelNodes = new Map<vscode.WebviewPanel, DbObjectNodeRef>();

  private readonly panelIsNewTab = new Map<vscode.WebviewPanel, boolean>();

  // Layout persistente por painel (coluna, ordem, largura)
  private readonly panelLayouts = new Map<
    vscode.WebviewPanel,
    TableLayoutState
  >();

  // Estado da tabela por painel (filtros, sort, paginação)
  private readonly panelStates = new Map<vscode.WebviewPanel, TableState>();

  // ID único do preview tab (para geração de filename temporário)
  private readonly panelPreviewTabIds = new Map<vscode.WebviewPanel, string>();

  // Estado do editor de preview JSON nativo
  private readonly panelNativePreview = new Map<
    vscode.WebviewPanel,
    NativeJsonPreviewState
  >();

  // Mapa reverso: URI do documento de preview → painel que o abriu
  private readonly nativePreviewDocumentToPanel = new Map<
    string,
    vscode.WebviewPanel
  >();

  private previewTabIdSequence = 1;

  // === Operações de painel reutilizável ===
  public getReusedPanel(key: string): vscode.WebviewPanel | undefined {
    return this.reusedPanels.get(key);
  }

  public setReusedPanel(key: string, panel: vscode.WebviewPanel): void {
    this.reusedPanels.set(key, panel);
  }

  public deleteReusedPanel(key: string): void {
    this.reusedPanels.delete(key);
  }

  // === Operações de node (tabela referenciada) ===
  public getNode(panel: vscode.WebviewPanel): DbObjectNodeRef | undefined {
    return this.panelNodes.get(panel);
  }

  public setNode(panel: vscode.WebviewPanel, node: DbObjectNodeRef): void {
    this.panelNodes.set(panel, node);
  }

  public deleteNode(panel: vscode.WebviewPanel): void {
    this.panelNodes.delete(panel);
  }

  // === Operações de tipo de aba ===
  public isNewTab(panel: vscode.WebviewPanel): boolean {
    return this.panelIsNewTab.get(panel) ?? false;
  }

  public setIsNewTab(panel: vscode.WebviewPanel, isNew: boolean): void {
    this.panelIsNewTab.set(panel, isNew);
  }

  public deleteIsNewTab(panel: vscode.WebviewPanel): void {
    this.panelIsNewTab.delete(panel);
  }

  // === Operações de layout ===
  public getLayout(panel: vscode.WebviewPanel): TableLayoutState | undefined {
    return this.panelLayouts.get(panel);
  }

  public setLayout(panel: vscode.WebviewPanel, layout: TableLayoutState): void {
    this.panelLayouts.set(panel, layout);
  }

  public deleteLayout(panel: vscode.WebviewPanel): void {
    this.panelLayouts.delete(panel);
  }

  // === Operações de estado da tabela ===
  public getState(panel: vscode.WebviewPanel): TableState | undefined {
    return this.panelStates.get(panel);
  }

  public setState(panel: vscode.WebviewPanel, state: TableState): void {
    this.panelStates.set(panel, state);
  }

  public deleteState(panel: vscode.WebviewPanel): void {
    this.panelStates.delete(panel);
  }

  // === Operações de id de preview tab ===
  public getPreviewTabId(panel: vscode.WebviewPanel): string | undefined {
    return this.panelPreviewTabIds.get(panel);
  }

  public setPreviewTabId(panel: vscode.WebviewPanel, id: string): void {
    this.panelPreviewTabIds.set(panel, id);
  }

  public deletePreviewTabId(panel: vscode.WebviewPanel): void {
    this.panelPreviewTabIds.delete(panel);
  }

  public generatePreviewTabId(): string {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    this.previewTabIdSequence += 1;
    return id;
  }

  // === Operações de estado do preview nativo ===
  public getNativePreview(
    panel: vscode.WebviewPanel,
  ): NativeJsonPreviewState | undefined {
    return this.panelNativePreview.get(panel);
  }

  public setNativePreview(
    panel: vscode.WebviewPanel,
    state: NativeJsonPreviewState,
  ): void {
    this.panelNativePreview.set(panel, state);
  }

  public deleteNativePreview(panel: vscode.WebviewPanel): void {
    this.panelNativePreview.delete(panel);
  }

  // === Operações de mapa reverso (documento → painel) ===
  public getPanelByPreviewDocument(
    uri: string,
  ): vscode.WebviewPanel | undefined {
    return this.nativePreviewDocumentToPanel.get(uri);
  }

  public setPreviewDocumentPanel(
    uri: string,
    panel: vscode.WebviewPanel,
  ): void {
    this.nativePreviewDocumentToPanel.set(uri, panel);
  }

  public deletePreviewDocumentPanel(uri: string): void {
    this.nativePreviewDocumentToPanel.delete(uri);
  }

  // === Operações de iteração e snapshot ===
  public getAllNodes(): IterableIterator<
    [vscode.WebviewPanel, DbObjectNodeRef]
  > {
    return this.panelNodes.entries();
  }

  public getAllIsNewTab(): IterableIterator<[vscode.WebviewPanel, boolean]> {
    return this.panelIsNewTab.entries();
  }

  public getAllLayouts(): IterableIterator<
    [vscode.WebviewPanel, TableLayoutState]
  > {
    return this.panelLayouts.entries();
  }

  public getAllStates(): IterableIterator<[vscode.WebviewPanel, TableState]> {
    return this.panelStates.entries();
  }

  // === Limpeza de painel ===
  public clearPanel(panel: vscode.WebviewPanel): void {
    this.panelNodes.delete(panel);
    this.panelIsNewTab.delete(panel);
    this.panelLayouts.delete(panel);
    this.panelStates.delete(panel);
    this.panelPreviewTabIds.delete(panel);
  }
}
