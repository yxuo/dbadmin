# Changelog

## [1.1.0] - 2026-11-24

### Added

- SQLite support using sql.js/WASM: open `.sqlite`, `.sqlite3`, `.db`, and `.db3` files; browse tables, views, and triggers; edit rows; and use SQL Book, DDL, ER diagrams, exports, MCP, and SQL dumps
- Native VS Code custom editor for SQLite files and an **Open SQLite database file** command
- Option to add an opened SQLite file to the DBAdmin explorer and switch to the explorer automatically
- Connection form engine selector (PostgreSQL or SQLite)
- SQLite-specific file backup and SQL dump actions in the explorer
- SQLite labels and messages in the bundled locales
- Marketplace keywords for Postgres and SQLite discovery

### Changed

- Marketplace description and README now present DBAdmin as a PostgreSQL and SQLite manager
- The minimum supported VS Code version is now 1.95
- Existing explorer, table, SQL Book, metadata, export, diagram, and MCP flows now operate through the database engine abstraction

## [1.0.1] - 2026-08-20

### Fixed

- Marketplace README screenshots for the table editor (`edit-modal.png`, `edit-split.png`)

## [1.0.0] - 2026-08-18

First stable release — **PostgreSQL foundation** for VS Code / Cursor.

### Added

- Connection manager with global persistence and optional database allowlists
- Tree explorer: connections → databases → schemas → tables, views, functions, procedures, triggers, and extensions
- Table view: pagination, column filters, in-place editing, FK navigation, copy/paste, and layout persistence
- Table DDL: show full `CREATE TABLE` script; create and drop tables from the tree or table menu
- Metadata panels for columns and constraints; edit column nullable/default values
- ER diagram with relationship highlighting and export
- Connection dashboard: traffic, queries, sessions, and transactions
- Schema and database operations: create, rename, duplicate, drop; backup, restore, and clear schema
- Routines: create, edit, and delete functions, procedures, and triggers via the SQL runner
- Data export to CSV and JSON
- SQL Book and SQL runner with connection context; optional inline table with persisted cell outputs
- Native schema dump and optional `pg_dump` / `pg_restore` integration
- MCP server for AI tools (list connections, inspect schemas, run SQL)
- Settings panel, table filter in the sidebar, and i18n (English / Portuguese)
