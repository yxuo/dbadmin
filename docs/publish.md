# Publish to the VS Code Marketplace

This guide describes the Marketplace publishing flow in general terms.

## 1) Prerequisites

- Microsoft account with access to the extension publisher.
- PAT (Personal Access Token) created in Azure DevOps.
- Project compiling and packaging without errors.

## 2) Create a PAT

1. Go to `https://aex.dev.azure.com/me`.
2. Open `Personal access tokens`.
3. Create a new token with:
   - Scope: `Custom defined`
   - Marketplace: `Manage` (and `Publish` if the panel separates permissions)
4. Do not use `Full access`.

## 3) Log in

```bash
npx @vscode/vsce login <publisher-id>
```

## 4) Publish

```bash
npx @vscode/vsce publish
```

or:

```bash
npx @vscode/vsce publish <version>
```

## 5) Best practices

- Use PATs with minimum scope.
- Set short expiration and rotate periodically.
- In CI, store the PAT in secrets.
- Never commit PATs to the repository.

## 6) Full developer guide

For the complete development workflow (build, VSIX, package validation, and release), see:

- [docs/development.md](development.md)
