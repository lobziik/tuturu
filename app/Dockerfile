FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bunfig.toml ./

# Install dependencies
RUN bun install

# Copy source code
COPY src/ ./src/
COPY public/ ./public/

# Build client
RUN bun run build

# Build server with embedded assets
RUN mkdir -p dist && bun run build:server

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun fetch http://localhost:3000/health || exit 1

# Run the compiled executable
CMD ["./dist/server"]
