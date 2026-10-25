# Architecture

How tuturu is put together, for contributors and coding agents. Security properties and their
limits are in [THREAT-MODEL.md](THREAT-MODEL.md). Working rules are in
[../AGENTS.md](../AGENTS.md). If this document and the code disagree, the code is right and
this document needs fixing.

## Overview

```
Browser (Preact PWA)
   │  HTTPS / WSS / TURNS, all on :443
   ▼
nginx stream (SNI preread, no decryption)
   ├─ a.<domain> ─▶ nginx http :8443 (TLS) ─▶ Bun :3000   HTTP, WebSocket, SQLite, blobs, [mediasoup SFU]
   ├─ t.<domain> ─▶ coturn :5349 (TURNS, coturn terminates TLS itself)
   └─ default    ─▶ nginx http :8443 ─▶ static site (/var/www/html)
```

Media goes peer-to-peer (mesh) or through mediasoup in the Bun process (SFU). In both cases it
uses direct ICE paths when possible and falls back to coturn (or always uses it with
`FORCE_RELAY=true`).

## Crypto (client only)

```
input  = passphrase + ":" + pin            salt = "tuturu:" + location.hostname
master = Argon2id(input, salt, 64 MiB, t=3, p=1) → 32 bytes          (hash-wasm)
roomId = HKDF-SHA256(master, salt="tuturu-hkdf-v1", info="room-id")        → 16 bytes, hex
aesKey = HKDF-SHA256(master, salt="tuturu-hkdf-v1", info="encryption-key")  → AES-256-GCM, non-extractable
wire   = iv(12) || ciphertext || tag(16), base64 over WebSocket
```

- `app/src/client/services/crypto.ts` is the only implementation. `app/hack/seed-messages.ts`
  duplicates the parameters on purpose and must be kept in sync.
- `roomId` goes to the server for routing; `aesKey` never leaves the browser.
- The same `aesKey` encrypts chat payloads, nicknames and media frames.
- Symmetric-only by decision: no identity keys, PKI, ratchets or forward secrecy.

## Wire protocol (`app/src/shared/schemas.ts`)

- WebSocket messages are JSON with `v: 1` and a `type` discriminator. Zod schemas
  (`ClientToServerMessageSchema`, `ServerToClientMessageSchema`) are the single source of
  truth; TypeScript types come from `z.infer<>`.
- Both sides `safeParse` every inbound message. On failure the server answers
  `error / INVALID_MESSAGE` and keeps the socket; the client logs and drops the message.
- Message groups:
  - room: `join`, `leave`, `peers-list`, `peer-joined`, `peer-left`, `ping` / `pong`
  - chat: `chat`, `chat-broadcast`, `chat-ack`, `history-request`, `history`,
    `chat-received` (relay exists, client handling is a stub)
  - mesh signaling: `offer`, `answer`, `ice-candidate` (directed by `targetPeerId`, the server
    rewrites the sender into `peerId`)
  - call membership: `join-call`, `leave-call`, `call-peers`
  - SFU: `sfu-join`, `sfu-create-transport`, `sfu-connect-transport`, `sfu-produce`,
    `sfu-consume-resume`, `sfu-producer-pause` / `-resume`, and server-side
    `sfu-router-caps`, `sfu-transport-created`, `sfu-producer-created`, `sfu-new-consumer`,
    `sfu-active-speaker`
- The server treats `blob`, `encryptedNickname`, SDP and ICE as opaque strings. Signaling is
  not end-to-end encrypted.
- `ChatMessage`, inside the ciphertext, carries `deviceId`, a per-device monotonic `seq`,
  `uuid`, `sender`, `timestamp`, `type: 'text' | 'photo'` and its payload. The type union is
  strict on purpose.
- History pagination uses the server message `id` as the cursor (`before` = oldest id seen).
- HTTP: `GET /health`, `GET /ws` (upgrade), `POST|GET /api/blob/<uuidv4>` (upload requires
  `BLOB_UPLOAD_TOKEN`, disabled when unset; the UI does not use blobs yet), plus embedded static
  assets with ETags.

## Server (`app/src/server/`)

Hand-wired dependency injection, factories everywhere.

| Module | Role |
|---|---|
| `index.ts` | Wires dependencies, owns the single `send()` used for all outgoing WS traffic, starts `Bun.serve`, hourly retention cleanup, SIGINT/SIGTERM shutdown |
| `config.ts` | Zod-validated env, read at import time; throws on bad config |
| `ws.ts` | Thin router: JSON parse → Zod → exhaustive switch → handlers |
| `handlers.ts` | Orchestration: join/leave, chat persist + broadcast + ack, history, relay, calls, SFU entry points |
| `rooms.ts` | In-memory rooms (ephemeral: created on join, deleted when empty), call membership, injected `send` |
| `database.ts` | bun:sqlite, WAL, prepared statements, one `messages` table |
| `blob.ts` | Flat directory, UUIDv4 file names, mtime-based cleanup |
| `heartbeat.ts` | Per-connection ping every 30s, close after 90s without pong |
| `turn.ts`, `ice.ts` | coturn REST credentials (HMAC-SHA1, 4h TTL) and the ICE server list (TURNS :443 first) |
| `assets.ts`, `http.ts` | Embedded static assets, ETags, cache busting, blob endpoints |
| `worker-bin.ts`, `worker-extract.ts`, `worker-smoke-test.ts` | Embedded mediasoup worker: extract, hash check, smoke test |
| `sfu/` | `worker-manager` (pool, respawn), `room-manager` (router + AudioLevelObserver per room), `peer-handler` (transports, producers, consumers), `codecs` (Opus + VP8) |

- SFU is optional (`TUTURU_SFU_ENABLED`). SFU operations for one peer are serialized through
  `enqueueSfuOp` in `handlers.ts`, because the client sends them back to back.
- Chat is synchronous: insert, broadcast to the others, ack the sender.
- Retention is `RETENTION_DAYS` (default 7) for both SQLite rows and blobs.

## Client (`app/src/client/`)

### State and effects

```
dispatch(action)
  → newState = reducer(prevState, action)                       pure
  → capture payloads into refs (MediaStream, aesKey)
  → runEffects({refs, dispatch}, {prevState, newState, action})  state/effects/orchestrator.ts
  → rawDispatch(action)                                          re-render
```

Effects run synchronously inside dispatch, not in `useEffect`: many actions (answers, ICE
candidates, SFU events) don't change state, and hook-based effects would never fire for them.

- `AppState` is a union on `phase`: `nickname → login → room`. Inside `room`, `screen` is the
  call sub-machine (`idle | acquiring-media | waiting-for-peer | call | error`) and `view`
  (`chat | call`) picks what's on screen. When the last remote peer leaves, the call returns to
  `waiting-for-peer` and keeps the camera on; that is intentional.
- Mutable resources (WebSocket, peer connections, streams, mediasoup objects, timers, the E2EE
  Worker, the IndexedDB handle, `aesKey`) live in `ResourceRefs`, created with `useRef` in
  `components/App.tsx`, never in reducer state.
- Effect handlers in `state/effects/` run in a fixed order, cleanup first: cleanup →
  roomWebSocket → peers → chat → settings → websocket → media → webrtc → sfu → error.

### Room connection (`effects/roomWebSocket.ts`, `services/websocket.ts`)

- On entering the room: open the WS, load the own `seq` counter from IDB, decrypt the latest 200
  cached blobs from IDB for instant display, then merge the server history.
- `join` carries `roomId` and the encrypted nickname. Reconnect is exponential backoff with
  jitter (1s up to 30s, at most 20 attempts). Dead-connection detection fires after 100s
  without a server ping.

### Chat and storage (`services/chatProtocol.ts`, `services/db.ts`)

- Send: build `ChatMessage` with `seq` incremented → optimistic UI → encrypt → WS → store the
  wire blob in IDB → persist own `seq`.
- Receive live: base64 → decrypt → JSON → version check → Zod → `checkAndStoreBlob` (one IDB
  transaction: reject `seq ≤ lastSeenSeq` as replay, reject known `uuid` as duplicate, write
  blob, update `lastSeenSeq`).
- Receive history: decrypt + validate, then `storeBlobIfNew` (dedup only; old messages would
  fail the seq check by definition).
- IndexedDB `tuturu` (`DB_VERSION` in `shared/constants.ts`): `settings` (nickname, deviceId,
  own seq counters), `seq` (`[roomId, deviceId] → lastSeenSeq`), `blobs` (encrypted wire blob
  plus plaintext index: uuid, roomId, timestamp, deviceId, seq, type). Migrations are
  append-only.

### Mesh calls (`services/webrtc.ts`, `effects/webrtc.ts`)

- One `RTCPeerConnection` per remote peer, in a `Map`. `call-peers` drives the diff: create
  connections for new peers, close them for peers that left.
- Perfect negotiation: the higher peerId is impolite and sends the offer; the polite side rolls
  back on glare. `makingOfferPeers` catches the window before `setLocalDescription`.
- After every `await`, `peerConnections.get(peerId) === pc` is checked; a mismatch aborts.
  ICE candidates are buffered until a remote description exists.

### SFU calls (`sfu/*`, `effects/sfu.ts`)

1. `MEDIA_ACQUIRED` → `join-call` + `sfu-join { rtpCapabilities: null }`
2. `sfu-router-caps` → load Device → `sfu-join` with real caps → request send and recv transports
3. send transport → produce audio/video; `produce` callbacks resolve FIFO on
   `sfu-producer-created`, with a 10s timeout
4. `sfu-new-consumer` → consume → attach decrypt transform → assemble the peer's stream →
   dispatch `RTC_CONNECTED` (only now, so the re-render sees the stream) → `sfu-consume-resume`
5. Mute and video toggles pause/resume producers on both ends.

### Media E2EE (`e2ee/`)

- Gated by the server-announced `e2eeMediaEnabled` (default true). When on, every
  sender/receiver gets an `RTCRtpScriptTransform` backed by one module Worker (`e2ee-worker.ts`,
  bundled separately, served as `/e2ee-worker.js`).
- Frame format: `[clear header N][iv 12][ciphertext + tag 16]`, with the clear header as
  AES-GCM additional data. N = 1 (Opus), 10 (VP8 keyframe), 3 (VP8 delta).
- Only Opus and VP8 under E2EE. Mesh forces VP8 with `setCodecPreferences`; the SFU router does
  not offer H264.
- Browser-specific constraints (Chrome's `encodedInsertableStreams`, iOS Safari transform
  timing, codec detection from SDP) are listed as invariants in `AGENTS.md` and explained in
  the `webrtc-e2ee-debug` skill.

## Build

- `app/build.ts` bundles `src/client/index.tsx` → `public/index.js` (react aliased to
  preact/compat for virtua) and `src/client/e2ee/e2ee-worker.ts` → `public/e2ee-worker.js`.
- The server is compiled with `bun build --compile`. `assets.ts` embeds HTML, CSS, JS and
  icons; `index.html` is rewritten at startup with content-hash query strings and an inline
  script carrying the E2EE worker hash.
- The mediasoup worker is always built from source (`worker:build`,
  `MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true`) and embedded via `import … with { type: 'file' }`.
  At runtime it is extracted to `/tmp/tuturu` (or `TUTURU_WORKER_DIR`) with a sidecar hash; the
  smoke test runs only after a fresh extraction or with `TUTURU_SMOKE_TEST=1`.

## Container (`container/`, `tuturu`)

- Two-stage build: `oven/bun:1.3-debian` builds client, worker and server binary;
  `redhat/ubi10-init` runs systemd as PID 1 with nginx, coturn and certbot from EPEL.
- Units, in order: `tuturu-init` (oneshot: validate env, render `nginx.conf` and
  `turnserver.conf` with envsubst, write `/etc/tuturu/env`) → `tuturu-certbot` (standalone
  issue for `<domain>`, `a.<domain>`, `t.<domain>`) → `tuturu-nginx`, `tuturu-coturn`,
  `tuturu-app`. `tuturu-certbot-renew.timer` runs daily; its post-hook restarts coturn.
- systemd does not inherit the container environment. `tuturu-init.service` lists every
  variable in `PassEnvironment=`, and the other units read `/etc/tuturu/env`.
- The `tuturu` CLI writes `~/.config/tuturu/env`, runs the image with `--systemd always`, ports
  80, 443 and 49152–49200/udp, and the `tuturu-certs` volume. `podman logs` stays empty; logs
  are in journald inside the container (`./tuturu logs [app|nginx|coturn|certbot]`).
- Current behaviour: only the certificates are on a volume, so `/var/lib/tuturu` (SQLite,
  blobs) does not survive container recreation (`restart`, `upgrade`). `NODE_ENV` is not set,
  so `config.nodeEnv` is `development` in production.

## Runtime notes

- **Bun child-process bug:** after a short-lived child with extra stdio pipes exits, the next
  child's fd 3 can get immediate EOF, and mediasoup workers die with `code:0, signal:null`.
  `sfu/worker-manager.ts` respawns on that exit code (at most 3 times per slot per minute);
  other exits shrink the pool.
- **Bun `execSync`** does not see `process.env` mutations, so `worker:build` sets `PYTHONPATH`
  on the command line.
- **coturn certificates** are read once at start; without the restart in the renew post-hook,
  TURNS breaks after renewal (about every 90 days).
- **SFU announced IP:** `TUTURU_SFU_ANNOUNCED_IP` → `EXTERNAL_IP` → `127.0.0.1` in development.
  A wrong value makes ICE fail without an error.
- **CSP:** nginx sends `script-src 'self' 'wasm-unsafe-eval'` for the app (WASM is needed for
  Argon2id). Inline scripts are not allowed by that policy, so behind nginx the injected
  worker-hash script is blocked, and `/e2ee-worker.js` loads without its `?v=` query while being
  served `immutable`. This is a known issue; don't add more inline scripts.
