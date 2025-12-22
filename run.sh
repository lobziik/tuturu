#!/bin/bash
# Run tuturu container
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-tuturu}"
IMAGE_TAG="${IMAGE_TAG:-local}"
CONTAINER_NAME="${CONTAINER_NAME:-tuturu}"

# Required environment variables
: "${DOMAIN:?DOMAIN is required (e.g., call.example.com)}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL is required}"
: "${EXTERNAL_IP:?EXTERNAL_IP is required}"

# Optional environment variables
TURN_USERNAME="${TURN_USERNAME:-webrtc}"
LETSENCRYPT_STAGING="${LETSENCRYPT_STAGING:-false}"

# Certificate volume: use CERTS_DIR if provided, otherwise named volume
if [[ -n "${CERTS_DIR:-}" ]]; then
    CERT_VOLUME="${CERTS_DIR}:/etc/letsencrypt"
else
    CERT_VOLUME="tuturu-certs:/etc/letsencrypt"
fi

echo "Starting ${CONTAINER_NAME}..."
echo "  DOMAIN: ${DOMAIN}"
echo "  EXTERNAL_IP: ${EXTERNAL_IP}"
echo "  LETSENCRYPT_STAGING: ${LETSENCRYPT_STAGING}"
echo "  CERTS: ${CERT_VOLUME}"

# Stop and remove existing container if present
podman rm -f "${CONTAINER_NAME}" 2>/dev/null || true

podman run -d \
    --name "${CONTAINER_NAME}" \
    --hostname "${CONTAINER_NAME}" \
    --systemd always \
    -p 80:80 \
    -p 443:443 \
    -p 49152-49200:49152-49200/udp \
    -e "DOMAIN=${DOMAIN}" \
    -e "LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}" \
    -e "EXTERNAL_IP=${EXTERNAL_IP}" \
    -e "TURN_USERNAME=${TURN_USERNAME}" \
    ${TURN_PASSWORD:+-e "TURN_PASSWORD=${TURN_PASSWORD}"} \
    ${STUN_SERVERS:+-e "STUN_SERVERS=${STUN_SERVERS}"} \
    ${FORCE_RELAY:+-e "FORCE_RELAY=${FORCE_RELAY}"} \
    -e "LETSENCRYPT_STAGING=${LETSENCRYPT_STAGING}" \
    -v "${CERT_VOLUME}" \
    --restart unless-stopped \
    "${IMAGE_NAME}:${IMAGE_TAG}"

echo "Container started."
echo ""
echo "=== Viewing Logs ==="
echo "Container uses systemd, so use journalctl inside the container:"
echo ""
echo "  # Follow all service logs"
echo "  podman exec ${CONTAINER_NAME} journalctl -f"
echo ""
echo "  # View specific service logs"
echo "  podman exec ${CONTAINER_NAME} journalctl -u tuturu-app -f      # Bun signaling server"
echo "  podman exec ${CONTAINER_NAME} journalctl -u tuturu-nginx -f    # nginx reverse proxy"
echo "  podman exec ${CONTAINER_NAME} journalctl -u tuturu-coturn -f   # TURN/STUN server"
echo "  podman exec ${CONTAINER_NAME} journalctl -u tuturu-certbot     # Certificate provisioning"
echo "  podman exec ${CONTAINER_NAME} journalctl -u tuturu-init        # Initialization (one-shot)"
echo ""
echo "  # View logs since container start"
echo "  podman exec ${CONTAINER_NAME} journalctl -b"
echo ""
echo "  # View last N lines"
echo "  podman exec ${CONTAINER_NAME} journalctl -n 100"
echo ""
echo "  # Check service status"
echo "  podman exec ${CONTAINER_NAME} systemctl status tuturu-app tuturu-nginx tuturu-coturn"
