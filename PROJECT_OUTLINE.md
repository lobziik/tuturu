# tuturu - WebRTC Self-Hosted Video Calling App

## Project Goal
Build a simple, self-hosted WebRTC video calling application that works in restricted network environments (specifically Russia). The app should be easy to deploy on any VPS using Docker.

## Use Case
Enable video calls between two parties where one is in a country with messenger restrictions. Users connect by entering a shared PIN code.

## Core Requirements

### Functional Requirements
1. **PIN-based calling**: Two users enter the same 6-digit PIN to connect
2. **Video + Audio**: Full duplex video and audio streaming
3. **Peer-to-peer with relay fallback**: Direct connection preferred, TURN relay when needed
4. **Simple UI**: Minimal interface - PIN input, video display, hang up button
5. **Self-contained**: No external dependencies or third-party services

### Technical Requirements
1. **WebRTC** for peer-to-peer media streaming
2. **Bun** as single runtime for:
   - Building/bundling frontend
   - WebSocket signaling server
   - Static file serving
3. **coturn** for STUN/TURN server (NAT traversal and relay)
4. **Docker Compose** for deployment orchestration
5. **HTTPS/WSS**: Secure connections required for WebRTC

### Non-Functional Requirements
1. Easy deployment: Single `docker-compose up` command
2. Portable: Works on any VPS with Docker
3. Minimal resource usage
4. Works through restrictive firewalls/NATs
5. No registration or authentication (beyond PIN matching)

## Architecture

### High-Level Components
```
┌─────────────────────────────────────────────────┐
│                Docker Compose                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────┐│
│  │  Bun App     │  │   coturn     │  │ nginx  ││
│  │  Container   │  │   Container  │  │(SSL)   ││
│  │              │  │              │  │        ││
│  │ - WebSocket  │  │ - STUN       │  │- HTTPS ││
│  │ - Signaling  │  │ - TURN       │  │- Proxy ││
│  │ - Frontend   │  │ - Relay      │  │        ││
│  └──────────────┘  └──────────────┘  └────────┘│
└─────────────────────────────────────────────────┘
```

### Technology Stack
- **Runtime**: Bun (latest stable)
- **Signaling**: Bun native WebSockets
- **TURN/STUN**: coturn
- **Frontend**: Vanilla JavaScript (WebRTC native APIs)
- **Containerization**: Docker + Docker Compose
- **SSL**: nginx + Let's Encrypt OR Caddy

### Connection Flow
1. User A opens app → enters PIN (e.g., 123456)
2. User B opens app → enters same PIN (123456)
3. WebSocket signaling matches users by PIN
4. WebRTC negotiation (SDP offer/answer exchange)
5. ICE candidates exchanged (try STUN for direct connection)
6. If direct fails, fall back to TURN relay
7. Media streams established
8. Video/audio call active

## Project Structure

```
tuturu/
├── README.md                    # Setup and deployment instructions
├── docker-compose.yml           # Main orchestration file
├── .env.example                 # Environment variables template
├── .gitignore
│
├── app/                         # Bun application
│   ├── Dockerfile               # Bun app container image
│   ├── package.json             # Dependencies (if any)
│   ├── bunfig.toml             # Bun configuration
│   ├── src/
│   │   ├── server.ts           # WebSocket signaling server
│   │   └── types.ts            # TypeScript types
│   └── public/                 # Frontend files
│       ├── index.html          # Main UI
│       ├── app.js              # WebRTC client logic
│       └── styles.css          # Minimal styling
│
├── coturn/                      # TURN/STUN configuration
│   ├── Dockerfile              # coturn container (or use official image)
│   └── turnserver.conf         # coturn configuration
│
└── nginx/                       # SSL termination (optional)
    ├── Dockerfile
    ├── nginx.conf
    └── ssl/                    # Certificate mount point
```

## Component Specifications

### 1. Bun Application (app/)

#### Server (server.ts)
- WebSocket server listening on port 3000
- PIN-based room management
- Signaling message relay (offer/answer/ICE candidates)
- Static file serving

**Key endpoints:**
- `ws://localhost:3000` - WebSocket connection
- `GET /` - Serve index.html
- `GET /health` - Health check endpoint

**WebSocket events:**
- `join-pin` - User joins with PIN
- `offer` - WebRTC offer from caller
- `answer` - WebRTC answer from callee
- `ice-candidate` - ICE candidate exchange
- `leave` - User disconnects

#### Frontend (public/)

**index.html:**
- PIN input field
- Local video element
- Remote video element
- Call controls (mute, video off, hang up)

**app.js:**
- WebSocket client connection
- WebRTC PeerConnection setup
- Media stream handling (getUserMedia)
- ICE candidate handling
- UI event handlers

**Configuration needed:**
- WebSocket server URL (from environment)
- STUN/TURN server URLs (passed from backend)
- ICE server credentials

### 2. coturn Container

**Configuration (turnserver.conf):**
- Listening port: 3478 (UDP/TCP)
- TLS listening port: 5349
- Relay port range: 49152-49200
- Authentication: long-term credentials
- Realm: Your domain
- Static credentials for app

**Environment variables:**
- `TURN_USERNAME` - TURN authentication username
- `TURN_PASSWORD` - TURN authentication password
- `EXTERNAL_IP` - VPS public IP address

### 3. nginx Container (Optional but Recommended)

**Purpose:**
- SSL termination for WebSocket and HTTP
- Let's Encrypt certificate management
- Reverse proxy to Bun app

**Configuration:**
- Port 80 → redirect to 443
- Port 443 → proxy to Bun app :3000
- WebSocket upgrade handling
- SSL certificate paths

## Environment Variables

```env
# Domain
DOMAIN=yourdomain.com

# Bun App
BUN_PORT=3000
NODE_ENV=production

# coturn
TURN_USERNAME=webrtc
TURN_PASSWORD=<generate-strong-password>
TURN_REALM=yourdomain.com
EXTERNAL_IP=<vps-public-ip>

# SSL (if using Let's Encrypt)
LETSENCRYPT_EMAIL=your@email.com
```

## Security Considerations

1. **HTTPS/WSS only**: WebRTC requires secure contexts
2. **TURN authentication**: Prevent unauthorized relay usage
3. **PIN expiry**: Optional - PINs expire after 24 hours
4. **Rate limiting**: Prevent PIN brute force
5. **CORS**: Restrict origins in production
6. **No data persistence**: No logs, no call records

## Deployment Instructions

### Prerequisites
- VPS with Docker and Docker Compose installed
- Domain name pointing to VPS IP
- Ports open: 80, 443, 3478, 49152-49200

### Steps
1. Clone repository to VPS
2. Copy `.env.example` to `.env` and configure
3. Run `docker-compose up -d`
4. Access app at `https://yourdomain.com`

### Testing
1. Open app in two different browsers/devices
2. Enter same PIN in both
3. Grant camera/microphone permissions
4. Verify video call establishes

## Development Phases

### Phase 1: Basic Signaling
- [ ] Set up Bun WebSocket server
- [ ] Implement PIN-based room matching
- [ ] Message relay (offer/answer/ICE)
- [ ] Basic HTML/JS client
- [ ] Test signaling without media

### Phase 2: WebRTC Integration
- [ ] Add WebRTC PeerConnection setup
- [ ] Implement getUserMedia
- [ ] Handle ICE candidate exchange
- [ ] Test local peer-to-peer connection
- [ ] Add basic UI controls

### Phase 3: TURN Server
- [ ] Configure coturn
- [ ] Integrate TURN credentials in app
- [ ] Test connection through relay
- [ ] Verify NAT traversal

### Phase 4: Dockerization
- [ ] Create Dockerfile for Bun app
- [ ] Set up coturn container
- [ ] Create docker-compose.yml
- [ ] Test full stack locally

### Phase 5: Production Setup
- [ ] Add nginx for SSL
- [ ] Configure Let's Encrypt
- [ ] Set up health checks
- [ ] Add logging
- [ ] Create deployment documentation

### Phase 6: Optimization
- [ ] Add connection quality indicators
- [ ] Implement reconnection logic
- [ ] Add bandwidth adaptation
- [ ] Optimize for mobile browsers
- [ ] Add error handling and user feedback

## Known Limitations & Trade-offs

1. **No multi-party calls**: Designed for 1-to-1 only
2. **No call history**: Stateless by design
3. **No recording**: Privacy-focused
4. **PIN security**: 6-digit PINs can be guessed (consider adding rate limiting)
5. **TURN bandwidth**: Relayed calls use server bandwidth (cost consideration)
6. **Browser compatibility**: Modern browsers only (Chrome, Firefox, Safari, Edge)

## Testing Checklist

- [ ] Both users on same network (direct P2P)
- [ ] Users on different networks (STUN)
- [ ] One user behind symmetric NAT (TURN)
- [ ] Mobile browsers (iOS Safari, Chrome Android)
- [ ] Connection from Russia (primary use case)
- [ ] Weak/unstable network conditions
- [ ] Multiple concurrent calls
- [ ] Reconnection after network interruption

## Future Enhancements (Out of Scope for v1)

- Screen sharing
- Text chat alongside video
- Call quality metrics
- Mobile apps (native)
- End-to-end encryption (WebRTC is encrypted, but add signaling encryption)
- Multiple TURN servers for redundancy
- Admin dashboard for monitoring

## Resources & References

### Documentation
- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Bun Documentation](https://bun.sh/docs)
- [coturn Documentation](https://github.com/coturn/coturn)
- [Perfect Negotiation Pattern](https://w3c.github.io/webrtc-pc/#perfect-negotiation-example)

### Key WebRTC Concepts
- **SDP (Session Description Protocol)**: Describes media capabilities
- **ICE (Interactive Connectivity Establishment)**: NAT traversal protocol
- **STUN (Session Traversal Utilities for NAT)**: Discovers public IP
- **TURN (Traversal Using Relays around NAT)**: Relay server for difficult networks

## Development Guidelines for AI Agents

When implementing this project:

1. **Start simple**: Get basic signaling working before adding complexity
2. **Test incrementally**: Verify each component before integration
3. **Handle errors gracefully**: WebRTC has many failure modes
4. **Log appropriately**: Connection state changes, ICE candidates, errors
5. **Consider mobile**: Touch-friendly UI, handle mobile browser quirks
6. **Keep it stateless**: No database, no user accounts
7. **Prioritize reliability**: Connection must work even in poor conditions
8. **Document assumptions**: Network requirements, browser versions, etc.

## Success Criteria

The project is successful when:
1. Two users can reliably connect using a PIN
2. Video and audio quality is acceptable
3. Connection works from Russia to international server
4. Deployment takes < 10 minutes on fresh VPS
5. No dependency on external services
6. Works on mobile and desktop browsers

---

**Project Status**: Planning/Architecture Phase
**Last Updated**: 2025-12-06
**Target Deployment**: Self-hosted VPS with Docker
