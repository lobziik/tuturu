# tuturu

*"Tuturu~! ♪" — Mayushii*

Self-hosted WebRTC video calling. PIN-based room matching. Single container.

## What is This

A one-to-one video calling application you run on your own server. Two people enter the same PIN and get connected via
WebRTC.

**What's inside:**

- Bun signaling server (WebSocket)
- coturn for STUN/TURN relay
- nginx for TLS termination and routing
- Let's Encrypt for automatic certificates
- systemd orchestration (single container, multiple services)

**What it relies on:**

- Browser WebRTC APIs (`RTCPeerConnection`, `getUserMedia`)
- Modern browser (Chrome, Firefox, Safari, Edge)
- A domain name (required for TLS)
- A VPS with ports 80, 443, 49152-49200/udp available

## Quickstart

### 1. Get a Domain

Purchase or use an existing domain. You'll need to create a couple DNS records.

### 2. Get a VPS

Any Linux VPS with:

- 1 CPU, 512MB RAM minimum
- Ubuntu 22.04+ or similar

### 3. Configure DNS

Point to your VPS IP:

```
yourdomain.com → A → YOUR_VPS_IP
a.yourdomain.com  → A → YOUR_VPS_IP
t.yourdomain.com → A → YOUR_VPS_IP
```

Wait for DNS propagation (check with `dig yourdomain.com`).

Subdomains are also possible

```
tuturu.yourdomain.com → A → YOUR_VPS_IP
a.tuturu.yourdomain.com  → A → YOUR_VPS_IP
t.tuturu.yourdomain.com → A → YOUR_VPS_IP
```

### 4. Run

```bash
# Download
curl -fsSL https://raw.githubusercontent.com/lobziik/tuturu/main/tuturu -o tuturu
chmod +x tuturu

# Install (interactive)
sudo ./tuturu install

# Follow prompts for domain and email
```

First run takes 1-2 minutes while Let's Encrypt issues certificates.

### 5. Use

Open `https://a.yourdomain.com` on both devices, enter the same PIN, call.

## Commands

```
./tuturu install     # First-time setup
./tuturu start       # Start container
./tuturu stop        # Stop container
./tuturu restart     # Restart
./tuturu logs        # View all logs
./tuturu logs app    # Signaling server logs
./tuturu logs nginx  # nginx logs
./tuturu logs coturn # TURN server logs
./tuturu status      # Service status
./tuturu upgrade     # Pull latest, restart
./tuturu help        # Show commands
```

## Requirements

| Component | Requirement                      |
|-----------|----------------------------------|
| Domain    | Required (TLS certificates)      |
| Ports     | 80, 443 (TCP), 49152-49200 (UDP) |
| Runtime   | Podman 4.0+ or Docker            |
| Resources | 512MB RAM, 1 CPU                 |

## How It Works

```
Browser A                    Your VPS                    Browser B
    │                           │                            │
    ├───WebSocket───►┌──────────┴──────────┐◄────WebSocket───┤
    │                │  tuturu-server:3000 │                 │
    │                │   (Bun signaling)   │                 │
    │                └──────────┬──────────┘                 │
    │                           │                            │
    ├───TURN/STUN───►┌──────────┴──────────┐◄────TURN/STUN───┤
    │                │   coturn:3478/5349  │                 │
    │                │   (media relay)     │                 │
    │                └──────────┬──────────┘                 │
    │                           │                            │
    ├───────────────────────────┼────────────────────────────┤
    │                      WebRTC P2P                        │
    │               (or relayed via TURN)                    │
    └────────────────────────────────────────────────────────┘
```

1. Both browsers connect to signaling server via WebSocket
2. PIN matching pairs them into a room
3. WebRTC negotiation (SDP offer/answer)
4. ICE candidate exchange via signaling
5. Media streams established (direct P2P or via TURN relay)

## Project Structure

```
tuturu/
├── app/                    # Bun application
│   ├── src/
│   │   ├── client/         # Browser app
│   │   └── server/         # Signaling server
│   └── public/             # Static assets
├── container/              # Container build
│   ├── Dockerfile
│   ├── systemd/            # Service units
│   └── templates/          # nginx, coturn configs
├── docs/                   # Documentation
└── tuturu                  # CLI script
```

## Documentation

TBD

---

```
Lab Note: AI wrote code. Gadget works. Cats were present. Cats have not contacted The Organization. To my knowledge.
```
