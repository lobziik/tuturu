FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bunfig.toml ./

# Install dependencies (if any)
RUN bun install

# Copy source code
COPY src/ ./src/
COPY public/ ./public/

# Build client TypeScript bundle
RUN bun run build

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun fetch http://localhost:3000/health || exit 1

# Run the server
CMD ["bun", "run", "src/server.ts"]
