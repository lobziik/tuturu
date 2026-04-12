FROM oven/bun:latest

WORKDIR /app

# Install mediasoup worker build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip gcc g++ make \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lock bunfig.toml ./

# Install dependencies (worker is built later via build:prod → worker:prepare)
RUN bun install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY public/ ./public/
COPY build.ts tsconfig.json ./

# Build client + prepare worker + compile server
RUN mkdir -p dist && bun run build:prod

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun fetch http://localhost:3000/health || exit 1

# Run the compiled executable
CMD ["./dist/server"]
