#!/bin/bash
set -e

# tuturu SSL Certificate Setup Script
# Obtains Let's Encrypt certificates for all required subdomains
# Uses certbot podman container (no installation required)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== tuturu SSL Certificate Setup ===${NC}"
echo ""

# Change to project root directory
cd "$(dirname "$0")/.." || exit 1

# Load environment variables from .env if it exists
if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    echo "Please copy .env.example to .env and configure it first:"
    echo "  cp .env.example .env"
    echo "  # Edit .env with your domain and email"
    exit 1
fi

# Source .env (export all variables)
set -a
source .env
set +a

# Validate required variables
if [ -z "$DOMAIN" ] || [ -z "$LETSENCRYPT_EMAIL" ]; then
    echo -e "${RED}Error: DOMAIN and LETSENCRYPT_EMAIL must be set in .env${NC}"
    echo "Please edit .env and set:"
    echo "  DOMAIN=yourdomain.com"
    echo "  LETSENCRYPT_EMAIL=your@email.com"
    exit 1
fi

# Get server's public IP
SERVER_IP=$(curl -s ifconfig.me || echo "UNKNOWN")

echo -e "Configuration:"
echo -e "  Domain: ${GREEN}${DOMAIN}${NC}"
echo -e "  Email:  ${GREEN}${LETSENCRYPT_EMAIL}${NC}"
echo -e "  Server IP: ${GREEN}${SERVER_IP}${NC}"
echo ""

echo -e "${YELLOW}This script will obtain Let's Encrypt certificates for:${NC}"
echo "  1. ${DOMAIN} (cover website)"
echo "  2. a.${DOMAIN} (Bun signaling app)"
echo "  3. t.${DOMAIN} (coturn TURN server)"
echo ""

echo -e "${YELLOW}Prerequisites:${NC}"
echo "  - Ports 80 and 443 must be accessible from the internet"
echo "  - DNS records must point to this server's IP (${SERVER_IP}):"
echo ""
echo "    ${DOMAIN}          A    ${SERVER_IP}"
echo "    a.${DOMAIN}      A    ${SERVER_IP}"
echo "    t.${DOMAIN}     A    ${SERVER_IP}"
echo ""
echo -e "${YELLOW}Important:${NC}"
echo "  - If nginx is running, it will be stopped temporarily"
echo "  - Certbot needs port 80 for domain validation"
echo ""

# Prompt for confirmation
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Create ssl directory
mkdir -p ./ssl

# Stop nginx if running (needs port 80)
if podman ps --format '{{.Names}}' | grep -q tuturu-nginx; then
    echo ""
    echo -e "${YELLOW}Stopping nginx container to free port 80...${NC}"
    podman stop tuturu-nginx
fi

# Function to obtain certificate for a domain
obtain_cert() {
    local domain=$1
    local dns_check=$2

    echo ""
    echo -e "${GREEN}=== Obtaining certificate for ${domain} ===${NC}"

    # Check DNS resolution
    if [ "$dns_check" = "true" ]; then
        echo "Checking DNS resolution..."
        RESOLVED_IP=$(dig +short "${domain}" @8.8.8.8 | tail -n1)
        if [ -z "$RESOLVED_IP" ]; then
            echo -e "${RED}Warning: ${domain} does not resolve to any IP${NC}"
            echo "Please ensure DNS records are configured correctly."
            read -p "Continue anyway? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Skipping ${domain}"
                return 1
            fi
        elif [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
            echo -e "${YELLOW}Warning: ${domain} resolves to ${RESOLVED_IP}, but server IP is ${SERVER_IP}${NC}"
            read -p "Continue anyway? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Skipping ${domain}"
                return 1
            fi
        else
            echo -e "${GREEN}DNS OK: ${domain} → ${RESOLVED_IP}${NC}"
        fi
    fi

    # Run certbot in podman container (standalone mode)
    echo "Running certbot..."
    if podman run --rm \
        -v "$(pwd)/ssl:/etc/letsencrypt" \
        -p 80:80 \
        certbot/certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "${LETSENCRYPT_EMAIL}" \
        --no-eff-email \
        -d "${domain}"; then

        # Check if certificate was obtained
        if [ ! -d "./ssl/live/${domain}" ]; then
            echo -e "${RED}Failed to obtain certificate for ${domain}${NC}"
            return 1
        fi

        # Create domain-specific directory structure expected by nginx/coturn
        mkdir -p "./ssl/${domain}"
        cp "./ssl/live/${domain}/fullchain.pem" "./ssl/${domain}/fullchain.pem"
        cp "./ssl/live/${domain}/privkey.pem" "./ssl/${domain}/privkey.pem"
        chmod 600 "./ssl/${domain}/privkey.pem"

        echo -e "${GREEN}✓ Certificate obtained for ${domain}${NC}"
        return 0
    else
        echo -e "${RED}Certbot command failed for ${domain} (exit code: $?)${NC}"
        echo "This domain will be skipped. You can re-run the script later."
        return 1
    fi
}

# Obtain certificates for all domains
SUCCESS_COUNT=0
TOTAL_COUNT=3

# Base domain (cover website)
if obtain_cert "${DOMAIN}" "true"; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
fi

# App subdomain
if obtain_cert "a.${DOMAIN}" "true"; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
fi

# TURN subdomain
if obtain_cert "t.${DOMAIN}" "true"; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
fi

echo ""
echo -e "${GREEN}=== Certificate Setup Complete ===${NC}"
echo ""
echo "Certificates obtained: ${SUCCESS_COUNT}/${TOTAL_COUNT}"
echo ""

if [ $SUCCESS_COUNT -eq $TOTAL_COUNT ]; then
    echo -e "${GREEN}✓ All certificates obtained successfully${NC}"
    echo ""
    echo "Certificates are stored in: ./ssl/"
    echo ""
    echo "Next steps:"
    echo "  1. Review your .env configuration"
    echo "  2. Start all services:"
    echo "       podman-compose up -d"
    echo "  3. Check service status:"
    echo "       podman-compose ps"
    echo "  4. View logs:"
    echo "       podman-compose logs -f"
    echo ""
    echo "Certificate renewal:"
    echo "  Certificates expire in 90 days. To renew:"
    echo "    ./scripts/setup-ssl.sh"
    echo "  Or set up automatic renewal with a cron job."
    echo ""
else
    echo -e "${YELLOW}⚠ Some certificates could not be obtained${NC}"
    echo "Please check the errors above and ensure:"
    echo "  - DNS records are correct"
    echo "  - Ports 80 and 443 are accessible"
    echo "  - Firewall allows incoming connections"
    echo ""
    echo "You can re-run this script after fixing the issues."
fi
