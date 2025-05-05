import { z } from 'zod';
import type { SqlExecutionResult, SqlErrorResponse } from '../types/index.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Type guard to check if a SQL execution result is an error response.
 */
export function isSqlErrorResponse(result: SqlExecutionResult): result is SqlErrorResponse {
    return (result as SqlErrorResponse).error !== undefined;
}

/**
 * Handles the response from SQL execution (via RPC or pg).
 * Checks for errors, parses the data using the provided Zod schema,
 * and throws an error if parsing fails or if the database returned an error.
 */
export function handleSqlResponse<T extends z.ZodTypeAny>(
    result: SqlExecutionResult,
    schema: T
): z.infer<T> {
    if (isSqlErrorResponse(result)) {
        // Throw an error that the MCP SDK can potentially catch and format
        throw new Error(`SQL Error (${result.error.code || 'UNKNOWN'}): ${result.error.message}`);
    }

    // If it's not an error, it should be SqlSuccessResponse (unknown[])
    try {
        // Parse the data (which should be unknown[] according to SqlSuccessResponse)
        const parsedData = schema.parse(result);
        return parsedData;
    } catch (validationError: unknown) {
        // Handle Zod validation errors
        if (validationError instanceof z.ZodError) {
             console.error("Zod validation failed:", validationError.errors);
             throw new Error(`Output validation failed: ${validationError.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
        }
        // Handle other potential errors during parsing
        console.error("Error parsing SQL response:", validationError);
        const message = validationError instanceof Error ? validationError.message : String(validationError);
        throw new Error(`Failed to parse SQL response: ${message}`);
    }
}

/**
 * Executes an external shell command asynchronously.
 * Returns stdout, stderr, and any execution error.
 */
export async function runExternalCommand(command: string): Promise<{
    stdout: string;
    stderr: string;
    error: Error | null;
}> {
    try {
        const { stdout, stderr } = await execAsync(command);
        return { stdout, stderr, error: null };
    } catch (error: unknown) {
        // execAsync throws on non-zero exit code, includes stdout/stderr in the error object
        const execError = error as Error & { stdout?: string; stderr?: string };
        return {
            stdout: execError.stdout || '',
            stderr: execError.stderr || execError.message, // Use message if stderr is empty
            error: execError,
        };
    }
} 