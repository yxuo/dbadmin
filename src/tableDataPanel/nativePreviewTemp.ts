import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export function formatPreviewJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function sanitizePreviewFileNamePart(value: string): string {
  const sanitized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "na";
}

export function buildNativePreviewFilePrefix(
  tableName: string,
  tabId: string,
): string {
  const tablePart = sanitizePreviewFileNamePart(tableName);
  const tabPart = sanitizePreviewFileNamePart(tabId);
  return `${tablePart}_dbadmin_${tabPart}`;
}

export function cleanupNativePreviewTempFilesByPrefix(
  prefix: string,
  keepPath?: string,
): void {
  try {
    const tmpDir = os.tmpdir();
    const keep = keepPath ? path.normalize(keepPath).toLowerCase() : null;
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const isTarget =
        entry.startsWith(prefix) &&
        (entry.endsWith(".json") || entry.endsWith(".txt"));
      if (!isTarget) {
        continue;
      }
      const fullPath = path.join(tmpDir, entry);
      const normalized = path.normalize(fullPath).toLowerCase();
      if (keep && normalized === keep) {
        continue;
      }
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Ignore inaccessible files during prefix cleanup.
      }
    }
  } catch {
    // Ignore cleanup issues.
  }
}

export async function createNativePreviewTempDocument(
  content: string,
  tmpFilePrefix: string,
): Promise<{
  document: vscode.TextDocument;
  tmpFilePath: string;
  tmpFilePrefix: string;
}> {
  const formattedContent = formatPreviewJson(String(content ?? ""));
  const extension = "preview";
  const tmpFilePath = path.join(os.tmpdir(), `${tmpFilePrefix}.${extension}`);
  fs.writeFileSync(tmpFilePath, formattedContent, "utf8");
  const openedDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(tmpFilePath),
  );
  const document = await vscode.languages.setTextDocumentLanguage(
    openedDocument,
    "json",
  );
  return { document, tmpFilePath, tmpFilePrefix };
}

export function cleanupStaleNativePreviewTempFiles(): void {
  try {
    const tmpDir = os.tmpdir();
    const openDocs = new Set(
      vscode.workspace.textDocuments.map((doc) =>
        path.normalize(doc.uri.fsPath).toLowerCase(),
      ),
    );
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const isNamedByPrefix = entry.includes("_dbadmin_");
      if (!isNamedByPrefix) {
        continue;
      }
      if (
        !entry.endsWith(".json") &&
        !entry.endsWith(".txt") &&
        !entry.endsWith(".preview")
      ) {
        continue;
      }
      const fullPath = path.join(tmpDir, entry);
      const normalized = path.normalize(fullPath).toLowerCase();
      if (openDocs.has(normalized)) {
        continue;
      }
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Ignore inaccessible files in temp cleanup.
      }
    }
  } catch {
    // Ignore temp cleanup issues.
  }
}
