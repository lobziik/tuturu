# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tuturu is a PIN-based peer-to-peer WebRTC video calling application for self-hosting. It's designed to work in restrictive network environments (firewalls, symmetric NAT, restricted ISPs) by using TURN relay fallback.

**Current Status**: Planning/Architecture Phase - No code implemented yet

## Tech Stack

- **Runtime**: Bun (TypeScript)
- **Signaling**: Bun native WebSockets
- **TURN/STUN**: coturn
- **Frontend**: Vanilla JavaScript (WebRTC native APIs)
- **Deployment**: Docker Compose

## Development Commands

Once implemented, the project will use:

```bash
# Development (when app/ exists)
cd app
bun install          # Install dependencies
bun run src/server.ts  # Run signaling server locally
bun test             # Run tests (when implemented)

# Docker deployment
docker-compose up -d     # Start all services
docker-compose logs -f   # View logs
docker-compose down      # Stop all services

# Testing
bun run src/server.ts    # Start local server for testing
```

## Architecture Overview

### Three-Container System

1. **Bun App Container** (app/)
   - WebSocket signaling server (PIN-based room matching)
   - Static file serving (frontend)
   - Port 3000 internally

2. **coturn Container** (coturn/)
   - STUN/TURN server for NAT traversal
   - Port 3478 (UDP/TCP), TLS 5349
   - Relay port range: 49152-49200

3. **nginx Container** (nginx/)
   - SSL termination (HTTPS/WSS required for WebRTC)
   - Reverse proxy to Bun app
   - Ports 80, 443

### Connection Flow

1. Both users enter same 6-digit PIN
2. WebSocket signaling matches users by PIN
3. WebRTC negotiation (SDP offer/answer exchange via WebSocket)
4. ICE candidates exchanged (try STUN first for direct P2P)
5. If direct connection fails, fall back to TURN relay
6. Media streams established

### Key Components When Implemented

**app/src/server.ts**: WebSocket server handling:
- `join-pin` - User joins with PIN
- `offer` - WebRTC offer from caller
- `answer` - WebRTC answer from callee
- `ice-candidate` - ICE candidate exchange
- `leave` - User disconnects

**app/public/app.js**: WebRTC client handling:
- WebSocket client connection
- RTCPeerConnection setup
- getUserMedia for camera/mic
- ICE candidate handling

## Development Guidelines

### WebRTC-Specific Considerations

1. **HTTPS/WSS Required**: WebRTC APIs require secure contexts in browsers
2. **Perfect Negotiation Pattern**: Use W3C recommended pattern for robust offer/answer exchange
3. **ICE Candidate Handling**: Must relay ALL ICE candidates, not just the first
4. **Connection State Management**: Handle all RTCPeerConnection states (new, connecting, connected, disconnected, failed, closed)
5. **Mobile Browser Quirks**: iOS Safari and Chrome Android have different WebRTC implementations

### Failure Mode Handling

WebRTC has many failure points. The code must handle:
- getUserMedia permission denied
- WebSocket connection failures
- ICE gathering failures
- Connection timeout (no ICE candidates work)
- Network interruptions mid-call
- PIN collision (>2 users with same PIN)

### Stateless Design

No database, no user accounts, no call records. All state is ephemeral:
- PIN rooms exist only while users are connected
- No logging of media content
- No authentication beyond PIN matching

### TURN Server Configuration

coturn must be configured with:
- Static credentials (TURN_USERNAME/TURN_PASSWORD from .env)
- External IP address for ICE candidate generation
- Port range for relay connections
- Realm matching domain name

## Network Requirements

For deployment, the VPS must have these ports open:
- 80 (HTTP redirect to HTTPS)
- 443 (HTTPS/WSS)
- 3478 (STUN/TURN UDP/TCP)
- 49152-49200 (TURN relay port range)

## Testing Strategy

When implementing, test in this order:
1. WebSocket signaling without media
2. Local P2P connection (same network, no STUN/TURN)
3. Different networks with STUN (direct P2P)
4. Symmetric NAT with TURN relay
5. Mobile browsers (iOS Safari is most restrictive)
6. Connection from target restrictive network environment

## Implementation Phases

See PROJECT_OUTLINE.md for detailed phases. High-level order:
1. Basic signaling (WebSocket + PIN matching)
2. WebRTC integration (PeerConnection, getUserMedia)
3. TURN server setup
4. Dockerization
5. Production setup (SSL, nginx)
6. Optimization (reconnection, error handling)
