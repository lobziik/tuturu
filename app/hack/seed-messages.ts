/**
 * Seed script: insert 50k encrypted messages into the server SQLite database.
 *
 * Usage: bun run scripts/seed-messages.ts [--count 50000] [--hostname localhost]
 *
 * Uses passphrase 'perf', pin '111111'. Derives keys with the given hostname
 * (default: localhost) so the client can decrypt when connecting from that host.
 */

import { Database } from 'bun:sqlite';
import { argon2id } from 'hash-wasm';

// ============================================================================
// Config
// ============================================================================

const PASSPHRASE = 'perf';
const PIN = '111111';
const HOSTNAME = parseArg('--hostname') ?? 'localhost';
const COUNT = Number(parseArg('--count') ?? '50000');
const DB_PATH = parseArg('--db') ?? './messages.db';
const BATCH_SIZE = 5000;

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

// ============================================================================
// Crypto (inline — avoids importing client module that pulls in DOM types)
// ============================================================================

const IV_LENGTH = 12;
const HKDF_SALT = new TextEncoder().encode('tuturu-hkdf-v1');

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

async function deriveKeys(passphrase: string, pin: string, hostname: string) {
  const encoder = new TextEncoder();
  const input = `${passphrase}:${pin}`;
  const salt = `tuturu:${hostname}`;

  const masterHex = await argon2id({
    password: input,
    salt: encoder.encode(salt),
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: 'hex',
  });
  const masterBytes = hexToBytes(masterHex);

  const hkdfKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveBits']);

  const roomIdBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', info: encoder.encode('room-id'), salt: HKDF_SALT },
    hkdfKey,
    128,
  );
  const roomId = bytesToHex(new Uint8Array(roomIdBits));

  const aesKeyBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', info: encoder.encode('encryption-key'), salt: HKDF_SALT },
    hkdfKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBits, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);

  return { roomId, aesKey };
}

async function encryptMessage(aesKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

// ============================================================================
// Message generation
// ============================================================================

function makeChatMessage(seq: number, timestamp: number) {
  return {
    v: 1,
    deviceId: 'seed-device-001',
    seq,
    uuid: crypto.randomUUID(),
    sender: 'PerfBot',
    timestamp,
    type: 'text' as const,
    text: `Message #${seq} — ${randomText()}`,
  };
}

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
  'uniform',
  'victor',
  'whiskey',
  'xray',
  'yankee',
  'zulu',
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
];

function randomText(): string {
  const len = 3 + Math.floor(Math.random() * 10);
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    parts.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
  }
  return parts.join(' ');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Deriving keys: passphrase='${PASSPHRASE}' pin='${PIN}' hostname='${HOSTNAME}'`);
  const { roomId, aesKey } = await deriveKeys(PASSPHRASE, PIN, HOSTNAME);
  console.log(`Room ID: ${roomId}`);
  console.log(`Generating and encrypting ${COUNT} messages...`);

  const db = new Database(DB_PATH);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = OFF');
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      blob TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_room_created
    ON messages (room_id, created_at DESC)
  `);

  const insertStmt = db.prepare(
    'INSERT INTO messages (room_id, blob, created_at) VALUES (?, ?, ?)',
  );

  const encoder = new TextEncoder();
  const baseTimestamp = Date.now() - COUNT * 1000; // 1 msg per second going back

  let inserted = 0;
  for (let batchStart = 0; batchStart < COUNT; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, COUNT);
    const rows: Array<[string, string, number]> = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const seq = i + 1;
      const timestamp = baseTimestamp + i * 1000;
      const msg = makeChatMessage(seq, timestamp);
      const plaintext = encoder.encode(JSON.stringify(msg));
      const wire = await encryptMessage(aesKey, plaintext);
      const b64 = toBase64(wire);
      rows.push([roomId, b64, timestamp]);
    }

    const insertMany = db.transaction(() => {
      for (const [rid, blob, ts] of rows) {
        insertStmt.run(rid, blob, ts);
      }
    });
    insertMany();

    inserted += rows.length;
    console.log(`  ${inserted}/${COUNT} inserted`);
  }

  db.run('PRAGMA synchronous = NORMAL');
  db.close();

  console.log(`Done. ${inserted} messages inserted for room ${roomId} in ${DB_PATH}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
