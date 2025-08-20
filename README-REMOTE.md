# Self-hosted Supabase Remote MCP Server

This is a remote HTTP-accessible version of the Self-hosted Supabase MCP Server. It provides all the same functionality as the original stdio-based server, but accessible via HTTP endpoints for easier integration and deployment.

## Features

- **HTTP-based MCP Protocol**: Access MCP tools via HTTP endpoints instead of stdio
- **Docker Support**: Containerized deployment with Docker and docker-compose
- **All Original Tools**: Maintains all functionality from the original Supabase MCP server
- **Health Monitoring**: Built-in health check endpoints
- **CORS Support**: Cross-origin requests supported for web-based clients

## Quick Start

### Using Docker Compose (Recommended)

1. **Clone and setup**:
   ```bash
   git clone <repository-url>
   cd selfhosted-supabase-mcp
   ```

2. **Create environment file**:
   ```bash
   cp .env.example .env
   # Edit .env with your Supabase configuration
   ```

3. **Start the services**:
   ```bash
   docker-compose -f docker-compose.remote.yml up -d
   ```

4. **Test the server**:
   ```bash
   # Health check
   curl http://localhost:3000/health
   
   # List available tools
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

### Manual Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Build the remote server**:
   ```bash
   npm run build:remote
   ```

3. **Set environment variables**:
   ```bash
   export SUPABASE_URL="http://localhost:8000"
   export SUPABASE_ANON_KEY="your-anon-key"
   # ... other variables from .env.example
   ```

4. **Start the server**:
   ```bash
   npm run start:remote
   ```

## Configuration

### Required Environment Variables

- `SUPABASE_URL`: Your Supabase instance URL
- `SUPABASE_ANON_KEY`: Supabase anonymous key

### Optional Environment Variables

- `SUPABASE_SERVICE_ROLE_KEY`: Service role key for admin operations
- `DATABASE_URL`: Direct PostgreSQL connection string
- `SUPABASE_AUTH_JWT_SECRET`: JWT secret for auth operations
- `PORT`: Server port (default: 3000)
- `WORKSPACE_PATH`: Path for file operations (default: current directory)

## API Endpoints

### MCP Protocol
- `POST /mcp`: Main MCP protocol endpoint
- `GET /sse`: Server-Sent Events endpoint (basic implementation)

### Monitoring
- `GET /health`: Health check endpoint
- `GET /`: Server information and available endpoints

## Available Tools

All tools from the original Supabase MCP server are available:

- **Database**: `list_tables`, `execute_sql`, `get_database_stats`, `get_database_connections`
- **Extensions**: `list_extensions`
- **Migrations**: `list_migrations`, `apply_migration`
- **Auth**: `create_auth_user`, `get_auth_user`, `list_auth_users`, `update_auth_user`, `delete_auth_user`
- **Storage**: `list_storage_buckets`, `list_storage_objects`
- **Realtime**: `list_realtime_publications`
- **Types**: `generate_typescript_types`
- **Configuration**: `get_project_url`, `get_anon_key`, `get_service_key`, `verify_jwt_secret`
- **Hooks**: `rebuild_hooks`

## Usage Examples

### List Tables
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_tables",
      "arguments": {}
    }
  }'
```

### Execute SQL
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "execute_sql",
      "arguments": {
        "sql": "SELECT * FROM users LIMIT 5"
      }
    }
  }'
```

## Development

### Build Commands
- `npm run build:remote`: Build the remote server
- `npm run dev:remote`: Development mode with auto-reload

### Testing
```bash
# Start development server
npm run dev:remote

# In another terminal, test endpoints
curl http://localhost:3000/health
```

## Deployment

### Docker
```bash
# Build image
docker build -t supabase-mcp-remote .

# Run container
docker run -d \
  --name supabase-mcp \
  -p 3000:3000 \
  -e SUPABASE_URL="your-url" \
  -e SUPABASE_ANON_KEY="your-key" \
  supabase-mcp-remote
```

### Docker Compose
```bash
# Production deployment
docker-compose -f docker-compose.remote.yml up -d

# View logs
docker-compose -f docker-compose.remote.yml logs -f mcp-server
```

## Troubleshooting

### Common Issues

1. **Connection refused**: Check if Supabase is running and accessible
2. **Authentication errors**: Verify your keys in the environment variables
3. **Tool execution failures**: Check the server logs for detailed error messages

### Logs
```bash
# Docker logs
docker logs supabase-mcp-server

# Docker Compose logs
docker-compose -f docker-compose.remote.yml logs mcp-server
```

## Migration from Stdio Version

The remote server maintains the same tool interface as the stdio version. The main differences:

1. **Transport**: HTTP instead of stdio
2. **Configuration**: Environment variables instead of CLI arguments
3. **Deployment**: Docker containers instead of direct Node.js execution

All tool functionality remains identical.
