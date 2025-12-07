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

1. **User A joins**: Enters PIN → WebSocket connects → Receives ICE servers → Waits for peer
2. **User B joins**: Enters PIN → WebSocket connects → Receives ICE servers
3. **Server notifies User A** (first peer): Sends `peer-joined` message
4. **User A creates offer**: Creates RTCPeerConnection → Generates offer → Sends to User B
5. **User B receives offer**: Creates RTCPeerConnection → Sets remote description → Creates answer → Sends to User A
6. **User A receives answer**: Sets remote description → Connection establishing
7. **ICE candidates exchanged**: Both peers exchange candidates (STUN for direct P2P, TURN fallback if needed)
8. **Media streams established**: Video/audio flowing peer-to-peer (or via TURN relay)

**Important**: Only the first peer creates the offer to avoid WebRTC "glare condition" (both peers creating offers simultaneously)

### Key Components

**app/src/types.ts**: Shared TypeScript types:
- `Message` - WebSocket message types
- `ClientData` - Client data stored in WebSocket (`id`, `pin`)
- `IceServerConfig` - STUN/TURN configuration
- Custom error types (InvalidPinError, RoomFullError, InvalidMessageError)

**app/src/server.ts**: Server-specific types (not exported):
- `Client` - Full client with `ServerWebSocket<ClientData>` reference
- `Room` - PIN-based room with array of `Client[]`

**app/src/server.ts**: WebSocket signaling server (TypeScript):
- `join-pin` - User joins with PIN, receives ICE server config
- `peer-joined` - Sent to FIRST peer only (triggers offer creation)
- `offer` - WebRTC offer relayed from first peer to second peer
- `answer` - WebRTC answer relayed from second peer to first peer
- `ice-candidate` - ICE candidate exchange (relayed between peers)
- `leave` - User disconnects
- Room management (max 2 clients per PIN, enforced via RoomFullError)
- ICE server configuration (STUN + TURN when configured)
- **Glare prevention**: Only first peer receives `peer-joined`, avoiding simultaneous offers

**app/src/client.ts**: WebRTC client (TypeScript, bundled to public/client.js):
- WebSocket client connection
- RTCPeerConnection setup (created when needed, not on join)
- getUserMedia for camera/mic (audio fallback if no camera)
- Offer/Answer handling:
  - On `peer-joined`: Creates offer (first peer only)
  - On `offer`: Creates answer (second peer)
  - On `answer`: Sets remote description (first peer)
- ICE candidate handling (all candidates relayed)
- Error tracking (intentional vs unexpected disconnections)
- Connection state management (connecting, connected, disconnected, failed)

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
2. **Type Architecture**:
   - `ClientData` (shared): Minimal data stored in WebSocket
   - `Client` (server-only): `ClientData` + `ServerWebSocket<ClientData>` reference
   - No `any` types - everything strictly typed
3. **Client Build**: `bun build src/client.ts` bundles to `public/client.js`
4. **Server Runtime**: Bun runs `src/server.ts` directly (no build needed)
5. **Source Maps**: External source maps for debugging bundled client
6. **Type Safety**: All DOM elements, WebRTC, and WebSocket APIs are typed

### WebRTC-Specific Considerations

1. **HTTPS/WSS Required**: WebRTC APIs require secure contexts in browsers
2. **Glare Prevention**: Only first peer creates offer to avoid "glare condition"
   - Server sends `peer-joined` to first peer only
   - Second peer waits for incoming offer
   - Prevents both peers from creating offers simultaneously
3. **ICE Candidate Handling**: Must relay ALL ICE candidates, not just the first
4. **Connection State Management**: Handle all RTCPeerConnection states (new, connecting, connected, disconnected, failed, closed)
5. **Mobile Browser Quirks**: iOS Safari and Chrome Android have different WebRTC implementations
6. **Audio Fallback**: If no camera available, gracefully fall back to audio-only mode

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
