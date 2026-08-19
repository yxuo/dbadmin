# Development

This guide covers local development, build, packaging, package content validation, and publishing.

## 1) Prerequisites

- Node.js and npm installed
- Project dependencies installed
- Marketplace publisher account (for publishing)
- Azure DevOps PAT (for publishing)

## 2) Install dependencies

```bash
npm install
```

## 3) Compile the extension

```bash
npm run compile
```

## 4) Package VSIX

Default command:

```bash
npx @vscode/vsce package --no-dependencies --out <package-name>.vsix
```

## 5) Install VSIX locally

Via CLI:

```bash
code --install-extension .\<package-name>.vsix --force
```

Via UI:

1. Open Extensions in VS Code.
2. Click `...`.
3. Select `Install from VSIX...`.
4. Choose the generated VSIX file.

## 6) Verify package contents

To list files included in the VSIX:

```bash
npx @vscode/vsce ls
```

If needed, adjust `.vscodeignore` to exclude development artifacts, temporary files, and local-only content.

## 7) Publish to the Marketplace

### 7.1 Create a PAT (Azure DevOps)

1. Go to `https://aex.dev.azure.com/me`.
2. Open `Personal access tokens`.
3. Create a token with:
   - Scope: `Custom defined`
   - Marketplace: `Manage` (and `Publish` if the panel separates permissions)
4. Do not use `Full access`.

### 7.2 Log in with vsce

```bash
npx @vscode/vsce login <publisher-id>
```

### 7.3 Publish

```bash
npx @vscode/vsce publish
```

or:

```bash
npx @vscode/vsce publish <version>
```

## 8) Release checklist

- Build completed without errors.
- VSIX generated successfully.
- Package contents reviewed (`vsce ls`).
- `README.md` updated for the store page.
- `CHANGELOG.md` updated for the version.
- `LICENSE` present.

## 8.1) Connection configuration

- Each connection can define an optional list of databases visible in the sidebar.
- When the list is set, only those databases appear in the explorer.
- When the list is empty, all databases available to the connection are shown.

## 9) Security and operations

- Use PATs with minimum scope.
- Set short expiration and rotate periodically.
- Never commit PATs to the repository.
- In CI, store credentials in provider secrets (e.g. GitHub Actions Secrets).
