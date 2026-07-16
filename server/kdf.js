/*
 * Passphrase hashing, deliberately kept in its own module with ZERO
 * dependencies — node:crypto only.
 *
 * tools/hash-passphrase.js is the very first thing anyone runs, often before
 * `npm install` has succeeded (and on Windows, `npm` itself can be blocked by
 * PowerShell's execution policy). It must not need a package tree just to run
 * scrypt. Importing auth.js instead would drag in db.js and therefore `pg`.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt is in Node core: no native module to build on Railway, and one less
// dependency trusted with the only secret that matters.
export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

export async function hashPassphrase(passphrase, salt = crypto.randomBytes(16)) {
  const dk = await scrypt(passphrase, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

/*
 * A stored hash arrives via an env var pasted through a web UI, so it picks up
 * damage: surrounding quotes, stray whitespace, or the whole `NAME=value` line
 * when only the value was wanted. Each of those has exactly one intended
 * meaning, and none can occur in a real hash (base64 has no quotes or spaces),
 * so normalise rather than make someone hunt an invisible character.
 */
export function normalizeStoredHash(stored) {
  let s = String(stored == null ? '' : stored).trim();
  s = s.replace(/^PASSPHRASE_HASH\s*=\s*/i, '');   // the whole line got pasted
  s = s.replace(/^(['"])([\s\S]*)\1$/, '$2');      // wrapped in quotes
  return s.trim();
}

/*
 * Why a stored hash is unusable — so "wrong passphrase" and "the hash in your
 * env var is broken" stop being the same message. They were, and it cost real
 * debugging time.
 */
export function hashState(stored) {
  const s = normalizeStoredHash(stored);
  if (!s) return 'missing';
  const parts = s.split('$');
  if (parts[0] !== 'scrypt') return 'malformed';
  // A shell that expanded $32768 etc. leaves the right shape with empty parts.
  if (parts.length !== 6) return 'malformed';
  if (!(Number(parts[1]) > 0) || !(Number(parts[2]) > 0) || !(Number(parts[3]) > 0)) return 'malformed';
  if (!parts[4] || !parts[5]) return 'malformed';
  return 'ok';
}

export async function verifyPassphrase(passphrase, stored) {
  try {
    const parts = normalizeStoredHash(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (!expected.length) return false;
    const dk = await scrypt(passphrase, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(dk, expected);
  } catch {
    return false; // a malformed hash must read as "wrong", never as "right"
  }
}
