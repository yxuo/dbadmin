# Changelog

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
