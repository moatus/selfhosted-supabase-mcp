import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";

/**
 * Base MCP Agent class for HTTP-based MCP servers
 * Simplified version without Cloudflare Workers dependencies
 */
export abstract class McpAgent<TEnv = any, TState = any, TProps = any> {
    abstract server: McpServer;
    protected env: TEnv;
    protected props: TProps;
    protected state: TState;

    constructor(env: TEnv, props: TProps, state?: TState) {
        this.env = env;
        this.props = props;
        this.state = state || ({} as TState);
    }

    /**
     * Initialize the MCP agent - override this method to register tools
     */
    abstract init(): Promise<void>;

    /**
     * Cleanup method - override if needed
     */
    async cleanup(): Promise<void> {
        // Default implementation - override if needed
    }

    /**
     * Create HTTP server for MCP endpoints
     */
    static serve(path: string = "/mcp") {
        const app = new Hono();

        // Enable CORS for all origins
        app.use("*", async (c, next) => {
            c.header("Access-Control-Allow-Origin", "*");
            c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

            if (c.req.method === "OPTIONS") {
                return c.text("", 200);
            }

            await next();
        });

        // MCP endpoint
        app.post(path, async (c) => {
            try {
                const body = await c.req.json();
                
                // Create agent instance
                const env = c.env || {};
                const props = {}; // No authentication for now
                const agent = new (this as any)(env, props);
                
                // Initialize agent
                await agent.init();
                
                // Handle MCP request
                const response = await agent.server.handleRequest(body);
                
                return c.json(response);
            } catch (error) {
                console.error("MCP request error:", error);
                return c.json({
                    error: {
                        code: -32603,
                        message: "Internal error",
                        data: error instanceof Error ? error.message : String(error)
                    }
                }, 500);
            }
        });

        // Health check endpoint
        app.get("/health", (c) => {
            return c.json({ status: "ok", timestamp: new Date().toISOString() });
        });

        return app;
    }

    /**
     * Create Server-Sent Events endpoint (simplified version)
     */
    static serveSSE(path: string = "/sse") {
        const app = new Hono();

        app.use("*", async (c, next) => {
            c.header("Access-Control-Allow-Origin", "*");
            c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Cache-Control");

            if (c.req.method === "OPTIONS") {
                return c.text("", 200);
            }

            await next();
        });

        app.get(path, (c) => {
            // Basic SSE implementation
            c.header("Content-Type", "text/event-stream");
            c.header("Cache-Control", "no-cache");
            c.header("Connection", "keep-alive");
            
            return c.text("data: {\"type\":\"connection\",\"status\":\"connected\"}\n\n");
        });

        return app;
    }
}
