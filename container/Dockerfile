# =============================================================================
# Stage 1: Build Bun application
# =============================================================================
FROM oven/bun:1.3.5-debian AS app-builder

WORKDIR /build

# Install dependencies first (layer caching)
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source and build
COPY app/src ./src
COPY app/public ./public
COPY app/bunfig.toml ./

# Build client and compile server to standalone executable
RUN bun run build && \
    bun build --compile --minify --target=bun-linux-x64 \
    ./src/server/index.ts --outfile tuturu-server

# =============================================================================
# Stage 2: Build Valkey from source
# =============================================================================
FROM debian:bookworm-slim AS valkey-builder

ARG VALKEY_VERSION=9.0.1

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Download and extract Valkey source
RUN curl -fsSL "https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VERSION}.tar.gz" \
        -o valkey.tar.gz && \
    tar -xzf valkey.tar.gz && \
    mv "valkey-${VALKEY_VERSION}" valkey

# Build Valkey (server only, with TLS support)
RUN cd valkey && \
    make BUILD_TLS=yes MALLOC=libc -j$(nproc) valkey-server && \
    strip src/valkey-server

# =============================================================================
# Stage 3: Final UBI10-init image with systemd
# =============================================================================
FROM redhat/ubi10-init:10.1-1763368398

LABEL org.opencontainers.image.title="tuturu" \
      org.opencontainers.image.description="WebRTC 1 to 1 video calling" \
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

# Copy Valkey binary from builder
COPY --from=valkey-builder /build/valkey/src/valkey-server /usr/local/bin/
RUN chmod +x /usr/local/bin/valkey-server

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
        tuturu-redis.service \
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
