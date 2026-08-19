# Build a VSIX (local install)

This guide shows how to package the extension as a VSIX file and install it in VS Code.

## Prerequisites

- Node.js and npm installed
- Project dependencies installed

## 1) Install dependencies

```bash
npm install
```

## 2) Compile the extension

```bash
npm run compile
```

## 3) Generate the VSIX

Default command:

```bash
npx @vscode/vsce package --out dbadmin-1.0.0.vsix
```

In this project, `vsce` may prompt for confirmation due to manifest warnings. For local automation, use:

```bash
"y" | npx @vscode/vsce package --allow-missing-repository --allow-star-activation --out dbadmin-1.0.0.vsix
```

## 4) Install in VS Code

Via CLI:

```bash
code --install-extension .\dbadmin-1.0.0.vsix --force
```

Via UI:

1. Open Extensions in VS Code.
2. Click `...` (view menu).
3. Select `Install from VSIX...`.
4. Choose the generated VSIX file.

## 5) Update a local install

When generating new local builds:

- Run `npm run compile` again
- Run `vsce package` again
- Reinstall with `--force`

## Tips

- Inspect package contents with:

```bash
npx @vscode/vsce ls
```

- If the package is too large, review `.vscodeignore`.
