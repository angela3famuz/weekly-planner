import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  pool, migrate, LOCK_SYNC,
  UPSERT_WEEK, UPSERT_SETTINGS,
  SELECT_CHANGED_WEEKS, SELECT_CHANGED_SETTINGS, SELECT_CURSOR,
  INSERT_HISTORY, SELECT_PREV_WEEK_DOC, SELECT_PREV_SETTINGS_DOC,
  SELECT_WEEK_STAMP, SELECT_SETTINGS_STAMP,
  SELECT_HISTORY, SELECT_HISTORY_DOC,
} from './db.js';
// Re-exported: it used to live here, and both the tests and the boot path
// import it from this module.
export { describeError } from './errors.js';
import { describeError } from './errors.js';
import {
  verifyPassphrase, newToken, storeToken, checkToken, revokeAllTokens, bearerFrom,
} from './auth.js';
import { hashState } from './kdf.js';

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

  /*
   * A health check that does not touch its dependencies reports "ok" while
   * being useless: this process can be perfectly alive with the database gone.
   * So actually query it. Reading from `weeks` proves two things at once — the
   * connection works AND the schema exists — without returning a row count,
   * which would leak usage to an unauthenticated caller.
   *
   * `version` answers "is my fix actually deployed?" without reading logs.
   * Railway sets RAILWAY_GIT_COMMIT_SHA; absent elsewhere, which is fine.
   */
  app.get('/health', async (_req, res) => {
    // `configured: true` used to mean only "the env var is non-empty" — true
    // even for a hash mangled beyond use, while /auth rejected every correct
    // passphrase. `passphrase` says WHICH, so the two stop being one symptom.
    const state = hashState(passphraseHash);
    const out = {
      ok: true,
      configured: state === 'ok',
      passphrase: state,
      version: (process.env.RAILWAY_GIT_COMMIT_SHA || 'dev').slice(0, 7),
      database: 'connected',
    };
    try {
      await pool.query('select 1 from weeks limit 1');
    } catch (e) {
      // The detail names the host and can name the schema, so it goes to the
      // logs — not to whoever curls this.
      console.error('[health] database unreachable: ' + describeError(e));
      out.ok = false;
      out.database = 'unreachable';
      return res.status(503).json(out);
    }
    res.json(out);
  });

  app.post('/auth', authGlobalLimiter, authIpLimiter, async (req, res, next) => {
    try {
      // A broken hash is a server fault, not a wrong passphrase. Saying 401
      // here sent someone hunting a typo that did not exist.
      const state = hashState(passphraseHash);
      if (state !== 'ok') {
        console.error('[config] PASSPHRASE_HASH is ' + state + ' — /auth cannot accept anything. ' +
          'The value must be the hash alone: scrypt$N$r$p$salt$hash, no name, no quotes.');
        return res.status(503).json({ error: state === 'missing' ? 'not_configured' : 'passphrase_hash_malformed' });
      }
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
  // Substituting {} for a bad shape here let handleSync — which only checked
  // typeof === 'object', and an array passes that — go on to write the array
  // with NOTHING validated: no week-key check, no updatedAt check, no clock
  // ceiling. Only the date column's cast stopped it, as a 500. Say no instead.
  if (body.weeks != null && (typeof body.weeks !== 'object' || Array.isArray(body.weeks))) {
    return { error: 'bad_weeks' };
  }
  const weeks = body.weeks || {};
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

/*
 * Key order must not count as a change. The stored doc comes back from a jsonb
 * column, and jsonb canonicalises key order (by key length, then bytewise);
 * the incoming doc carries the client's insertion order. Plain JSON.stringify
 * therefore compared {focus,notes,...} against {days,focus,...} and called
 * every re-sync a change — so the guard below never once fired in production,
 * and every no-op save appended a duplicate history row.
 *
 * The existing test passed only by accident: its fixture's keys were already
 * in jsonb's order.
 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter((k) => v[k] !== undefined)             // JSON.stringify drops these
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
    .join(',') + '}';
}

// updatedAt always differs between versions, so compare the content without it.
function changedFrom(prevRow, incoming) {
  if (!prevRow) return true;                       // first ever version
  const strip = (o) => {
    const { updatedAt, ...rest } = o || {};
    return stableStringify(rest);
  };
  return strip(prevRow.doc) !== strip(incoming) || Boolean(prevRow.deleted) !== Boolean(incoming.deleted);
}

async function handleSync(req, res, next) {
  const body = req.body || {};
  const nowMs = Date.now();

  const invalid = validateSync(body, nowMs);
  if (invalid) return res.status(400).json(invalid);

  const since = Number.isInteger(body.since) && body.since > 0 ? body.since : 0;
  const weeks = body.weeks || {};   // validateSync has already refused any other shape
  const settings = body.settings ?? null;

  // connect() must be INSIDE the try: Express 4 does not forward an async
  // handler's rejection to the error middleware, so an unreachable database
  // rejected here escaped as an unhandled rejection and killed the process —
  // while the very same outage gave /health a tidy 503.
  let client;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query(LOCK_SYNC);
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
    let settingsWinner = null;
    if (settings) {
      const prev = await client.query(SELECT_PREV_SETTINGS_DOC);
      const r = await client.query(UPSERT_SETTINGS, [settings, settings.updatedAt]);
      if (r.rowCount === 0) {
        conflicts.push('settings');
        /*
         * The push lost, so the row's seq did not move — and SELECT_CHANGED_
         * SETTINGS only returns `seq > since`, so a client whose cursor is
         * already past it is never told what beat it. That was survivable while
         * settings were replaced wholesale. It is not now: the client merges
         * habits per item, and it can only merge against a document it has
         * seen. Hand it the winner.
         */
        settingsWinner = prev.rows[0] ? prev.rows[0].doc : null;
      } else if (changedFrom(prev.rows[0], settings)) {
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
    else if (settingsWinner) out.settings = settingsWinner;
    res.json(out);
  } catch (e) {
    if (client) await client.query('rollback').catch(() => {});
    next(e);
  } finally {
    if (client) client.release();
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
    // A negative or fractional limit reached Postgres verbatim and came back a
    // 500 — the caller's mistake reported as a server fault.
    const limit = Math.max(1, Math.min(Math.trunc(Number(req.query.limit)) || 50, MAX_HISTORY_PAGE));
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

  let client;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query(LOCK_SYNC);
    const found = await client.query(SELECT_HISTORY_DOC, [id]);
    if (!found.rowCount) {
      await client.query('rollback');
      return res.status(404).json({ error: 'no_such_version' });
    }
    const { kind, ref, doc, deleted } = found.rows[0];

    /*
     * A restore must always win, so it cannot just be stamped `now`.
     * validateSync accepts stamps up to five minutes ahead (CLOCK_SKEW_
     * TOLERANCE_MS), so a device with a fast clock can leave a stored week
     * stamped in the future. `now` would then not be greater than it, the
     * upsert's `where excluded.updated_at > ...` would match nothing, and the
     * restore would do NOTHING while still answering 200 — on the one path that
     * exists for "I have lost a month of planning".
     */
    const stampRow = kind === 'week'
      ? await client.query(SELECT_WEEK_STAMP, [ref])
      : await client.query(SELECT_SETTINGS_STAMP);
    const stored = stampRow.rowCount ? Number(stampRow.rows[0].updated_at) : 0;
    const updatedAt = Math.max(Date.now(), stored + 1);
    const restored = { ...doc, updatedAt };

    const r = kind === 'week'
      ? await client.query(UPSERT_WEEK, [ref, restored, deleted, updatedAt])
      : await client.query(UPSERT_SETTINGS, [restored, updatedAt]);
    // Belt and braces: updatedAt is built to win, so a loss here means the
    // reasoning above is wrong. Say so rather than report a phantom success.
    if (r.rowCount === 0) {
      await client.query('rollback');
      return res.status(409).json({ error: 'restore_lost_conflict', ref });
    }
    await client.query(INSERT_HISTORY, [kind, kind === 'week' ? ref : 'settings',
      restored, kind === 'week' ? deleted : false, updatedAt]);

    const cursor = await client.query(SELECT_CURSOR);
    await client.query('commit');
    res.json({ restored: { kind, ref, updatedAt }, now: Number(cursor.rows[0].cursor) });
  } catch (e) {
    if (client) await client.query('rollback').catch(() => {});
    next(e);
  } finally {
    if (client) client.release();
  }
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
  const hs = hashState(process.env.PASSPHRASE_HASH);
  if (hs === 'missing') {
    console.warn('[config] PASSPHRASE_HASH is not set — /auth will return 503. Run `node tools/hash-passphrase.js`.');
  } else if (hs === 'malformed') {
    console.error('[config] PASSPHRASE_HASH is SET BUT MALFORMED, so every correct passphrase will be refused.');
    console.error('[config] The value must be the hash alone — scrypt$N$r$p$salt$hash — with no');
    console.error('[config] "PASSPHRASE_HASH=" prefix, no quotes, and all six $-separated parts present.');
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
