import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  pool, migrate,
  UPSERT_WEEK, UPSERT_SETTINGS,
  SELECT_CHANGED_WEEKS, SELECT_CHANGED_SETTINGS, SELECT_CURSOR,
  INSERT_HISTORY, SELECT_PREV_WEEK_DOC, SELECT_PREV_SETTINGS_DOC,
  SELECT_HISTORY, SELECT_HISTORY_DOC,
} from './db.js';
import {
  verifyPassphrase, newToken, storeToken, checkToken, revokeAllTokens, bearerFrom,
} from './auth.js';

const MAX_WEEKS_PER_SYNC = 400;      // ~8 years; a runaway guard, not a real limit
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export const DEFAULTS = {
  authLimit: 5,                      // per IP per window
  authWindowMs: 15 * 60 * 1000,
  authGlobalLimit: 20,               // across all IPs, so rotating them doesn't help
  syncLimit: 60,                     // per minute; authenticated, so just a runaway guard
  syncWindowMs: 60 * 1000,
};

function envOrigins() {
  // Never `*`. An empty list means no browser can reach this.
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/*
 * Config is injected rather than read from env at import time, so tests can
 * exercise the real limiter at a testable threshold instead of turning it off.
 */
export function createApp(opts = {}) {
  const passphraseHash = opts.passphraseHash ?? process.env.PASSPHRASE_HASH ?? '';
  const allowedOrigins = opts.allowedOrigins ?? envOrigins();
  const cfg = { ...DEFAULTS, ...opts };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);         // Railway sits behind one proxy hop
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // The brute-force surface: one passphrase, so these are load-bearing.
  const authIpLimiter = rateLimit({
    windowMs: cfg.authWindowMs, limit: cfg.authLimit,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'too_many_attempts' },
  });
  const authGlobalLimiter = rateLimit({
    windowMs: cfg.authWindowMs, limit: cfg.authGlobalLimit,
    keyGenerator: () => 'global',
    standardHeaders: false, legacyHeaders: false,
    message: { error: 'too_many_attempts' },
  });
  const syncLimiter = rateLimit({
    windowMs: cfg.syncWindowMs, limit: cfg.syncLimit,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate_limited' },
  });

  async function requireAuth(req, res, next) {
    try {
      if (await checkToken(bearerFrom(req))) return next();
      res.status(401).json({ error: 'unauthorized' });
    } catch (e) { next(e); }
  }

  // `version` answers "is my fix actually deployed?" without reading logs.
  // Railway sets RAILWAY_GIT_COMMIT_SHA; absent elsewhere, which is fine.
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      configured: Boolean(passphraseHash),
      version: (process.env.RAILWAY_GIT_COMMIT_SHA || 'dev').slice(0, 7),
    });
  });

  app.post('/auth', authGlobalLimiter, authIpLimiter, async (req, res, next) => {
    try {
      if (!passphraseHash) return res.status(503).json({ error: 'not_configured' });
      const passphrase = req.body && req.body.passphrase;
      if (typeof passphrase !== 'string' || !passphrase) {
        return res.status(400).json({ error: 'passphrase_required' });
      }
      if (!(await verifyPassphrase(passphrase, passphraseHash))) {
        return res.status(401).json({ error: 'wrong_passphrase' });
      }
      const token = newToken();
      await storeToken(token);
      res.json({ token });
    } catch (e) { next(e); }
  });

  app.delete('/tokens', requireAuth, async (_req, res, next) => {
    try {
      res.json({ revoked: await revokeAllTokens() });
    } catch (e) { next(e); }
  });

  app.post('/sync', syncLimiter, requireAuth, handleSync);
  app.get('/history', syncLimiter, requireAuth, handleHistoryList);
  app.post('/restore', syncLimiter, requireAuth, handleRestore);

  // Never echo the request body: it is the user's schedule.
  app.use((err, _req, res, _next) => {
    // body-parser failures are the caller's fault; reporting them as 500 would
    // send someone debugging the server for a client-side problem.
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
    console.error('[error]', err && err.message);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Reject the whole request rather than write half of it.
function validateSync(body, nowMs) {
  const weeks = body.weeks && typeof body.weeks === 'object' && !Array.isArray(body.weeks)
    ? body.weeks : {};
  const keys = Object.keys(weeks);
  if (keys.length > MAX_WEEKS_PER_SYNC) return { error: 'too_many_weeks' };

  const ceiling = nowMs + CLOCK_SKEW_TOLERANCE_MS;
  const check = (doc, what) => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'bad_doc', detail: what };
    if (!Number.isInteger(doc.updatedAt) || doc.updatedAt <= 0) return { error: 'bad_updated_at', detail: what };
    // A fast clock must break loudly here rather than silently win every
    // conflict. Clamping instead would leave server and client permanently
    // disagreeing with no error surfaced anywhere.
    if (doc.updatedAt > ceiling) return { error: 'clock_skew', serverTime: nowMs };
    return null;
  };

  for (const k of keys) {
    if (!WEEK_KEY.test(k)) return { error: 'bad_week_key', detail: k };
    const bad = check(weeks[k], k);
    if (bad) return bad;
  }
  if (body.settings != null) {
    const bad = check(body.settings, 'settings');
    if (bad) return bad;
  }
  return null;
}

// updatedAt always differs between versions, so compare the content without it.
function changedFrom(prevRow, incoming) {
  if (!prevRow) return true;                       // first ever version
  const strip = (o) => {
    const { updatedAt, ...rest } = o || {};
    return JSON.stringify(rest);
  };
  return strip(prevRow.doc) !== strip(incoming) || Boolean(prevRow.deleted) !== Boolean(incoming.deleted);
}

async function handleSync(req, res, next) {
  const body = req.body || {};
  const nowMs = Date.now();

  const invalid = validateSync(body, nowMs);
  if (invalid) return res.status(400).json(invalid);

  const since = Number.isInteger(body.since) && body.since > 0 ? body.since : 0;
  const weeks = body.weeks && typeof body.weeks === 'object' ? body.weeks : {};
  const settings = body.settings ?? null;

  const client = await pool.connect();
  try {
    await client.query('begin');
    const conflicts = [];

    for (const [weekIso, doc] of Object.entries(weeks)) {
      // Read the outgoing version first so an unchanged re-sync does not append
      // an identical history row. Same transaction as the upsert, so a version
      // can never be recorded for a write that did not happen, nor lost for one
      // that did.
      const prev = await client.query(SELECT_PREV_WEEK_DOC, [weekIso]);
      const r = await client.query(UPSERT_WEEK, [weekIso, doc, Boolean(doc.deleted), doc.updatedAt]);
      if (r.rowCount === 0) { conflicts.push(weekIso); continue; }
      if (changedFrom(prev.rows[0], doc)) {
        await client.query(INSERT_HISTORY, ['week', weekIso, doc, Boolean(doc.deleted), doc.updatedAt]);
      }
    }
    if (settings) {
      const prev = await client.query(SELECT_PREV_SETTINGS_DOC);
      const r = await client.query(UPSERT_SETTINGS, [settings, settings.updatedAt]);
      if (r.rowCount === 0) conflicts.push('settings');
      else if (changedFrom(prev.rows[0], settings)) {
        await client.query(INSERT_HISTORY, ['settings', 'settings', settings, false, settings.updatedAt]);
      }
    }

    const changed = await client.query(SELECT_CHANGED_WEEKS, [since]);
    const changedSettings = await client.query(SELECT_CHANGED_SETTINGS, [since]);
    const cursor = await client.query(SELECT_CURSOR);
    await client.query('commit');

    const out = { now: Number(cursor.rows[0].cursor), weeks: {}, settings: null, conflicts };
    for (const row of changed.rows) {
      out.weeks[row.week_iso] = row.deleted ? { ...row.doc, deleted: true } : row.doc;
    }
    if (changedSettings.rowCount) out.settings = changedSettings.rows[0].doc;
    res.json(out);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
}

const MAX_HISTORY_PAGE = 200;

// GET /history?ref=2026-07-13  ->  the versions available to restore
async function handleHistoryList(req, res, next) {
  try {
    const ref = String(req.query.ref || '');
    const kind = ref === 'settings' ? 'settings' : 'week';
    if (kind === 'week' && !WEEK_KEY.test(ref)) {
      return res.status(400).json({ error: 'bad_ref' });
    }
    const limit = Math.min(Number(req.query.limit) || 50, MAX_HISTORY_PAGE);
    const { rows } = await pool.query(SELECT_HISTORY, [kind, ref, limit]);
    res.json({
      ref,
      versions: rows.map((r) => ({
        id: Number(r.id),
        updatedAt: Number(r.updated_at),
        recordedAt: r.recorded_at,
        deleted: r.deleted,
      })),
    });
  } catch (e) { next(e); }
}

/*
 * POST /restore { id }
 *
 * Restoring does not rewrite history or reach into other devices — it writes the
 * old content back as a NEW current version, stamped now so it wins
 * last-write-wins and propagates on each device's next sync. The restore is
 * itself recorded, so restoring the wrong thing is also undoable.
 */
async function handleRestore(req, res, next) {
  const id = req.body && req.body.id;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const found = await client.query(SELECT_HISTORY_DOC, [id]);
    if (!found.rowCount) {
      await client.query('rollback');
      return res.status(404).json({ error: 'no_such_version' });
    }
    const { kind, ref, doc, deleted } = found.rows[0];
    const updatedAt = Date.now();
    const restored = { ...doc, updatedAt };

    if (kind === 'week') {
      await client.query(UPSERT_WEEK, [ref, restored, deleted, updatedAt]);
      await client.query(INSERT_HISTORY, ['week', ref, restored, deleted, updatedAt]);
    } else {
      await client.query(UPSERT_SETTINGS, [restored, updatedAt]);
      await client.query(INSERT_HISTORY, ['settings', 'settings', restored, false, updatedAt]);
    }
    const cursor = await client.query(SELECT_CURSOR);
    await client.query('commit');
    res.json({ restored: { kind, ref, updatedAt }, now: Number(cursor.rows[0].cursor) });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
}

/*
 * Node 20+ enables autoSelectFamily by default: when a hostname resolves to
 * several addresses (IPv6 and IPv4) and ALL of them fail, it throws an
 * AggregateError whose .message is EMPTY and whose real causes are hidden in
 * .errors. Railway's private network is IPv6-only, so a failure there arrives
 * in exactly that shape — and logging only e.message printed
 * "[boot] migration failed:" with nothing after it, over and over.
 * Never log a bare .message for a connection error.
 */
export function describeError(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code) parts.push('code=' + e.code);
  if (Array.isArray(e.errors) && e.errors.length) {
    parts.push('caused by: ' + e.errors
      .map((sub) => (sub && sub.message ? sub.message : String(sub)) + (sub && sub.code ? ' [' + sub.code + ']' : ''))
      .join(' | '));
  }
  if (!parts.length) parts.push(e.constructor ? e.constructor.name : String(e));
  return parts.join(' · ');
}

// Where are we actually dialling? Host and port only — the URL carries the
// database password, which must never reach a log.
export function dbTarget(url = process.env.DATABASE_URL) {
  try {
    const u = new URL(url);
    return u.hostname + ':' + (u.port || '5432') + u.pathname;
  } catch {
    return '(DATABASE_URL is not a valid URL — check for an unresolved ${{...}} reference)';
  }
}

// Railway's private network can take a few seconds to come up after a container
// starts, so the first connection legitimately fails. Exiting immediately turned
// that into an endless crash-loop.
async function migrateWithRetry(attempts = 7) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await migrate();
      if (attempt > 1) console.log('[boot] database reached on attempt ' + attempt);
      return;
    } catch (e) {
      console.error('[boot] attempt ' + attempt + '/' + attempts + ' — cannot reach ' + dbTarget() + ': ' + describeError(e));
      if (attempt === attempts) throw e;
      const wait = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.log('[boot] retrying in ' + wait + 'ms');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Only boot when run directly, so tests can import createApp without listening.
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const PORT = Number(process.env.PORT) || 8080;
  if (!process.env.DATABASE_URL) {
    console.error('[config] DATABASE_URL is not set. Add a PostgreSQL plugin to the Railway project,');
    console.error('[config] then set DATABASE_URL = ${{Postgres.DATABASE_URL}} on THIS service.');
    process.exit(1);
  }
  console.log('[config] database target: ' + dbTarget());
  if (!process.env.PASSPHRASE_HASH) {
    console.warn('[config] PASSPHRASE_HASH is not set — /auth will return 503. Run `node tools/hash-passphrase.js`.');
  }
  if (!envOrigins().length) {
    console.warn('[config] ALLOWED_ORIGINS is not set — no browser will be allowed to call this.');
  }
  const app = createApp();
  migrateWithRetry()
    .then(() => app.listen(PORT, () => console.log('sync listening on :' + PORT)))
    .catch((e) => {
      console.error('[boot] giving up: ' + describeError(e));
      console.error('[boot] checklist: is the Postgres plugin in the SAME Railway project as this service?');
      console.error('[boot]            is DATABASE_URL a ${{Postgres.DATABASE_URL}} reference, not typed by hand?');
      console.error('[boot]            if using a public database URL rather than the private network, set DATABASE_SSL=true');
      process.exit(1);
    });
}
