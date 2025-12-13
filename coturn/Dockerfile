FROM coturn/coturn:edge-alpine

# Switch to root to install packages (base image runs as non-root)
USER root

# Install envsubst (part of gettext)
RUN apk add --no-cache gettext

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch back to non-root user
USER nobody:nogroup

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
