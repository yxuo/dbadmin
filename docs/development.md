# Development, packaging, and publishing

This guide covers local development, VSIX packaging, and publishing to the VS Code Marketplace.

## 1 Prerequisites

- Node.js and npm
- Marketplace publisher account (for publishing)
- Azure DevOps PAT with Marketplace **Manage** (or **Publish** — not Full access

Publisher id in this repo: `yxuo`.

## 2 Install and compile

```bash
npm install
npm run compile
```

Watch mode: `npm run watch`.

## 3 Package a VSIX

```bash
npx @vscode/vsce package --no-dependencies --out dbadmin-1.0.0.vsix
```

Match the filename to `package.json` `version`. Inspect what goes into the package:

```bash
npx @vscode/vsce ls
```

If the package is too large, trim `.vscodeignore`.
The Marketplace does not allow publishing a package larger than 10 MB.

If `vsce` prompts on manifest warnings, you can pipe a confirmation (local automation only):

```bash
"y" | npx @vscode/vsce package --no-dependencies --out dbadmin-1.0.0.vsix
```

## 4 Install the VSIX locally

CLI:

```bash
code --install-extension .\dbadmin-1.0.0.vsix --force
```

UI: Extensions → `...` → **Install from VSIX...**

After code changes: compile → package → reinstall with `--force` → **Developer: Reload Window**.

## 5 Publish to the Marketplace

### PAT

1. [Personal access tokens](https://aex.dev.azure.com/me)
2. Scope: Custom defined → Marketplace: **Manage** (and **Publish** if listed separately)

### Login and publish

```bash
npx @vscode/vsce login yxuo
npx @vscode/vsce publish
```

Or pin the version: `npx @vscode/vsce publish 1.0.0`.

`vsce` runs `vscode:prepublish` (`npm run compile` and uses `package.json` `version`. You cannot republish the same version; bump to `1.0.1` (or later instead.

Optional after publish: git tag `v1.0.0` and a GitHub Release with the `.vsix` attached. The Marketplace does not require either.

## 6 Release checklist

- Build completes without errors
- VSIX generated; contents reviewed (`vsce ls`)
- `README.md` ready for the store page
- `CHANGELOG.md` matches the version
- `LICENSE` present
- PAT stored only locally or in CI secrets — never in git

## Connection configuration

Each connection can list which databases appear in the sidebar. An empty list shows all databases available to that connection.
