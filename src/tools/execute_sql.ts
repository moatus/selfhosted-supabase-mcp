import { z } from 'zod';
import type { SelfhostedSupabaseClient } from '../client/index.js';
// import type { McpToolDefinition } from '@modelcontextprotocol/sdk'; // Removed incorrect import
import { handleSqlResponse } from './utils.js';
import type { ToolContext } from './types.js';

// Input schema
const ExecuteSqlInputSchema = z.object({
    sql: z.string().describe('The SQL query to execute.'),
    read_only: z.boolean().optional().default(false).describe('Hint for the RPC function whether the query is read-only (best effort).'),
    // Future enhancement: Add option to force direct connection?
    // use_direct_connection: z.boolean().optional().default(false).describe('Attempt to use direct DB connection instead of RPC.'),
});
type ExecuteSqlInput = z.infer<typeof ExecuteSqlInputSchema>;

// Output schema - expects an array of results (rows)
const ExecuteSqlOutputSchema = z.array(z.unknown()).describe('The array of rows returned by the SQL query.');

// Static JSON Schema for MCP capabilities
const mcpInputSchema = {
    type: 'object',
    properties: {
        sql: { type: 'string', description: 'The SQL query to execute.' },
        read_only: { type: 'boolean', default: false, description: 'Hint for the RPC function whether the query is read-only (best effort).' },
    },
    required: ['sql'],
};

// The tool definition - No explicit McpToolDefinition type needed
export const executeSqlTool = {
    name: 'execute_sql',
    description: 'Executes an arbitrary SQL query against the database, primarily using the execute_sql RPC function.',
    inputSchema: ExecuteSqlInputSchema,
    mcpInputSchema: mcpInputSchema,
    outputSchema: ExecuteSqlOutputSchema,
    execute: async (input: ExecuteSqlInput, context: ToolContext) => {
        const client = context.selfhostedClient;

        // TODO: Add logic for optional direct connection if needed

        console.error(`Executing SQL (readOnly: ${input.read_only}): ${input.sql.substring(0, 100)}...`);
        const result = await client.executeSqlViaRpc(input.sql, input.read_only);

        // handleSqlResponse will throw on SQL errors or validation errors
        return handleSqlResponse(result, ExecuteSqlOutputSchema);
    },
}; 