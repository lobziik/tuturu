# tuturu

*"Tuturu~! ♪" — Mayuri Shiina*

Self-hosted primitive chat and WebRTC video calling for small groups.

One shared passphrase = one room.

Single container.

## What is This

A self-hosted PWA for chat and video calls between people who agree on a passphrase and a 6-digit PIN.
Server stores encrypted messages, routes WebSocket signaling, and (optionally) forwards media via an SFU.
Up to 6 participants per room for now.

You run it on your own VPS, behind your own domain, Let's Encrypt for TLS.

## Quickstart

### 1. Get a domain

Buy one or use a domain you control. You'll create three A-records.

### 2. Get a VPS

Any Linux VPS will do. 512 MB RAM is comfortable (256 MB works for me).

### 3. Configure DNS

Point three records to your VPS IP. Examples for `call.example.com`:

```
call.example.com    A    YOUR_VPS_IP
a.call.example.com  A    YOUR_VPS_IP
t.call.example.com  A    YOUR_VPS_IP
```

Wait for propagation: `dig a.call.example.com`.

### 4. Run

```bash
curl -fsSL https://github.com/lobziik/tuturu/releases/latest/download/tuturu -o tuturu
chmod +x tuturu
sudo ./tuturu install
```

The installer prompts for domain, email (Let's Encrypt), external IP, and TURN-relay-only mode. First run takes 1–2
minutes while certificates are issued.

### 5. Use

Open `https://a.<your-domain>` on each device. Enter a nickname, agree on a passphrase + PIN with the other
participants, type both, and you're in the same room.

## What's Inside

A single OCI container running:

- **tuturu-app** — Bun signaling server. WebSocket protocol, SQLite for chat history, optional mediasoup SFU.
- **tuturu-nginx** — TLS termination on port 443 with SNI demux: `a.<domain>` → app, `t.<domain>` → coturn, default →
  static site.
- **tuturu-coturn** — STUN/TURN with TURNS on 443. REST-API auth, ephemeral HMAC credentials, 4-hour TTL.
- **tuturu-certbot** + renewal timer — Let's Encrypt issuance and rotation. Post-renewal hook restarts coturn.

The frontend is a Preact PWA, wanna-be-mobile-first.

```
┌─────────────────────────────────────────────────────────┐
│  Container (UBI10-init, systemd PID 1)                  │
│                                                         │
│   tuturu-init.service       (oneshot, renders configs)  │
│                                                         │
│   tuturu-nginx.service      :80   ACME + redirect       │
│                             :443  TLS + SNI demux       │
│                                                         │
│   tuturu-app.service        :3000 Bun (WS, HTTP, SFU)   │
│                                                         │
│   tuturu-coturn.service     :3478 STUN/TURN             │
│                             :5349 TURNS (behind nginx)  │
│                             49152–49200/udp relay       │
│                                                         │
│   tuturu-certbot-renew.timer  → restart coturn on rotate│
│                                                         │
│   /var/lib/tuturu/          messages.db                 │
│   /etc/letsencrypt/         certificates (volume)       │
└─────────────────────────────────────────────────────────┘
```

## What It Relies On

- Modern browser with WebRTC, IndexedDB, Web Crypto, and WebSockets — Chrome, Firefox, Safari, Edge.
- Domain name. Three DNS A-records: `<domain>`, `a.<domain>`, `t.<domain>` → your VPS IP.
- VPS that can reach Let's Encrypt over port 80 and bind 80, 443, plus a UDP relay range.
- Required ports: 80/tcp (ACME + redirect), 443/tcp (HTTPS, WSS, and TURNS — all SNI-demuxed), 49152–49200/udp (TURN
  media relay).

256 MB RAM and 1 CPU have been enough for mesh calls. SFU mode wants more RAM and a real core.

## Commands

```
sudo ./tuturu install     # First-time setup (interactive)
./tuturu start            # Start container
./tuturu stop             # Stop and remove container
./tuturu restart          # Stop + start
./tuturu logs             # Follow journalctl inside the container
./tuturu logs app         # tuturu-app only
./tuturu logs nginx       # tuturu-nginx only
./tuturu logs coturn      # tuturu-coturn only
./tuturu logs certbot     # tuturu-certbot only
./tuturu status           # Container + service status
./tuturu upgrade          # Pull latest CLI, restart container
./tuturu help
```

## How It Works

Inside the container, every service is a systemd unit. `tuturu-init` runs once at start, validates `/etc/tuturu/env`,
renders `nginx.conf` and `turnserver.conf` from templates, then exits. Everything else stays alive: `tuturu-nginx`,
`tuturu-coturn`, `tuturu-app`, `tuturu-certbot-renew.timer`.

### SNI routing on port 443

All TLS traffic — HTTPS, WebSocket, and TURNS — arrives on a single port. nginx looks at the SNI of each TLS
connection without decryption and forwards to a right backend.

```
                 Browser
                    │
                    │   TLS · :443
                    ▼
   ┌── nginx  (SNI preread, no decryption) ──┐
   │                                          │
   │   SNI = a.<domain>  ──►  tuturu-app      │
   │                          :3000           │
   │                          ├─ WSS signaling│
   │                          ├─ HTTPS        │
   │                          ├─ static PWA   │
   │                          └─ mediasoup SFU│
   │                                          │
   │   SNI = t.<domain>  ──►  tuturu-coturn   │
   │                          :5349 (TURNS)   │
   │                                          │
   │   default SNI       ──►  static site     │
   │                          (static, nginx) │
   └──────────────────────────────────────────┘
```

Static site on the apex domain is just a page served by nginx.

Application UI lives at `a.<domain>`.

`t.<domain>` SNI value is for TURNS only and serves no HTTP.

### Media paths

Signaling (WSS) is always served by `tuturu-app` via the SNI route above. The actual audio/video traffic takes one of
two paths per connection, decided by ICE.

```
Direct  (preferred — when ICE finds host or srflx candidates)

   Browser A  ◄──────────  SRTP/UDP  ──────────►  Browser B
              media never touches the server


Relayed  (TURN fallback, or always when FORCE_RELAY=true)

                          tuturu-coturn
                          ┌─────────────────────┐
                          │ control:            │
   Browser A  ──TURN────► │   :443 TURNS  SNI=t.│ ◄────TURN──  Browser B
                          │   :5349 TURNS       │
                          │   :3478 plain TURN  │
                          │                     │
   Browser A  ◄──media──► │ media:              │ ◄──media──► Browser B
                          │   UDP 49152–49200   │
                          └─────────────────────┘
```

In **SFU mode**, the picture is the same except one side of every connection is `tuturu-app`'s mediasoup endpoint
instead of another browser. Each browser still negotiates ICE the same way: direct to mediasoup if reachable (it's not),
relayed through coturn otherwise.

```
   Browser A  ◄─── direct or via coturn ───►  tuturu-app
   Browser B  ◄─── direct or via coturn ───►  (mediasoup)
   Browser C  ◄─── direct or via coturn ───►       │
                                                   │
                                                   └─ fans frames out
                                                      across A, B, C
```

### About crypto, briefly

The passphrase and PIN never leave the browser. They go through Argon2id into a 32-byte master key.
HKDF-SHA256 then splits it into a room ID (sent to the server for routing) and an AES-256-GCM key (kept on the client).
Chat messages are encrypted with that key before they reach the server and stored as blobs both on the
server (SQLite db) and on each device (IndexedDB).

When media E2EE is enabled, every audio and video frame is encrypted on the sender with the same key via `RTCRtpScriptTransform` and decrypted on the receiver.

```
passphrase + PIN ─┐
                  │  Argon2id ──▶          master (32 bytes)
                  │                                ▼
"tuturu:" + host ─┘                       ┌─────────────────┐
                                          │                 │
                                          │   HKDF-SHA256   │
                                          │                 │
                                          └────┬───────┬────┘
                                               │       │
                          info="room-id"       │       │  info="encryption-key"
                                               ▼       ▼
                                        roomId (16B)   AES-256-GCM key
                                        →  server      stays on client                                                   
```

## Configuration

Configuration lives at `~/.config/tuturu/env` (or `$XDG_CONFIG_HOME/tuturu/env`).

The installer writes the minimum required set. Anything below can be added to the env file and picked up on the next
`restart`.

| Variable                    | Default | What it does                                                      |
|-----------------------------|---------|-------------------------------------------------------------------|
| `DOMAIN`                    | —       | Base domain. Required.                                            |
| `LETSENCRYPT_EMAIL`         | —       | Required for ACME.                                                |
| `EXTERNAL_IP`               | —       | Public IPv4 of the host.                                          |
| `FORCE_RELAY`               | `false` | Force all WebRTC media through coturn (no host/srflx candidates). |
| `RETENTION_DAYS`            | `7`     | Server-side TTL for chat messages.                                |
| `MAX_PARTICIPANTS`          | `6`     | Per-room peer limit.                                              |
| `TUTURU_SFU_ENABLED`        | `false` | Enable mediasoup SFU. When off, all calls are mesh.               |
| `TUTURU_E2EE_MEDIA_ENABLED` | `true`  | Per-frame E2EE on RTP via RTCRtpScriptTransform.                  |

### Call topology and the coturn relay

Every call uses WebRTC. Each browser establishes connections through standard ICE: it tries direct paths first (host
candidates on the LAN, server-reflexive candidates discovered through STUN), and falls back to **coturn** as a TURN
relay when direct fails. Setting `FORCE_RELAY=true` skips the direct attempt and forces all media through coturn from
the start.

On top of that transport layer there are two topology choices.
Both can use direct ICE paths or relay through coturn — the topology is independent of the transport.

```
   Mesh  (default)                  SFU  (opt-in)

      A ──── B                         A
      │ ╲  ╱ │                          ╲
      │  ╲╱  │                           ╲
      │  ╱╲  │                            ▶  tuturu-app
      │ ╱  ╲ │                           /   (mediasoup)
      D ──── C                          /     ▲
                                       B      │
                                       C ─────┤
   N(N-1)/2 connections                D ─────┘
   each peer encodes N-1
   outgoing streams                   N connections
                                      each peer encodes one stream
```

**Mesh** is the default for now. Every peer holds a separate WebRTC connection to every other peer.
Each client encodes its outgoing video N–1 times and sends N–1 streams.
Mesh is fine for few participants on phones; with more folks - phones might not be feeling that well.

**SFU** is opt-in (`TUTURU_SFU_ENABLED=true`). A single media-routing server fans frames out.
Every client encodes once, sends one stream to the server, and receives N–1 streams back.
Gives a nice perk of looking into media headers (like sound lvl), which opens up a way for some cool features (speaker detection, for instance).
Still experimental.

#### mediasoup

The SFU is built on [mediasoup](https://github.com/versatica/mediasoup) which ships as a Node/TypeScript control library
plus a C++ worker part that does the actual SRTP/RTCP packet forwarding.

### End-to-end media encryption

On by default. Every audio and video frame is encrypted on the sender with AES, using the same room key that protects
chat, and decrypted on the receiver.

**NOTE:** The unencrypted-header bytes that the codec depacketizer needs (1 byte for Opus, 3–10 bytes for VP8) are unencrypted.

E2EE forces VP8 in mesh and rejects H264 in the SFU router, because RTCEncodedVideoFrame metadata for H264 differs
across browsers and breaks AAD.

This might be turned off - `TUTURU_E2EE_MEDIA_ENABLED=false`. When E2EE off, browsers can negotiate H264,
which is expected to use iOS hardware acceleration — noticeably lighter on CPU and battery on iPhones during longer calls.

## Project Structure

```
tuturu/
├── app/
│   ├── src/
│   │   ├── client/         # Preact PWA, state machine, SFU client, E2EE worker
│   │   ├── server/         # Bun signaling server, HTTP, SQLite, SFU
│   │   └── shared/         # Zod schemas (wire protocol), shared types
│   ├── public/             # Static assets, manifest, icons
│   ├── build.ts            # Client + worker build
│   └── package.json
├── container/
│   ├── Dockerfile          # Two-stage: Bun build → UBI10-init runtime
│   ├── systemd/            # tuturu-*.service units
│   ├── templates/          # nginx.conf.template, turnserver.conf.template
│   ├── scripts/            # tuturu-init.sh, tuturu-certbot.sh
│   └── html/               # Static site for the apex domain
├── tuturu                  # User-facing CLI (bash)
└── README.md
```

`bun run check` runs lint, typecheck, prettier, stylelint, and dead-code analysis.
`bun test` runs the unit and integration suite.

## Documentation

TBD.

## License

[MIT](LICENSE.md).

---

```
Lab Note: 
AI wrote code. Gadget works.
Cats were present. Cats have not contacted The Organization. To my knowledge. But precautions taken.
```
