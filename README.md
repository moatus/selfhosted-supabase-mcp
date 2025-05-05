# Self-Hosted Supabase MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

This project provides a [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/specification) server designed specifically for interacting with **self-hosted Supabase instances**. It bridges the gap between MCP clients (like IDE extensions) and your local or privately hosted Supabase projects, enabling database introspection, management, and interaction directly from your development environment.

This server was built from scratch, drawing lessons from adapting the official Supabase cloud MCP server, to provide a minimal, focused implementation tailored for the self-hosted use case.

## Purpose

The primary goal of this server is to enable developers using self-hosted Supabase installations to leverage MCP-based tools for tasks such as:

*   Querying database schemas and data.
*   Managing database migrations.
*   Inspecting database statistics and connections.
*   Managing authentication users.
*   Interacting with Supabase Storage.
*   Generating type definitions.

It avoids the complexities of the official cloud server related to multi-project management and cloud-specific APIs, offering a streamlined experience for single-project, self-hosted environments.

## Features (Implemented Tools)

The server exposes the following tools to MCP clients:

*   **Schema & Migrations**
    *   `list_tables`: Lists tables in the database schemas.
    *   `list_extensions`: Lists installed PostgreSQL extensions.
    *   `list_migrations`: Lists applied Supabase migrations.
    *   `apply_migration`: Applies a SQL migration script.
*   **Database Operations & Stats**
    *   `execute_sql`: Executes an arbitrary SQL query (via RPC or direct connection).
    *   `get_database_connections`: Shows active database connections (`pg_stat_activity`).
    *   `get_database_stats`: Retrieves database statistics (`pg_stat_*`).
*   **Project Configuration & Keys**
    *   `get_project_url`: Returns the configured Supabase URL.
    *   `get_anon_key`: Returns the configured Supabase anon key.
    *   `get_service_key`: Returns the configured Supabase service role key (if provided).
    *   `verify_jwt_secret`: Checks if the JWT secret is configured and returns a preview.
*   **Development & Extension Tools**
    *   `generate_typescript_types`: Generates TypeScript types from the database schema.
    *   `rebuild_hooks`: Attempts to restart the `pg_net` worker (if used).
*   **Auth User Management**
    *   `list_auth_users`: Lists users from `auth.users`.
    *   `get_auth_user`: Retrieves details for a specific user.
    *   `create_auth_user`: Creates a new user (Requires direct DB access, insecure password handling).
    *   `delete_auth_user`: Deletes a user (Requires direct DB access).
    *   `update_auth_user`: Updates user details (Requires direct DB access, insecure password handling).
*   **Storage Insights**
    *   `list_storage_buckets`: Lists all storage buckets.
    *   `list_storage_objects`: Lists objects within a specific bucket.
*   **Realtime Inspection**
    *   `list_realtime_publications`: Lists PostgreSQL publications (often `supabase_realtime`).

*(Note: `get_logs` was initially planned but skipped due to implementation complexities in a self-hosted environment).*

## Setup and Installation

### Prerequisites

*   Node.js (Version 18.x or later recommended)
*   npm (usually included with Node.js)
*   Access to your self-hosted Supabase instance (URL, keys, potentially direct DB connection string).

### Steps

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd self-hosted-supabase-mcp
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Build the project:**
    ```bash
    npm run build
    ```
    This compiles the TypeScript code to JavaScript in the `dist` directory.

## Configuration

The server requires configuration details for your Supabase instance. These can be provided via command-line arguments or environment variables. CLI arguments take precedence.

**Required:**

*   `--url <url>` or `SUPABASE_URL=<url>`: The main HTTP URL of your Supabase project (e.g., `http://localhost:8000`).
*   `--anon-key <key>` or `SUPABASE_ANON_KEY=<key>`: Your Supabase project's anonymous key.

**Optional (but Recommended/Required for certain tools):**

*   `--service-key <key>` or `SUPABASE_SERVICE_ROLE_KEY=<key>`: Your Supabase project's service role key. Needed for operations requiring elevated privileges, like attempting to automatically create the `execute_sql` helper function if it doesn't exist.
*   `--db-url <url>` or `DATABASE_URL=<url>`: The direct PostgreSQL connection string for your Supabase database (e.g., `postgresql://postgres:password@localhost:5432/postgres`). Required for tools needing direct database access or transactions (`apply_migration`, Auth tools, Storage tools, querying `pg_catalog`, etc.).
*   `--jwt-secret <secret>` or `SUPABASE_AUTH_JWT_SECRET=<secret>`: Your Supabase project's JWT secret. Needed for tools like `verify_jwt_secret`.

### Important Notes:

*   **`execute_sql` Helper Function:** Many tools rely on a `public.execute_sql` function within your Supabase database for secure and efficient SQL execution via RPC. The server attempts to check for this function on startup. If it's missing *and* a `service-key` (or `SUPABASE_SERVICE_ROLE_KEY`) *and* `db-url` (or `DATABASE_URL`) are provided, it will attempt to create the function and grant necessary permissions. If creation fails or keys aren't provided, tools relying solely on RPC may fail.
*   **Direct Database Access:** Tools interacting directly with privileged schemas (`auth`, `storage`) or system catalogs (`pg_catalog`) generally require the `DATABASE_URL` to be configured for a direct `pg` connection.

## Usage

Run the server using Node.js, providing the necessary configuration:

```bash
# Using CLI arguments (example)
node dist/index.js --url http://localhost:8000 --anon-key <your-anon-key> --db-url postgresql://postgres:password@localhost:5432/postgres [--service-key <your-service-key>]

# Or configure using environment variables and run:
# export SUPABASE_URL=http://localhost:8000
# export SUPABASE_ANON_KEY=<your-anon-key>
# export DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres
# export SUPABASE_SERVICE_ROLE_KEY=<your-service-key>
node dist/index.js

# Using npm start script (if configured in package.json to pass args/read env)
npm start -- --url ... --anon-key ...
```

The server communicates via standard input/output (stdio) and is designed to be invoked by an MCP client application (e.g., an IDE extension like Cursor). The client will connect to the server's stdio stream to list and call the available tools.

## Development

*   **Language:** TypeScript
*   **Build:** `tsc` (TypeScript Compiler)
*   **Dependencies:** Managed via `npm` (`package.json`)
*   **Core Libraries:** `@supabase/supabase-js`, `pg` (node-postgres), `zod` (validation), `commander` (CLI args), `@modelcontextprotocol/sdk` (MCP server framework).

## License

This project is licensed under the MIT License. See the LICENSE file for details. 