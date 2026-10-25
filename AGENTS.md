# AGENTS.md

Working guide for coding agents (and humans) in this repo. If it disagrees with the code, the
code wins; fix this file in the same PR.

Read before non-trivial work:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): server, client, protocol, SFU, container.
- `.claude/skills/webrtc-e2ee-debug/`: before changing call, media or E2EE code.

A local `ai/` folder (gitignored) may hold older design notes. Treat it as history.

## What this is

Self-hosted chat + WebRTC calls for a small group (up to 6 per room). Passphrase + 6-digit PIN
= room. One container: nginx (TLS, SNI demux on :443), coturn, a compiled Bun server (HTTP,
WebSocket, SQLite, optional mediasoup SFU), certbot. Preact PWA client. The server is untrusted
for content: everything user-generated is encrypted in the browser with a key the server
never sees.

## Map

```
app/src/shared/     Zod wire schemas (source of truth), constants, shared types
app/src/server/     Bun server; sfu/ = mediasoup worker pool, routers, per-peer signaling
app/src/client/     state/ (reducer + effects/), services/, sfu/, e2ee/, components/
app/public/         index.html, styles.css, icons; build output (gitignored)
app/hack/           dev scripts, not linted, not shipped
container/          Dockerfile, systemd units, nginx/coturn templates, init scripts
tuturu              operator CLI (bash)
```

## Commands (run from `app/`)

Bun **1.3.11** (pinned in CI; also a dependency, so `node_modules/.bin/bun` is 1.3.11).

```bash
bun install --frozen-lockfile
bun run build          # client → public/index.js + public/e2ee-worker.js
bun run test           # bun test --randomize
bun run check          # eslint + prettier --check + tsc + stylelint + knip
bun run dev            # build once + server with --hot on :3000
bun run worker:prepare # mediasoup worker from source (python3 gcc g++ make)
```

- Run `bun run build` before tests on a fresh checkout: the server test suite imports the built
  client assets.
- The server won't start without `src/server/mediasoup-worker`, even with SFU off (static
  file import). Mesh-only: `touch src/server/mediasoup-worker`. SFU: `worker:prepare`.
- The dev server writes `messages.db*` and `blobs/` into `app/`. Don't commit them.
- Send long test output to a file and grep it, don't read the stream.

**Done means:** `bun run check` and `bun run test` pass with zero warnings, and there are no
import cycles (`bunx madge --circular --extensions ts,tsx src/`). Changes to the server binary,
mediasoup, `build.ts` or `container/` need the `build-verify` PR label.

## Invariants

Don't break these without an explicit maintainer decision.

1. Passphrase, PIN and `aesKey` never leave the browser, are never stored or logged, never go
   into reducer state. `aesKey` stays non-extractable and lives in refs.
2. New user content is encrypted with `aesKey` before it reaches WS or HTTP. The server stores
   and relays opaque blobs and never parses them.
3. Changing Argon2/HKDF parameters, salts or info strings re-keys every room and orphans all
   history. Symmetric-only; no asymmetric crypto, PKI or ratchets. `hack/seed-messages.ts`
   mirrors the parameters.
4. Every inbound WS message is Zod-validated on both sides. Wire types come from `z.infer`.
5. One outgoing path on the server (`send` in `index.ts`); `rooms.ts` never calls `ws.send`.
6. Mutable resources (WS, peer connections, streams, mediasoup objects, timers, Worker, IDB)
   live in refs, not reducer state. Effects run synchronously in dispatch; don't move them to
   `useEffect`.
7. IndexedDB holds ciphertext plus a plaintext index only. Migrations are append-only: bump
   `DB_VERSION`, add a migration, never edit an old one.
8. Media E2EE never silently degrades to plaintext. Opus + VP8 only under E2EE.
9. `encodedInsertableStreams` only on connections that get a transform on every
   sender/receiver (otherwise Chrome drops all media). On the mesh callee path, transforms go on
   before `setRemoteDescription` (iOS). The codec comes from SDP, not `getParameters()`. No
   `tee()` on frame streams. Details: the `webrtc-e2ee-debug` skill.
10. Mesh: after every `await`, check `peerConnections.get(peerId) === pc` before going on.

## Conventions

- Strict TS plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: add optional props
  with conditional spread, not `undefined`.
- No `any`. `as` only at real boundaries (validated loose records → mediasoup types, asset
  imports, missing DOM typings, test mocks). Narrow on `x.type` directly, not via intermediate
  variables.
- Exhaustive `switch` (lint-enforced); `never` default where the switch returns.
- Factories and closures, no classes (Error subclasses OK). Named exports, `import type`.
  No new module-level mutable state.
- Expected failures return typed result unions; invariant violations throw. Fail fast.
- New files: JSDoc header with `@module`; explain *why*, especially browser workarounds.
  English comments.
- Logs: bracketed prefix (`[WS]`, `[RTC:<peerId>]`, `[SFU:Effects]`, `[E2EE]`, `[HANDLER]`, …).
  Never log secrets. The server has no content to log; keep it that way.
- Prettier: single quotes, trailing commas, width 100. Plain CSS in `public/styles.css`
  with `:root` variables; no Tailwind or CSS-in-JS.
- Sonar nits seen here: `globalThis` over `window`, `Number.parseInt`, optional chaining,
  cognitive complexity.

## Tests

- `bun:test`, colocated `*.test.ts`, randomized order.
- Unit tests for pure logic: reducer transitions, schemas (valid and invalid), crypto,
  chatProtocol, db (`import 'fake-indexeddb/auto'`, `resetDBCache` per test), E2EE frame
  processing, SDP parsing, SFU managers with mocked mediasoup.
- `server/ws_integration.test.ts` runs a real server on port 0 with `:memory:` SQLite. New
  message types get positive and negative cases there.
- Module mocks: `mock.module(...)`, then `await import()` the unit under test.
- Argon2 is slow: derive once in `beforeAll`, or `crypto.subtle.generateKey` when the
  derivation itself isn't under test.
- Untestable browser files are listed in `sonar.coverage.exclusions`; prefer extracting logic
  over adding to that list.

## Workflow

- Branch → PR → squash merge. Prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `build:`, `config:`, scoped like `fix(sonar):`.
- CI runs lint/type/format/knip and build + tests + coverage + Sonar. `build_verify` (worker
  from source, compiled binary, `/health` smoke test) runs only on `main` and on PRs
  labelled `build-verify`.
- Release = tag `X.Y.Z` (no `v`): multi-arch image to GHCR plus the versioned `tuturu` CLI on
  the GitHub release.
- Never commit build output (`public/index.js`, `public/e2ee-worker.js`, `dist/`,
  `src/server/mediasoup-worker`, `coverage/`).
- Planned work lives in GitHub issues (`security`, `tracking`, `bug`). Check them before
  redesigning something.

## Change recipes

- **Env var:** `server/config.ts` (schema + mapping) → `container/scripts/tuturu-init.sh`
  (log + write to `/etc/tuturu/env`) → `PassEnvironment=` in
  `container/systemd/tuturu-init.service` → `tuturu` `write_config` if set at install →
  README table. Skip a step and the value is silently dropped in production.
- **WS message:** `shared/schemas.ts` union → `server/ws.ts` → `server/handlers.ts` →
  client `services/websocket.ts` → `Action` in `state/types.ts` → reducer → effect. Tests in
  schemas, ws_integration and reducer.
- **Static asset / entrypoint:** `public/` or `build.ts` → `server/assets.ts` →
  `server/http.ts` route table → `server/global.d.ts` for a new extension → `knip.json` for a
  new entry. Keep `src="index.js"` / `href="styles.css"` in `index.html` literal (rewritten at
  startup). New script/connect sources need the CSP in `container/templates/nginx.conf.template`;
  inline scripts are blocked.
- **E2EE codec:** `sfu/codecs.ts`, `normalizeCodec` + `E2eeCodec` in `e2ee-transform.ts`, the
  mirrored union and header sizes in `e2ee-worker.ts`, VP8 forcing in `services/webrtc.ts`.
  Verify on a real iPhone and in Chrome.
- **Dependencies:** `bun add` / `bun update` so `bun.lock` moves. `package-lock.json` only
  feeds GitHub's dependency tooling; Dependabot PRs touching only that file change nothing
  that ships, so redo the bump with bun. Bun and mediasoup upgrades need `build-verify` and
  a real call.
