import crypto from 'node:crypto';
import { pool } from './db.js';

// Passphrase hashing lives in kdf.js, which has no dependencies, so the hash
// tool can run before (or without) a successful npm install. Re-exported here
// so callers still have one place to look.
export { SCRYPT, hashPassphrase, verifyPassphrase } from './kdf.js';

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
