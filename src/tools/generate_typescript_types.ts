import { z } from 'zod';
import type { SelfhostedSupabaseClient } from '../client/index.js';
// import type { McpToolDefinition } from '@modelcontextprotocol/sdk/types.js'; // Removed incorrect import
import type { ToolContext } from './types.js';
import { runExternalCommand } from './utils.js'; // Need a new helper for running commands

// Input schema
const GenerateTypesInputSchema = z.object({
    included_schemas: z.array(z.string()).optional().default(['public']).describe('Database schemas to include in type generation.'),
});
type GenerateTypesInput = z.infer<typeof GenerateTypesInputSchema>;

// Output schema
const GenerateTypesOutputSchema = z.object({
    success: z.boolean(),
    message: z.string().describe('Output message from the generation process.'),
    types: z.string().optional().describe('The generated TypeScript types, if successful.'),
});

// Static JSON Schema for MCP capabilities
const mcpInputSchema = {
    type: 'object',
    properties: {
        included_schemas: {
            type: 'array',
            items: { type: 'string' },
            default: ['public'],
            description: 'Database schemas to include in type generation.',
        },
    },
    required: [], // included_schemas is optional with default
};

// The tool definition - No explicit McpToolDefinition type needed
export const generateTypesTool = {
    name: 'generate_typescript_types',
    description: 'Generates TypeScript types from the database schema using the Supabase CLI (`supabase gen types`). Requires DATABASE_URL configuration and Supabase CLI installed.',
    inputSchema: GenerateTypesInputSchema,
    mcpInputSchema: mcpInputSchema, // Add static JSON schema
    outputSchema: GenerateTypesOutputSchema,
    execute: async (input: GenerateTypesInput, context: ToolContext) => {
        const client = context.selfhostedClient;
        const dbUrl = client.getDbUrl(); // Need this getter in the client

        if (!dbUrl) {
            return {
                success: false,
                message: 'Error: DATABASE_URL is not configured. Cannot generate types.',
            };
        }

        // Construct the command
        // Use --local flag for self-hosted?
        const schemas = input.included_schemas.join(','); // Comma-separated for the CLI flag
        // Note: The actual command might vary slightly based on Supabase CLI version and context.
        // Using --db-url is generally safer for self-hosted.
        const command = `supabase gen types typescript --db-url "${dbUrl}" --schema "${schemas}"`;

        console.error(`Running command: ${command}`);

        try {
            const { stdout, stderr, error } = await runExternalCommand(command);

            if (error) {
                console.error(`Error executing supabase gen types: ${stderr || error.message}`);
                return {
                    success: false,
                    message: `Command failed: ${stderr || error.message}`,
                };
            }

            if (stderr) {
                console.error(`supabase gen types produced stderr output: ${stderr}`);
                 // Treat stderr as non-fatal for now, maybe just warnings
            }

            console.error('Type generation successful.');
            return {
                success: true,
                message: `Types generated successfully.${stderr ? `\nWarnings:\n${stderr}` : ''}`,
                types: stdout,
            };

        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error(`Exception during type generation: ${errorMessage}`);
            return {
                success: false,
                message: `Exception during type generation: ${errorMessage}`,
            };
        }
    },
}; 