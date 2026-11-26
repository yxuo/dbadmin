import * as vscode from "vscode";

const CHANNEL_NAME = "DBAdmin";

let channel: vscode.OutputChannel | undefined;

export function initDbAdminOutput(
  context: vscode.ExtensionContext,
): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  context.subscriptions.push(channel);
  log("Extension activated");
  return channel;
}

export function log(message: string, extra?: unknown): void {
  append("info", message, extra);
}

export function logError(message: string, error?: unknown): void {
  append("error", message, error);
}

export function revealOutput(preserveFocus = true): void {
  channel?.show(preserveFocus);
}

function append(level: "info" | "error", message: string, extra?: unknown): void {
  if (!channel) {
    return;
  }
  const time = new Date().toISOString();
  const suffix = extra === undefined ? "" : ` ${stringifyExtra(extra)}`;
  channel.appendLine(`[${time}] [${level}] ${message}${suffix}`);
}

function stringifyExtra(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
