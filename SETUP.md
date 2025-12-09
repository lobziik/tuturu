# tuturu Deployment Guide

Complete setup instructions for deploying tuturu with maximum DPI resistance using nginx SNI routing and coturn TURN relay.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [DNS Configuration](#dns-configuration)
3. [Environment Setup](#environment-setup)
4. [SSL Certificates](#ssl-certificates)
5. [Deploy Services](#deploy-services)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)
8. [Maintenance](#maintenance)

---

## Prerequisites

### Server Requirements

- **VPS/Dedicated Server** with public IP address
- **OS**: Ubuntu 20.04+ / Debian 11+ (or any Linux with Docker support)
- **RAM**: Minimum 2GB (4GB recommended for multiple concurrent calls)
- **CPU**: 2 cores minimum
- **Bandwidth**: Unmetered or generous quota (TURN relay uses bandwidth)

### Software Requirements

- **Docker** (20.10+)
- **Docker Compose** (2.0+)
- **Domain name** with DNS control

### Firewall / Port Requirements

Open these ports on your server:

| Port | Protocol | Service | Description |
|------|----------|---------|-------------|
| 80 | TCP | nginx | HTTP (redirects to HTTPS) |
| 443 | TCP | nginx | HTTPS/WSS (SNI routing) |
| 3478 | UDP/TCP | coturn | TURN (fallback) |
| 5349 | TCP | coturn | TURNS (fallback) |
| 49152-49200 | UDP | coturn | TURN relay range |

**Important**: Port 443 handles all primary traffic (HTTPS, WebSocket, TURN/TLS) via SNI routing.

### Install Docker & Docker Compose

```bash
# Update package list
sudo apt update

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add current user to docker group (avoid sudo)
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Verify installation
docker --version
docker-compose --version
```

---

## DNS Configuration

### Required DNS Records

Configure these DNS A records to point to your VPS public IP:

```
Record Type: A
Name                    Value
--------------------------------
yourdomain.com          YOUR_VPS_IP
app.yourdomain.com      YOUR_VPS_IP
turn.yourdomain.com     YOUR_VPS_IP
```

Replace `yourdomain.com` with your actual domain.

### Verify DNS Propagation

```bash
# Get your VPS public IP
curl ifconfig.me

# Check DNS resolution (wait 5-10 minutes after setting records)
dig +short yourdomain.com
dig +short app.yourdomain.com
dig +short turn.yourdomain.com

# All should return your VPS IP
```

**Note**: DNS propagation can take up to 24-48 hours, but usually completes within minutes.

---

## Environment Setup

### 1. Clone Repository

```bash
# Clone the repository
git clone <your-repo-url> tuturu
cd tuturu
```

### 2. Create Environment File

```bash
# Copy example environment file
cp .env.example .env

# Edit configuration
nano .env
```

### 3. Configure Environment Variables

Edit `.env` with your settings:

```bash
# === Domain Configuration ===
DOMAIN=yourdomain.com

# === Bun App Configuration ===
BUN_PORT=3000
NODE_ENV=production

# === STUN Servers ===
STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302

# === coturn TURN Server Configuration ===
TURN_USERNAME=webrtc
TURN_PASSWORD=YOUR_STRONG_PASSWORD_HERE_MIN_24_CHARS

# Realm (should match your domain)
TURN_REALM=yourdomain.com

# External IP address of your VPS
EXTERNAL_IP=YOUR_VPS_PUBLIC_IP

# === SSL Certificates (Let's Encrypt) ===
LETSENCRYPT_EMAIL=admin@yourdomain.com
```

**Security Notes**:
- Use a strong password for `TURN_PASSWORD` (24+ characters)
- Keep `.env` file secure (never commit to git)
- Set restrictive permissions: `chmod 600 .env`

---

## SSL Certificates

### Obtain Let's Encrypt Certificates

The project includes an automated SSL setup script:

```bash
# Make script executable (if not already)
chmod +x scripts/setup-ssl.sh

# Run SSL setup
./scripts/setup-ssl.sh
```

The script will:
1. Validate your `.env` configuration
2. Check DNS resolution for all subdomains
3. Obtain certificates for:
   - `yourdomain.com` (cover website)
   - `app.yourdomain.com` (WebRTC app)
   - `turn.yourdomain.com` (TURN server)
4. Store certificates in `./ssl/` directory

**What to expect**:
```
=== tuturu SSL Certificate Setup ===

Configuration:
  Domain: yourdomain.com
  Email:  admin@yourdomain.com
  Server IP: 1.2.3.4

This script will obtain Let's Encrypt certificates for:
  1. yourdomain.com (cover website)
  2. app.yourdomain.com (Bun signaling app)
  3. turn.yourdomain.com (coturn TURN server)

Continue? (y/n)
```

Press `y` to continue.

### Certificate Renewal

Let's Encrypt certificates expire after 90 days. To renew:

```bash
# Stop services
docker-compose down

# Re-run setup script
./scripts/setup-ssl.sh

# Restart services
docker-compose up -d
```

**Automated Renewal** (optional):

```bash
# Add cron job (runs monthly)
crontab -e

# Add this line:
0 0 1 * * cd /path/to/tuturu && docker-compose down && ./scripts/setup-ssl.sh && docker-compose up -d
```

---

## Deploy Services

### 1. Build Application

```bash
# Build client and server
cd app
bun install
bun run build:prod
cd ..
```

**Expected output**:
```
Bundled 8 modules in 21ms
  index.js  106.21 KB  (entry point)
```

### 2. Validate Configuration

```bash
# Check docker-compose syntax
docker-compose config

# Verify nginx configuration (will fail if SSL certs missing)
docker run --rm \
  -v $(pwd)/nginx/nginx.conf:/etc/nginx/nginx.conf:ro \
  nginx:alpine nginx -t
```

### 3. Start Services

```bash
# Start all services in detached mode
docker-compose up -d

# View logs (Ctrl+C to exit)
docker-compose logs -f

# Check service status
docker-compose ps
```

**Expected output**:
```
NAME                IMAGE              STATUS         PORTS
tuturu-app          tuturu-app         Up (healthy)
tuturu-coturn       coturn/coturn      Up
tuturu-nginx        nginx:alpine       Up (healthy)   0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
```

All services should be `Up` and healthy.

---

## Verification

### 1. Check Service Health

```bash
# Service status
docker-compose ps

# View logs for each service
docker-compose logs app
docker-compose logs coturn
docker-compose logs nginx

# Check nginx routing logs
docker-compose exec nginx cat /var/log/nginx/stream-access.log
```

### 2. Test HTTP → HTTPS Redirect

```bash
curl -I http://yourdomain.com
# Should return: HTTP/1.1 301 Moved Permanently
# Location: https://yourdomain.com
```

### 3. Test Cover Website

```bash
# Visit in browser
https://yourdomain.com

# Or via curl
curl -k https://yourdomain.com
```

You should see the cover website ("Welcome" page).

### 4. Test WebRTC App

```bash
# Visit in browser
https://app.yourdomain.com
```

You should see the tuturu PIN entry screen.

### 5. Test TURN Server

```bash
# Install coturn utils (if not installed)
sudo apt install coturn-utils

# Test TURN allocation
turnutils_uclient \
  -t -T \
  -u webrtc \
  -w YOUR_TURN_PASSWORD \
  -p 5349 \
  turn.yourdomain.com

# Expected output:
# 0: Total transmit time is ...
# 0: Total lost packets 0 (0.000000%), total send dropped 0
```

### 6. Test WebRTC Connection

**Full End-to-End Test**:

1. Open `https://app.yourdomain.com` in **two different browsers** (or two devices)
2. Enter the same 6-digit PIN in both
3. Allow camera/microphone access
4. Video call should establish

**Check ICE Candidates** (Chrome):

1. Open `chrome://webrtc-internals` in new tab
2. Start call in `app.yourdomain.com` tab
3. Look for "ICE candidate" entries
4. Should see **relay** type candidates (indicates TURN is working)

```
Candidate: ... typ relay raddr ... rport ... generation 0
```

---

## Troubleshooting

### Services Won't Start

**Problem**: `docker-compose up -d` fails

**Solutions**:
```bash
# Check logs for errors
docker-compose logs

# Verify SSL certificates exist
ls -la ssl/*/

# Check port conflicts
sudo netstat -tulpn | grep -E ':(80|443|3478|5349)'

# Ensure no other services using ports
sudo systemctl stop nginx  # If system nginx is running
```

### SSL Certificate Errors

**Problem**: Certificate validation fails

**Solutions**:
```bash
# Verify DNS is correctly configured
dig +short app.yourdomain.com
dig +short turn.yourdomain.com

# Ensure ports 80 and 443 are accessible
curl http://yourdomain.com

# Re-run SSL setup
docker-compose down
./scripts/setup-ssl.sh
docker-compose up -d
```

### TURN Server Not Working

**Problem**: WebRTC calls fail, no relay candidates

**Solutions**:
```bash
# Check coturn logs
docker-compose logs coturn

# Verify coturn is listening on ports
sudo netstat -tulpn | grep -E ':(3478|5349)'

# Test TURN directly (bypass nginx)
turnutils_uclient -t -T -u webrtc -w PASSWORD -p 5349 turn.yourdomain.com

# Check firewall
sudo ufw status
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:49200/udp
```

### nginx SNI Routing Issues

**Problem**: Traffic not routing correctly to backends

**Solutions**:
```bash
# Check nginx stream logs
docker-compose exec nginx cat /var/log/nginx/stream-access.log
docker-compose exec nginx cat /var/log/nginx/stream-error.log

# Test SNI routing with openssl
openssl s_client -connect yourdomain.com:443 -servername app.yourdomain.com
# Should connect to app backend

openssl s_client -connect yourdomain.com:443 -servername turn.yourdomain.com
# Should connect to coturn

# Restart nginx
docker-compose restart nginx
```

### Permission Denied Errors

**Problem**: Docker permission errors

**Solutions**:
```bash
# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker

# Or run with sudo
sudo docker-compose up -d
```

### coturn on Host Network Issues (Linux)

**Problem**: `host.docker.internal` not resolving in nginx

**Solution**: Already configured in `docker-compose.yml` with `extra_hosts`. If still failing:

```bash
# Find host IP on docker bridge
ip addr show docker0

# Manually add to nginx extra_hosts in docker-compose.yml
extra_hosts:
  - "host.docker.internal:172.17.0.1"  # Use your docker0 IP
```

---

## Maintenance

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f app
docker-compose logs -f coturn
docker-compose logs -f nginx

# Last 100 lines
docker-compose logs --tail=100
```

### Restart Services

```bash
# Restart all
docker-compose restart

# Restart specific service
docker-compose restart nginx
```

### Update Application

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
cd app && bun run build:prod && cd ..
docker-compose up -d --build
```

### Monitor Resource Usage

```bash
# Container stats
docker stats

# Disk usage
docker system df

# Clean up old images
docker system prune -a
```

### Backup

**What to backup**:
- `.env` file (contains credentials)
- `ssl/` directory (SSL certificates)

```bash
# Create backup
tar -czf tuturu-backup-$(date +%Y%m%d).tar.gz .env ssl/

# Restore backup
tar -xzf tuturu-backup-20241209.tar.gz
```

---

## Architecture Overview

### Port 443 SNI Routing

All traffic on port 443 is routed based on Server Name Indication (SNI):

```
Client connects to port 443 with SNI
          ↓
    nginx stream module (ssl_preread)
          ↓
    Reads SNI from TLS ClientHello
          ↓
    ┌─────────────────────────────────┐
    │                                 │
    ↓                 ↓               ↓
app.domain.com   turn.domain.com   domain.com
    ↓                 ↓               ↓
nginx:8443        coturn:5349     nginx:8443
    ↓                                 ↓
  Bun app:3000                    Static site
```

### DPI Resistance Features

1. **All traffic on port 443**: Looks like HTTPS to DPI systems
2. **TLS encryption**: TURN traffic encrypted, no protocol signatures visible
3. **SNI-based routing**: No port scanning reveals TURN server
4. **Cover website**: Active probing sees legitimate website
5. **Priority order**: Client tries most resistant transports first:
   - TURNS:443 (via nginx SNI)
   - TURNS:5349 (direct)
   - TURN:3478/TCP
   - TURN:3478/UDP

---

## Next Steps

After successful deployment:

1. **Test from restrictive network**: Verify calls work from your target environment
2. **Monitor bandwidth**: TURN relay uses server bandwidth
3. **Set up monitoring**: Use tools like Prometheus/Grafana for metrics
4. **Consider multiple TURN servers**: Geographic distribution for redundancy
5. **Review logs regularly**: Check for suspicious activity

---

## Support

For issues or questions:
- Check logs: `docker-compose logs`
- Review troubleshooting section above
- Check GitHub issues: [repo-url]

---

**Document Version**: 1.0
**Last Updated**: 2024-12-09
**Architecture**: nginx SNI routing + coturn TURN relay + Bun WebSocket signaling
