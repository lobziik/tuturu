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
# Using short subdomain prefixes (a. and t.) for DPI evasion
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
# Verify certificates were obtained
# =============================================================================
log "Verifying certificates..."

for domain in "${DOMAIN}" "a.${DOMAIN}" "t.${DOMAIN}"; do
    cert_file="/etc/letsencrypt/live/${domain}/fullchain.pem"
    if [[ ! -f "${cert_file}" ]]; then
        # Let's Encrypt may use the base domain's directory for all certs
        # Check if cert exists in base domain directory
        alt_cert_file="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
        if [[ "${domain}" != "${DOMAIN}" ]] && [[ -f "${alt_cert_file}" ]]; then
            log "Certificate for ${domain} found in ${DOMAIN} directory (SAN certificate)"
        else
            error "Failed to obtain certificate for ${domain}. Expected at ${cert_file}"
        fi
    else
        log "Certificate verified: ${cert_file}"
    fi
done

log "All certificates obtained successfully"
