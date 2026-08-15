import * as vscode from "vscode";
import { WebviewMessage } from "./types";

/**
 * Contexto passado para handlers de mensagens do webview.
 * Permite acesso ao painel, à mensagem atual e a callbacks de resposta.
 */
export interface MessageHandlerContext {
  panel: vscode.WebviewPanel;
  message: WebviewMessage;
  sendStatus: (kind: "ok" | "error", message: string) => void;
  sendResponse: (response: unknown) => void;
}

/**
 * Tipo de handler para um tipo específico de mensagem.
 * Retorna true se a mensagem foi processada, false se deve ser delegada.
 */
export type MessageHandler = (context: MessageHandlerContext) => Promise<void>;

/**
 * Mapa de handlers por tipo de mensagem.
 */
export interface MessageHandlers {
  ready?: MessageHandler;
  reload?: MessageHandler;
  updateState?: MessageHandler;
  save?: MessageHandler;
  exportData?: MessageHandler;
  copyAdvancedClipboard?: MessageHandler;
  openInNewTab?: MessageHandler;
  openSettings?: MessageHandler;
  showInExplorer?: MessageHandler;
  openJsonInNativeEditor?: MessageHandler;
  syncNativeJsonPreview?: MessageHandler;
  openForeignKeyTarget?: MessageHandler;
  searchForeignKeyMentions?: MessageHandler;
  openConnectionManager?: MessageHandler;
  updateLayout?: MessageHandler;
  loadDiagram?: MessageHandler;
  exportDiagram?: MessageHandler;
  openDiagramTableInNewTab?: MessageHandler;
}

/**
 * Roteador de mensagens do webview.
 * Despacha mensagens para handlers apropriados com tratamento de erro centralizado.
 */
export class MessageRouter {
  constructor(private readonly handlers: MessageHandlers) {}

  /**
   * Processa uma mensagem do webview, roteando para o handler apropriado.
   */
  public async handleMessage(
    panel: vscode.WebviewPanel,
    message: WebviewMessage,
  ): Promise<void> {
    const sendStatus = (kind: "ok" | "error", text: string): void => {
      panel.webview.postMessage({
        type: "status",
        kind,
        message: text,
      });
    };

    const sendResponse = (response: unknown): void => {
      panel.webview.postMessage(response);
    };

    const context: MessageHandlerContext = {
      panel,
      message,
      sendStatus,
      sendResponse,
    };

    try {
      const handler = this.getHandlerForMessage(message);
      if (handler) {
        await handler(context);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Erro inesperado";
      sendStatus("error", errorMessage);
    }
  }

  /**
   * Retorna o handler para um tipo específico de mensagem.
   */
  private getHandlerForMessage(
    message: WebviewMessage,
  ): MessageHandler | undefined {
    switch (message.type) {
      case "ready":
        return this.handlers.ready;
      case "reload":
        return this.handlers.reload;
      case "updateState":
        return this.handlers.updateState;
      case "save":
        return this.handlers.save;
      case "exportData":
        return this.handlers.exportData;
      case "copyAdvancedClipboard":
        return this.handlers.copyAdvancedClipboard;
      case "openInNewTab":
        return this.handlers.openInNewTab;
      case "openSettings":
        return this.handlers.openSettings;
      case "showInExplorer":
        return this.handlers.showInExplorer;
      case "openJsonInNativeEditor":
        return this.handlers.openJsonInNativeEditor;
      case "syncNativeJsonPreview":
        return this.handlers.syncNativeJsonPreview;
      case "openForeignKeyTarget":
        return this.handlers.openForeignKeyTarget;
      case "searchForeignKeyMentions":
        return this.handlers.searchForeignKeyMentions;
      case "openConnectionManager":
        return this.handlers.openConnectionManager;
      case "updateLayout":
        return this.handlers.updateLayout;
      case "loadDiagram":
        return this.handlers.loadDiagram;
      case "exportDiagram":
        return this.handlers.exportDiagram;
      case "openDiagramTableInNewTab":
        return this.handlers.openDiagramTableInNewTab;
      default:
        return undefined;
    }
  }
}
