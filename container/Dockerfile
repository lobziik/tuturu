# =============================================================================
# Stage 1: Build Bun application + mediasoup worker
# =============================================================================
FROM oven/bun:1.3-debian AS app-builder

WORKDIR /build

# Install mediasoup worker build dependencies (C++ compiler, Python, make).
# These stay in the build stage only — NOT in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        gcc \
        g++ \
        make \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer caching).
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source and build
COPY app/src ./src
COPY app/public ./public
COPY app/bunfig.toml app/build.ts app/tsconfig.json ./

# Docker provides TARGETARCH automatically (amd64, arm64)
ARG TARGETARCH

# 1. Build mediasoup C++ worker from source (bun doesn't run postinstall by default).
# 2. Verify and copy worker for embed.
# 3. Build client assets.
# 4. Compile server to standalone executable with embedded worker.
# Map TARGETARCH to Bun compile target: amd64 -> bun-linux-x64, arm64 -> bun-linux-arm64
RUN BUN_TARGET="bun-linux-x64" && \
    if [ "$TARGETARCH" = "arm64" ]; then BUN_TARGET="bun-linux-arm64"; fi && \
    bun run worker:build && \
    bun run worker:verify && \
    bun run worker:copy && \
    bun run build && \
    bun build --compile --minify --target=$BUN_TARGET \
    ./src/server/index.ts --outfile tuturu-server

# =============================================================================
# Stage 2: Final UBI10-init image with systemd
# =============================================================================
FROM redhat/ubi10-init:10.1-1774254118

LABEL org.opencontainers.image.title="tuturu" \
      org.opencontainers.image.description="WebRTC video calling and messaging" \
      org.opencontainers.image.licenses="AGPL-3.0"

# Install EPEL repository and required packages
RUN dnf install -y \
        https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm && \
    dnf install -y \
        nginx \
        nginx-mod-stream \
        coturn \
        certbot \
        gettext \
        procps-ng \
        curl \
        openssl \
        && \
    dnf clean all && \
    rm -rf /var/cache/dnf

# Copy compiled Bun application
COPY --from=app-builder /build/tuturu-server /usr/local/bin/
RUN chmod +x /usr/local/bin/tuturu-server

# Copy configuration templates
COPY container/templates/nginx.conf.template /etc/nginx/
COPY container/templates/turnserver.conf.template /etc/coturn/

# Copy systemd service files
COPY container/systemd/*.service container/systemd/*.timer /etc/systemd/system/

# Copy scripts
COPY container/scripts/ /usr/local/bin/
RUN chmod +x /usr/local/bin/tuturu-*.sh

# Copy static files (cover website)
COPY container/html/ /var/www/html/

# Create required directories
RUN mkdir -p \
        /var/lib/tuturu \
        /var/www/acme/.well-known/acme-challenge \
        /etc/tuturu \
        /etc/coturn \
        /run/nginx && \
    chown -R nginx:nginx /var/www /run/nginx

# Enable systemd services
RUN systemctl enable \
        tuturu-init.service \
        tuturu-certbot.service \
        tuturu-nginx.service \
        tuturu-coturn.service \
        tuturu-app.service \
        tuturu-certbot-renew.timer

# Expose ports
# 80: HTTP (redirect + ACME challenge)
# 443: HTTPS/WSS/TURNS via SNI routing
# 49152-49200: TURN relay range
EXPOSE 80/tcp 443/tcp 49152-49200/udp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf http://127.0.0.1:3000/health || exit 1

# Volume for certificates persistence
VOLUME ["/etc/letsencrypt"]

# Start systemd as PID 1
CMD ["/sbin/init"]
