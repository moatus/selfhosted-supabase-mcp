// src/remote-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

// src/client/index.ts
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
var SelfhostedSupabaseClient = class _SelfhostedSupabaseClient {
  options;
  supabase;
  pgPool = null;
  // Lazy initialized pool for direct DB access
  rpcFunctionExists = false;
  // SQL definition for the helper function
  static CREATE_EXECUTE_SQL_FUNCTION = `
        CREATE OR REPLACE FUNCTION public.execute_sql(query text, read_only boolean DEFAULT false)
        RETURNS jsonb -- Using jsonb is generally preferred over json
        LANGUAGE plpgsql
        AS $$
        DECLARE
          result jsonb;
        BEGIN
          -- Note: SET TRANSACTION READ ONLY might not behave as expected within a function
          -- depending on the outer transaction state. Handle read-only logic outside if needed.

          -- Execute the dynamic query and aggregate results into a JSONB array
          EXECUTE 'SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (' || query || ') t' INTO result;

          RETURN result;
        EXCEPTION
          WHEN others THEN
            -- Rethrow the error with context, including the original SQLSTATE
            RAISE EXCEPTION 'Error executing SQL (SQLSTATE: %): % ', SQLSTATE, SQLERRM;
        END;
        $$;
    `;
  // SQL to grant permissions
  static GRANT_EXECUTE_SQL_FUNCTION = `
        GRANT EXECUTE ON FUNCTION public.execute_sql(text, boolean) TO authenticated;
        -- Optionally grant to anon if needed (uncomment if required):
        -- GRANT EXECUTE ON FUNCTION public.execute_sql(text, boolean) TO anon;
    `;
  /**
   * Creates an instance of SelfhostedSupabaseClient.
   * Note: Call initialize() after creating the instance to check for RPC functions.
   * @param options - Configuration options for the client.
   */
  constructor(options) {
    this.options = options;
    this.supabase = createClient(options.supabaseUrl, options.supabaseAnonKey, options.supabaseClientOptions);
    if (!options.supabaseUrl || !options.supabaseAnonKey) {
      throw new Error("Supabase URL and Anon Key are required.");
    }
  }
  /**
   * Factory function to create and asynchronously initialize the client.
   * Checks for the existence of the helper RPC function.
   */
  static async create(options) {
    const client = new _SelfhostedSupabaseClient(options);
    await client.initialize();
    return client;
  }
  /**
   * Initializes the client by checking for the required RPC function.
   * Attempts to create the function if it doesn't exist and a service role key is provided.
   */
  async initialize() {
    console.error("Initializing SelfhostedSupabaseClient...");
    try {
      await this.checkAndCreateRpcFunction();
      console.error(`RPC function 'public.execute_sql' status: ${this.rpcFunctionExists ? "Available" : "Unavailable"}`);
    } catch (error) {
      console.error("Error during client initialization:", error);
    }
    console.error("Initialization complete.");
  }
  // --- Public Methods (to be implemented) ---
  /**
   * Executes SQL using the preferred RPC method.
   */
  async executeSqlViaRpc(query, readOnly = false) {
    if (!this.rpcFunctionExists) {
      console.error("Attempted to call executeSqlViaRpc, but RPC function is not available.");
      return {
        error: {
          message: "execute_sql RPC function not found or client not properly initialized.",
          code: "MCP_CLIENT_ERROR"
        }
      };
    }
    console.error(`Executing via RPC (readOnly: ${readOnly}): ${query.substring(0, 100)}...`);
    try {
      const { data, error } = await this.supabase.rpc("execute_sql", {
        query,
        read_only: readOnly
      });
      if (error) {
        console.error("Error executing SQL via RPC:", error);
        return {
          error: {
            message: error.message,
            code: error.code,
            // Propagate Supabase/PostgREST error code
            details: error.details,
            hint: error.hint
          }
        };
      }
      if (Array.isArray(data)) {
        return data;
      }
      console.error("Unexpected response format from execute_sql RPC:", data);
      return {
        error: {
          message: "Unexpected response format from execute_sql RPC. Expected JSON array.",
          code: "MCP_RPC_FORMAT_ERROR"
        }
      };
    } catch (rpcError) {
      const errorMessage = rpcError instanceof Error ? rpcError.message : String(rpcError);
      console.error("Exception during executeSqlViaRpc call:", rpcError);
      return {
        error: {
          message: `Exception during RPC call: ${errorMessage}`,
          code: "MCP_RPC_EXCEPTION"
        }
      };
    }
  }
  /**
   * Executes SQL directly against the database using the pg library.
   * Requires DATABASE_URL to be configured.
   * Useful for simple queries when RPC is unavailable or direct access is preferred.
   * NOTE: Does not support transactions or parameterization directly.
   * Consider executeTransactionWithPg for more complex operations.
   */
  async executeSqlWithPg(query) {
    if (!this.options.databaseUrl) {
      return { error: { message: "DATABASE_URL is not configured. Cannot execute SQL directly.", code: "MCP_CONFIG_ERROR" } };
    }
    await this.ensurePgPool();
    if (!this.pgPool) {
      return { error: { message: "pg Pool not available after initialization attempt.", code: "MCP_POOL_ERROR" } };
    }
    let client;
    try {
      client = await this.pgPool.connect();
      console.error(`Executing via pg: ${query.substring(0, 100)}...`);
      const result = await client.query(query);
      return result.rows;
    } catch (dbError) {
      const error = dbError instanceof Error ? dbError : new Error(String(dbError));
      console.error("Error executing SQL with pg:", error);
      const code = dbError?.code || "PG_ERROR";
      return { error: { message: error.message, code } };
    } finally {
      client?.release();
    }
  }
  /**
   * Ensures the pg connection pool is initialized.
   * Should be called before accessing this.pgPool.
   */
  async ensurePgPool() {
    if (this.pgPool) return;
    if (!this.options.databaseUrl) {
      throw new Error("DATABASE_URL is not configured. Cannot initialize pg pool.");
    }
    console.error("Initializing pg pool...");
    this.pgPool = new Pool({ connectionString: this.options.databaseUrl });
    this.pgPool.on("error", (err, client) => {
      console.error("PG Pool Error: Unexpected error on idle client", err);
    });
    try {
      const client = await this.pgPool.connect();
      console.error("pg pool connected successfully.");
      client.release();
    } catch (err) {
      console.error("Failed to connect pg pool:", err);
      await this.pgPool.end();
      this.pgPool = null;
      throw new Error(`Failed to connect pg pool: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /**
  * Executes a series of operations within a single database transaction using the pg library.
  * Requires DATABASE_URL to be configured.
  * @param callback A function that receives a connected pg client and performs queries.
  *                 It should return a promise that resolves on success or rejects on failure.
  *                 The transaction will be committed if the promise resolves,
  *                 and rolled back if it rejects.
  */
  async executeTransactionWithPg(callback) {
    if (!this.options.databaseUrl) {
      throw new Error("DATABASE_URL is not configured. Cannot execute transaction directly.");
    }
    await this.ensurePgPool();
    if (!this.pgPool) {
      throw new Error("pg Pool not available for transaction.");
    }
    const client = await this.pgPool.connect();
    try {
      await client.query("BEGIN");
      console.error("BEGIN transaction");
      const result = await callback(client);
      await client.query("COMMIT");
      console.error("COMMIT transaction");
      return result;
    } catch (error) {
      console.error("Transaction Error - Rolling back:", error);
      await client.query("ROLLBACK");
      console.error("ROLLBACK transaction");
      throw error;
    } finally {
      client.release();
    }
  }
  // --- Helper/Private Methods (to be implemented) ---
  async checkAndCreateRpcFunction() {
    console.error("Checking for public.execute_sql RPC function...");
    try {
      const { error } = await this.supabase.rpc("execute_sql", { query: "SELECT 1" });
      if (!error) {
        console.error("'public.execute_sql' function found.");
        this.rpcFunctionExists = true;
        return;
      }
      const UNDEFINED_FUNCTION_ERROR_CODE = "42883";
      const POSTGREST_FUNCTION_NOT_FOUND_CODE = "PGRST202";
      if (error.code === UNDEFINED_FUNCTION_ERROR_CODE || error.code === POSTGREST_FUNCTION_NOT_FOUND_CODE) {
        console.error(
          `'public.execute_sql' function not found (Code: ${error.code}). Attempting creation...`
        );
        if (!this.options.supabaseServiceRoleKey) {
          console.error("Cannot create 'public.execute_sql': supabaseServiceRoleKey not provided.");
          this.rpcFunctionExists = false;
          return;
        }
        if (!this.options.databaseUrl) {
          console.error("Cannot create 'public.execute_sql' reliably without databaseUrl for direct connection.");
          this.rpcFunctionExists = false;
          return;
        }
        try {
          console.error("Creating 'public.execute_sql' function using direct DB connection...");
          await this.executeSqlWithPg(_SelfhostedSupabaseClient.CREATE_EXECUTE_SQL_FUNCTION);
          await this.executeSqlWithPg(_SelfhostedSupabaseClient.GRANT_EXECUTE_SQL_FUNCTION);
          console.error("'public.execute_sql' function created and permissions granted successfully.");
          console.error("Notifying PostgREST to reload schema cache...");
          await this.executeSqlWithPg("NOTIFY pgrst, 'reload schema'");
          console.error("PostgREST schema reload notification sent.");
          this.rpcFunctionExists = true;
        } catch (creationError) {
          const errorMessage = creationError instanceof Error ? creationError.message : String(creationError);
          console.error("Failed to create 'public.execute_sql' function or notify PostgREST:", creationError);
          this.rpcFunctionExists = false;
          throw new Error(`Failed to create execute_sql function/notify: ${errorMessage}`);
        }
      } else {
        console.error(
          "Unexpected error checking for 'public.execute_sql' function:",
          error
        );
        this.rpcFunctionExists = false;
        throw new Error(
          `Error checking for execute_sql function: ${error.message}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error("Exception during RPC function check/creation:", err);
      this.rpcFunctionExists = false;
      throw new Error(`Exception during RPC function check/creation: ${errorMessage}`);
    }
  }
  // --- Getters --- 
  getSupabaseUrl() {
    return this.options.supabaseUrl;
  }
  getAnonKey() {
    return this.options.supabaseAnonKey;
  }
  getServiceRoleKey() {
    return this.options.supabaseServiceRoleKey;
  }
  /**
   * Gets the configured JWT secret, if provided.
   */
  getJwtSecret() {
    return this.options.jwtSecret;
  }
  /**
   * Gets the configured direct database connection URL, if provided.
   */
  getDbUrl() {
    return this.options.databaseUrl;
  }
  /**
   * Checks if the direct database connection (pg) is configured.
   */
  isPgAvailable() {
    return !!this.options.databaseUrl;
  }
};

// src/tools/list_tables.ts
import { z as z2 } from "zod";

// src/tools/utils.ts
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
var execAsync = promisify(exec);
function handleSqlResponse(result, schema) {
  if ("error" in result) {
    throw new Error(`SQL Error (${result.error.code}): ${result.error.message}`);
  }
  try {
    return schema.parse(result);
  } catch (validationError) {
    if (validationError instanceof z.ZodError) {
      throw new Error(`Schema validation failed: ${validationError.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
    }
    throw new Error(`Unexpected validation error: ${validationError}`);
  }
}
async function runExternalCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(command);
    return { stdout, stderr, error: null };
  } catch (error) {
    const execError = error;
    return {
      stdout: execError.stdout || "",
      stderr: execError.stderr || execError.message,
      // Use message if stderr is empty
      error: execError
    };
  }
}
async function executeSqlWithFallback(client, sql, readOnly = true) {
  if (client.isPgAvailable()) {
    console.info("Using direct database connection (bypassing JWT)...");
    return await client.executeSqlWithPg(sql);
  }
  console.info("Falling back to RPC method...");
  return await client.executeSqlViaRpc(sql, readOnly);
}

// src/tools/list_tables.ts
var ListTablesOutputSchema = z2.array(z2.object({
  schema: z2.string(),
  name: z2.string(),
  comment: z2.string().nullable().optional()
  // Add comment if available
}));
var ListTablesInputSchema = z2.object({
  // No specific input needed for listing tables
  // Optional: add schema filter later if needed
  // schema: z.string().optional().describe('Filter tables by schema name.'),
});
var mcpInputSchema = {
  type: "object",
  properties: {},
  required: []
};
var listTablesTool = {
  name: "list_tables",
  description: "Lists all accessible tables in the connected database, grouped by schema.",
  inputSchema: ListTablesInputSchema,
  // Use defined schema
  mcpInputSchema,
  // Add the static JSON schema for MCP
  outputSchema: ListTablesOutputSchema,
  // Use explicit types for input and context
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const listTablesSql = `
            SELECT
                n.nspname as schema,
                c.relname as name,
                pgd.description as comment
            FROM
                pg_catalog.pg_class c
            JOIN
                pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN
                pg_catalog.pg_description pgd ON pgd.objoid = c.oid AND pgd.objsubid = 0
            WHERE
                c.relkind = 'r' -- r = ordinary table
                AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                AND n.nspname NOT LIKE 'pg_temp_%'
                AND n.nspname NOT LIKE 'pg_toast_temp_%'
                 -- Exclude Supabase internal schemas
                AND n.nspname NOT IN ('auth', 'storage', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'realtime', 'supabase_functions', 'supabase_migrations', '_realtime')
                AND has_schema_privilege(n.oid, 'USAGE')
                AND has_table_privilege(c.oid, 'SELECT')
            ORDER BY
                n.nspname,
                c.relname
        `;
    const result = await executeSqlWithFallback(client, listTablesSql, true);
    return handleSqlResponse(result, ListTablesOutputSchema);
  }
};

// src/tools/list_extensions.ts
import { z as z3 } from "zod";
var ListExtensionsOutputSchema = z3.array(z3.object({
  name: z3.string(),
  schema: z3.string(),
  version: z3.string(),
  description: z3.string().nullable().optional()
}));
var ListExtensionsInputSchema = z3.object({});
var mcpInputSchema2 = {
  type: "object",
  properties: {},
  required: []
};
var listExtensionsTool = {
  name: "list_extensions",
  description: "Lists all installed PostgreSQL extensions in the database.",
  inputSchema: ListExtensionsInputSchema,
  mcpInputSchema: mcpInputSchema2,
  outputSchema: ListExtensionsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const listExtensionsSql = `
            SELECT
                pe.extname AS name,
                pn.nspname AS schema,
                pe.extversion AS version,
                pd.description
            FROM
                pg_catalog.pg_extension pe
            LEFT JOIN
                pg_catalog.pg_namespace pn ON pn.oid = pe.extnamespace
            LEFT JOIN
                pg_catalog.pg_description pd ON pd.objoid = pe.oid AND pd.classoid = 'pg_catalog.pg_extension'::regclass
            WHERE
                pe.extname != 'plpgsql' -- Exclude the default plpgsql extension
            ORDER BY
                pe.extname
        `;
    const result = await executeSqlWithFallback(client, listExtensionsSql, true);
    return handleSqlResponse(result, ListExtensionsOutputSchema);
  }
};

// src/tools/list_migrations.ts
import { z as z4 } from "zod";
var ListMigrationsOutputSchema = z4.array(z4.object({
  version: z4.string(),
  name: z4.string(),
  inserted_at: z4.string()
  // Keep as string from DB
}));
var ListMigrationsInputSchema = z4.object({});
var mcpInputSchema3 = {
  type: "object",
  properties: {},
  required: []
};
var listMigrationsTool = {
  name: "list_migrations",
  description: "Lists applied database migrations recorded in supabase_migrations.schema_migrations table.",
  inputSchema: ListMigrationsInputSchema,
  mcpInputSchema: mcpInputSchema3,
  outputSchema: ListMigrationsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const listMigrationsSql = `
            SELECT
                version,
                name,
                inserted_at
            FROM
                supabase_migrations.schema_migrations
            ORDER BY
                version
        `;
    const result = await executeSqlWithFallback(client, listMigrationsSql, true);
    return handleSqlResponse(result, ListMigrationsOutputSchema);
  }
};

// src/tools/apply_migration.ts
import { z as z5 } from "zod";
var ApplyMigrationInputSchema = z5.object({
  version: z5.string().describe("The migration version string (e.g., '20240101120000')."),
  name: z5.string().optional().describe("An optional descriptive name for the migration."),
  sql: z5.string().describe("The SQL DDL content of the migration.")
});
var ApplyMigrationOutputSchema = z5.object({
  success: z5.boolean(),
  version: z5.string(),
  message: z5.string().optional()
});
var mcpInputSchema4 = {
  type: "object",
  properties: {
    version: { type: "string", description: "The migration version string (e.g., '20240101120000')." },
    name: { type: "string", description: "An optional descriptive name for the migration." },
    sql: { type: "string", description: "The SQL DDL content of the migration." }
  },
  required: ["version", "sql"]
};
var applyMigrationTool = {
  name: "apply_migration",
  description: "Applies a SQL migration script and records it in the supabase_migrations.schema_migrations table within a transaction.",
  inputSchema: ApplyMigrationInputSchema,
  mcpInputSchema: mcpInputSchema4,
  outputSchema: ApplyMigrationOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    try {
      if (!client.isPgAvailable()) {
        throw new Error("Direct database connection (DATABASE_URL) is required for applying migrations but is not configured or available.");
      }
      await client.executeTransactionWithPg(async (pgClient) => {
        console.error(`Executing migration SQL for version ${input.version}...`);
        await pgClient.query(input.sql);
        console.error("Migration SQL executed successfully.");
        console.error(`Recording migration version ${input.version} in schema_migrations...`);
        await pgClient.query(
          "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2);",
          [input.version, input.name ?? ""]
        );
        console.error(`Migration version ${input.version} recorded.`);
      });
      return {
        success: true,
        version: input.version,
        message: `Migration ${input.version} applied successfully.`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to apply migration ${input.version}:`, errorMessage);
      throw new Error(`Failed to apply migration ${input.version}: ${errorMessage}`);
    }
  }
};

// src/tools/execute_sql.ts
import { z as z6 } from "zod";
var ExecuteSqlInputSchema = z6.object({
  sql: z6.string().describe("The SQL query to execute."),
  read_only: z6.boolean().optional().default(false).describe("Hint for the RPC function whether the query is read-only (best effort).")
  // Future enhancement: Add option to force direct connection?
  // use_direct_connection: z.boolean().optional().default(false).describe('Attempt to use direct DB connection instead of RPC.'),
});
var ExecuteSqlOutputSchema = z6.array(z6.unknown()).describe("The array of rows returned by the SQL query.");
var mcpInputSchema5 = {
  type: "object",
  properties: {
    sql: { type: "string", description: "The SQL query to execute." },
    read_only: { type: "boolean", default: false, description: "Hint for the RPC function whether the query is read-only (best effort)." }
  },
  required: ["sql"]
};
var executeSqlTool = {
  name: "execute_sql",
  description: "Executes an arbitrary SQL query against the database, using direct database connection when available or RPC function as fallback.",
  inputSchema: ExecuteSqlInputSchema,
  mcpInputSchema: mcpInputSchema5,
  outputSchema: ExecuteSqlOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    console.error(`Executing SQL (readOnly: ${input.read_only}): ${input.sql.substring(0, 100)}...`);
    const result = await executeSqlWithFallback(client, input.sql, input.read_only);
    return handleSqlResponse(result, ExecuteSqlOutputSchema);
  }
};

// src/tools/get_database_connections.ts
import { z as z7 } from "zod";
var GetDbConnectionsOutputSchema = z7.array(z7.object({
  datname: z7.string().nullable().describe("Database name"),
  usename: z7.string().nullable().describe("User name"),
  application_name: z7.string().nullable().describe("Application name (e.g., PostgREST, psql)"),
  client_addr: z7.string().nullable().describe("Client IP address"),
  backend_start: z7.string().nullable().describe("Time when the backend process started"),
  state: z7.string().nullable().describe("Current connection state (e.g., active, idle)"),
  query: z7.string().nullable().describe("Last or current query being executed"),
  pid: z7.number().describe("Process ID of the backend")
}));
var GetDbConnectionsInputSchema = z7.object({});
var mcpInputSchema6 = {
  type: "object",
  properties: {},
  required: []
};
var getDatabaseConnectionsTool = {
  name: "get_database_connections",
  description: "Retrieves information about active database connections from pg_stat_activity.",
  inputSchema: GetDbConnectionsInputSchema,
  mcpInputSchema: mcpInputSchema6,
  outputSchema: GetDbConnectionsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const getConnectionsSql = `
            SELECT
                pid,
                datname,
                usename,
                application_name,
                client_addr::text, -- Cast inet to text
                backend_start::text, -- Cast timestamp to text
                state,
                query
            FROM
                pg_stat_activity
            WHERE
                backend_type = 'client backend' -- Exclude background workers, etc.
                -- Optionally filter out self?
                -- AND pid != pg_backend_pid()
            ORDER BY
                backend_start
        `;
    const result = await executeSqlWithFallback(client, getConnectionsSql, true);
    return handleSqlResponse(result, GetDbConnectionsOutputSchema);
  }
};

// src/tools/get_database_stats.ts
import { z as z8 } from "zod";
var GetDbStatsOutputSchema = z8.object({
  database_stats: z8.array(z8.object({
    datname: z8.string().nullable(),
    numbackends: z8.number().nullable(),
    xact_commit: z8.string().nullable(),
    // bigint as string
    xact_rollback: z8.string().nullable(),
    // bigint as string
    blks_read: z8.string().nullable(),
    // bigint as string
    blks_hit: z8.string().nullable(),
    // bigint as string
    tup_returned: z8.string().nullable(),
    // bigint as string
    tup_fetched: z8.string().nullable(),
    // bigint as string
    tup_inserted: z8.string().nullable(),
    // bigint as string
    tup_updated: z8.string().nullable(),
    // bigint as string
    tup_deleted: z8.string().nullable(),
    // bigint as string
    conflicts: z8.string().nullable(),
    // bigint as string
    temp_files: z8.string().nullable(),
    // bigint as string
    temp_bytes: z8.string().nullable(),
    // bigint as string
    deadlocks: z8.string().nullable(),
    // bigint as string
    checksum_failures: z8.string().nullable(),
    // bigint as string
    checksum_last_failure: z8.string().nullable(),
    // timestamp as string
    blk_read_time: z8.number().nullable(),
    // double precision
    blk_write_time: z8.number().nullable(),
    // double precision
    stats_reset: z8.string().nullable()
    // timestamp as string
  })).describe("Statistics per database from pg_stat_database"),
  bgwriter_stats: z8.array(z8.object({
    // Usually a single row
    checkpoints_timed: z8.string().nullable(),
    checkpoints_req: z8.string().nullable(),
    checkpoint_write_time: z8.number().nullable(),
    checkpoint_sync_time: z8.number().nullable(),
    buffers_checkpoint: z8.string().nullable(),
    buffers_clean: z8.string().nullable(),
    maxwritten_clean: z8.string().nullable(),
    buffers_backend: z8.string().nullable(),
    buffers_backend_fsync: z8.string().nullable(),
    buffers_alloc: z8.string().nullable(),
    stats_reset: z8.string().nullable()
  })).describe("Statistics from the background writer process from pg_stat_bgwriter")
});
var GetDbStatsInputSchema = z8.object({});
var mcpInputSchema7 = {
  type: "object",
  properties: {},
  required: []
};
var getDatabaseStatsTool = {
  name: "get_database_stats",
  description: "Retrieves statistics about database activity and the background writer from pg_stat_database and pg_stat_bgwriter.",
  inputSchema: GetDbStatsInputSchema,
  mcpInputSchema: mcpInputSchema7,
  outputSchema: GetDbStatsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const getDbStatsSql = `
            SELECT
                datname,
                numbackends,
                xact_commit::text,
                xact_rollback::text,
                blks_read::text,
                blks_hit::text,
                tup_returned::text,
                tup_fetched::text,
                tup_inserted::text,
                tup_updated::text,
                tup_deleted::text,
                conflicts::text,
                temp_files::text,
                temp_bytes::text,
                deadlocks::text,
                checksum_failures::text,
                checksum_last_failure::text,
                blk_read_time,
                blk_write_time,
                stats_reset::text
            FROM pg_stat_database
        `;
    const getBgWriterStatsSql = `
            SELECT
                checkpoints_timed::text,
                checkpoints_req::text,
                checkpoint_write_time,
                checkpoint_sync_time,
                buffers_checkpoint::text,
                buffers_clean::text,
                maxwritten_clean::text,
                buffers_backend::text,
                buffers_backend_fsync::text,
                buffers_alloc::text,
                stats_reset::text
            FROM pg_stat_bgwriter
        `;
    const [dbStatsResult, bgWriterStatsResult] = await Promise.all([
      executeSqlWithFallback(client, getDbStatsSql, true),
      executeSqlWithFallback(client, getBgWriterStatsSql, true)
    ]);
    const dbStats = handleSqlResponse(dbStatsResult, GetDbStatsOutputSchema.shape.database_stats);
    const bgWriterStats = handleSqlResponse(bgWriterStatsResult, GetDbStatsOutputSchema.shape.bgwriter_stats);
    return {
      database_stats: dbStats,
      bgwriter_stats: bgWriterStats
    };
  }
};

// src/tools/get_project_url.ts
import { z as z9 } from "zod";
var GetProjectUrlInputSchema = z9.object({});
var GetProjectUrlOutputSchema = z9.object({
  project_url: z9.string().url()
});
var mcpInputSchema8 = {
  type: "object",
  properties: {},
  required: []
};
var getProjectUrlTool = {
  name: "get_project_url",
  description: "Returns the configured Supabase project URL for this server.",
  inputSchema: GetProjectUrlInputSchema,
  mcpInputSchema: mcpInputSchema8,
  // Add static JSON schema
  outputSchema: GetProjectUrlOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const url = client.getSupabaseUrl();
    return { project_url: url };
  }
};

// src/tools/get_anon_key.ts
import { z as z10 } from "zod";
var GetAnonKeyInputSchema = z10.object({});
var GetAnonKeyOutputSchema = z10.object({
  anon_key: z10.string()
});
var mcpInputSchema9 = {
  type: "object",
  properties: {},
  required: []
};
var getAnonKeyTool = {
  name: "get_anon_key",
  description: "Returns the configured Supabase anon key for this server.",
  inputSchema: GetAnonKeyInputSchema,
  mcpInputSchema: mcpInputSchema9,
  outputSchema: GetAnonKeyOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const key = client.getAnonKey();
    return { anon_key: key };
  }
};

// src/tools/get_service_key.ts
import { z as z11 } from "zod";
var GetServiceKeyInputSchema = z11.object({});
var GetServiceKeyOutputSchema = z11.object({
  service_key_status: z11.enum(["found", "not_configured"]).describe("Whether the service key was provided to the server."),
  service_key: z11.string().optional().describe("The configured Supabase service role key (if configured).")
});
var mcpInputSchema10 = {
  type: "object",
  properties: {},
  required: []
};
var getServiceKeyTool = {
  name: "get_service_key",
  description: "Returns the configured Supabase service role key for this server, if available.",
  inputSchema: GetServiceKeyInputSchema,
  mcpInputSchema: mcpInputSchema10,
  outputSchema: GetServiceKeyOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const key = client.getServiceRoleKey();
    if (key) {
      return { service_key_status: "found", service_key: key };
    }
    return { service_key_status: "not_configured" };
  }
};

// src/tools/verify_jwt_secret.ts
import { z as z12 } from "zod";
var VerifyJwtInputSchema = z12.object({});
var VerifyJwtOutputSchema = z12.object({
  jwt_secret_status: z12.enum(["found", "not_configured"]).describe("Whether the JWT secret was provided to the server."),
  jwt_secret_preview: z12.string().optional().describe("A preview of the JWT secret (first few characters) if configured.")
});
var mcpInputSchema11 = {
  type: "object",
  properties: {},
  required: []
};
var verifyJwtSecretTool = {
  name: "verify_jwt_secret",
  description: "Checks if the Supabase JWT secret is configured for this server and returns a preview.",
  inputSchema: VerifyJwtInputSchema,
  mcpInputSchema: mcpInputSchema11,
  outputSchema: VerifyJwtOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const secret = client.getJwtSecret();
    if (secret) {
      const preview = `${secret.substring(0, Math.min(secret.length, 5))}...`;
      return {
        jwt_secret_status: "found",
        jwt_secret_preview: preview
      };
    }
    return { jwt_secret_status: "not_configured" };
  }
};

// src/tools/generate_typescript_types.ts
import { z as z13 } from "zod";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { mkdirSync } from "fs";
function normalizeOutputPath(inputPath) {
  if (process.platform === "win32" && inputPath.match(/^\/[a-zA-Z]:/)) {
    inputPath = inputPath.substring(1);
    inputPath = inputPath.charAt(0).toUpperCase() + inputPath.slice(1);
  }
  return resolve(inputPath);
}
var GenerateTypesInputSchema = z13.object({
  included_schemas: z13.array(z13.string()).optional().default(["public"]).describe("Database schemas to include in type generation."),
  output_filename: z13.string().optional().default("database.types.ts").describe("Filename to save the generated types to in the workspace root."),
  output_path: z13.string().describe("Absolute path where to save the file. If provided, output_filename will be ignored.")
});
var GenerateTypesOutputSchema = z13.object({
  success: z13.boolean(),
  message: z13.string().describe("Output message from the generation process."),
  types: z13.string().optional().describe("The generated TypeScript types, if successful."),
  file_path: z13.string().optional().describe("The absolute path to the saved types file, if successful."),
  platform: z13.string().describe("Operating system platform (win32, darwin, linux).")
});
var mcpInputSchema12 = {
  type: "object",
  properties: {
    included_schemas: {
      type: "array",
      items: { type: "string" },
      default: ["public"],
      description: "Database schemas to include in type generation."
    },
    output_filename: {
      type: "string",
      default: "database.types.ts",
      description: "Filename to save the generated types to in the workspace root."
    },
    output_path: {
      type: "string",
      description: 'Absolute path where to download the generated TypeScript file. Examples: Windows: "C:\\\\path\\\\to\\\\project\\\\database.types.ts", macOS/Linux: "/path/to/project/database.types.ts". This parameter is required.'
    }
  },
  required: ["output_path"]
  // output_path is required for file download
};
var generateTypesTool = {
  name: "generate_typescript_types",
  description: "Generates TypeScript types from the database schema using the Supabase CLI (`supabase gen types`) and downloads the file to the specified absolute path. The tool returns the current platform (win32, darwin, linux) to help with path formatting. Requires DATABASE_URL configuration and Supabase CLI installed.",
  inputSchema: GenerateTypesInputSchema,
  mcpInputSchema: mcpInputSchema12,
  // Add static JSON schema
  outputSchema: GenerateTypesOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const dbUrl = client.getDbUrl();
    if (!dbUrl) {
      return {
        success: false,
        message: "Error: DATABASE_URL is not configured. Cannot generate types.",
        platform: process.platform
      };
    }
    const schemas = input.included_schemas.join(",");
    const command = `supabase gen types typescript --db-url "${dbUrl}" --schema "${schemas}"`;
    console.error(`Running command: ${command}`);
    try {
      const { stdout, stderr, error } = await runExternalCommand(command);
      if (error) {
        console.error(`Error executing supabase gen types: ${stderr || error.message}`);
        return {
          success: false,
          message: `Command failed: ${stderr || error.message}`,
          platform: process.platform
        };
      }
      if (stderr) {
        console.error(`supabase gen types produced stderr output: ${stderr}`);
      }
      let outputPath;
      try {
        outputPath = normalizeOutputPath(input.output_path);
        console.error(`Normalized output path: ${outputPath}`);
      } catch (pathError) {
        const pathErrorMessage = pathError instanceof Error ? pathError.message : String(pathError);
        console.error(`Invalid output path: ${pathErrorMessage}`);
        return {
          success: false,
          message: `Invalid output path "${input.output_path}": ${pathErrorMessage}`,
          platform: process.platform
        };
      }
      try {
        const outputDir = dirname(outputPath);
        try {
          mkdirSync(outputDir, { recursive: true });
        } catch (dirError) {
          if (dirError.code !== "EEXIST") {
            throw dirError;
          }
        }
        writeFileSync(outputPath, stdout, "utf8");
        console.error(`Types saved to: ${outputPath}`);
      } catch (writeError) {
        const writeErrorMessage = writeError instanceof Error ? writeError.message : String(writeError);
        console.error(`Failed to write types file: ${writeErrorMessage}`);
        return {
          success: false,
          message: `Type generation succeeded but failed to save file: ${writeErrorMessage}. Platform: ${process.platform}. Attempted path: ${outputPath}`,
          types: stdout,
          platform: process.platform
        };
      }
      console.error("Type generation and file save successful.");
      return {
        success: true,
        message: `Types generated successfully and saved to ${outputPath}.${stderr ? `
Warnings:
${stderr}` : ""}`,
        types: stdout,
        file_path: outputPath,
        platform: process.platform
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Exception during type generation: ${errorMessage}`);
      return {
        success: false,
        message: `Exception during type generation: ${errorMessage}. Platform: ${process.platform}`,
        platform: process.platform
      };
    }
  }
};

// src/tools/create_auth_user.ts
import { z as z14 } from "zod";
var CreateAuthUserInputSchema = z14.object({
  email: z14.string().email().describe("The email address for the new user."),
  password: z14.string().min(6).describe("Plain text password (min 6 chars). WARNING: Insecure."),
  role: z14.string().optional().describe("User role."),
  app_metadata: z14.record(z14.unknown()).optional().describe("Optional app metadata."),
  user_metadata: z14.record(z14.unknown()).optional().describe("Optional user metadata.")
});
var CreatedAuthUserZodSchema = z14.object({
  id: z14.string().uuid(),
  email: z14.string().email().nullable(),
  role: z14.string().nullable(),
  created_at: z14.string().nullable(),
  last_sign_in_at: z14.string().nullable(),
  // Will likely be null on creation
  raw_app_meta_data: z14.record(z14.unknown()).nullable(),
  raw_user_meta_data: z14.record(z14.unknown()).nullable()
  // Add other fields returned by the INSERT if necessary
});
var mcpInputSchema13 = {
  type: "object",
  properties: {
    email: { type: "string", format: "email", description: "The email address for the new user." },
    password: { type: "string", minLength: 6, description: "Plain text password (min 6 chars). WARNING: Insecure." },
    role: { type: "string", default: "authenticated", description: "User role." },
    user_metadata: { type: "object", description: "Optional user metadata." },
    app_metadata: { type: "object", description: "Optional app metadata." }
  },
  required: ["email", "password"]
};
var createAuthUserTool = {
  name: "create_auth_user",
  description: "Creates a new user directly in auth.users. WARNING: Requires plain password, insecure. Use with extreme caution.",
  inputSchema: CreateAuthUserInputSchema,
  mcpInputSchema: mcpInputSchema13,
  // Ensure defined above
  outputSchema: CreatedAuthUserZodSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const { email, password, role, app_metadata, user_metadata } = input;
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to create an auth user directly.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to create an auth user directly.");
    }
    console.warn(`SECURITY WARNING: Creating user ${email} with plain text password via direct DB insert.`);
    context.log(`Attempting to create user ${email}...`, "warn");
    const createdUser = await client.executeTransactionWithPg(async (pgClient) => {
      try {
        await pgClient.query("SELECT crypt('test', gen_salt('bf'))");
      } catch (err) {
        throw new Error("Failed to execute crypt function. Ensure pgcrypto extension is enabled in the database.");
      }
      const sql = `
                INSERT INTO auth.users (
                    instance_id, email, encrypted_password, role,
                    raw_app_meta_data, raw_user_meta_data, 
                    aud, email_confirmed_at, confirmation_sent_at -- Set required defaults
                )
                VALUES (
                    COALESCE(current_setting('app.instance_id', TRUE), '00000000-0000-0000-0000-000000000000')::uuid,
                    $1, crypt($2, gen_salt('bf')),
                    $3,
                    $4::jsonb,
                    $5::jsonb,
                    'authenticated', now(), now()
                )
                RETURNING id, email, role, raw_app_meta_data, raw_user_meta_data, created_at::text, last_sign_in_at::text;
            `;
      const params = [
        email,
        password,
        role || "authenticated",
        // Default role
        JSON.stringify(app_metadata || {}),
        JSON.stringify(user_metadata || {})
      ];
      try {
        const result = await pgClient.query(sql, params);
        if (result.rows.length === 0) {
          throw new Error("User creation failed, no user returned after insert.");
        }
        return CreatedAuthUserZodSchema.parse(result.rows[0]);
      } catch (dbError) {
        let errorMessage = "Unknown database error during user creation";
        let isUniqueViolation = false;
        if (typeof dbError === "object" && dbError !== null && "code" in dbError) {
          if (dbError.code === "23505") {
            isUniqueViolation = true;
            errorMessage = `User creation failed: Email '${email}' likely already exists.`;
          } else if ("message" in dbError && typeof dbError.message === "string") {
            errorMessage = `Database error (${dbError.code}): ${dbError.message}`;
          } else {
            errorMessage = `Database error code: ${dbError.code}`;
          }
        } else if (dbError instanceof Error) {
          errorMessage = `Database error during user creation: ${dbError.message}`;
        } else {
          errorMessage = `Database error during user creation: ${String(dbError)}`;
        }
        console.error("Error creating user in DB:", dbError);
        throw new Error(errorMessage);
      }
    });
    console.error(`Successfully created user ${email} with ID ${createdUser.id}.`);
    context.log(`Successfully created user ${email} with ID ${createdUser.id}.`);
    return createdUser;
  }
};

// src/tools/get_auth_user.ts
import { z as z15 } from "zod";
var GetAuthUserInputSchema = z15.object({
  user_id: z15.string().uuid().describe("The UUID of the user to retrieve.")
});
var AuthUserZodSchema = z15.object({
  id: z15.string().uuid(),
  email: z15.string().email().nullable(),
  role: z15.string().nullable(),
  created_at: z15.string().nullable(),
  last_sign_in_at: z15.string().nullable(),
  raw_app_meta_data: z15.record(z15.unknown()).nullable(),
  raw_user_meta_data: z15.record(z15.unknown()).nullable()
  // Add more fields as needed
});
var mcpInputSchema14 = {
  type: "object",
  properties: {
    user_id: {
      type: "string",
      description: "The UUID of the user to retrieve.",
      format: "uuid"
      // Hint format if possible
    }
  },
  required: ["user_id"]
};
var getAuthUserTool = {
  name: "get_auth_user",
  description: "Retrieves details for a specific user from auth.users by their ID.",
  inputSchema: GetAuthUserInputSchema,
  mcpInputSchema: mcpInputSchema14,
  outputSchema: AuthUserZodSchema,
  // Use the single user Zod schema
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const { user_id } = input;
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to get auth user details.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to get auth user details.");
    }
    const sql = `
            SELECT
                id,
                email,
                role,
                raw_app_meta_data,
                raw_user_meta_data,
                created_at::text,
                last_sign_in_at::text
            FROM auth.users
            WHERE id = $1
        `;
    const params = [user_id];
    console.error(`Attempting to get auth user ${user_id} using direct DB connection...`);
    const user = await client.executeTransactionWithPg(async (pgClient) => {
      const result = await pgClient.query(sql, params);
      if (result.rows.length === 0) {
        throw new Error(`User with ID ${user_id} not found.`);
      }
      try {
        const singleUser = AuthUserZodSchema.parse(result.rows[0]);
        return singleUser;
      } catch (validationError) {
        if (validationError instanceof z15.ZodError) {
          console.error("Zod validation failed:", validationError.errors);
          throw new Error(`Output validation failed: ${validationError.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
        }
        throw validationError;
      }
    });
    console.error(`Found user ${user_id}.`);
    context.log(`Found user ${user_id}.`);
    return user;
  }
};

// src/tools/list_auth_users.ts
import { z as z16 } from "zod";
var ListAuthUsersInputSchema = z16.object({
  limit: z16.number().int().positive().optional().default(50).describe("Max number of users to return"),
  offset: z16.number().int().nonnegative().optional().default(0).describe("Number of users to skip")
  // Add filters later (e.g., by email pattern, role)
});
var AuthUserZodSchema2 = z16.object({
  id: z16.string().uuid(),
  email: z16.string().email().nullable(),
  role: z16.string().nullable(),
  // Timestamps returned as text from DB might not strictly be ISO 8601 / Zod datetime compliant
  created_at: z16.string().nullable(),
  last_sign_in_at: z16.string().nullable(),
  raw_app_meta_data: z16.record(z16.unknown()).nullable(),
  raw_user_meta_data: z16.record(z16.unknown()).nullable()
  // Add more fields as needed (e.g., email_confirmed_at, phone)
});
var ListAuthUsersOutputSchema = z16.array(AuthUserZodSchema2);
var mcpInputSchema15 = {
  type: "object",
  properties: {
    limit: {
      type: "number",
      description: "Max number of users to return",
      default: 50
    },
    offset: {
      type: "number",
      description: "Number of users to skip",
      default: 0
    }
  },
  required: []
};
var listAuthUsersTool = {
  name: "list_auth_users",
  description: "Lists users from the auth.users table.",
  inputSchema: ListAuthUsersInputSchema,
  mcpInputSchema: mcpInputSchema15,
  outputSchema: ListAuthUsersOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const { limit, offset } = input;
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to list auth users.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to list auth users.");
    }
    const listUsersSql = `
            SELECT
                id,
                email,
                role,
                raw_app_meta_data,
                raw_user_meta_data,
                created_at::text, -- Cast timestamp to text for JSON
                last_sign_in_at::text -- Cast timestamp to text for JSON
            FROM
                auth.users
            ORDER BY
                created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
        `;
    console.error("Attempting to list auth users using direct DB connection...");
    const result = await client.executeSqlWithPg(listUsersSql);
    const validatedUsers = handleSqlResponse(result, ListAuthUsersOutputSchema);
    console.error(`Found ${validatedUsers.length} users.`);
    context.log(`Found ${validatedUsers.length} users.`);
    return validatedUsers;
  }
};

// src/tools/update_auth_user.ts
import { z as z17 } from "zod";
var UpdateAuthUserInputSchema = z17.object({
  user_id: z17.string().uuid().describe("The UUID of the user to update."),
  email: z17.string().email().optional().describe("New email address."),
  password: z17.string().min(6).optional().describe("New plain text password (min 6 chars). WARNING: Insecure."),
  role: z17.string().optional().describe("New role."),
  app_metadata: z17.record(z17.unknown()).optional().describe("New app metadata (will overwrite existing)."),
  user_metadata: z17.record(z17.unknown()).optional().describe("New user metadata (will overwrite existing).")
}).refine(
  (data) => data.email || data.password || data.role || data.app_metadata || data.user_metadata,
  { message: "At least one field to update (email, password, role, app_metadata, user_metadata) must be provided." }
);
var UpdatedAuthUserZodSchema = z17.object({
  id: z17.string().uuid(),
  email: z17.string().email().nullable(),
  role: z17.string().nullable(),
  created_at: z17.string().nullable(),
  updated_at: z17.string().nullable(),
  // Expect this to be updated
  last_sign_in_at: z17.string().nullable(),
  raw_app_meta_data: z17.record(z17.unknown()).nullable(),
  raw_user_meta_data: z17.record(z17.unknown()).nullable()
});
var mcpInputSchema16 = {
  type: "object",
  properties: {
    user_id: { type: "string", format: "uuid", description: "The UUID of the user to update." },
    email: { type: "string", format: "email", description: "New email address." },
    password: { type: "string", minLength: 6, description: "New plain text password (min 6 chars). WARNING: Insecure." },
    role: { type: "string", description: "New role." },
    user_metadata: { type: "object", description: "New user metadata (will overwrite existing)." },
    app_metadata: { type: "object", description: "New app metadata (will overwrite existing)." }
  },
  required: ["user_id"]
};
var updateAuthUserTool = {
  name: "update_auth_user",
  description: "Updates fields for a user in auth.users. WARNING: Password handling is insecure. Requires service_role key and direct DB connection.",
  inputSchema: UpdateAuthUserInputSchema,
  mcpInputSchema: mcpInputSchema16,
  // Ensure defined
  outputSchema: UpdatedAuthUserZodSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const { user_id, email, password, role, app_metadata, user_metadata } = input;
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to update auth user details.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to update auth user details.");
    }
    const updates = [];
    const params = [];
    let paramIndex = 1;
    if (email !== void 0) {
      updates.push(`email = $${paramIndex++}`);
      params.push(email);
    }
    if (password !== void 0) {
      updates.push(`encrypted_password = crypt($${paramIndex++}, gen_salt('bf'))`);
      params.push(password);
      console.warn(`SECURITY WARNING: Updating password for user ${user_id} with plain text password via direct DB update.`);
    }
    if (role !== void 0) {
      updates.push(`role = $${paramIndex++}`);
      params.push(role);
    }
    if (app_metadata !== void 0) {
      updates.push(`raw_app_meta_data = $${paramIndex++}::jsonb`);
      params.push(JSON.stringify(app_metadata));
    }
    if (user_metadata !== void 0) {
      updates.push(`raw_user_meta_data = $${paramIndex++}::jsonb`);
      params.push(JSON.stringify(user_metadata));
    }
    params.push(user_id);
    const userIdParamIndex = paramIndex;
    const sql = `
            UPDATE auth.users
            SET ${updates.join(", ")}, updated_at = NOW()
            WHERE id = $${userIdParamIndex}
            RETURNING id, email, role, raw_app_meta_data, raw_user_meta_data, created_at::text, updated_at::text, last_sign_in_at::text;
        `;
    console.error(`Attempting to update auth user ${user_id}...`);
    context.log(`Attempting to update auth user ${user_id}...`);
    const updatedUser = await client.executeTransactionWithPg(async (pgClient) => {
      if (password !== void 0) {
        try {
          await pgClient.query("SELECT crypt('test', gen_salt('bf'))");
        } catch (err) {
          throw new Error("Failed to execute crypt function for password update. Ensure pgcrypto extension is enabled.");
        }
      }
      try {
        const result = await pgClient.query(sql, params);
        if (result.rows.length === 0) {
          throw new Error(`User update failed: User with ID ${user_id} not found or no rows affected.`);
        }
        return UpdatedAuthUserZodSchema.parse(result.rows[0]);
      } catch (dbError) {
        let errorMessage = "Unknown database error during user update";
        let isUniqueViolation = false;
        if (typeof dbError === "object" && dbError !== null && "code" in dbError) {
          if (email !== void 0 && dbError.code === "23505") {
            isUniqueViolation = true;
            errorMessage = `User update failed: Email '${email}' likely already exists for another user.`;
          } else if ("message" in dbError && typeof dbError.message === "string") {
            errorMessage = `Database error (${dbError.code}): ${dbError.message}`;
          } else {
            errorMessage = `Database error code: ${dbError.code}`;
          }
        } else if (dbError instanceof Error) {
          errorMessage = `Database error during user update: ${dbError.message}`;
        } else {
          errorMessage = `Database error during user update: ${String(dbError)}`;
        }
        console.error("Error updating user in DB:", dbError);
        throw new Error(errorMessage);
      }
    });
    console.error(`Successfully updated user ${user_id}.`);
    context.log(`Successfully updated user ${user_id}.`);
    return updatedUser;
  }
};

// src/tools/delete_auth_user.ts
import { z as z18 } from "zod";
var DeleteAuthUserInputSchema = z18.object({
  user_id: z18.string().uuid().describe("The UUID of the user to delete.")
});
var DeleteAuthUserOutputSchema = z18.object({
  success: z18.boolean(),
  message: z18.string()
});
var mcpInputSchema17 = {
  type: "object",
  properties: {
    user_id: {
      type: "string",
      format: "uuid",
      description: "The UUID of the user to delete."
    }
  },
  required: ["user_id"]
};
var deleteAuthUserTool = {
  name: "delete_auth_user",
  description: "Deletes a user from auth.users by their ID. Requires service_role key and direct DB connection.",
  inputSchema: DeleteAuthUserInputSchema,
  mcpInputSchema: mcpInputSchema17,
  outputSchema: DeleteAuthUserOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const { user_id } = input;
    if (!client.isPgAvailable()) {
      throw new Error("Direct database connection (DATABASE_URL) is required for deleting users but is not configured or available.");
    }
    try {
      const result = await client.executeTransactionWithPg(async (pgClient) => {
        const deleteResult = await pgClient.query(
          "DELETE FROM auth.users WHERE id = $1",
          [user_id]
        );
        return deleteResult;
      });
      if (result.rowCount === 1) {
        return {
          success: true,
          message: `Successfully deleted user with ID: ${user_id}`
        };
      }
      return {
        success: false,
        message: `User with ID ${user_id} not found or could not be deleted.`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error deleting user ${user_id}:`, errorMessage);
      throw new Error(`Failed to delete user ${user_id}: ${errorMessage}`);
    }
  }
};

// src/tools/list_storage_buckets.ts
import { z as z19 } from "zod";
var BucketSchema = z19.object({
  id: z19.string(),
  name: z19.string(),
  owner: z19.string().nullable(),
  public: z19.boolean(),
  avif_autodetection: z19.boolean(),
  file_size_limit: z19.number().nullable(),
  allowed_mime_types: z19.array(z19.string()).nullable(),
  // Keep timestamps as strings as returned by DB/pg
  created_at: z19.string().nullable(),
  updated_at: z19.string().nullable()
});
var ListStorageBucketsOutputSchema = z19.array(BucketSchema);
var mcpInputSchema18 = {
  type: "object",
  properties: {},
  required: []
};
var inputSchema = z19.object({});
var listStorageBucketsTool = {
  name: "list_storage_buckets",
  description: "Lists all storage buckets in the project.",
  mcpInputSchema: mcpInputSchema18,
  inputSchema,
  outputSchema: ListStorageBucketsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    console.error("Listing storage buckets...");
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to list storage buckets.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to list storage buckets.");
    }
    const sql = `
            SELECT
                id,
                name,
                owner,
                public,
                avif_autodetection,
                file_size_limit,
                allowed_mime_types,
                created_at::text, -- Cast to text
                updated_at::text  -- Cast to text
            FROM storage.buckets;
        `;
    console.error("Attempting to list storage buckets using direct DB connection...");
    const result = await client.executeSqlWithPg(sql);
    const validatedBuckets = handleSqlResponse(result, ListStorageBucketsOutputSchema);
    console.error(`Found ${validatedBuckets.length} buckets.`);
    context.log(`Found ${validatedBuckets.length} buckets.`);
    return validatedBuckets;
  }
};
var list_storage_buckets_default = listStorageBucketsTool;

// src/tools/list_storage_objects.ts
import { z as z20 } from "zod";
var ListStorageObjectsInputSchema = z20.object({
  bucket_id: z20.string().describe("The ID of the bucket to list objects from."),
  limit: z20.number().int().positive().optional().default(100).describe("Max number of objects to return"),
  offset: z20.number().int().nonnegative().optional().default(0).describe("Number of objects to skip"),
  prefix: z20.string().optional().describe("Filter objects by a path prefix (e.g., 'public/')")
});
var StorageObjectSchema = z20.object({
  id: z20.string().uuid(),
  name: z20.string().nullable(),
  // Name can be null according to schema
  bucket_id: z20.string(),
  owner: z20.string().uuid().nullable(),
  version: z20.string().nullable(),
  // Get mimetype directly from SQL extraction
  mimetype: z20.string().nullable(),
  // size comes from metadata
  size: z20.string().pipe(z20.coerce.number().int()).nullable(),
  // Keep raw metadata as well
  metadata: z20.record(z20.any()).nullable(),
  created_at: z20.string().nullable(),
  updated_at: z20.string().nullable(),
  last_accessed_at: z20.string().nullable()
});
var ListStorageObjectsOutputSchema = z20.array(StorageObjectSchema);
var mcpInputSchema19 = {
  type: "object",
  properties: {
    bucket_id: { type: "string", description: "The ID of the bucket to list objects from." },
    limit: { type: "number", description: "Max number of objects to return", default: 100 },
    offset: { type: "number", description: "Number of objects to skip", default: 0 },
    prefix: { type: "string", description: "Filter objects by a path prefix (e.g., 'public/')" }
  },
  required: ["bucket_id"]
};
var listStorageObjectsTool = {
  name: "list_storage_objects",
  description: "Lists objects within a specific storage bucket, optionally filtering by prefix.",
  mcpInputSchema: mcpInputSchema19,
  inputSchema: ListStorageObjectsInputSchema,
  outputSchema: ListStorageObjectsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const { bucket_id, limit, offset, prefix } = input;
    console.error(`Listing objects for bucket ${bucket_id} (Prefix: ${prefix || "N/A"})...`);
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to list storage objects.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to list storage objects.");
    }
    const objects = await client.executeTransactionWithPg(async (pgClient) => {
      let sql = `
                SELECT
                    id,
                    name,
                    bucket_id,
                    owner,
                    version,
                    metadata ->> 'mimetype' AS mimetype,
                    metadata ->> 'size' AS size, -- Extract size from metadata
                    metadata,
                    created_at::text,
                    updated_at::text,
                    last_accessed_at::text
                FROM storage.objects
                WHERE bucket_id = $1
            `;
      const params = [bucket_id];
      let paramIndex = 2;
      if (prefix) {
        sql += ` AND name LIKE $${paramIndex++}`;
        params.push(`${prefix}%`);
      }
      sql += " ORDER BY name ASC NULLS FIRST";
      sql += ` LIMIT $${paramIndex++}`;
      params.push(limit);
      sql += ` OFFSET $${paramIndex++}`;
      params.push(offset);
      sql += ";";
      console.error("Executing parameterized SQL to list storage objects within transaction...");
      const result = await pgClient.query(sql, params);
      return handleSqlResponse(result.rows, ListStorageObjectsOutputSchema);
    });
    console.error(`Found ${objects.length} objects.`);
    context.log(`Found ${objects.length} objects.`);
    return objects;
  }
};
var list_storage_objects_default = listStorageObjectsTool;

// src/tools/list_realtime_publications.ts
import { z as z21 } from "zod";
var ListRealtimePublicationsInputSchema = z21.object({});
var PublicationSchema = z21.object({
  oid: z21.number().int(),
  pubname: z21.string(),
  pubowner: z21.number().int(),
  // Owner OID
  puballtables: z21.boolean(),
  pubinsert: z21.boolean(),
  pubupdate: z21.boolean(),
  pubdelete: z21.boolean(),
  pubtruncate: z21.boolean(),
  pubviaroot: z21.boolean()
  // Potentially add pubownername if needed via join
});
var ListRealtimePublicationsOutputSchema = z21.array(PublicationSchema);
var mcpInputSchema20 = {
  type: "object",
  properties: {},
  required: []
};
var listRealtimePublicationsTool = {
  name: "list_realtime_publications",
  description: "Lists PostgreSQL publications, often used by Supabase Realtime.",
  mcpInputSchema: mcpInputSchema20,
  inputSchema: ListRealtimePublicationsInputSchema,
  outputSchema: ListRealtimePublicationsOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    console.error("Listing Realtime publications...");
    if (!client.isPgAvailable()) {
      context.log("Direct database connection (DATABASE_URL) is required to list publications.", "error");
      throw new Error("Direct database connection (DATABASE_URL) is required to list publications.");
    }
    const sql = `
            SELECT
                oid,
                pubname,
                pubowner,
                puballtables,
                pubinsert,
                pubupdate,
                pubdelete,
                pubtruncate,
                pubviaroot
            FROM pg_catalog.pg_publication;
        `;
    console.error("Attempting to list publications using direct DB connection...");
    const result = await client.executeSqlWithPg(sql);
    const validatedPublications = handleSqlResponse(result, ListRealtimePublicationsOutputSchema);
    console.error(`Found ${validatedPublications.length} publications.`);
    context.log(`Found ${validatedPublications.length} publications.`);
    return validatedPublications;
  }
};
var list_realtime_publications_default = listRealtimePublicationsTool;

// src/tools/rebuild_hooks.ts
import { z as z22 } from "zod";
var RebuildHooksInputSchema = z22.object({});
var RebuildHooksOutputSchema = z22.object({
  success: z22.boolean(),
  message: z22.string()
});
var mcpInputSchema21 = {
  type: "object",
  properties: {},
  required: []
};
var rebuildHooksTool = {
  name: "rebuild_hooks",
  description: "Attempts to restart the pg_net worker. Requires the pg_net extension to be installed and available.",
  inputSchema: RebuildHooksInputSchema,
  mcpInputSchema: mcpInputSchema21,
  outputSchema: RebuildHooksOutputSchema,
  execute: async (input, context) => {
    const client = context.selfhostedClient;
    const restartSql = "SELECT net.worker_restart()";
    try {
      console.error("Attempting to restart pg_net worker...");
      const result = await executeSqlWithFallback(client, restartSql, false);
      if ("error" in result) {
        const notFound = result.error.code === "42883";
        const message = `Failed to restart pg_net worker: ${result.error.message}${notFound ? " (Is pg_net installed and enabled?)" : ""}`;
        console.error(message);
        return { success: false, message };
      }
      console.error("pg_net worker restart requested successfully.");
      return { success: true, message: "pg_net worker restart requested successfully." };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Exception attempting to restart pg_net worker: ${errorMessage}`);
      return { success: false, message: `Exception attempting to restart pg_net worker: ${errorMessage}` };
    }
  }
};

// src/remote-server.ts
async function main() {
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL || "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    SUPABASE_AUTH_JWT_SECRET: process.env.SUPABASE_AUTH_JWT_SECRET,
    PORT: process.env.PORT || "3000",
    WORKSPACE_PATH: process.env.WORKSPACE_PATH || process.cwd()
  };
  if (!env.SUPABASE_URL) {
    console.error("Error: SUPABASE_URL environment variable is required");
    process.exit(1);
  }
  if (!env.SUPABASE_ANON_KEY) {
    console.error("Error: SUPABASE_ANON_KEY environment variable is required");
    process.exit(1);
  }
  console.log("Starting Self-hosted Supabase Remote MCP Server...");
  console.log(`Supabase URL: ${env.SUPABASE_URL}`);
  console.log(`Workspace Path: ${env.WORKSPACE_PATH}`);
  const supabaseClient = await SelfhostedSupabaseClient.create({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.SUPABASE_AUTH_JWT_SECRET
  });
  await supabaseClient.initialize();
  console.log("Supabase client initialized successfully");
  const availableTools = {
    list_tables: listTablesTool,
    list_extensions: listExtensionsTool,
    list_migrations: listMigrationsTool,
    apply_migration: applyMigrationTool,
    execute_sql: executeSqlTool,
    get_database_connections: getDatabaseConnectionsTool,
    get_database_stats: getDatabaseStatsTool,
    get_project_url: getProjectUrlTool,
    get_anon_key: getAnonKeyTool,
    get_service_key: getServiceKeyTool,
    verify_jwt_secret: verifyJwtSecretTool,
    generate_typescript_types: generateTypesTool,
    create_auth_user: createAuthUserTool,
    get_auth_user: getAuthUserTool,
    list_auth_users: listAuthUsersTool,
    update_auth_user: updateAuthUserTool,
    delete_auth_user: deleteAuthUserTool,
    list_storage_buckets: list_storage_buckets_default,
    list_storage_objects: list_storage_objects_default,
    list_realtime_publications: list_realtime_publications_default,
    rebuild_hooks: rebuildHooksTool
  };
  const toolContext = {
    selfhostedClient: supabaseClient,
    log: (message, level = "info") => {
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    },
    workspacePath: env.WORKSPACE_PATH || process.cwd()
  };
  const capabilitiesTools = {};
  for (const [toolName, tool] of Object.entries(availableTools)) {
    const staticInputSchema = tool.mcpInputSchema || { type: "object", properties: {} };
    capabilitiesTools[toolName] = {
      name: toolName,
      description: tool.description || "Tool description missing",
      inputSchema: staticInputSchema
    };
  }
  const capabilities = { tools: capabilitiesTools };
  const server = new Server(
    {
      name: "self-hosted-supabase-remote-mcp",
      version: "1.0.0"
    },
    {
      capabilities
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(capabilities.tools)
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = availableTools[toolName];
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
    try {
      let parsedArgs = request.params.arguments;
      if (tool.inputSchema && typeof tool.inputSchema.parse === "function") {
        parsedArgs = tool.inputSchema.parse(request.params.arguments);
      }
      const result = await tool.execute(parsedArgs, toolContext);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toolContext.log(`Tool ${toolName} failed: ${errorMessage}`, "error");
      throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${errorMessage}`);
    }
  });
  console.log(`Registered ${Object.keys(availableTools).length} tools`);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (c.req.method === "OPTIONS") {
      return c.text("", 200);
    }
    await next();
  });
  app.post("/mcp", async (c) => {
    try {
      const body = await c.req.json();
      if (!body.jsonrpc || body.jsonrpc !== "2.0") {
        return c.json({
          jsonrpc: "2.0",
          id: body.id || null,
          error: {
            code: -32600,
            message: "Invalid Request"
          }
        }, 400);
      }
      const mockTransport = {
        start: async () => {
        },
        close: async () => {
        },
        send: async (message) => message
      };
      let response;
      if (body.method === "initialize") {
        response = {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities,
            serverInfo: {
              name: "self-hosted-supabase-remote-mcp",
              version: "1.0.0"
            }
          }
        };
      } else if (body.method === "tools/list") {
        response = {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: Object.values(capabilities.tools)
          }
        };
      } else if (body.method === "tools/call") {
        try {
          const toolName = body.params?.name;
          const toolArgs = body.params?.arguments || {};
          if (!toolName) {
            throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
          }
          const tool = availableTools[toolName];
          if (!tool) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
          }
          let parsedArgs = toolArgs;
          if (tool.inputSchema && typeof tool.inputSchema.parse === "function") {
            parsedArgs = tool.inputSchema.parse(toolArgs);
          }
          const toolResult = await tool.execute(parsedArgs, toolContext);
          response = {
            jsonrpc: "2.0",
            id: body.id,
            result: toolResult
          };
        } catch (error) {
          const mcpError = error;
          response = {
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: mcpError.code || -32603,
              message: mcpError.message || "Internal error"
            }
          };
        }
      } else {
        response = {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32601,
            message: "Method not found"
          }
        };
      }
      return c.json(response);
    } catch (error) {
      console.error("MCP request error:", error);
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Internal error",
          data: error instanceof Error ? error.message : String(error)
        }
      }, 500);
    }
  });
  app.get("/sse", (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("Access-Control-Allow-Origin", "*");
    return c.text('data: {"type":"connection","status":"connected"}\n\n');
  });
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      server: "Self-hosted Supabase Remote MCP Server",
      version: "1.0.0"
    });
  });
  app.get("/", (c) => {
    return c.json({
      name: "Self-hosted Supabase Remote MCP Server",
      version: "1.0.0",
      endpoints: {
        mcp: "/mcp",
        sse: "/sse",
        health: "/health"
      },
      documentation: "https://github.com/HenkDz/selfhosted-supabase-mcp"
    });
  });
  const port = parseInt(env.PORT || "3000");
  console.log(`Server starting on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`Health check: http://localhost:${port}/health`);
  serve({
    fetch: app.fetch,
    port
  });
}
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT. Shutting down gracefully...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM. Shutting down gracefully...");
  process.exit(0);
});
main().catch((error) => {
  console.error("Failed to start remote MCP server:", error);
  process.exit(1);
});
