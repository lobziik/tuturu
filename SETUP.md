# tuturu Deployment Guide

Complete setup instructions for deploying tuturu with maximum DPI resistance using nginx SNI routing and coturn TURN relay.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [DNS Configuration](#dns-configuration)
3. [Build Container](#build-container)
4. [Deploy](#deploy)
5. [Verification](#verification)
6. [Troubleshooting](#troubleshooting)
7. [Maintenance](#maintenance)

---

## Prerequisites

### Server Requirements

- **VPS/Dedicated Server** with public IP address
- **OS**: Any Linux with Docker support (or Podman)
- **RAM**: Minimum 2GB (4GB recommended for multiple concurrent calls)
- **CPU**: 2 cores minimum
- **Bandwidth**: Unmetered or generous quota (TURN relay uses bandwidth)

### Software Requirements

- **Docker** (20.10+) or **Podman**
- **Domain name** with DNS control

### Firewall / Port Requirements

Open these ports on your server:

| Port | Protocol | Service | Description |
|------|----------|---------|-------------|
| 80 | TCP | nginx | HTTP (ACME challenge + redirect) |
| 443 | TCP | nginx | HTTPS/WSS/TURNS (SNI routing) |
| 49152-49200 | UDP | coturn | TURN relay range |

**Important**: Port 443 handles all primary traffic (HTTPS, WebSocket, TURNS) via SNI routing.

### Install Docker

```bash
# Update package list
sudo apt update

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add current user to docker group (avoid sudo)
sudo usermod -aG docker $USER
newgrp docker

# Verify installation
docker --version
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
a.yourdomain.com        YOUR_VPS_IP
t.yourdomain.com        YOUR_VPS_IP
```

- `yourdomain.com` - Cover website (looks like normal site)
- `a.yourdomain.com` - WebRTC app (signaling + frontend)
- `t.yourdomain.com` - TURN server (media relay)

### Verify DNS Propagation

```bash
# Get your VPS public IP
curl ifconfig.me

# Check DNS resolution (wait 5-10 minutes after setting records)
dig +short yourdomain.com
dig +short a.yourdomain.com
dig +short t.yourdomain.com

# All should return your VPS IP
```

**Note**: DNS propagation can take up to 24-48 hours, but usually completes within minutes.

---

## Build Container

### 1. Clone Repository

```bash
git clone <your-repo-url> tuturu
cd tuturu
```

### 2. Build Container Image

```bash
./build.sh
```

This builds a single container with all services:
- Bun signaling server
- nginx reverse proxy with SNI routing
- coturn TURN/STUN server
- certbot for Let's Encrypt certificates

---

## Deploy

### 1. Edit run.sh

Edit `run.sh` with your configuration:

```bash
nano run.sh
```

Set these required variables:
- `DOMAIN` - Your base domain (e.g., `call.example.com`)
- `LETSENCRYPT_EMAIL` - Email for Let's Encrypt notifications
- `EXTERNAL_IP` - Public IP of your server

Optional variables:
- `TURN_USERNAME` - TURN auth username (default: `webrtc`)
- `TURN_PASSWORD` - TURN auth password (auto-generated if not set)
- `LETSENCRYPT_STAGING` - Set to `true` for testing (avoid rate limits)

### 2. Run Container

```bash
./run.sh
```

Or run manually:

```bash
docker run -d --name tuturu \
  -e DOMAIN=call.example.com \
  -e LETSENCRYPT_EMAIL=you@example.com \
  -e EXTERNAL_IP=$(curl -s ifconfig.me) \
  -p 80:80 \
  -p 443:443 \
  -p 49152-49200:49152-49200/udp \
  -v tuturu-certs:/etc/letsencrypt \
  --privileged \
  tuturu:latest
```

### 3. Monitor Startup

```bash
# Watch all logs
docker exec tuturu journalctl -f

# Check initialization (runs once on first start)
docker exec tuturu journalctl -u tuturu-init

# Check certificate provisioning
docker exec tuturu journalctl -u tuturu-certbot
```

**First startup takes 1-2 minutes** while certificates are obtained.

---

## Verification

### 1. Check Service Status

```bash
# All services status
docker exec tuturu systemctl status tuturu-*

# Individual service logs
docker exec tuturu journalctl -u tuturu-app -f
docker exec tuturu journalctl -u tuturu-nginx -f
docker exec tuturu journalctl -u tuturu-coturn -f
```

### 2. Test HTTP → HTTPS Redirect

```bash
curl -I http://yourdomain.com
# Should return: HTTP/1.1 301 Moved Permanently
# Location: https://yourdomain.com/
```

### 3. Test Cover Website

Open in browser: `https://yourdomain.com`

You should see the cover website.

### 4. Test WebRTC App

Open in browser: `https://a.yourdomain.com`

You should see the tuturu PIN entry screen.

### 5. Test WebRTC Connection

**Full End-to-End Test**:

1. Open `https://a.yourdomain.com` in **two different browsers** (or two devices)
2. Enter the same 6-digit PIN in both
3. Allow camera/microphone access
4. Video call should establish

**Check ICE Candidates** (Chrome):

1. Open `chrome://webrtc-internals` in new tab
2. Start call in another tab
3. Look for "ICE candidate" entries
4. Should see **relay** type candidates (indicates TURN is working)

---

## Troubleshooting

### Container Won't Start

```bash
# Check container logs
docker logs tuturu

# Check if ports are in use
sudo netstat -tulpn | grep -E ':(80|443)'

# Stop conflicting services
sudo systemctl stop nginx apache2
```

### Certificate Errors

```bash
# Check certbot logs
docker exec tuturu journalctl -u tuturu-certbot

# Verify DNS is correct
dig +short a.yourdomain.com
dig +short t.yourdomain.com

# Use staging CA for testing (add to run.sh)
-e LETSENCRYPT_STAGING=true
```

### TURN Server Not Working

```bash
# Check coturn logs
docker exec tuturu journalctl -u tuturu-coturn -f

# Verify coturn config
docker exec tuturu cat /etc/coturn/turnserver.conf

# Check firewall allows UDP
sudo ufw allow 49152:49200/udp
```

### nginx Issues

```bash
# Check nginx logs
docker exec tuturu journalctl -u tuturu-nginx -f

# Check nginx config
docker exec tuturu nginx -t

# View nginx error log
docker exec tuturu cat /var/log/nginx/error.log
```

### Service Keeps Restarting

```bash
# Check specific service status
docker exec tuturu systemctl status tuturu-app

# Check service logs
docker exec tuturu journalctl -u tuturu-app --no-pager

# Reset initialization (re-run tuturu-init on next start)
docker exec tuturu rm /var/lib/tuturu/.initialized
docker restart tuturu
```

---

## Maintenance

### View Logs

```bash
# All logs (follow)
docker exec tuturu journalctl -f

# Specific service
docker exec tuturu journalctl -u tuturu-app -f
docker exec tuturu journalctl -u tuturu-nginx -f
docker exec tuturu journalctl -u tuturu-coturn -f

# Last 100 lines
docker exec tuturu journalctl -n 100
```

### Restart Services

```bash
# Restart container (all services)
docker restart tuturu

# Restart specific service inside container
docker exec tuturu systemctl restart tuturu-app
docker exec tuturu systemctl restart tuturu-nginx
```

### Update Application

```bash
# Pull latest changes
git pull

# Rebuild container
./build.sh

# Restart with new image
docker stop tuturu && docker rm tuturu
./run.sh
```

### Certificate Renewal

Certificates auto-renew via systemd timer. To manually renew:

```bash
docker exec tuturu systemctl start tuturu-certbot
```

### Monitor Resource Usage

```bash
# Container stats
docker stats tuturu

# Disk usage
docker system df
```

### Backup

**What to backup**:
- Certificate volume: `tuturu-certs`

```bash
# Backup certificates
docker run --rm -v tuturu-certs:/certs -v $(pwd):/backup alpine \
  tar czf /backup/tuturu-certs-backup.tar.gz /certs

# Restore certificates
docker run --rm -v tuturu-certs:/certs -v $(pwd):/backup alpine \
  tar xzf /backup/tuturu-certs-backup.tar.gz -C /
```

---

## Architecture Overview

### Single Container with systemd

All services run in one container managed by systemd:

```
┌─────────────────────────────────────────────────────┐
│                tuturu container                      │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ tuturu-init  │→ │tuturu-certbot│→ │tuturu-app │ │
│  │  (one-shot)  │  │  (one-shot)  │  │ (Bun:3000)│ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│         ↓                 ↓               ↑         │
│  ┌──────────────────────────────────────────────┐  │
│  │              tuturu-nginx (:80, :443)         │  │
│  │              SNI routing on port 443          │  │
│  └──────────────────────────────────────────────┘  │
│         ↓                                           │
│  ┌──────────────────────────────────────────────┐  │
│  │         tuturu-coturn (:5349, :49152-49200)   │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

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
a.domain.com     t.domain.com    domain.com
    ↓                 ↓               ↓
nginx:8443       coturn:5349     nginx:8443
    ↓                                 ↓
 Bun app:3000                   Cover website
```

### DPI Resistance Features

1. **All traffic on port 443**: Looks like HTTPS to DPI systems
2. **TLS encryption**: TURN traffic encrypted, no protocol signatures visible
3. **SNI-based routing**: No port scanning reveals TURN server
4. **Cover website**: Active probing sees legitimate website

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMAIN` | Yes | - | Base domain (e.g., `call.example.com`) |
| `LETSENCRYPT_EMAIL` | Yes | - | Email for Let's Encrypt |
| `EXTERNAL_IP` | Yes | - | Public IP of server |
| `TURN_USERNAME` | No | `webrtc` | TURN authentication username |
| `TURN_PASSWORD` | No | auto-generated | TURN authentication password |
| `TURN_MIN_PORT` | No | `49152` | TURN relay port range start |
| `TURN_MAX_PORT` | No | `49200` | TURN relay port range end |
| `LETSENCRYPT_STAGING` | No | `false` | Use staging CA for testing |
| `FORCE_RELAY` | No | `false` | Force TURN relay for all connections |

---

**Document Version**: 2.0
**Last Updated**: 2024-12-21
**Architecture**: Single systemd container with nginx SNI routing + coturn TURN relay + Bun WebSocket signaling
