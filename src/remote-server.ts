import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { SelfhostedSupabaseClient } from "./client/index.js";
import type { ToolContext } from "./tools/types.js";
import { z } from "zod";

// Import all tools
import { listTablesTool } from "./tools/list_tables.js";
import { listExtensionsTool } from "./tools/list_extensions.js";
import { listMigrationsTool } from "./tools/list_migrations.js";
import { applyMigrationTool } from "./tools/apply_migration.js";
import { executeSqlTool } from "./tools/execute_sql.js";
import { getDatabaseConnectionsTool } from "./tools/get_database_connections.js";
import { getDatabaseStatsTool } from "./tools/get_database_stats.js";
import { getProjectUrlTool } from "./tools/get_project_url.js";
import { getAnonKeyTool } from "./tools/get_anon_key.js";
import { getServiceKeyTool } from "./tools/get_service_key.js";
import { verifyJwtSecretTool } from "./tools/verify_jwt_secret.js";
import { generateTypesTool } from "./tools/generate_typescript_types.js";
import { createAuthUserTool } from "./tools/create_auth_user.js";
import { getAuthUserTool } from "./tools/get_auth_user.js";
import { listAuthUsersTool } from "./tools/list_auth_users.js";
import { updateAuthUserTool } from "./tools/update_auth_user.js";
import { deleteAuthUserTool } from "./tools/delete_auth_user.js";
import listStorageBucketsTool from "./tools/list_storage_buckets.js";
import listStorageObjectsTool from "./tools/list_storage_objects.js";
import listRealtimePublicationsTool from "./tools/list_realtime_publications.js";
import { rebuildHooksTool } from "./tools/rebuild_hooks.js";

// Environment interface
interface RemoteEnv {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    DATABASE_URL?: string;
    SUPABASE_AUTH_JWT_SECRET?: string;
    PORT?: string;
    WORKSPACE_PATH?: string;
}

/**
 * Main function to start the remote MCP server
 */
async function main() {
    // Load environment variables
    const env: RemoteEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || "",
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        DATABASE_URL: process.env.DATABASE_URL,
        SUPABASE_AUTH_JWT_SECRET: process.env.SUPABASE_AUTH_JWT_SECRET,
        PORT: process.env.PORT || "3000",
        WORKSPACE_PATH: process.env.WORKSPACE_PATH || process.cwd(),
    };

    // Validate required environment variables
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

    // Initialize Supabase client
    const supabaseClient = await SelfhostedSupabaseClient.create({
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        databaseUrl: env.DATABASE_URL,
        jwtSecret: env.SUPABASE_AUTH_JWT_SECRET,
    });

    await supabaseClient.initialize();
    console.log("Supabase client initialized successfully");

    // Register all available tools
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
        list_storage_buckets: listStorageBucketsTool,
        list_storage_objects: listStorageObjectsTool,
        list_realtime_publications: listRealtimePublicationsTool,
        rebuild_hooks: rebuildHooksTool,
    };

    // Create tool context
    const toolContext: ToolContext = {
        selfhostedClient: supabaseClient,
        log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
        },
        workspacePath: env.WORKSPACE_PATH || process.cwd(),
    };

    // Prepare capabilities for the Server constructor
    const capabilitiesTools: Record<string, any> = {};
    for (const [toolName, tool] of Object.entries(availableTools)) {
        const staticInputSchema = tool.mcpInputSchema || { type: 'object', properties: {} };

        capabilitiesTools[toolName] = {
            name: toolName,
            description: tool.description || 'Tool description missing',
            inputSchema: staticInputSchema,
        };
    }

    const capabilities = { tools: capabilitiesTools };

    // Create MCP Server
    const server = new Server(
        {
            name: 'self-hosted-supabase-remote-mcp',
            version: '1.0.0',
        },
        {
            capabilities,
        },
    );

    // Set up request handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.values(capabilities.tools),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const tool = availableTools[toolName as keyof typeof availableTools];

        if (!tool) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }

        try {
            let parsedArgs = request.params.arguments;

            // Use Zod schema for validation if available
            if (tool.inputSchema && typeof tool.inputSchema.parse === 'function') {
                parsedArgs = (tool.inputSchema as z.ZodTypeAny).parse(request.params.arguments);
            }

            // Execute the tool
            const result = await tool.execute(parsedArgs, toolContext);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            toolContext.log(`Tool ${toolName} failed: ${errorMessage}`, 'error');
            throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${errorMessage}`);
        }
    });

    console.log(`Registered ${Object.keys(availableTools).length} tools`);

    // Create main Hono app
    const app = new Hono();

    // Enable CORS
    app.use("*", async (c, next) => {
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

        if (c.req.method === "OPTIONS") {
            return c.text("", 200);
        }

        await next();
    });

    // MCP endpoint - handle JSON-RPC requests
    app.post("/mcp", async (c) => {
        try {
            const body = await c.req.json();

            // Handle JSON-RPC request
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

            // Create a mock transport for the server
            const mockTransport = {
                start: async () => {},
                close: async () => {},
                send: async (message: any) => message,
            };

            // Process the request through the MCP server
            let response;

            if (body.method === "initialize") {
                response = {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        protocolVersion: "2024-11-05",
                        capabilities: capabilities,
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

                    const tool = availableTools[toolName as keyof typeof availableTools];
                    if (!tool) {
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
                    }

                    // Validate arguments if schema is available
                    let parsedArgs = toolArgs;
                    if (tool.inputSchema && typeof tool.inputSchema.parse === 'function') {
                        parsedArgs = (tool.inputSchema as z.ZodTypeAny).parse(toolArgs);
                    }

                    // Execute the tool
                    const toolResult = await tool.execute(parsedArgs, toolContext);

                    response = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: toolResult
                    };
                } catch (error) {
                    const mcpError = error as McpError;
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

    // SSE endpoint (basic implementation)
    app.get("/sse", (c) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");
        c.header("Access-Control-Allow-Origin", "*");
        
        return c.text("data: {\"type\":\"connection\",\"status\":\"connected\"}\n\n");
    });

    // Health check endpoint
    app.get("/health", (c) => {
        return c.json({ 
            status: "ok", 
            timestamp: new Date().toISOString(),
            server: "Self-hosted Supabase Remote MCP Server",
            version: "1.0.0"
        });
    });

    // Root endpoint with server info
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
        port: port,
    });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM. Shutting down gracefully...');
    process.exit(0);
});

// Start the server
main().catch((error) => {
    console.error("Failed to start remote MCP server:", error);
    process.exit(1);
});
