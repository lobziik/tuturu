---
name: webrtc-e2ee-debug
description: Diagnose tuturu call failures - no audio/video, frozen or garbled media, E2EE crypto-failed counters, iOS-only breakage, SFU peers stuck connecting, TURN/ICE not connecting. Use before changing code in services/webrtc.ts, e2ee/, sfu/ or effects/sfu.ts.
---

# WebRTC + media E2EE debugging (tuturu)

Goal: find which layer drops the media before touching code. Most bugs here are timing or
gating bugs that look like "nothing happens". Read the client sections of
`docs/ARCHITECTURE.md` (mesh, SFU, media E2EE) and invariants 8–10 in `AGENTS.md` first.

## 1. Pin down the setup

Collect these before forming a theory:

- **Topology**: mesh or SFU. `JOINED_ROOM` in the console (`[ACTION] JOINED_ROOM`) carries
  `sfuEnabled` and `e2eeMediaEnabled`; the header badge shows `E2EE` / `SFU · server can see media`.
- **Browsers on both ends**, including iOS Safari vs iOS Chrome (both WebKit) vs installed PWA.
- **Direction**: who can't see/hear whom. Self-view problems are local capture/render, not
  WebRTC.
- **Relay**: `FORCE_RELAY` on the server, and whether it reproduces on the same LAN.
- Does it reproduce with E2EE off (`TUTURU_E2EE_MEDIA_ENABLED=false`)? If not, it's an E2EE
  pipeline problem. If yes, it's transport/negotiation/render.

## 2. Read the E2EE worker counters

Each transform pipeline logs from the worker (devtools: select the worker context, or it
shows in the page console in Chrome):

```
[E2EE:Worker pipe#N] options received: object encrypt|decrypt codec=opus|vp8
[E2EE:Worker pipe#N] decrypt codec=vp8: <ok> ok, <malformed> malformed, <crypto-failed> crypto-failed
```

Logged on the first frame and every 100 frames.

| What you see | Meaning | Where to look |
|---|---|---|
| No `options received` at all | Transform never constructed, or the worker didn't load | `buildE2eeConfig` / `handleSfuRouterCaps`, network tab for `/e2ee-worker.js`, CSP |
| `options received`, no counter lines ever | Browser isn't feeding frames into the transform | Chrome: `encodedInsertableStreams` missing on that PC. iOS mesh callee: transform attached after `setRemoteDescription` |
| Steady `crypto-failed` on decrypt | Key mismatch, or header size mismatch (different codec on each side), or bytes altered in transit | Compare codecs in both SDPs; H264 sneaking in; both peers derived the same room? |
| Brief `crypto-failed` at call start, then `ok` | Normal ramp-up | Nothing |
| Steady `malformed` | Frames truncated or not encrypted by the sender | Sender has no encrypt transform while receiver decrypts |
| All `ok` but no picture | Decode/render problem, not crypto | Section 4 |

Never add `tee()` on the frame streams to inspect them: it silently kills the pipeline.
Temporary extra logging is fine, but keep it out of the per-frame hot path and remove it before
merging.

## 3. Known failure signatures

- **Chrome: no media in either direction with E2EE off.** `encodedInsertableStreams: true` was
  set without a transform. Check `RTC_ENCODED_INSERTABLE_STREAMS` gating in
  `createPeerConnection` (mesh) and `buildTransportOptions` (SFU).
- **iOS receives nothing on mesh, sends fine.** Receiver transform attached after SRD. Must
  happen in `acceptOfferAndAnswer` before `setRemoteDescription`.
- **iOS ↔ Chrome video freezes or all frames crypto-failed with E2EE on.** H264 got
  negotiated. Under E2EE mesh must force VP8 (`applyVp8VideoPreference`); SFU router must not
  list H264.
- **Receiver transform never wired on iOS.** `getParameters().codecs` is empty right after SDP
  apply; codec must come from `parseNegotiatedCodecs(sdp)`.
- **Audio clicks/distortion only with E2EE.** Wrong clear-header size for the codec (Opus = 1
  byte); check `getUnencryptedByteCount` and that the transform got `codec=opus`.
- **SFU peer stuck on "Connecting...".** `SFU_NEW_CONSUMER` sets `connecting`; `RTC_CONNECTED`
  is dispatched only after the consumer stream is in `remoteStreams`. Look for
  `[SFU:Effects] Failed to create consumer` and whether `sfu-consume-resume` was sent
  (server logs `[SFU:PeerHandler] Consumer ... resumed`).
- **SFU ICE never connects.** Wrong announced IP (`TUTURU_SFU_ANNOUNCED_IP` / `EXTERNAL_IP`;
  dev falls back to `127.0.0.1`, unreachable from a phone), or transports created without ICE
  servers.
- **SFU produce hangs then fails after 10s.** `sfu-producer-created` never arrived; check the
  server log for the per-peer queue error (`[HANDLER] SFU error for peer`).
- **Server: mediasoup workers die with `code:0, signal:null`.** Bun fd 3 EOF bug; respawn
  logic in `worker-manager.ts` should handle it. Repeated respawns hitting the rate limit →
  pool shrinks to zero → "No workers available".
- **TURNS stopped working "suddenly", coturn logs `TLS/TCP socket buffer operation error`
  with empty username.** Expired cert in coturn memory; coturn was not restarted after renewal.
- **Black remote tile on iOS, SFU path.** Stream built with `new MediaStream()` + `addTrack`
  doesn't autoplay; `VideoTile` must call `play()`.
- **Blank self-view on iOS.** Local capture/render: `play()` rejection, track `ended`/`muted`
  after backgrounding, `<video>` remount losing `srcObject`, one stream shared by two
  `<video>` elements. Not an E2EE problem.

## 4. Tools

- **Chrome**: `chrome://webrtc-internals` (inbound-rtp `packetsReceived`,
  `framesDecoded`, `codecId`, candidate pair state).
- **iOS**: Safari Web Inspector (iPhone: Settings → Safari → Advanced → Web Inspector; USB to a
  Mac; Safari → Develop menu). No webrtc-internals; run `getStats()` from the console:

  ```js
  // in the console, with a PC reachable from a breakpoint or a temporary global
  (await pc.getStats()).forEach(r => r.type === 'inbound-rtp' && console.log(r.kind, r.packetsReceived, r.framesDecoded, r.codecId));
  ```

  Rising `packetsReceived` with `framesDecoded` stuck at 0 means the media arrives but decode
  or decrypt fails. Both at 0 means transport/ICE.
- **Inspect SDP**: `pc.localDescription.sdp` / `pc.remoteDescription.sdp`: first payload type on
  `m=video` must be VP8 when E2EE is on.
- **Server/container**: `./tuturu logs app`, `./tuturu logs coturn`, or
  `podman exec tuturu journalctl -u tuturu-app -f` (`podman logs` is empty for this image).
- **Device testing in dev**: phones need HTTPS for `getUserMedia` and Web Crypto. Run
  `bun run dev`, then `tailscale serve --bg --https=443 http://localhost:3000` and open the
  `*.ts.net` URL. For SFU set `TUTURU_SFU_ENABLED=true`, build the worker
  (`bun run worker:prepare`) and set `TUTURU_SFU_ANNOUNCED_IP` to an IP the phone can reach
  (e.g. the Tailscale IP).

## 5. Rules for the fix

- Reproduce on the real device class that failed; iOS fixes are not verified in desktop Safari.
- Never "fix" by disabling E2EE, dropping the codec restriction, or catching and ignoring the
  error that surfaces as `RTC_FAILED`. Plaintext fallback is a bug.
- Keep mesh and SFU gating symmetric: if you change when the insertable-streams flag or a
  transform is applied on one path, check the other.
- Add a unit test where logic is extractable (SDP parsing, frame processing, gating helpers);
  browser timing fixes get a comment explaining the device behaviour that forced them.
