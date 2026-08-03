import * as vscode from "vscode";

export async function closeDocumentTabByUri(uri: vscode.Uri): Promise<void> {
  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((candidate) => {
      const input = candidate.input;
      return (
        input instanceof vscode.TabInputText &&
        input.uri.toString() === uri.toString()
      );
    });

  if (tab) {
    await vscode.window.tabGroups.close(tab, true);
    return;
  }

  const editor = vscode.window.visibleTextEditors.find(
    (candidate) => candidate.document.uri.toString() === uri.toString(),
  );
  if (!editor) {
    return;
  }

  await vscode.window.showTextDocument(editor.document, {
    preview: false,
    preserveFocus: true,
    viewColumn: editor.viewColumn,
  });
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
}

export function scrollPreviewDocumentToTop(
  document: vscode.TextDocument,
): void {
  const top = new vscode.Position(0, 0);
  const topRange = new vscode.Range(top, top);
  vscode.window.visibleTextEditors.forEach((editor) => {
    if (editor.document.uri.toString() !== document.uri.toString()) {
      return;
    }
    editor.selection = new vscode.Selection(top, top);
    editor.revealRange(topRange, vscode.TextEditorRevealType.AtTop);
  });
}

export function findPreviewTabGroupViewColumn(): vscode.ViewColumn | undefined {
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const tabInput = tab.input as {
        uri?: vscode.Uri;
        modified?: vscode.Uri;
        original?: vscode.Uri;
      };
      const candidateUris = [
        tabInput.uri,
        tabInput.modified,
        tabInput.original,
      ].filter((uri): uri is vscode.Uri => uri !== undefined);

      for (const uri of candidateUris) {
        const pathStr = uri.fsPath || uri.path;
        if (pathStr.includes("_dbadmin_") && pathStr.endsWith(".preview")) {
          return tabGroup.viewColumn;
        }
      }
    }
  }
  return undefined;
}

export function isDocumentActiveInEditor(
  document: vscode.TextDocument,
): boolean {
  return (
    vscode.window.activeTextEditor?.document.uri.toString() ===
    document.uri.toString()
  );
}

export function getVisibleEditorForDocument(
  document: vscode.TextDocument,
): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === document.uri.toString(),
  );
}
