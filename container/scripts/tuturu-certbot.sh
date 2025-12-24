#!/bin/bash
# tuturu-certbot.sh
# Obtain Let's Encrypt certificates for tuturu domains
# FAIL FAST: Exit immediately on any error

set -euo pipefail

log() { echo "[tuturu-certbot] $*"; }
error() { echo "[tuturu-certbot] ERROR: $*" >&2; exit 1; }

# =============================================================================
# Load environment
# =============================================================================
if [[ ! -f /etc/tuturu/env ]]; then
    error "/etc/tuturu/env not found. Run tuturu-init.sh first."
fi

set -a
source /etc/tuturu/env
set +a

# =============================================================================
# Check if certificates already exist
# =============================================================================
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

if [[ -f "${CERT_PATH}" ]]; then
    log "Certificates already exist at ${CERT_PATH}"
    log "Skipping certificate acquisition"
    exit 0
fi

# =============================================================================
# Define domains to obtain certificates for
# =============================================================================
# Using short subdomain prefixes (a. and t.)
DOMAINS="${DOMAIN},a.${DOMAIN},t.${DOMAIN}"

log "Obtaining certificates for: ${DOMAINS}"

# =============================================================================
# Build certbot command
# =============================================================================
CERTBOT_FLAGS=(
    "--non-interactive"
    "--agree-tos"
    "--email" "${LETSENCRYPT_EMAIL}"
    "-d" "${DOMAIN}"
    "-d" "a.${DOMAIN}"
    "-d" "t.${DOMAIN}"
)

# Use staging environment for testing
if [[ "${LETSENCRYPT_STAGING:-}" == "true" ]]; then
    CERTBOT_FLAGS+=("--staging")
    log "Using Let's Encrypt STAGING environment (certificates will NOT be trusted)"
fi

# =============================================================================
# Obtain certificates using standalone mode
# =============================================================================
log "Running certbot in standalone mode..."
log "This requires port 80 to be available"

certbot certonly \
    --standalone \
    "${CERTBOT_FLAGS[@]}"

# =============================================================================
# Verify certificate was obtained
# =============================================================================
# certbot creates a single SAN certificate covering all domains
# stored in the first domain's directory
log "Verifying certificate..."

if [[ ! -f "${CERT_PATH}" ]]; then
    error "Failed to obtain certificate. Expected at ${CERT_PATH}"
fi

log "Certificate verified: ${CERT_PATH}"
log "SAN certificate covers: ${DOMAIN}, a.${DOMAIN}, t.${DOMAIN}"
