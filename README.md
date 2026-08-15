# DBAdmin — PostgreSQL with a modern UI in VS Code

DBAdmin brings a **lean, visual, and powerful** database experience into VS Code.  
Connect, explore, filter, query, and operate PostgreSQL without leaving the editor.

## Why DBAdmin

- **Modern, focused UI**: the essentials, without visual clutter.
- **Fast workflow**: common actions are a few clicks away.
- **Built for real use**: data browsing, metadata, export, backup, and restore.



## Main features

- **Tree explorer**: connections → databases → schemas → tables.
- **Connection management**: create, edit, and remove connections with global persistence.
- **Table view**: pagination, advanced filters, and smooth navigation.
- **Full metadata**: columns, indexes, and constraints in a clear layout.
- **Data export**: CSV and JSON.
- **SQL Book**: interactive query execution with grid results.
- **Backup and restore**: integration with `pg_dump` and `pg_restore`.
- **MCP**: AI tools can list connections, inspect schemas, and run SQL using saved DBAdmin credentials.

## Installation

1. Open the Marketplace in VS Code.
2. Search for **DBAdmin**.
3. Click **Install**.

Alternatively via VSIX:

1. Download the `.vsix` from the release.
2. Run **Extensions: Install from VSIX...**.

## Requirements

- VS Code 1.85+
- Access to a PostgreSQL server
- `pg_dump` and `pg_restore` for backup features (optional)
