# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tuturu is a PIN-based peer-to-peer WebRTC video calling application for self-hosting. It's designed to work in restrictive network environments (firewalls, symmetric NAT, restricted ISPs) by using TURN relay fallback.

**Current Status**: Phase 1 Complete - Basic signaling server and client implemented

## Tech Stack

- **Runtime**: Bun (TypeScript)
- **Signaling**: Bun native WebSockets
- **TURN/STUN**: coturn (not yet implemented - Phase 3)
- **Frontend**: TypeScript (bundled with Bun, WebRTC native APIs)
- **Build**: Bun bundler
- **Deployment**: Docker Compose

## Development Commands

### Local Development

```bash
cd app
bun install              # Install dependencies

# Build client TypeScript
bun run build            # Build client once (src/client.ts → public/client.js)
bun run build:watch      # Build client in watch mode (rebuilds on changes)

# Run server
bun run dev              # Run server with hot reload
bun run start            # Run server in production mode

# Development workflow (2 terminals)
# Terminal 1: bun run build:watch
# Terminal 2: bun run dev
```

### Docker Deployment

```bash
docker-compose up --build    # Build and start all services
docker-compose up -d         # Start in detached mode
docker-compose logs -f app   # View app logs
docker-compose down          # Stop all services
```

### Testing

```bash
# Local testing
bun run build && bun run dev
# Open http://localhost:3000 in two browsers
# Enter same 6-digit PIN in both
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

### Key Components

**app/src/types.ts**: Shared TypeScript types:
- `Message` - WebSocket message types
- `Client` - Client connection info
- `Room` - PIN-based room structure
- `IceServerConfig` - STUN/TURN configuration
- Custom error types (InvalidPinError, RoomFullError, etc.)

**app/src/server.ts**: WebSocket signaling server (TypeScript):
- `join-pin` - User joins with PIN
- `offer` - WebRTC offer from caller
- `answer` - WebRTC answer from callee
- `ice-candidate` - ICE candidate exchange
- `leave` - User disconnects
- Room management (max 2 clients per PIN)
- ICE server configuration (STUN + TURN when configured)

**app/src/client.ts**: WebRTC client (TypeScript, bundled to public/client.js):
- WebSocket client connection
- RTCPeerConnection setup
- getUserMedia for camera/mic
- ICE candidate handling
- Error tracking (intentional vs unexpected disconnections)
- Connection state management

**Build Process**:
- Client TypeScript (`src/client.ts`) is bundled by Bun → `public/client.js`
- Server TypeScript (`src/server.ts`) runs directly with Bun (no build needed)
- Types (`src/types.ts`) are shared between client and server
- Source maps generated for debugging

## Development Guidelines

### Error Handling: FAIL FAST AND LOUD

The codebase follows strict error handling principles:

**Server (server.ts)**:
- Custom error classes: `InvalidPinError`, `RoomFullError`, `InvalidMessageError`
- Validation happens immediately (fail fast on invalid PIN format)
- Errors sent to client with clear messages before closing connection
- No silent failures or empty catch blocks

**Client (client.ts)**:
- Distinguishes intentional vs unexpected disconnections (`isIntentionalClose` flag)
- Human-readable WebSocket close codes via `getCloseCodeDescription()`
- Actionable error messages (e.g., "Please allow access and try again", not "Unknown reason")
- getUserMedia errors categorized: permission denied, not found, already in use
- All errors displayed to user and logged to console

### TypeScript & Build Process

1. **Shared Types**: Import types from `types.ts` in both server and client
2. **Client Build**: `bun build src/client.ts` bundles to `public/client.js`
3. **Server Runtime**: Bun runs `src/server.ts` directly (no build needed)
4. **Source Maps**: External source maps for debugging bundled client
5. **Type Safety**: All DOM elements, WebRTC, and WebSocket APIs are typed

### WebRTC-Specific Considerations

1. **HTTPS/WSS Required**: WebRTC APIs require secure contexts in browsers
2. **Perfect Negotiation Pattern**: Use W3C recommended pattern for robust offer/answer exchange
3. **ICE Candidate Handling**: Must relay ALL ICE candidates, not just the first
4. **Connection State Management**: Handle all RTCPeerConnection states (new, connecting, connected, disconnected, failed, closed)
5. **Mobile Browser Quirks**: iOS Safari and Chrome Android have different WebRTC implementations

### Failure Mode Handling

WebRTC has many failure points. The code handles:
- ✅ getUserMedia permission denied (actionable error message)
- ✅ WebSocket connection failures (with close code descriptions)
- ✅ ICE gathering failures (network blocking detection)
- ✅ Connection timeout (clear error + cleanup)
- ✅ Network interruptions mid-call (reconnection detection)
- ✅ PIN collision (max 2 clients enforced, RoomFullError thrown)

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

## File Structure

```
app/
├── src/
│   ├── server.ts        # WebSocket signaling server (runs directly)
│   ├── client.ts        # WebRTC client (builds to public/client.js)
│   └── types.ts         # Shared TypeScript types
├── public/
│   ├── index.html       # Static HTML
│   ├── styles.css       # Styling
│   └── client.js        # Generated by build (git-ignored)
├── package.json         # Scripts: build, build:watch, dev, start
├── bunfig.toml          # Bun configuration
└── Dockerfile           # Includes build step
```

## Implementation Phases

See PROJECT_OUTLINE.md for detailed phases.

**Completed**:
- ✅ Phase 1: Basic signaling (WebSocket + PIN matching)
- ✅ Phase 2: WebRTC integration (PeerConnection, getUserMedia)
- ✅ Phase 4 (partial): Docker setup for app service

**Remaining**:
- ⏳ Phase 3: TURN server setup (coturn configuration)
- ⏳ Phase 4 (complete): Full Docker Compose with coturn
- ⏳ Phase 5: Production setup (SSL, nginx, Let's Encrypt)
- ⏳ Phase 6: Optimization (reconnection, bandwidth adaptation)
