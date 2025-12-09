# tuturu 📞

> *"Tuturu~"* - Mayuri Shiina

A simple, self-hosted WebRTC video calling app for connecting across any network barrier.

## What is tuturu?

tuturu is a PIN-based peer-to-peer video calling application designed to work in restrictive network environments. No
accounts, no tracking, no third-party services - just enter a shared PIN and connect.

Named after Mayuri's iconic phone greeting from Steins;Gate, because sometimes the simplest communication methods are
the most reliable across worldlines (or firewalls).

## Features

- 🔢 **PIN-based connection** - Share a 6-digit code, start calling
- 📹 **Video + Audio** - Full duplex streaming
- 🔒 **Self-hosted** - Your server, your rules
- 🌐 **Works everywhere** - TURN relay for restrictive networks
- 🐳 **Docker deployment** - `docker-compose up` and you're live
- 🚫 **No registration** - Stateless and privacy-focused

## Quick Start

```bash
# Clone the repo
git clone https://github.com/yourusername/tuturu.git
cd tuturu

# Configure environment
cp .env.example .env
# Edit .env with your domain and credentials

# Deploy
docker-compose up -d

# Access at https://yourdomain.com
```

## How it works

1. Both users open the app
2. Enter the same 6-digit PIN
3. WebRTC connects you directly (or via TURN relay if needed)
4. Video call established

## Tech Stack

- **Runtime**: Bun
- **Signaling**: Native WebSockets
- **TURN/STUN**: coturn
- **Frontend**: TypeScript with state machine architecture (8 modular files)
- **Build**: Single executable with embedded assets (58 MB)
- **Deployment**: Docker Compose

## Architecture Highlights

- **State Machine Pattern**: Unidirectional data flow with pure reducer (Action → State → Render)
- **Production Bundling**: Single executable contains Bun runtime + all code + all static assets
- **No External Dependencies**: Production deployment requires only the compiled binary
- **Unit Tested**: 25 tests covering all state transitions
- **Mobile-Friendly**: iOS Safari and Chrome Android compatible

## Use Case

Built for connecting with family and friends in regions with messenger restrictions. Works through:

- Corporate firewalls
- Symmetric NAT
- Restrictive ISPs
- VPN-unfriendly networks

## Local Development

```bash
cd app
bun install

# Development (2 terminals)
bun run build:watch    # Terminal 1: Watch client changes
bun run dev            # Terminal 2: Run server with hot reload

# Production build
bun run build:prod     # Build client + bundle server
./dist/server          # Run standalone executable

# Testing
bun test               # Run unit tests (25 tests)
bun run lint           # Run linter
bun run typecheck      # Type check
```

## Documentation

See [CLAUDE.md](CLAUDE.md) for development guidelines and architecture details.

See [PROJECT_OUTLINE.md](ai/PROJECT_OUTLINE.md) for complete implementation phases.

## Requirements

- VPS with Docker and Docker Compose
- Domain name (for SSL)
- Ports: 80, 443, 3478, 49152-49200

## License

MIT
