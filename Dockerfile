# Remote HTTP-accessible MCP Server for Self-hosted Supabase
FROM node:lts-alpine

# Install wget for health checks
RUN apk add --no-cache wget

WORKDIR /app

# Install dependencies (including dev for build)
COPY package.json package-lock.json ./
RUN npm install

# Copy source files
COPY . .

# Build the remote server
RUN npm run build:remote

# Expose the HTTP port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Set default environment variables
ENV PORT=3000
ENV NODE_ENV=production

# Run the remote MCP server
CMD ["node", "dist-remote/remote-server.js"]
