FROM coturn/coturn:edge-alpine

# Install envsubst (part of gettext)
RUN apk add --no-cache gettext

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
