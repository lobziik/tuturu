# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tuturu is a PIN-based peer-to-peer WebRTC video calling application for self-hosting. It's designed to work in restrictive network environments (firewalls, symmetric NAT, restricted ISPs) by using TURN relay fallback.

**Current Status**: Production-ready single container with signaling, TURN, nginx, and auto-SSL

## Tech Stack

- **Runtime**: Bun (TypeScript)
- **Signaling**: Bun native WebSockets
- **TURN/STUN**: coturn (in single container)
- **Frontend**: TypeScript (bundled with Bun, WebRTC native APIs)
- **Build**: Bun bundler
- **Deployment**: Single systemd container (UBI10-init)
- **Reverse Proxy**: nginx with SNI routing
- **Certificates**: Let's Encrypt (certbot)

## Development Commands

### Local Development

```bash
cd app
bun install              # Install dependencies

# Build client TypeScript
bun run build            # Build client once (src/client/index.ts → public/index.js)
bun run build:watch      # Build client in watch mode (rebuilds on changes)

# Build production bundle (single executable)
bun run build:server     # Bundle server with embedded assets → dist/server
bun run build:prod       # Build client + bundle server (full production build)

# Run server
bun run dev              # Run server from source with hot reload (development)
bun run start            # Run server from source (production mode)
bun run start:prod       # Run bundled executable (dist/server)

# Development workflow (2 terminals)
# Terminal 1: bun run build:watch
# Terminal 2: bun run dev

# Production workflow
bun run build:prod       # Build everything
./dist/server            # Run single executable (no dependencies!)
```

### Single Container Deployment

```bash
# Build container
./build.sh                   # Builds tuturu:latest image

# Run container
./run.sh                     # Runs with required env vars (edit for your domain)

# Or manually:
docker run -d --name tuturu \
  -e DOMAIN=call.example.com \
  -e LETSENCRYPT_EMAIL=you@example.com \
  -e EXTERNAL_IP=1.2.3.4 \
  -p 80:80 -p 443:443 -p 49152-49200:49152-49200/udp \
  -v tuturu-certs:/etc/letsencrypt \
  --privileged \
  tuturu:latest

# View logs (systemd journal)
docker exec tuturu journalctl -f

# View specific service logs
docker exec tuturu journalctl -u tuturu-app -f
docker exec tuturu journalctl -u tuturu-nginx -f
docker exec tuturu journalctl -u tuturu-coturn -f
docker exec tuturu journalctl -u tuturu-redis -f
docker exec tuturu journalctl -u tuturu-init
```

### Testing

```bash
# Local testing
bun run build && bun run dev
# Open http://localhost:3000 in two browsers
# Enter same 6-digit PIN in both
```

## Architecture Overview

### Single Container System (systemd-based)

All services run in a single UBI10-init container managed by systemd:

1. **tuturu-app** (Bun WebSocket server)
   - WebSocket signaling server (PIN-based room matching)
   - Ephemeral TURN credential generation (HMAC-SHA1)
   - Static file serving (frontend)
   - Port 3000 internally

2. **tuturu-redis** (credential revocation)
   - Blacklist for revoked TURN credentials
   - Auto-expiring entries (TTL matches credential lifetime)
   - 64MB max memory with LRU eviction

3. **tuturu-coturn** (TURN/STUN server)
   - NAT traversal for restrictive networks
   - Ephemeral credentials via REST API (use-auth-secret)
   - Redis integration for credential revocation
   - Port 3478 (STUN), 5349 (TURNS via SNI routing)
   - Relay port range: 49152-49200

4. **tuturu-nginx** (reverse proxy)
   - SNI-based TLS routing on port 443 (DPI resistant)
   - SSL termination for app traffic
   - TURNS passthrough to coturn
   - Port 80 (ACME challenge + redirect)

5. **tuturu-certbot** (Let's Encrypt)
   - Automatic certificate provisioning
   - Renewal via systemd timer

6. **tuturu-init** (one-shot initialization)
   - Validates environment variables
   - Generates nginx and coturn configs from templates
   - Runs once on first container start

### Container Environment Variables

Pass via `docker run -e` or env file:
- `DOMAIN` (required) - Base domain (e.g., `call.example.com`)
- `LETSENCRYPT_EMAIL` (required) - Email for Let's Encrypt
- `EXTERNAL_IP` (required) - Public IP of server
- `TURN_SECRET` (optional, auto-generated if not set) - Secret for ephemeral HMAC credentials (min 32 chars)
- `TURN_MIN_PORT` / `TURN_MAX_PORT` (optional, default: 49152-49200)
- `STUN_SERVERS` (optional, default: `stun:t.${DOMAIN}:3478`) - STUN server URLs
- `LETSENCRYPT_STAGING` (optional) - Use staging CA for testing
- `FORCE_RELAY` (optional, default: `false`) - Force TURN relay for all connections

### systemd Service Architecture

Environment variables flow: `docker -e` → systemd → `PassEnvironment=` → services

```
tuturu-init.service (oneshot, runs first)
    ├── Receives env vars via PassEnvironment
    ├── Generates /etc/nginx/nginx.conf from template
    ├── Generates /etc/coturn/turnserver.conf from template
    └── Saves env to /etc/tuturu/env for other services

tuturu-certbot.service (oneshot)
    └── Obtains certificates from Let's Encrypt

tuturu-redis.service (before coturn and app)
    └── Redis for TURN credential revocation blacklist

tuturu-nginx.service (after certbot)
tuturu-coturn.service (after certbot, redis)
tuturu-app.service (after init, redis)
```

### SNI-Based Routing (DPI Resistance)

All traffic on port 443 looks like standard HTTPS:
- `a.domain.com` → nginx → Bun app (WebSocket/HTTPS)
- `t.domain.com` → coturn (TURNS passthrough)
- `domain.com` → nginx → cover website

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

**app/src/rooms.ts**: Room management module:
- `Client` - Full client with `ServerWebSocket<ClientData>` reference
- `Room` - PIN-based room with `Client[]` and `turnCredentials` map
- `getOrCreateRoom()`, `addClientToRoom()`, `removeClientFromRoom()`
- Automatic TURN credential revocation when clients leave

**app/src/turn.ts**: Ephemeral TURN credentials module:
- `generateTurnCredentials()` - HMAC-SHA1 credentials (coturn REST API format)
- `revokeTurnCredentials()` - Add to Redis blacklist with auto-expiring TTL
- `initRedis()` / `closeRedis()` - Redis connection lifecycle
- 4-hour credential TTL, soft Redis dependency (works without Redis)

**app/src/server.ts**: WebSocket signaling server (TypeScript):
- `join-pin` - User joins with PIN, receives ephemeral ICE credentials
- `peer-joined` - Sent to FIRST peer only (triggers offer creation)
- `offer` - WebRTC offer relayed from first peer to second peer
- `answer` - WebRTC answer relayed from second peer to first peer
- `ice-candidate` - ICE candidate exchange (relayed between peers)
- `leave` - User disconnects
- **Glare prevention**: Only first peer receives `peer-joined`, avoiding simultaneous offers

**app/src/client/**: WebRTC client (State Machine Architecture):

Modular architecture with unidirectional data flow:
- `index.ts` - Entry point, dispatch loop, initialization
- `state.ts` - State machine (types, actions, pure reducer function)
- `render.ts` - DOM rendering (single source of truth for UI)
- `effects.ts` - Side effect orchestration
- `websocket.ts` - WebSocket connection management
- `media.ts` - getUserMedia handling (with iOS Safari compatibility)
- `webrtc.ts` - RTCPeerConnection lifecycle
- `events.ts` - DOM event listeners

**State Machine Pattern**:
- **Unidirectional data flow**: Action → Reducer → Side Effects → Render
- **Pure reducer**: All state transitions explicit and testable
- **Discriminated unions**: Type-safe screen states (pin-entry, connecting, acquiring-media, waiting-for-peer, negotiating, call, error)
- **Action logging**: Every state change logged for debugging
- **No race conditions**: Error timeout properly managed
- **Mobile-friendly**: iOS Safari constraints preserved (ideal vs exact getUserMedia)

**Build Process**:
- **Client**: `src/client/index.ts` bundled by Bun → `public/index.js` (106 KB with inline sourcemaps)
- **Server (Development)**: `src/server.ts` runs directly with Bun (hot reload)
- **Server (Production)**: `src/server.ts` bundled with embedded assets → `dist/server` (58 MB executable)
- **Static Assets**: HTML, CSS, and client JS embedded in server executable at compile time
- **Types**: `src/types.ts` shared between client and server
- **No external dependencies**: Production executable contains Bun runtime + all assets

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
3. **Client Build**:
   - `bun build src/client/index.ts` bundles to `public/index.js` (106 KB)
   - Inline source maps for debugging (Chrome DevTools compatible)
   - Minified for production
4. **Server Development**: Bun runs `src/server.ts` directly with hot reload
5. **Server Production**:
   - `bun build --compile src/server.ts` creates standalone executable
   - Static assets (HTML, CSS, JS) embedded using Bun's import attributes
   - Single 58 MB file containing Bun runtime + all code + all assets
   - No external file dependencies at runtime
6. **Asset Embedding**:
   - Uses ES2025 import attributes: `import html from './file.html' with { type: 'text' }`
   - Assets baked into executable at compile time
   - Served from memory (faster than disk I/O)
7. **Type Safety**: All DOM elements, WebRTC, and WebSocket APIs are typed

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

coturn uses ephemeral HMAC-SHA1 credentials (REST API format):
- `use-auth-secret` with `static-auth-secret` from TURN_SECRET
- Redis integration for credential revocation blacklist
- External IP address for ICE candidate generation
- Port range for relay connections
- Realm matching domain name

**Credential format:**
- Username: `expiryTimestamp:clientId`
- Password: `base64(HMAC-SHA1(username, TURN_SECRET))`
- TTL: 4 hours (credentials auto-expire)

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
│   ├── client/          # Client state machine architecture
│   │   ├── index.ts     # Entry point, dispatch loop
│   │   ├── state.ts     # State machine (types, actions, reducer)
│   │   ├── state.test.ts # Unit tests for reducer (25 tests)
│   │   ├── render.ts    # DOM rendering
│   │   ├── effects.ts   # Side effect orchestration
│   │   ├── websocket.ts # WebSocket management
│   │   ├── media.ts     # getUserMedia handling
│   │   ├── webrtc.ts    # RTCPeerConnection lifecycle
│   │   └── events.ts    # DOM event listeners
│   ├── server.ts        # WebSocket signaling server
│   ├── rooms.ts         # Room management module
│   ├── turn.ts          # Ephemeral TURN credentials + Redis revocation
│   ├── config.ts        # Server configuration
│   ├── types.ts         # Shared TypeScript types
│   └── global.d.ts      # Type declarations for asset imports
├── public/
│   ├── index.html       # Static HTML (embedded in production)
│   ├── styles.css       # Styling (embedded in production)
│   └── index.js         # Built client code (git-ignored)
├── dist/
│   └── server           # Compiled executable (58 MB, git-ignored)
├── package.json         # Scripts: build, build:prod, dev, start:prod, test
└── bunfig.toml          # Bun configuration

container/
├── Dockerfile           # Multi-stage build (Debian builder → UBI10-init)
├── scripts/
│   ├── tuturu-init.sh   # Initialization script (env validation, config generation)
│   └── tuturu-certbot.sh # Let's Encrypt certificate provisioning
├── systemd/
│   ├── tuturu-init.service      # One-shot initialization
│   ├── tuturu-app.service       # Bun signaling server
│   ├── tuturu-redis.service     # Redis for TURN credential revocation
│   ├── tuturu-nginx.service     # nginx reverse proxy
│   ├── tuturu-coturn.service    # TURN/STUN server
│   ├── tuturu-certbot.service   # Certificate provisioning
│   └── tuturu-certbot-renew.timer # Certificate renewal timer
├── templates/
│   ├── nginx.conf.template      # nginx config with ${DOMAIN} substitution
│   └── turnserver.conf.template # coturn config with env substitution
└── html/
    └── index.html       # Cover website (served on base domain)

build.sh                 # Build container image
run.sh                   # Run container with env vars
```

## Implementation Phases

See PROJECT_OUTLINE.md for detailed phases.

**Completed**:
- ✅ Phase 1: Basic signaling (WebSocket + PIN matching)
- ✅ Phase 2: WebRTC integration (PeerConnection, getUserMedia)
- ✅ Phase 3: TURN server setup (coturn in single container)
- ✅ Phase 4: Single container deployment (systemd, nginx, certbot)
- ✅ Phase 5: Production setup (SSL via Let's Encrypt, SNI routing)
- ✅ **Frontend Refactor**: State machine architecture (8 modules, 25 unit tests)
- ✅ **Production Bundling**: Single executable with embedded assets
- ✅ **Ephemeral TURN Credentials**: HMAC-SHA1 credentials with Redis revocation

**Remaining**:
- ⏳ Phase 6: Optimization (reconnection, bandwidth adaptation)

**Architecture Highlights**:
- **Single Container**: All services (app, nginx, coturn, redis, certbot) in one systemd container
- **SNI Routing**: DPI-resistant design - all traffic looks like HTTPS on port 443
- **PassEnvironment**: Container env vars flow to systemd services
- **Auto-certificates**: Let's Encrypt with automatic renewal
- **State Machine Pattern**: Predictable client state transitions, action logging
- **Ephemeral Credentials**: Per-call TURN credentials with immediate revocation via Redis
