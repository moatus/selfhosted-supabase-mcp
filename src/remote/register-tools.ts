import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SelfhostedSupabaseClient } from "../client/index.js";
import type { ToolContext } from "../tools/types.js";

// Import all existing tools
import { listTablesTool } from "../tools/list_tables.js";
import { listExtensionsTool } from "../tools/list_extensions.js";
import { listMigrationsTool } from "../tools/list_migrations.js";
import { applyMigrationTool } from "../tools/apply_migration.js";
import { executeSqlTool } from "../tools/execute_sql.js";
import { getDatabaseConnectionsTool } from "../tools/get_database_connections.js";
import { getDatabaseStatsTool } from "../tools/get_database_stats.js";
import { getProjectUrlTool } from "../tools/get_project_url.js";
import { getAnonKeyTool } from "../tools/get_anon_key.js";
import { getServiceKeyTool } from "../tools/get_service_key.js";
import { verifyJwtSecretTool } from "../tools/verify_jwt_secret.js";
import { generateTypesTool } from "../tools/generate_typescript_types.js";
import { createAuthUserTool } from "../tools/create_auth_user.js";
import { getAuthUserTool } from "../tools/get_auth_user.js";
import { listAuthUsersTool } from "../tools/list_auth_users.js";
import { updateAuthUserTool } from "../tools/update_auth_user.js";
import { deleteAuthUserTool } from "../tools/delete_auth_user.js";
import listStorageBucketsTool from "../tools/list_storage_buckets.js";
import listStorageObjectsTool from "../tools/list_storage_objects.js";
import listRealtimePublicationsTool from "../tools/list_realtime_publications.js";
import { rebuildHooksTool } from "../tools/rebuild_hooks.js";

interface RemoteToolContext {
    workspacePath: string;
}

/**
 * Register all Supabase tools with the remote MCP server
 */
export async function registerSupabaseTools(
    server: McpServer,
    supabaseClient: SelfhostedSupabaseClient,
    context: RemoteToolContext
): Promise<void> {
    // Create tool context
    const toolContext: ToolContext = {
        selfhostedClient: supabaseClient,
        log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
        },
        workspacePath: context.workspacePath,
    };

    // List of all available tools
    const tools = [
        listTablesTool,
        listExtensionsTool,
        listMigrationsTool,
        applyMigrationTool,
        executeSqlTool,
        getDatabaseConnectionsTool,
        getDatabaseStatsTool,
        getProjectUrlTool,
        getAnonKeyTool,
        getServiceKeyTool,
        verifyJwtSecretTool,
        generateTypesTool,
        createAuthUserTool,
        getAuthUserTool,
        listAuthUsersTool,
        updateAuthUserTool,
        deleteAuthUserTool,
        listStorageBucketsTool,
        listStorageObjectsTool,
        listRealtimePublicationsTool,
        rebuildHooksTool,
    ];

    console.log(`Registering ${tools.length} Supabase tools...`);

    // Register each tool with the server
    for (const tool of tools) {
        try {
            server.tool(
                tool.name,
                tool.description,
                tool.inputSchema,
                async (input: any) => {
                    try {
                        toolContext.log(`Executing tool: ${tool.name}`, 'info');
                        const result = await tool.execute(input, toolContext);
                        toolContext.log(`Tool ${tool.name} completed successfully`, 'info');
                        return result;
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        toolContext.log(`Tool ${tool.name} failed: ${errorMessage}`, 'error');
                        
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `**Error executing ${tool.name}**\n\n${errorMessage}`
                                }
                            ]
                        };
                    }
                }
            );
            
            console.log(`✓ Registered tool: ${tool.name}`);
        } catch (error) {
            console.error(`✗ Failed to register tool ${tool.name}:`, error);
        }
    }

    console.log("All Supabase tools registered successfully!");
}
