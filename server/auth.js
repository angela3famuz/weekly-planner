import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './db.js';

const scrypt = promisify(crypto.scrypt);

// scrypt is in Node core: no native module to build on Railway, and one less
// dependency trusted with the only secret that matters.
export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

export async function hashPassphrase(passphrase, salt = crypto.randomBytes(16)) {
  const dk = await scrypt(passphrase, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

export async function verifyPassphrase(passphrase, stored) {
  try {
    const parts = String(stored || '').split('$');
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
    return false; // malformed hash must read as "wrong", never as "right"
  }
}

// Tokens are 256-bit random, so they cannot be guessed and need no slow KDF.
// Hashing them at rest means a database leak does not hand over a live session.
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function storeToken(token) {
  await pool.query(
    'insert into tokens (token_hash) values ($1) on conflict (token_hash) do nothing',
    [tokenHash(token)]
  );
}

export async function checkToken(token) {
  if (!token) return false;
  const { rowCount } = await pool.query(
    'update tokens set last_seen = now() where token_hash = $1',
    [tokenHash(token)]
  );
  return rowCount === 1;
}

export async function revokeAllTokens() {
  const { rowCount } = await pool.query('delete from tokens');
  return rowCount;
}

export function bearerFrom(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}
