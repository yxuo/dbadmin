# Development, packaging, and publishing

This guide covers local development, VSIX packaging, and publishing to the VS Code Marketplace.

## 1 Prerequisites

- Node.js and npm
- Marketplace publisher account (for publishing)
- Azure DevOps PAT with Marketplace **Manage** or **Publish** — not Full access

Publisher id in this repo: `yxuo`.

## 2 Install and compile

```bash
npm install
npm run compile
```

Watch mode: `npm run watch`.

## 3 Package a VSIX

```bash
npx @vscode/vsce package --out dbadmin-1.0.0.vsix
```

Match the filename to `package.json` `version`. Inspect what goes into the package:

```bash
npx @vscode/vsce ls --tree
```

If the package is too large (over 10 MB), trim `.vscodeignore`. In particular,
keep only the SQLite Node WASM loader and the copy of `sql-wasm.wasm` under
`resources/sqljs`; the debug, asm.js, worker, and ZIP variants from `sql.js` are
not used at runtime.
The Marketplace does not allow publishing a package larger than 10 MB.

If `vsce` prompts on manifest warnings, you can pipe a confirmation (local automation only):

```bash
"y" | npx @vscode/vsce package --out dbadmin-1.0.0.vsix
```

## 4 Install the VSIX locally

CLI:

```bash
code --install-extension .\dbadmin-1.0.0.vsix --force
```

UI: Extensions → `...` → **Install from VSIX...**

After code changes: compile → package → reinstall with `--force` → **Developer: Reload Window**.

## 5 Publish to the Marketplace

Complete [the release checklist](#6-release-checklist) first. In particular, the
release commit, tag, and GitHub Release should exist before publishing the same
VSIX to the Marketplace.

### PAT

1. [Personal access tokens](https://aex.dev.azure.com/me)
2. Scope: Custom defined → Marketplace: **Manage** (and **Publish** if listed separately)

### Login and publish

```bash
npx @vscode/vsce login yxuo
npx @vscode/vsce publish
```

Or pin the version: `npx @vscode/vsce publish 1.0.0`.

`vsce` runs `vscode:prepublish` (`npm run compile`) and uses the version from
`package.json`. You cannot republish the same version; bump to `1.0.1` or later.

## 6 Release checklist

Follow this order for every release:

1. Finish the code changes and run `npm test`.
2. Review `README.md`, screenshots, localized strings, keywords, and any other
   Marketplace content affected by the release.
3. Choose the next semantic version and update it with
   `npm version 1.1.0`, 
   `npm version patch --no-git-tag-version`, 
   `npm version minor --no-git-tag-version`, or
   `npm version major --no-git-tag-version` 
   for example.
4. Move the release notes from `Unreleased` (if present) in `CHANGELOG.md` to a
   section matching the new version and date. Add a fresh `Unreleased` section.
5. Run `npm test`, generate the VSIX, and review its contents with
   `npx @vscode/vsce ls`.
6. Install that exact VSIX locally and smoke-test the changed features.
7. Commit and push the release, including `package.json`, `package-lock.json`,
   `CHANGELOG.md`, `README.md`, and any updated images or localization files.
8. Create and push the matching Git tag, for example `git tag v1.1.1` followed
   by `git push origin v1.1.1`.
9. Create the GitHub Release from that tag, copy the matching changelog section
   into its notes, and attach the VSIX.
10. Publish the same VSIX/version to the Marketplace with `vsce`, then verify the
    Marketplace listing and installation.

Also confirm:

- `LICENSE` is present.
- The package contains no source-only files, tests, local data, or credentials.
- The PAT is stored only locally or in CI secrets — never in git.

## Connection configuration

Each connection can list which databases appear in the sidebar. An empty list shows all databases available to that connection.
