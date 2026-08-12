import * as vscode from "vscode";

const SQLBOOK_VSICONS_ASSOCIATION = {
  icon: "sql",
  extensions: ["sqlbook"],
  languages: [
    {
      ids: "sqlbook",
      defaultExtension: "sqlbook",
    },
  ],
  format: "svg",
};

function extensionMatchesSqlbook(value: unknown): boolean {
  return String(value).replace(/^\./, "").toLowerCase() === "sqlbook";
}

function hasSqlbookVsiconsAssociation(files: unknown[]): boolean {
  return files.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const candidate = entry as {
      extensions?: unknown;
      languages?: unknown;
    };

    if (
      Array.isArray(candidate.extensions) &&
      candidate.extensions.some(extensionMatchesSqlbook)
    ) {
      return true;
    }

    if (!Array.isArray(candidate.languages)) {
      return false;
    }

    return candidate.languages.some((language) => {
      if (!language || typeof language !== "object") {
        return false;
      }

      const ids = (language as { ids?: string | string[] }).ids;
      if (Array.isArray(ids)) {
        return ids.some((id) => String(id).toLowerCase() === "sqlbook");
      }

      return String(ids ?? "").toLowerCase() === "sqlbook";
    });
  });
}

/**
 * Icon themes win over language default icons. When vscode-icons / Material
 * Icon Theme are installed, ensure `.sqlbook` reuses the same SQL icon.
 *
 * `configurationDefaults` alone is not enough if the user already customized
 * these settings — the user value replaces the entire default.
 */
export async function ensureSqlbookFileIconAssociations(): Promise<void> {
  if (vscode.extensions.getExtension("vscode-icons-team.vscode-icons")) {
    const config = vscode.workspace.getConfiguration("vsicons");
    const files = config.get<unknown[]>("associations.files") ?? [];

    if (!hasSqlbookVsiconsAssociation(files)) {
      await config.update(
        "associations.files",
        [...files, SQLBOOK_VSICONS_ASSOCIATION],
        vscode.ConfigurationTarget.Global,
      );

      try {
        await vscode.commands.executeCommand("vscode-icons.regenerateIcons");
      } catch {
        // Theme may prompt reload; association is already persisted.
      }
    }
  }

  if (vscode.extensions.getExtension("PKief.material-icon-theme")) {
    const config = vscode.workspace.getConfiguration("material-icon-theme");
    const associations = {
      ...(config.get<Record<string, string>>("files.associations") ?? {}),
    };

    if (!associations["*.sqlbook"] && !associations.sqlbook) {
      associations["*.sqlbook"] = "sql";
      await config.update(
        "files.associations",
        associations,
        vscode.ConfigurationTarget.Global,
      );
    }
  }
}
